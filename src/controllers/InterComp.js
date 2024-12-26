const WSController = require("./WSController");
const { mapInterComp } = require("../utils");
const SnapshotManager = require("../utils/snapshotManager");
const ocrService = require("../utils/ocrService");
const dayjs = require("dayjs");

class InterComp extends WSController {
  constructor(dataWsUrl, triggerWsUrl, reconnectInterval, station) {
    super(dataWsUrl, triggerWsUrl, reconnectInterval);
    this.station = station;

    this.lprSnapshotManager = new SnapshotManager(10); // For LPR snapshots
    this.overviewSnapshotManager = new SnapshotManager(10); // For Overview snapshots
  }

  async handleDataMessage(message) {
    try {
      const rawData = JSON.parse(message);
      const mappedData = mapInterComp(rawData, this.station);
      console.log("Mapped InterComp Data:", mappedData);

      const lane = mappedData.lane;
      const minStamp = dayjs(mappedData.stamp).subtract(5, "minute").toDate();
      const maxStamp = dayjs(mappedData.stamp).add(5, "minute").toDate();

      const lprSnapshots = this.lprSnapshotManager.findSnapshots(lane, minStamp, maxStamp);
      if (lprSnapshots.length > 0) {
        await ocrService.sendToOCR(lprSnapshots, mappedData, "http://example.com/lpr-ocr");
      }
    } catch (err) {
      console.error("InterComp error handling data message:", err);
    }
  }

  async handleTriggerMessage(message) {
    // Handle trigger logic here
  }
}

module.exports = InterComp;
