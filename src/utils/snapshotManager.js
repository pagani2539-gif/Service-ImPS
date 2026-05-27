// src\utils\snapshotManager.js
const axios = require("axios");
const fs = require("fs-extra");
const path = require("path");
const dayjs = require("dayjs");
const FormData = require("form-data");
const { snapshotRegistry, normalizeLane } = require("./snapshotRegistry");

const SNAP_MATCH_POLL_MS = Number(process.env.SNAP_MATCH_POLL_MS) || 150;
const SNAP_MATCH_MAX_WAIT_MS = Number(process.env.SNAP_MATCH_MAX_WAIT_MS) || 5000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

class SnapshotManager {
  constructor(pool, config, uploadUrl, baseImagePath) {
    this.pool = pool;
    this.baseImagePath = baseImagePath;
    this.config = config;
    this.uploadUrl = uploadUrl;
  }

  async takeSnapshot(url, metadata) {
    const lane = normalizeLane(metadata.lane);
    const { type, stamp } = metadata;

    try {
      const response = await axios.get(url, {
        responseType: "arraybuffer",
        timeout: 3000,
      });
      if (response.status !== 200) {
        throw new Error(`Failed to fetch snapshot: ${response.status}`);
      }

      const date = dayjs(stamp);
      const year = date.format("YYYY");
      const month = date.format("MM");
      const day = date.format("DD");
      const timestamp = date.format("YYYY_MM_DD_HH_mm_ss_SSS");
      const filename = `${type}_${lane}_${timestamp}.jpg`;
      const filePath = path.join(
        this.baseImagePath,
        type,
        year,
        month,
        day,
        `lane${lane}`,
        filename
      );

      await fs.ensureDir(path.dirname(filePath));
      await fs.writeFile(filePath, response.data);

      const stampDate = date.toDate();
      
      // Register in memory FIRST to ensure it's claimable immediately
      snapshotRegistry.register({
        lane,
        type,
        stamp: stampDate,
        imageUrl: filePath,
      });

      // Then save to DB (we don't strictly need to await this if we want speed, 
      // but awaiting ensures DB consistency if memory fails)
      try {
        await this.pool.execute(
          `INSERT INTO snapshots (lane, type, stamp, image_url) VALUES (?, ?, ?, ?)`,
          [lane, type, stampDate, filePath]
        );
      } catch (dbErr) {
        console.error(`[Snapshot] DB Insert failed for ${filename}:`, dbErr.message);
      }

      return { lane, type, stamp: stampDate, imageUrl: filePath };
    } catch (err) {
      console.error(
        `Error taking snapshot for lane ${lane}, type ${type}:`,
        err.message
      );
      return null;
    }
  }

  /**
   * Poll until a snapshot is available or timeout (handles capture still in flight).
   */
  async findSnapshots(mappedData, type) {
    const isOverview = type === "overview";
    const initialDelay = isOverview
      ? Math.max(0, this.config.delay_capture_overview || 0)
      : 0;

    if (initialDelay > 0) {
      await sleep(initialDelay);
    }

    const deadline = Date.now() + SNAP_MATCH_MAX_WAIT_MS;
    let attempts = 0;

    while (Date.now() <= deadline) {
      attempts++;
      const found = await this._findSnapshotOnce(mappedData, type);
      if (found) return found;
      if (Date.now() + SNAP_MATCH_POLL_MS > deadline) break;
      await sleep(SNAP_MATCH_POLL_MS);
    }

    const targetTime = dayjs(mappedData.stamp).format("HH:mm:ss.SSS");
    console.warn(`[Snapshot] Not found after ${attempts} attempts (${SNAP_MATCH_MAX_WAIT_MS}ms). Type: ${type}, Target: ${targetTime}, Lane: ${mappedData.lane}`);
    return null;
  }

  async _findSnapshotOnce(mappedData, type) {
    const lane = normalizeLane(mappedData.lane);
    const minMs = this.config.minimum_search || 2000;
    const maxMs = this.config.maximum_search || 8000;

    const fromMemory = snapshotRegistry.claimClosest(
      { ...mappedData, lane },
      type,
      minMs,
      maxMs
    );
    if (fromMemory) {
      // Use background delete to not block processing
      this._deleteSnapshotRow(fromMemory.imageUrl).catch(() => {});
      return fromMemory;
    }

    try {
      const targetStamp = dayjs(mappedData.stamp).format(
        "YYYY-MM-DD HH:mm:ss.SSS"
      );
      const minStamp = dayjs(mappedData.stamp)
        .subtract(minMs, "millisecond")
        .format("YYYY-MM-DD HH:mm:ss.SSS");
      const maxStamp = dayjs(mappedData.stamp)
        .add(maxMs, "millisecond")
        .format("YYYY-MM-DD HH:mm:ss.SSS");

      const [rows] = await this.pool.query(
        `SELECT stamp, image_url
         FROM snapshots
         WHERE lane = ? AND type = ?
         AND stamp BETWEEN ? AND ?
         ORDER BY ABS(TIMESTAMPDIFF(MICROSECOND, stamp, ?)) ASC
         LIMIT 5`,
        [lane, type, minStamp, maxStamp, targetStamp]
      );

      for (const row of rows) {
        if (
          snapshotRegistry.isUsed(lane, type, row.stamp, row.image_url)
        ) {
          continue;
        }
        snapshotRegistry.markUsed(lane, type, row.stamp, row.image_url);
        this._deleteSnapshotRow(row.image_url).catch(() => {});
        return {
          stamp: dayjs(row.stamp).toDate(),
          lane,
          type,
          imageUrl: row.image_url,
        };
      }

      return null;
    } catch (err) {
      console.error(
        `[Snapshot] DB Query error for lane ${lane}, type ${type}:`,
        err.message
      );
      return null;
    }
  }

  async _deleteSnapshotRow(imageUrl) {
    try {
      await this.pool.execute(`DELETE FROM snapshots WHERE image_url = ?`, [
        imageUrl,
      ]);
    } catch (err) {
      console.error("Error deleting used snapshot row:", err.message);
    }
  }

  async moveFile(src, dest) {
    try {
      if (!fs.existsSync(src)) {
        throw new Error(`Source file does not exist: ${src}`);
      }
      await fs.ensureDir(path.dirname(dest));
      await fs.move(src, dest, { overwrite: true });
      return { success: true, message: `File moved successfully`, dest };
    } catch (err) {
      return { success: false, message: `Error moving file: ${err.message}` };
    }
  }

  async uploadImage(filePath) {
    try {
      if (!fs.existsSync(filePath)) {
        throw new Error(`File does not exist: ${filePath}`);
      }

      const fileName = path.basename(filePath);
      const formData = new FormData();
      formData.append("image", fs.createReadStream(filePath));
      formData.append("fileName", fileName);

      // Increased timeout to 10s for midnight stability
      const response = await axios.post(this.uploadUrl, formData, {
        headers: {
          ...formData.getHeaders(),
        },
        timeout: 10000, 
      });

      if (response.data && response.data.fileUrl) {
        return { success: true, data: response.data };
      }
      throw new Error("Response does not contain fileUrl");
    } catch (err) {
      console.error(`[Upload] Failed for ${path.basename(filePath)}: ${err.message}`);
      return {
        success: false,
        message: `Error uploading image: ${err.message}`,
      };
    }
  }
}

module.exports = SnapshotManager;
