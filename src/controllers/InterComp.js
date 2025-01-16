const WSController = require("./WSController");
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
} = require("../utils/mappers/mapInterComp");
const SnapshotManager = require("../utils/snapshotManager");
const ocrService = require("../utils/ocrService");
const dayjs = require("dayjs");

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

    this.lprSnapshotManager = new SnapshotManager(10); // For LPR snapshots
    this.overviewSnapshotManager = new SnapshotManager(10); // For Overview snapshots
  }

  async handleDataMessage(message) {
    try {
      const rawData = JSON.parse(message);
      const mappedData = mapInterComp(rawData, this.config);
      if (ignoreGVW(mappedData.gvw, this.config.gvw_ignored)) return;
      mappedData = classifyVehicle(mappedData, this.config);
      mappedData = setSingleTire(mappedData, this.singleTires);
      mappedData = setViolation(mappedData, this.vehicleClasses);
      mappedData = calculateESAL(mappedData, this.config, this.vehicleClasses);
      mappedData = isCrossingLaneWarning(mappedData);
      mappedData = mapWarningFlag(mappedData);
      mappedData = mapErrorFlag(mappedData);

      // Use Promise.all for concurrent snapshot fetching
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
              ? this.lprSnapshotManager.uploadImage(
                  lprSnapshots.imageUrl,
                  "lpr"
                )
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
    } catch (err) {
      console.error("DataLogger error handling data message:", err);
    }
  }

  async handleTriggerMessage(message) {
    // Handle trigger logic here
  }
}

module.exports = InterComp;
