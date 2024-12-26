const axios = require("axios");

class SnapshotManager {
  constructor(maxSize = 10) {
    this.snapshots = []; // Array to hold snapshots
    this.maxSize = maxSize;
  }

  /**
   * Takes a snapshot using a URL and stores it in memory.
   * @param {string} url - The URL to fetch the snapshot from.
   * @param {object} metadata - Metadata including `stamp` and `lane`.
   * @returns {Promise<void>}
   */
  async takeSnapshot(url, metadata) {
    try {
      const response = await axios.get(url, { responseType: "arraybuffer" });

      if (response.status === 200) {
        const snapshot = {
          stamp: metadata.stamp,
          lane: metadata.lane,
          image: Buffer.from(response.data), // Store image as a Buffer
        };

        // Add snapshot to memory
        if (this.snapshots.length >= this.maxSize) {
          this.snapshots.shift(); // Remove the oldest entry if max size is reached
        }
        this.snapshots.push(snapshot);

        console.log("Snapshot added to memory:", snapshot);
      } else {
        throw new Error(`Failed to fetch snapshot: ${response.status}`);
      }
    } catch (err) {
      console.error("Error taking snapshot:", err);
    }
  }

  /**
   * Retrieves the current snapshots in memory.
   * @returns {Array} - Array of snapshots.
   */
  getSnapshots() {
    return this.snapshots;
  }
}

module.exports = SnapshotManager;
