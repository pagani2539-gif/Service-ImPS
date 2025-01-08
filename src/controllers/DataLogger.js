const WebSocket = require("ws");
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
const baseLedPath = path.join(process.cwd(), "public/leds");

class DataLogger {
  constructor(dataWsUrl, triggerWsUrl, config, vehicleClasses, singleTires) {
    this.dataWsUrl = dataWsUrl;
    this.triggerWsUrl = triggerWsUrl;
    this.config = config;
    this.vehicleClasses = vehicleClasses;
    this.singleTires = singleTires;

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

    // Initialize WebSocket clients
    this.initWebSocketClients();
  }

  initWebSocketClients() {
    // WebSocket for data messages
    this.dataWebSocket = new WebSocket(this.dataWsUrl);
    this.dataWebSocket.on("open", () => {
      console.log("Data WebSocket connection opened");
    });
    this.dataWebSocket.on("message", (message) =>
      this.handleDataMessage(message)
    );
    this.dataWebSocket.on("error", (error) => {
      console.error("Data WebSocket error:", error);
    });
    this.dataWebSocket.on("close", () => {
      console.log("Data WebSocket connection closed");
    });

    // WebSocket for trigger messages
    this.triggerWebSocket = new WebSocket(this.triggerWsUrl);
    this.triggerWebSocket.on("open", () => {
      console.log("Trigger WebSocket connection opened");
    });
    this.triggerWebSocket.on("message", (message) =>
      this.handleTriggerMessage(message)
    );
    this.triggerWebSocket.on("error", (error) => {
      console.error("Trigger WebSocket error:", error);
    });
    this.triggerWebSocket.on("close", () => {
      console.log("Trigger WebSocket connection closed");
    });
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

      const [lprSnapshots, overviewSnapshots] = await Promise.all([
        this.lprSnapshotManager.findSnapshots(mappedData, "lpr"),
        this.overviewSnapshotManager.findSnapshots(mappedData, "overview"),
      ]);

      if (lprSnapshots || overviewSnapshots) {
        const [ocrResult, overviewUploadResult, lprUploadResult] = await Promise.all([
          lprSnapshots
            ? ocrService.sendToOCR(lprSnapshots, this.config.ocr_url)
            : Promise.resolve(null),
          overviewSnapshots
            ? this.overviewSnapshotManager.uploadImage(
                overviewSnapshots.imageUrl,
                "overview"
              )
            : Promise.resolve({ success: false }),
          lprSnapshots
            ? this.lprSnapshotManager.uploadImage(lprSnapshots.imageUrl, "lpr")
            : Promise.resolve({ success: false }),
        ]);

        if (ocrResult) {
          const cropUploadResult = ocrResult.crop_path
            ? await this.cropSnapshotManager.uploadImage(ocrResult.crop_path, "crop")
            : { success: false };

          if (lprUploadResult.success) {
            ocrResult.plate_path = lprUploadResult.data.fileUrl;
          }
          if (cropUploadResult.success) {
            ocrResult.crop_path = cropUploadResult.data.fileUrl;
          }

          mappedData.platePath = ocrResult.plate_path;
          mappedData.licensePlate = ocrResult.license_plate;
          mappedData.cropPath = ocrResult.crop_path;
          mappedData.province = ocrResult.province;
        } else {
          if (lprUploadResult.success) {
            mappedData.platePath = lprUploadResult.data.fileUrl;
          }
          console.warn("OCR result is null. LPR snapshot uploaded.");
        }

        if (overviewUploadResult.success) {
          mappedData.overviewPath = overviewUploadResult.data.fileUrl;
        }
      } else {
        console.warn("No LPR or Overview snapshots found.");
      }

      if (isBus(mappedData.licensePlate) || hasNonNumericCharacters(mappedData.licensePlate)) {
        return;
      }

      const vehicleID = await insertVehicleWithDetails(mappedData);
      console.log("Data saved successfully for Vehicle ID:", vehicleID);

      sendToWebSocket({ vehicleID: vehicleID });

      const conditionImage = mappedData.is_overweight
        ? path.join(baseLedPath, "/layout/overweight.jpg")
        : path.join(baseLedPath, "/layout/passed.jpg");

      if (overviewSnapshots) {
        await createAndSendLedDisplayImage(
          overviewSnapshots.imageUrl,
          conditionImage,
          mappedData.lane || 1,
          this.config.led_url,
          path.join(baseLedPath, `output/output_${mappedData.lane}.jpeg`),
          this.config.led_enabled
        );
      }
    } catch (err) {
      console.error("DataLogger error handling data message:", err);
    }
  }

  async handleTriggerMessage(message) {
    try {
      console.log('Received trigger message', dayjs().format('HH:mm:ss.SSSZ'));
      const rawTriggerData = JSON.parse(message);
      const eventId = rawTriggerData["event-id"];
      const channelId = `TH${rawTriggerData.data.ChannelId}`;
      const rawTime = rawTriggerData.data.Time;

      if (eventId !== "force-event") return;

      console.log(eventId, rawTime, dayjs().format('HH:mm:ss.SSSZ'));
      if (!channelId || !rawTime) {
        console.warn("Missing ChannelId or Time in trigger message");
        return;
      }

      if (rawTriggerData.data.TriggerType === "Start") {
        const lprSnapshotConfig = this.config.capture_lpr.find(
          (item) => item.lane === channelId
        );

        const overviewSnapshotConfig = this.config.capture_overview.find(
          (item) => item.lane === channelId
        );

        if (!lprSnapshotConfig || !overviewSnapshotConfig) {
          console.warn(`Snapshot configuration not found for lane ${channelId}`);
          return;
        }

        const lprSnapshotUrl = lprSnapshotConfig.snapCode;
        const overviewSnapshotUrl = overviewSnapshotConfig.snapCode;

        const metadata = {
          stamp: dayjs(rawTime),
          lane: channelId,
        };

        this.lprSnapshotManager.takeSnapshot(lprSnapshotUrl, {
          ...metadata,
          type: "lpr",
        });

        this.overviewSnapshotManager.takeSnapshot(overviewSnapshotUrl, {
          ...metadata,
          type: "overview",
        });
      }
    } catch (err) {
      console.error("DataLogger error handling trigger message:", err);
    }
  }
}

module.exports = DataLogger;
