const axios = require("axios");
const fs = require("fs-extra");
const path = require("path");
const dayjs = require("dayjs");
const FormData = require("form-data"); // Import form-data

class SnapshotManager {
  constructor(pool, config, uploadUrl, baseImagePath) {
    this.pool = pool; // Use the shared database pool
    this.baseImagePath = baseImagePath; // Base path to save images
    this.config = config; // Configuration
    this.uploadUrl = uploadUrl; // Upload URL (passed or from environment variable)
  }

  /**
   * Takes a snapshot, saves it locally, and stores the image URL in the database.
   * @param {string} url - The snapshot URL.
   * @param {object} metadata - Metadata including `lane`, `type`, and `stamp`.
   */
  async takeSnapshot(url, metadata) {
    const { lane, type, stamp } = metadata;
  
    try {
      const response = await axios.get(url, {
        responseType: "arraybuffer",
        timeout: 3000,
      });
  
      if (response.status === 200) {
        // Extract year, month, and day from the timestamp
        const date = dayjs(stamp);
        const year = date.format("YYYY");
        const month = date.format("MM");
        const day = date.format("DD");
  
        // Format timestamp and construct filename
        const timestamp = date.format("YYYY_MM_DD_HH_mm_ss");
        const filename = `${type}_${lane}_${timestamp}.jpg`;
  
        // Construct file path with year/month/day structure
        const dirPath = path.join(this.baseImagePath, year, month, day, lane);
        const filePath = path.join(dirPath, filename);
  
        // Check if the directory exists, and create it if necessary
        if (!fs.existsSync(dirPath)) {
          fs.mkdirSync(dirPath, { recursive: true });
        }
  
        // Save the image to the file system
        fs.writeFile(filePath, response.data, (err) => {
          if (err) {
            console.error(`Error writing file: ${err.message}`);
            return;
          }
  
          console.log(`File written to ${filePath}`);
  
          // Construct the image URL
          const imageUrl = filePath;
  
          // Save snapshot to the database
          this.pool.execute(
            `INSERT INTO snapshots (lane, type, stamp, image_url) VALUES (?, ?, ?, ?)`,
            [lane, type, new Date(stamp), imageUrl]
          );
  
          console.log(`Snapshot saved to database with URL: ${imageUrl}`);
        });
      } else {
        throw new Error(`Failed to fetch snapshot: ${response.status}`);
      }
    } catch (err) {
      console.error(`Error taking snapshot for lane ${lane}, type ${type}:`, err);
    }
  }
    

  /**
   * Finds snapshots within a given time range for a specific lane.
   * @param {object} mappedData - The mapped data containing lane and timestamp.
   * @param {string} type - The snapshot type.
   * @returns {object|null} - The first matching snapshot or null if none found.
   */
  async findSnapshots(mappedData, type) {
    try {
      // Introduce delay before executing the query
      if (this.config.delay_capture_overview > 0) {
        await new Promise((resolve) => setTimeout(resolve, this.config.delay_capture_overview));
      }

      const lane = mappedData.lane;
      const minStamp = dayjs(mappedData.stamp)
        .subtract(this.config.minimum_search, "millisecond")
        .format("YYYY-MM-DD HH:mm:ss.SSS");
      const maxStamp = dayjs(mappedData.stamp)
        .add(this.config.maximum_search, "millisecond")
        .format("YYYY-MM-DD HH:mm:ss.SSS");

      //   console.log("Querying snapshots with:", { lane, type, minStamp, maxStamp });

      const [rows] = await this.pool.query(
        `SELECT stamp, image_url 
         FROM snapshots 
         WHERE lane = ? AND type = ? 
         AND stamp BETWEEN ? AND ? 
         ORDER BY stamp ASC LIMIT 1`,
        [lane, type, minStamp, maxStamp]
      );

      if (rows.length > 0) {
        const row = rows[0];
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
        `Error finding snapshots for lane ${lane}, type ${type}:`,
        err
      );
      return null;
    }
  }

  /**
   * Moves a file from the source to the destination path.
   * @param {string} src - The source file path.
   * @param {string} dest - The destination file path.
   */
  async moveFile(src, dest) {
    try {
      if (!fs.existsSync(src)) {
        throw new Error(`Source file does not exist: ${src}`);
      }

      // Ensure the destination directory exists
      await fs.ensureDir(path.dirname(dest));

      // Move the file
      await fs.move(src, dest, { overwrite: true });

      //   console.log(`File moved from ${src} to ${dest}`);
      return { success: true, message: `File moved successfully`, dest };
    } catch (err) {
      //   console.error(`Error moving file from ${src} to ${dest}:`, err);
      return { success: false, message: `Error moving file: ${err.message}` }; // Return failure message
    }
  }

  /**
   * Uploads an image to a remote server.
   * @param {string} filePath - The local file path of the image to upload.
   * @param {string} folderType - The folder type (e.g., 'overview', 'lpr', 'crop').
   * @returns {object} - Response from the server or an error message.
   */
  async uploadImage(filePath) {
    try {
      // Check if the file exists
      if (!fs.existsSync(filePath)) {
        throw new Error(`File does not exist: ${filePath}`);
      }

      const fileName = path.basename(filePath);

      // Prepare the form data
      const formData = new FormData();
      formData.append("image", fs.createReadStream(filePath));
      formData.append("fileName", fileName);

      // Log the upload attempt for debugging
      console.log(`Uploading file: ${filePath} to ${this.uploadUrl}`);

      // Upload the image to the remote server
      const response = await axios.post(this.uploadUrl, formData, {
        headers: {
          ...formData.getHeaders(),
        },
        timeout: 5000, // Adjusted timeout for better handling
      });

      // Ensure the response contains the expected fileUrl
      if (response.data && response.data.fileUrl) {
        console.log(`File uploaded successfully: ${response.data.fileUrl}`);
        return { success: true, data: response.data };
      } else {
        throw new Error("Response does not contain fileUrl");
      }
    } catch (err) {
      // Log the error for debugging
      console.error(`Error uploading image: ${err.message}`);
      return {
        success: false,
        message: `Error uploading image: ${err.message}`,
      };
    }
  }
}

module.exports = SnapshotManager;
