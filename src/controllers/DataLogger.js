const WSController = require("./WSController");
const { sendToWebSocket } = require("../services/wsService");
const {
  createAndSendLedDisplayImage,
} = require("../services/ledDisplayService");
const {
  mapDataLogger,
  classifyVehicle,
  calculateESAL,
  setViolation,
  mapWarningFlag,
  mapErrorFlag,
  setSingleTire,
  isBus,
  ignoreGVW,
  hasNonNumericCharacters,
} = require("../utils/mappers/mapDataLogger");
const SnapshotManager = require("../utils/snapshotManager");
const dayjs = require("dayjs");
const ocrService = require("../utils/ocrService");
const pool = require("../config/db");
const path = require("path");
const { insertVehicleWithDetails } = require("../services/vehiclesService");
const baseImagePath = path.join(process.cwd(), "public/snapshots");
class DataLogger extends WSController {
  constructor(
    dataWsUrl,
    triggerWsUrl,
    reconnectInterval,
    config,
    vehicleClasses,
    singleTires
  ) {
    super(dataWsUrl, triggerWsUrl, reconnectInterval);
    this.config = config;
    // Initialize SnapshotManager for LPR and Overview
    this.lprSnapshotManager = new SnapshotManager(
      pool,
      config,
      process.env.IMAGE_LPR_UPLOAD_URL,
      baseImagePath
    );
    this.cropSnapshotManager = new SnapshotManager(
      pool,
      config,
      process.env.IMAGE_CROP_UPLOAD_URL,
      baseImagePath
    );
    this.overviewSnapshotManager = new SnapshotManager(
      pool,
      config,
      process.env.IMAGE_OVERVIEW_UPLOAD_URL,
      baseImagePath
    );
    this.vehicleClasses = vehicleClasses;
    this.singleTires = singleTires;
  }

  async handleDataMessage(message) {
    try {
      const rawData = JSON.parse(message);
      let mappedData = mapDataLogger(rawData);
      if (ignoreGVW(mappedData.gvw, this.config.gvw_ignored)) return;
      mappedData = classifyVehicle(mappedData, this.config);
      mappedData = setSingleTire(mappedData, this.singleTires);
      mappedData = setViolation(mappedData, this.vehicleClasses);
      mappedData = calculateESAL(mappedData, this.config, this.vehicleClasses);
      mappedData = mapWarningFlag(mappedData);
      mappedData = mapErrorFlag(mappedData);

      // const lprSnapshots = await this.lprSnapshotManager.findSnapshots(mappedData, "lpr");
      // const overviewSnapshots = await this.overviewSnapshotManager.findSnapshots(mappedData, "overview");

      // Use Promise.all for concurrent snapshot fetching
      const [lprSnapshots, overviewSnapshots] = await Promise.all([
        this.lprSnapshotManager.findSnapshots(mappedData, "lpr"),
        this.overviewSnapshotManager.findSnapshots(mappedData, "overview"),
      ]);

      if (lprSnapshots) {
        const ocrResult = await ocrService.sendToOCR(
          lprSnapshots,
          this.config.ocr_url
        );

        if (ocrResult) {
          // Use Promise.all for concurrent image uploads
          const [plateUploadResult, cropUploadResult] = await Promise.all([
            ocrResult.plate_path
              ? this.lprSnapshotManager.uploadImage(ocrResult.plate_path, "lpr")
              : Promise.resolve({ success: false }),
            ocrResult.crop_path
              ? this.cropSnapshotManager.uploadImage(
                  ocrResult.crop_path,
                  "crop"
                )
              : Promise.resolve({ success: false }),
          ]);

          if (plateUploadResult.success) {
            ocrResult.plate_path = plateUploadResult.data.fileUrl; // Update with uploaded file path
          }
          if (cropUploadResult.success) {
            ocrResult.crop_path = cropUploadResult.data.fileUrl; // Update with uploaded file path
          }

          // Update mappedData with the modified ocrResult
          mappedData.platePath = ocrResult.plate_path;
          mappedData.licensePlate = ocrResult.license_plate;
          mappedData.cropPath = ocrResult.crop_path;
          mappedData.province = ocrResult.province;
        }
      }

      if (overviewSnapshots) {
        const overviewUploadResult =
          await this.overviewSnapshotManager.uploadImage(
            overviewSnapshots.imageUrl,
            "overview"
          );
        if (overviewUploadResult.success) {
          mappedData.overviewPath = overviewUploadResult.data.fileUrl; // Update with uploaded file path
        }
      } else {
        console.warn("No Overview snapshots found.");
      }

      // Proceed to save the data only after all uploads are confirmed
      // Check if the vehicle is a bus
      if (isBus(mappedData.licensePlate)) {
        return; // Exit early if it's a bus
      }
      if (hasNonNumericCharacters(mappedData.licensePlate)) {
        return;
      }

      const vehicleID = await insertVehicleWithDetails(mappedData);
      console.log("Data saved successfully for Vehicle ID:", vehicleID);

      // Send data to WebSocket server
      sendToWebSocket({ vehicleID: vehicleID });
      // Create and send LED display image
      // Determine condition image based on `is_overweight`
      const conditionImage = mappedData.is_overweight
        ? "../../public/leds/overweight.png"
        : "../../public/leds/passed.png";

      // Create and send LED display image
      if (mappedData.overviewPath) {
        await createAndSendLedDisplayImage(
          mappedData.overviewPath,
          conditionImage, // Dynamic condition image
          mappedData.lane || 1, // Lane number
          this.config.ledServerUrl,
          '../../public/leds/output/output.png'
        );
      }
    } catch (err) {
      console.error("DataLogger error handling data message:", err);
    }
  }

  async handleTriggerMessage(message) {
    try {
      const rawTriggerData = JSON.parse(message);
      //   console.log("DataLogger received trigger message:", rawTriggerData);
      const eventId = rawTriggerData["event-id"];
      const channelId = `TH${rawTriggerData.data.ChannelId}`;
      const rawTime = rawTriggerData.data.Time;

      if (eventId === "presence-event") return;
      if (!channelId || !rawTime) {
        console.warn("Missing ChanelId or Time in trigger message");
        return;
      }

      if (rawTriggerData.data.TriggerType === "Start") {
        try {
          // Find the LPR snapshot URL for the given channelId
          const lprSnapshotConfig = this.config.capture_lpr.find(
            (item) => item.lane === channelId
          );

          // Find the Overview snapshot URL for the given channelId
          const overviewSnapshotConfig = this.config.capture_overview.find(
            (item) => item.lane === channelId
          );

          if (!lprSnapshotConfig || !overviewSnapshotConfig) {
            console.warn(
              `Snapshot configuration not found for lane ${channelId}`
            );
            return; // Exit if configuration is missing
          }

          const lprSnapshotUrl = lprSnapshotConfig.snapCode;
          const overviewSnapshotUrl = overviewSnapshotConfig.snapCode;

          // Metadata for snapshot
          const metadata = {
            stamp: dayjs(rawTime),
            lane: channelId,
          };

          // Proceed with capturing snapshots
          await this.lprSnapshotManager.takeSnapshot(lprSnapshotUrl, {
            ...metadata,
            type: "lpr",
          });

          await this.overviewSnapshotManager.takeSnapshot(overviewSnapshotUrl, {
            ...metadata,
            type: "overview",
          });
        } catch (err) {
          console.error("Error processing trigger message:", err);
        }
      }
    } catch (err) {
      console.error("DataLogger error handling trigger message:", err);
    }
  }
}

module.exports = DataLogger;
