const WSController = require("./WSController");
const { sendToWebSocket } = require("../services/wsService");
const { sendToVMS } = require("../services/ledDisplayService");
const {sendToTransmission} = require("../services/transmissionService");
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
  isVehicleExcludedByPlate,
  formatLicensePlate,
  isBusByWheelbase,
  isCrossingLaneWarning,
  convertDataTimeToMillisecond,
  isIgnoredLength,
} = require("../utils/mappers/mapInterComp");
const SnapshotManager = require("../utils/snapshotManager");
const { normalizeLane } = require("../utils/snapshotRegistry");
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
const threeDimensionBase = process.env.THREE_DIMENSION_BASE || '';
const PICO_BASE = process.env.PICO_BASE || '';
const { getSingleDualTire } = require('../services/picoService');
const transmissionUrl = process.env.TRANSMISSION_URL || '';

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
  async findAndProcessSnapshots(mappedData, existingLpr = null, existingOverview = null) {
    // 1. เริ่มค้นหาเฉพาะส่วนที่ยังไม่มีข้อมูล (รองรับการ Retry)
    // Smart Retry: ถ้ามี snapshot เดิมที่เคยหาเจอแล้วแต่ upload พลาด ให้ใช้ใบเดิม
    const lprSearchPromise = !mappedData.platePath 
      ? (existingLpr ? Promise.resolve(existingLpr) : this.lprSnapshotManager.findSnapshots(mappedData, "lpr"))
      : Promise.resolve(null);
      
    const overviewSearchPromise = !mappedData.overviewPath
      ? (existingOverview ? Promise.resolve(existingOverview) : this.overviewSnapshotManager.findSnapshots(mappedData, "overview"))
      : Promise.resolve(null);

    let lprSnapshotsFound = existingLpr;
    let overviewSnapshotsFound = existingOverview;

    // 2. จัดการส่วน LPR ทันทีที่ค้นหาเสร็จ
    const lprProcessPromise = lprSearchPromise.then(async (lprSnapshots) => {
      if (!lprSnapshots) return null;
      lprSnapshotsFound = lprSnapshots;

      const [ocrResult, lprUploadResult] = await Promise.all([
        ocrService.sendToOCR(lprSnapshots, this.config.ocr_url),
        this.lprSnapshotManager.uploadImage(lprSnapshots.imageUrl, "lpr")
      ]);

      if (ocrResult) {
        if (isVehicleExcludedByPlate(ocrResult.license_plate)) {
          return { exclude: true };
        }

        const cropUploadResult = ocrResult.crop_path
          ? await this.cropSnapshotManager.uploadImage(ocrResult.crop_path, "crop")
          : { success: false };

        if (lprUploadResult.success) mappedData.platePath = lprUploadResult.data.fileUrl;
        if (cropUploadResult.success) mappedData.cropPath = cropUploadResult.data.fileUrl;
        
        mappedData.licensePlate = formatLicensePlate(ocrResult.license_plate);
        mappedData.province = ocrResult.province;
      } else {
        // กรณีอ่าน OCR ไม่ได้ (การคัดกรองรถบัสด้วยฐานล้อถูกทำไปแล้วที่ handleDataMessage)
        if (lprUploadResult.success) mappedData.platePath = lprUploadResult.data.fileUrl;
      }
      return { exclude: false, snapshots: lprSnapshots };
    });

    // 3. จัดการส่วน Overview ทันทีที่ค้นหาเสร็จ
    const overviewProcessPromise = overviewSearchPromise.then(async (overviewSnapshots) => {
      if (!overviewSnapshots) return null;
      overviewSnapshotsFound = overviewSnapshots;
      const uploadResult = await this.overviewSnapshotManager.uploadImage(overviewSnapshots.imageUrl, "overview");
      if (uploadResult.success) {
        mappedData.overviewPath = uploadResult.data.fileUrl;
      }
      return overviewSnapshots;
    });

    const [lprRes, overviewRes] = await Promise.all([lprProcessPromise, overviewProcessPromise]);

    if (lprRes && lprRes.exclude) {
      return { continueProcessing: false, isExcluded: true };
    }

    return { 
        continueProcessing: true, 
        isExcluded: false,
        lprSnapshots: lprSnapshotsFound,
        overviewSnapshots: overviewSnapshotsFound
    };
  }

  async handleDataMessage(message) {
    try {
      const rawData = JSON.parse(message);
      const { TimeStamp_Start:StartTime, TimeStamp_End:StartTimeLastPresenceFall, id:ID } = rawData
      let mappedData = mapInterComp(rawData, this.config);
      if (ignoreGVW(mappedData.gvw, this.config.gvw_ignored)) return;
      mappedData = classifyVehicle(mappedData, this.config);
      mappedData = setSingleTire(mappedData, this.singleTires);
      mappedData = setViolation(mappedData, this.vehicleClasses);
      mappedData = calculateESAL(mappedData, this.config, this.vehicleClasses);
      mappedData = isCrossingLaneWarning(mappedData);
      mappedData = mapWarningFlag(mappedData);
      mappedData = mapErrorFlag(mappedData);
      let singleDualTire = null;
      if (PICO_BASE && mappedData.lane === 1) {
        try {
          singleDualTire = getSingleDualTire(PICO_BASE, StartTime, StartTimeLastPresenceFall, ID);
        } catch (err) { console.error("Error processing singleDualTire:", err); }
      }

      if ([1, 2].includes(mappedData.vehicleClassID)) {
        if(isIgnoredLength(mappedData.axles[1].wheelbase,this.config.vehicle_length_ignored)){
          return ;
        }
        // คัดรถบัสด้วยฐานล้อทันที (ก่อนไปหารูป)
        if (mappedData.vehicleClassID === 2 && isBusByWheelbase(mappedData.axles[1].wheelbase, this.config.wheelbase_bus)) {
          console.log(`[Filter] Excluded Bus by wheelbase: ${mappedData.axles[1].wheelbase} (ID: ${ID})`);
          return;
        }
      }
      
      const findResult = await this.findAndProcessSnapshots(mappedData);

      if (findResult.isExcluded) {
        console.warn(`[Filter] Vehicle excluded (ID: ${ID}).`);
        return;
      }

      sendToVMS(this.config.led_url, mappedData);

      const vehicleID = await insertVehicleWithDetails(mappedData);
      console.log("Data saved successfully for Vehicle ID:", vehicleID);

      if (threeDimensionBase) {
        try {
          const threeDimensionData = await getThreeDimension(threeDimensionBase, mappedData, vehicleID);
          if (threeDimensionData) await insertThreeDimensionWithWarnings(threeDimensionData);
        } catch (err) { console.error("Error processing threeDimension:", err); }
      }

      sendToWebSocket({ vehicleID: vehicleID });
      sendToTransmission(transmissionUrl,{ vehicleID: vehicleID } );

      if (!mappedData.overviewPath || !mappedData.platePath) {
        console.warn(`Missing images for Vehicle ID: ${vehicleID}. Retrying in 2s...`);
        await new Promise((resolve) => setTimeout(resolve, 2000));
        
        const retryResult = await this.findAndProcessSnapshots(
            mappedData,
            findResult.lprSnapshots,
            findResult.overviewSnapshots
        );
        if (retryResult.isExcluded) return;

        if (mappedData.overviewPath) await updateOverview(vehicleID, mappedData.overviewPath);
        if (mappedData.platePath) {
          await updatePlates(vehicleID, mappedData.licensePlate, mappedData.platePath, mappedData.province, mappedData.cropPath);
        }
        
        if (mappedData.overviewPath || mappedData.platePath) {
          sendToWebSocket({ vehicleID: vehicleID });
          sendToTransmission(transmissionUrl,{ vehicleID: vehicleID } );
        }
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
        const lane = normalizeLane(channelId);
        const lprSnapshotConfig = this.config.capture_lpr.find(
          (item) => normalizeLane(item.lane) === lane
        );
        const overviewSnapshotConfig = this.config.capture_overview.find(
          (item) => normalizeLane(item.lane) === lane
        );

        if (!lprSnapshotConfig || !overviewSnapshotConfig) {
          console.warn(
            `Snapshot configuration not found for lane ${channelId}`
          );
          return;
        }

        // Robust date handling for midnight transitions
        let stamp = dayjs(convertDataTimeToMillisecond(rawTime));
        const now = dayjs();
        
        // Although InterComp usually uses timestamps, this check adds safety for clock drifts
        if (stamp.isValid()) {
            if (stamp.diff(now, 'hour') > 12) {
              stamp = stamp.subtract(1, 'day');
            } else if (now.diff(stamp, 'hour') > 12) {
              stamp = stamp.add(1, 'day');
            }
        }

        const metadata = {
          stamp,
          lane,
        };

        await Promise.all([
          this.lprSnapshotManager.takeSnapshot(lprSnapshotConfig.snap_code, {
            ...metadata,
            type: "lpr",
          }),
          this.overviewSnapshotManager.takeSnapshot(
            overviewSnapshotConfig.snap_code,
            {
              ...metadata,
              type: "overview",
            }
          ),
        ]);
      } catch (err) {
        console.error("Error processing trigger message:", err);
      }
    } catch (err) {
      console.error("DataLogger error handling trigger message:", err);
    }
  }
}

module.exports = InterComp;
