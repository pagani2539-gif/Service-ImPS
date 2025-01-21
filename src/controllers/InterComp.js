const WSController = require("./WSController");
const { sendToWebSocket } = require("../services/wsService");
const {
  createAndSendLedDisplayImage,
} = require("../services/ledDisplayService");
const {
  mapInterComp,
  classifyVehicle,
  calculateESAL,
  setViolation,
  mapWarningFlag,
  mapErrorFlag,
  setSingleTire,
  isBusByLicensePlate,
  ignoreGVW,
  hasNonNumericCharacters,
  formatLicensePlate,
  isBusByWheelbase,
  isCrossingLaneWarning,
  convertDataTimeToMillisecond,
} = require("../utils/mappers/mapInterComp");
const SnapshotManager = require("../utils/snapshotManager");
const dayjs = require("dayjs");
const ocrService = require("../utils/ocrService");
const pool = require("../config/db");
const path = require("path");
const {
  insertVehicleWithDetails,
  updateOverview,
  updatePlates,
} = require("../services/vehiclesService");
const baseImagePath = path.join(process.cwd(), "public/snapshots");
const baseLedPath = path.join(process.cwd(), "public/leds");

class InterComp extends WSController {
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
    this.singleTires = singleTires;
    this.vehicleClasses = vehicleClasses;
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
  }
  async stop() {
    console.log(`Stopping Intercomp for station: ${this.config.station_name}`);
    // ปิด WebSocket connections และหยุด reconnect
    this.closeSockets();
    console.log("Intercomp stopped successfully.");
  }
  async findAndProcessSnapshots(mappedData) {
    const [lprSnapshots, overviewSnapshots] = await Promise.all([
      this.lprSnapshotManager.findSnapshots(mappedData, "lpr"),
      this.overviewSnapshotManager.findSnapshots(mappedData, "overview"),
    ]);

    if (lprSnapshots || overviewSnapshots) {
      // Concurrently send LPR snapshots to OCR, upload LPR image, and upload the overview image
      const [ocrResult, overviewUploadResult, lprUploadResult] =
        await Promise.all([
          lprSnapshots
            ? ocrService.sendToOCR(lprSnapshots, this.config.ocr_url)
            : Promise.resolve(null), // No OCR if no LPR snapshots
          overviewSnapshots
            ? this.overviewSnapshotManager.uploadImage(
                overviewSnapshots.imageUrl,
                "overview"
              )
            : Promise.resolve({ success: false }), // No upload if no overview snapshots
          lprSnapshots
            ? this.lprSnapshotManager.uploadImage(lprSnapshots.imageUrl, "lpr")
            : Promise.resolve({ success: false }), // No upload if no LPR snapshots
        ]);

      // Process OCR results and perform crop uploads if OCR is not null
      if (ocrResult) {
        if ([1, 2].includes(mappedData.vehicleClassID)) {
          // Check if the vehicle is a bus
          if (isBusByLicensePlate(ocrResult.license_plate)) {
            return; // Exit early if it's a bus
          }
          if (hasNonNumericCharacters(ocrResult.license_plate)) {
            return;
          }
        }

        const cropUploadResult = ocrResult.crop_path
          ? await this.cropSnapshotManager.uploadImage(
              ocrResult.crop_path,
              "crop"
            )
          : { success: false };

        // Update OCR data with uploaded file paths
        if (lprUploadResult.success) {
          ocrResult.plate_path = lprUploadResult.data.fileUrl;
        }
        if (cropUploadResult.success) {
          ocrResult.crop_path = cropUploadResult.data.fileUrl;
        }

        // Update mappedData with OCR results
        mappedData.platePath = ocrResult.plate_path;
        mappedData.licensePlate = formatLicensePlate(ocrResult.license_plate);
        mappedData.cropPath = ocrResult.crop_path;
        mappedData.province = ocrResult.province;
      } else {
        // Handle case where OCR result is null
        if ([1, 2].includes(mappedData.vehicleClassID)) {
          if (
            isBusByWheelbase(
              mappedData.axles[1].wheelbase,
              this.config.wheelbase_bus
            )
          ) {
            return;
          }
        }
        if (lprUploadResult.success) {
          mappedData.platePath = lprUploadResult.data.fileUrl;
        }
        console.warn("OCR result is null. LPR snapshot uploaded.");
      }

      // Update overview path if the upload was successful
      if (overviewUploadResult.success) {
        mappedData.overviewPath = overviewUploadResult.data.fileUrl;
      }
    } else {
      console.warn("No LPR or Overview snapshots found.");
    }

    return [lprSnapshots, overviewSnapshots];
  }
  async handleDataMessage(message) {
    try {
      const rawData = JSON.parse(message);
      let mappedData = mapInterComp(rawData, this.config);
      if (ignoreGVW(mappedData.gvw, this.config.gvw_ignored)) return;
      mappedData = classifyVehicle(mappedData, this.config);
      mappedData = setSingleTire(mappedData, this.singleTires);
      mappedData = setViolation(mappedData, this.vehicleClasses);
      mappedData = calculateESAL(mappedData, this.config, this.vehicleClasses);
      mappedData = isCrossingLaneWarning(mappedData);
      mappedData = mapWarningFlag(mappedData);
      mappedData = mapErrorFlag(mappedData);

      // Use Promise.all for concurrent snapshot fetching
      const [lprSnapshots, overviewSnapshots] =
        await this.findAndProcessSnapshots(mappedData);
      // Create and send LED display image
      // Determine condition image based on `is_overweight`
      const conditionImage = mappedData.is_overweight
        ? path.join(baseLedPath, "/layout/overweight.jpg")
        : path.join(baseLedPath, "/layout/passed.jpg");

      // Create and send LED display image
      if (overviewSnapshots) {
        createAndSendLedDisplayImage(
          overviewSnapshots.imageUrl,
          conditionImage, // Dynamic condition image
          mappedData.lane || 0, // Lane number
          this.config.led_url,
          path.join(baseLedPath, `output/output_${mappedData.lane}.jpeg`),
          this.config.led_enabled
        );
      }

      const vehicleID = await insertVehicleWithDetails(mappedData);
      console.log("Data saved successfully for Vehicle ID:", vehicleID);

      // Send data to WebSocket server
      sendToWebSocket({ vehicleID: vehicleID });
      if (!mappedData.overviewPath && !mappedData.platePath) {
        console.warn(
          "Retrying to find snapshots after 5 seconds...",
          vehicleID
        );
        await new Promise((resolve) => setTimeout(resolve, 5000));
        const [lprSnapshots, overviewSnapshots] =
          await this.findAndProcessSnapshots(mappedData);
        if (overviewSnapshots) {
          await updateOverview(vehicleID, mappedData.overviewPath);
        }
        if (lprSnapshots) {
          await updatePlates(
            vehicleID,
            mappedData.licensePlate,
            mappedData.platePath,
            mappedData.province,
            mappedData.cropPath
          );
        }
        sendToWebSocket({ vehicleID: vehicleID });
      }
    } catch (err) {
      console.error("DataLogger error handling data message:", err);
    }
  }

  async handleTriggerMessage(message) {
    try {
      const rawTriggerData = JSON.parse(message);
      // console.log("DataLogger received trigger message:", rawTriggerData);
      // const eventId = rawTriggerData["event-id"];
      const channelId = rawTriggerData.LaneNo;
      const rawTime = rawTriggerData.TriggerTime;

      // if (eventId != "force-event") return;
      if (!channelId || !rawTime) {
        console.warn("Missing ChanelId or Time in trigger message");
        return;
      }

      try {
        // Find the LPR snapshot URL for the given channelId
        const lprSnapshotConfig = this.config.capture_lpr.find(
          (item) => item.lane == channelId
        );

        // Find the Overview snapshot URL for the given channelId
        const overviewSnapshotConfig = this.config.capture_overview.find(
          (item) => item.lane == channelId
        );

        if (!lprSnapshotConfig || !overviewSnapshotConfig) {
          console.warn(
            `Snapshot configuration not found for lane ${channelId}`
          );
          return; // Exit if configuration is missing
        }

        const lprSnapshotUrl = lprSnapshotConfig.snap_code;
        const overviewSnapshotUrl = overviewSnapshotConfig.snap_code;

        // Metadata for snapshot
        const metadata = {
          stamp: dayjs(convertDataTimeToMillisecond(rawTime)),
          lane: channelId,
        };

        // Proceed with capturing snapshots
        this.lprSnapshotManager.takeSnapshot(lprSnapshotUrl, {
          ...metadata,
          type: "lpr",
        });

        this.overviewSnapshotManager.takeSnapshot(overviewSnapshotUrl, {
          ...metadata,
          type: "overview",
        });
      } catch (err) {
        console.error("Error processing trigger message:", err);
      }
    } catch (err) {
      console.error("DataLogger error handling trigger message:", err);
    }
  }
}

module.exports = InterComp;
