// src\utils\snapshotManager.js
const axios = require("axios");
const fs = require("fs-extra");
const path = require("path");
const dayjs = require("dayjs");
const FormData = require("form-data");
const logger = require("./logger");
const perf = require("./perfMonitor");
const { snapshotRegistry, normalizeLane } = require("./snapshotRegistry");

// ค่าดีฟอลต์หากไม่ได้ระบุใน env หรือฐานข้อมูล
const DEFAULT_SNAP_MATCH_DB_POLL_MS = 1000;
const DEFAULT_SNAP_MATCH_MAX_WAIT_MS = 3000;

// burst: ถ่ายกล้อง LPR หลายเฟรม/คัน (เฟรมแรกอ่านไม่ออก → ใช้เฟรมที่สอง) — overview ถ่ายใบเดียวเสมอ
const LPR_BURST_FRAMES = Math.max(1, Number(process.env.LPR_BURST_FRAMES) || 2);
// ระยะห่างระหว่างเฟรม (ms); 0 = ยิงติดกัน (ห่างแค่ ~1 round-trip → ป้ายขยับน้อยสุด กันหลุดเฟรม)
const LPR_BURST_GAP_MS = Math.max(0, Number(process.env.LPR_BURST_GAP_MS) || 0);

// แตก snapshot ที่ claim มา (อาจมีหลายเฟรม/burst) เป็น candidate หลายใบให้ ocrService เลือกใบที่อ่านออก
function expandFrames(snap) {
  if (!snap) return [];
  if (Array.isArray(snap.frames) && snap.frames.length) {
    return snap.frames.map((f) => ({
      stamp: snap.stamp,
      lane: snap.lane,
      type: snap.type,
      imageUrl: f.imageUrl,
      buffer: f.buffer,
    }));
  }
  return [snap]; // ไม่มี frames (DB recovery / entry เก่า) = ใบเดียว
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// โฟลเดอร์ปลายทางเปลี่ยนแค่วันละครั้งต่อ lane/type — cache ไว้ ไม่ต้อง stat ทุกรูป
const ensuredDirs = new Set();
async function ensureDirCached(dir) {
  if (ensuredDirs.has(dir)) return;
  await fs.ensureDir(dir);
  if (ensuredDirs.size > 256) ensuredDirs.clear();
  ensuredDirs.add(dir);
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
      const date = dayjs(stamp);
      const year = date.format("YYYY");
      const month = date.format("MM");
      const day = date.format("DD");
      const timestamp = date.format("YYYY_MM_DD_HH_mm_ss_SSS");
      const dir = path.join(this.baseImagePath, type, year, month, day, `lane${lane}`);
      await ensureDirCached(dir);
      const stampDate = date.toDate();

      // LPR ถ่าย burst (default 2 เฟรม); overview ถ่ายใบเดียว
      const wantFrames = type === "lpr" ? LPR_BURST_FRAMES : 1;

      const frames = [];
      for (let i = 0; i < wantFrames; i++) {
        if (i > 0 && LPR_BURST_GAP_MS > 0) await sleep(LPR_BURST_GAP_MS);
        try {
          const response = await axios.get(url, { responseType: "arraybuffer", timeout: 3000 });
          if (response.status !== 200) throw new Error(`status ${response.status}`);
          // เฟรมแรกใช้ชื่อเดิม (DB recovery จำได้); เฟรมถัดไปต่อท้าย _f2,_f3 กันชื่อชน
          const filename = i === 0
            ? `${type}_${lane}_${timestamp}.jpg`
            : `${type}_${lane}_${timestamp}_f${i + 1}.jpg`;
          const filePath = path.join(dir, filename);
          await fs.writeFile(filePath, response.data);
          frames.push({ imageUrl: filePath, buffer: response.data, stamp: stampDate });
        } catch (e) {
          if (i === 0) throw e; // เฟรมแรกถ่ายไม่ได้ = ถือว่าถ่ายไม่สำเร็จ
          // เฟรมถัดไปพลาด = ข้าม (ยังมีเฟรมแรกใช้ได้ ไม่ทำให้คันนี้หลุด)
          logger.warn(`[Snapshot] burst frame ${i + 1} failed (lane ${lane}): ${e.message}`);
          break;
        }
      }

      // diagnostic: 2 เฟรมซ้ำกันไหม (กล้องคืนเฟรมเดิม) — เทียบยาวก่อน เท่ากันค่อย equals
      if (frames.length >= 2) {
        perf.count("lpr_burst_captured");
        const a = frames[0].buffer, b = frames[1].buffer;
        if (Buffer.isBuffer(a) && Buffer.isBuffer(b) && a.length === b.length && a.equals(b)) {
          perf.count("burst_frames_identical");
        }
      }

      const first = frames[0];
      // Register in memory FIRST to ensure it's claimable immediately (มัดทุกเฟรมเป็นชุดเดียว/คัน)
      snapshotRegistry.register({
        lane,
        type,
        stamp: stampDate,
        imageUrl: first.imageUrl,
        buffer: first.buffer,
        frames,
      });

      // บันทึกลง DB แบบไม่บล็อก (เฟรมแรกพอ) — memory คือแหล่งหลัก แถว DB ใช้เฉพาะกู้รูปหลัง restart
      this.pool
        .execute(
          `INSERT INTO snapshots (lane, type, stamp, image_url) VALUES (?, ?, ?, ?)`,
          [lane, type, stampDate, first.imageUrl]
        )
        .catch((dbErr) => {
          logger.error(`[Snapshot] DB Insert failed for ${path.basename(first.imageUrl)}: ${dbErr.message}`);
        });

      return { lane, type, stamp: stampDate, imageUrl: first.imageUrl, buffer: first.buffer, frames };
    } catch (err) {
      logger.error(`Error taking snapshot for lane ${lane}, type ${type}: ${err.message}`);
      return null;
    }
  }

  /**
   * Wait until a snapshot is available or timeout (handles capture still in flight).
   * เช็ค memory แบบ event-driven (ตื่นทันทีเมื่อมีรูปใหม่ถูก register)
   * เช็ค DB เฉพาะรอบแรก + ทุก SNAP_MATCH_DB_POLL_MS — แถวใน DB ที่โปรเซสนี้เพิ่ง insert
   * อยู่ใน memory อยู่แล้วเสมอ DB จึงมีประโยชน์เฉพาะกู้รูปที่ค้างจากก่อน restart
   */
  async findSnapshots(mappedData, type, quiet = false) {
    const isOverview = type === "overview";
    const initialDelay = isOverview
      ? Math.max(0, this.config.delay_capture_overview || 0)
      : 0;

    if (initialDelay > 0) {
      await sleep(initialDelay);
    }

    const maxWaitMs = Number(process.env.SNAP_MATCH_MAX_WAIT_MS) || this.config.snap_match_max_wait_ms || DEFAULT_SNAP_MATCH_MAX_WAIT_MS;
    const dbPollMs = Number(process.env.SNAP_MATCH_DB_POLL_MS) || this.config.snap_match_db_poll_ms || DEFAULT_SNAP_MATCH_DB_POLL_MS;

    const deadline = Date.now() + maxWaitMs;
    const lanes = (mappedData.isStraddlingMerged && Array.isArray(mappedData.originalLanes))
      ? mappedData.originalLanes.map(normalizeLane)
      : [normalizeLane(mappedData.lane)];
    let attempts = 0;
    let lastDbCheck = 0;

    while (Date.now() <= deadline) {
      attempts++;
      const now = Date.now();
      const checkDb = lastDbCheck === 0 || now - lastDbCheck >= dbPollMs;
      if (checkDb) lastDbCheck = now;

      // Search across all possible lanes
      for (const currentLane of lanes) {
        const found = await this._findSnapshotOnce({ ...mappedData, lane: currentLane }, type, { checkDb });
        if (found) {
          const offsetMs = dayjs(found.stamp).valueOf() - dayjs(mappedData.stamp).valueOf();
          if (!quiet) logger.info(`[Snapshot] Found ${type} (ID: ${mappedData.id}, lane ${currentLane}, offset ${offsetMs >= 0 ? "+" : ""}${offsetMs}ms, attempts ${attempts})`);
          return found;
        }
      }

      const remaining = deadline - Date.now();
      if (remaining <= 0) break;

      // Wait for register on any of the lanes
      if (lanes.length > 1) {
        await Promise.race(
          lanes.map((currentLane) =>
            snapshotRegistry.waitForRegister(
              currentLane,
              type,
              Math.min(remaining, dbPollMs)
            )
          )
        );
      } else {
        await snapshotRegistry.waitForRegister(
          lanes[0],
          type,
          Math.min(remaining, dbPollMs)
        );
      }
    }

    const targetTime = dayjs(mappedData.stamp).format("HH:mm:ss.SSS");
    const searchedLanes = lanes.join(",");
    logger.warn(`[Snapshot] Not found after ${attempts} attempts (${maxWaitMs}ms). Type: ${type}, Target: ${targetTime}, Lane: ${searchedLanes}`);
    return null;
  }

  /**
   * คืน "ภาพผู้สมัคร" สำหรับ OCR เลือกใบที่ดีที่สุด
   * - รถคร่อมเลน (isStraddlingMerged) → claim ภาพที่ใกล้สุด "ของแต่ละเลน" ใน originalLanes (คนละใบ)
   *   → ได้ ≥2 ใบให้ ocrService เลือกใบที่อ่านออก/คมสุด (ใช้ภาพที่มีอยู่แล้ว ไม่ถ่ายเพิ่ม)
   * - รถปกติ → array ใบเดียว (พฤติกรรมเท่าเดิม)
   * เรียงตามลำดับ originalLanes → index 0 = เลนแรก (ใช้เป็น tie-break ค่าเริ่มต้น)
   */
  async findSnapshotCandidates(mappedData, type, quiet = false) {
    const isStraddle =
      mappedData.isStraddlingMerged &&
      Array.isArray(mappedData.originalLanes) &&
      mappedData.originalLanes.length > 1;

    if (!isStraddle) {
      const one = await this.findSnapshots(mappedData, type, quiet);
      return expandFrames(one); // burst: 1 entry อาจมีหลายเฟรม → แตกเป็นหลาย candidate
    }

    // หาภาพของแต่ละเลนแบบ independent (ค้นทีละเลน ไม่ให้ findSnapshots วนรวมเลนแล้วคืนใบเดียว)
    const lanes = [...new Set(mappedData.originalLanes.map(normalizeLane))];
    const results = await Promise.all(
      lanes.map((lane) =>
        this.findSnapshots(
          { ...mappedData, isStraddlingMerged: false, originalLanes: undefined, lane },
          type,
          quiet
        )
      )
    );
    // (เลน × เฟรม) — รถคร่อมเลน + burst รวมทุกใบให้เลือก
    return results.flatMap(expandFrames);
  }

  async _findSnapshotOnce(mappedData, type, { checkDb = true } = {}) {
    const lane = normalizeLane(mappedData.lane);
    // ช่วงเวลาจับคู่รูป↔รถ — override ได้ด้วย env โดยไม่ต้องแก้ค่าใน DB (minimum_search/maximum_search)
    // forward (maxMs) กว้างไป = รถคันหนึ่งคว้ารูปของคันถัดไป → ภาพคนละคัน/ภาพท้ายรถ
    const minMs = Number(process.env.SNAP_MATCH_BACK_MS) || this.config.minimum_search || 2000;
    const maxMs = Number(process.env.SNAP_MATCH_FWD_MS) || this.config.maximum_search || 8000;

    const fromMemory = snapshotRegistry.claimClosest(
      { ...mappedData, lane },
      type,
      minMs,
      maxMs
    );
    if (fromMemory) {
      // วัด offset (รูป − รถ, ms) ไว้จูน window: ดู p95/max ของ snap_offset_*_ms ใน [Metrics]
      // แล้วตั้ง SNAP_MATCH_FWD_MS ให้พอครอบ p95 ก็พอ (แคบสุดที่ยังจับคู่ถูก)
      perf.observe(`snap_offset_${type}_ms`, dayjs(fromMemory.stamp).valueOf() - dayjs(mappedData.stamp).valueOf());
      // Use background delete to not block processing
      this._deleteSnapshotRow(fromMemory.imageUrl).catch(() => {});
      return fromMemory;
    }

    if (!checkDb) return null;

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
      logger.error(`[Snapshot] DB Query error for lane ${lane}, type ${type}: ${err.message}`);
      return null;
    }
  }

  async _deleteSnapshotRow(imageUrl) {
    try {
      await this.pool.execute(`DELETE FROM snapshots WHERE image_url = ?`, [
        imageUrl,
      ]);
    } catch (err) {
      logger.error(`Error deleting used snapshot row: ${err.message}`);
    }
  }

  async uploadImage(filePath, type = null, buffer = null, quiet = false) {
    try {
      const fileName = path.basename(filePath);
      const formData = new FormData();
      if (buffer) {
        formData.append("image", buffer, { filename: fileName, contentType: "image/jpeg" });
      } else {
        if (!(await fs.pathExists(filePath))) {
          throw new Error(`File does not exist: ${filePath}`);
        }
        formData.append("image", fs.createReadStream(filePath));
      }
      formData.append("fileName", fileName);

      // Increased timeout to 10s for midnight stability
      const response = await axios.post(this.uploadUrl, formData, {
        headers: {
          ...formData.getHeaders(),
        },
        timeout: 10000, 
      });

      if (response.data && response.data.fileUrl) {
        if (!quiet) logger.info(`[Upload] OK ${type || "image"} (${fileName})`);
        return { success: true, data: response.data };
      }
      throw new Error("Response does not contain fileUrl");
    } catch (err) {
      logger.error(`[Upload] Failed for ${path.basename(filePath)}: ${err.message}`);
      return {
        success: false,
        message: `Error uploading image: ${err.message}`,
      };
    }
  }
}

module.exports = SnapshotManager;
