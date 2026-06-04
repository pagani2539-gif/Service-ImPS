// src\controllers\DataLogger.js
const WSController = require("./WSController");
const { sendToWebSocket } = require("../services/wsService");
const { sendToVMS } = require("../services/ledDisplayService");
const { sendToTransmission } = require("../services/transmissionService");
const {
  mapDataLogger,
  classifyVehicle,
  calculateESAL,
  setViolation,
  mapWarningFlag,
  mapErrorFlag,
  setSingleTire,
  isBusByLicensePlate,
  hasNonNumericCharacters,
  isVehicleExcludedByPlate,
  formatLicensePlate,
  isBusByWheelbase,
  mergeStraddlingVehicles,
  isReverseDirection
} = require("../utils/mappers/mapDataLogger");
const { ignoreGVW, isIgnoredLength } = require("../utils/mappers/mapInterComp");
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
const transmissionUrl = process.env.TRANSMISSION_URL || '';
const threeDimensionBase = process.env.THREE_DIMENSION_BASE || '';
const PICO_BASE = process.env.PICO_BASE || '';
const { getSingleDualTire } = require('../services/picoService');

const { getThreeDimension, insertThreeDimensionWithWarnings } = require('../services/threeDimensionService')

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
    this.straddlingBuffer = new Map(); // ใช้สำหรับพักข้อมูลรถรอ Merge (Key: LicensePlate)
    this.lastTriggerTimes = new Map(); // ใช้สำหรับบันทึกเวลาที่ได้รับ Trigger ล่าสุดแต่ละเลน (Key: lane, Value: timestamp)
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

  async stop() {
    console.log(`Stopping DataLogger for station: ${this.config.station_name}`);
    // ปิด WebSocket connections และหยุด reconnect
    this.closeSockets();
    console.log("DataLogger stopped successfully.");
  }

  // ฟังก์ชันสำหรับค้นหาและประมวลผล snapshots
  async findAndProcessSnapshots(mappedData, existingLpr = null, existingOverview = null) {
    const lane = normalizeLane(mappedData.lane);
    const lastTrigger = this.lastTriggerTimes.get(lane);
    const hasRecentTrigger = lastTrigger && (Date.now() - lastTrigger <= 15000); // 15 seconds window

    // 1. เริ่มค้นหาเฉพาะส่วนที่ยังไม่มีข้อมูล (รองรับการ Retry)
    // Smart Retry: ถ้ามี snapshot เดิมที่เคยหาเจอแล้วแต่ upload พลาด ให้ใช้ใบเดิม
    // หากไม่มีประวัติการ Trigger ล่าสุด (hasRecentTrigger เป็น false) ให้ใช้ _findSnapshotOnce เพื่อเช็คทันทีแบบไม่มีดีเลย์
    const lprSearchPromise = !mappedData.platePath 
      ? (existingLpr 
          ? Promise.resolve(existingLpr) 
          : (hasRecentTrigger 
              ? this.lprSnapshotManager.findSnapshots(mappedData, "lpr") 
              : this.lprSnapshotManager._findSnapshotOnce(mappedData, "lpr")))
      : Promise.resolve(null);
      
    const overviewSearchPromise = !mappedData.overviewPath
      ? (existingOverview 
          ? Promise.resolve(existingOverview) 
          : (hasRecentTrigger 
              ? this.overviewSnapshotManager.findSnapshots(mappedData, "overview") 
              : this.overviewSnapshotManager._findSnapshotOnce(mappedData, "overview")))
      : Promise.resolve(null);

    let lprSnapshotsFound = existingLpr;
    let overviewSnapshotsFound = existingOverview;

    // 2. จัดการส่วน LPR
    const lprProcessPromise = lprSearchPromise.then(async (lprSnapshots) => {
      let activeLprSnapshots = lprSnapshots;

      // Fallback: If no pre-triggered LPR snapshot is found, take a live snapshot on-demand
      if (!activeLprSnapshots && !mappedData.platePath) {
        const lane = normalizeLane(mappedData.lane);
        console.log(`[Snapshot Fallback] LPR snapshot not found. Triggering on-demand snapshot for lane ${lane}...`);
        const lprSnapshotConfig = this.config.capture_lpr.find(
          (item) => normalizeLane(item.lane) === lane
        );
        if (lprSnapshotConfig) {
          activeLprSnapshots = await this.lprSnapshotManager.takeSnapshot(lprSnapshotConfig.snap_code, { stamp: new Date(), lane, type: "lpr" });
        }
      }

      if (!activeLprSnapshots) return null;
      lprSnapshotsFound = activeLprSnapshots;

      const [ocrResult, lprUploadResult] = await Promise.all([
        ocrService.sendToOCR(activeLprSnapshots, this.config.ocr_url),
        this.lprSnapshotManager.uploadImage(activeLprSnapshots.imageUrl, "lpr")
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
      return { exclude: false, snapshots: activeLprSnapshots };
    });

    // 3. จัดการส่วน Overview
    const overviewProcessPromise = overviewSearchPromise.then(async (overviewSnapshots) => {
      let activeOverviewSnapshots = overviewSnapshots;

      // Fallback: If no pre-triggered Overview snapshot is found, take a live snapshot on-demand
      if (!activeOverviewSnapshots && !mappedData.overviewPath) {
        const lane = normalizeLane(mappedData.lane);
        console.log(`[Snapshot Fallback] Overview snapshot not found. Triggering on-demand snapshot for lane ${lane}...`);
        const overviewSnapshotConfig = this.config.capture_overview.find(
          (item) => normalizeLane(item.lane) === lane
        );
        if (overviewSnapshotConfig) {
          activeOverviewSnapshots = await this.overviewSnapshotManager.takeSnapshot(overviewSnapshotConfig.snap_code, { stamp: new Date(), lane, type: "overview" });
        }
      }

      if (!activeOverviewSnapshots) return null;
      overviewSnapshotsFound = activeOverviewSnapshots;
      const uploadResult = await this.overviewSnapshotManager.uploadImage(activeOverviewSnapshots.imageUrl, "overview");
      if (uploadResult.success) {
        mappedData.overviewPath = uploadResult.data.fileUrl;
      }
      return activeOverviewSnapshots;
    });

    const [lprRes, overviewRes] = await Promise.all([lprProcessPromise, overviewProcessPromise]);

    // ถ้าตรวจเจอว่าเป็นรถบัสจากป้ายทะเบียน
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
      const { StartTime, StartTimeLastPresenceFall, ID } = rawData
      let mappedData = mapDataLogger(rawData);
      if(isReverseDirection(mappedData.direction)) return;
      if (ignoreGVW(mappedData.gvw, this.config.gvw_ignored)) return;
      mappedData = classifyVehicle(mappedData, this.config);
      mappedData = setSingleTire(mappedData, this.singleTires);
      mappedData = setViolation(mappedData, this.vehicleClasses, [0, 19]);
      mappedData = calculateESAL(mappedData, this.config, this.vehicleClasses);
      mappedData = mapWarningFlag(mappedData);
      mappedData = mapErrorFlag(mappedData);
      
      let singleDualTire = null;
      if (PICO_BASE && mappedData.lane === 1) {
        try {
          singleDualTire = getSingleDualTire(PICO_BASE, StartTime, StartTimeLastPresenceFall, ID);
        } catch (err) { console.error("Error processing singleDualTire:", err); }
      }

      if ([1, 2].includes(mappedData.vehicleClassID)) {
        if (isIgnoredLength(mappedData.axles[1].wheelbase, this.config.vehicle_length_ignored)) {
          return;
        }
        // คัดรถบัสด้วยฐานล้อทันที (ก่อนไปหารูป)
        if (mappedData.vehicleClassID === 2 && isBusByWheelbase(mappedData.axles[1].wheelbase, this.config.wheelbase_bus)) {
          console.log(`[Filter] Excluded Bus by wheelbase: ${mappedData.axles[1].wheelbase} (ID: ${ID})`);
          return;
        }
      }
      
      // 1. ตรวจสอบเงื่อนไข Straddling (Warning 9 หรือ 10)
      const isStraddling = mappedData.warningFlag.includes(9) || mappedData.warningFlag.includes(10);
      if (isStraddling) {
        const currentTime = dayjs(mappedData.stamp);
        let matchFound = false;

        const maxDiff = this.config.straddling_time_diff || 3;

        // ค้นหาคู่ใน Buffer (เทียบเวลา + จำนวนเพลา)
        for (let [key, bufferedVehicle] of this.straddlingBuffer) {
          const bufferedTime = dayjs(bufferedVehicle.data.stamp);
          const timeDiff = Math.abs(currentTime.diff(bufferedTime, 'second'));

          // เงื่อนไข: เวลาห่างกันไม่เกิน 3 วินาที และจำนวนเพลาเท่ากัน
          if (timeDiff <= maxDiff && bufferedVehicle.data.axles.length === mappedData.axles.length) {
            console.log(`[Straddling] Match found! Merging vehicles (Time Diff: ${timeDiff}s, Axles: ${mappedData.axles.length})`);
            clearTimeout(bufferedVehicle.timeoutHandle);
            let merged = mergeStraddlingVehicles(bufferedVehicle.data, mappedData);
            if (merged) {
              mappedData = merged;
              this.straddlingBuffer.delete(key);
              matchFound = true;
              break; 
            }
          }
        }

        if (!matchFound) {
          // ใช้ key ที่ไม่ซ้ำกันสำหรับ Buffer
          const bufferKey = `straddle_${mappedData.lane}_${mappedData.stamp.getTime()}`;
          const timeoutHandle = setTimeout(async () => {
            const pending = this.straddlingBuffer.get(bufferKey);
            if (pending) {
              this.straddlingBuffer.delete(bufferKey);
              await this.processFinalVehicle(pending.data);
            }
          }, maxDiff * 1000); 

          this.straddlingBuffer.set(bufferKey, {
            data: mappedData,
            timeoutHandle: timeoutHandle
          });
          return; // หยุดรอคู่ของมัน
        }
      }

      sendToVMS(this.config.led_url, mappedData);

      // Perform initial snapshot search, OCR and upload BEFORE database insert
      const findResult = await this.findAndProcessSnapshots(mappedData);

      if (findResult && findResult.isExcluded) {
        console.warn(`[Filter] Vehicle is excluded by plate (Passenger car/Bus). Skipping insert.`);
        return;
      }

      const vehicleID = await insertVehicleWithDetails(mappedData);
      console.log("Data saved successfully for Vehicle ID:", vehicleID);

      if (threeDimensionBase) {
        try {
          const threeDimensionData = await getThreeDimension(threeDimensionBase, mappedData, vehicleID);
          if (threeDimensionData) await insertThreeDimensionWithWarnings(threeDimensionData);
        } catch (err) { console.error("Error processing threeDimension:", err); }
      }

      let hasTransmitted = false;

      // Only transmit initial data if both images are present
      if (mappedData.overviewPath && mappedData.platePath) {
        // Add 500ms delay to prevent race condition of browser requesting image before server disk write
        await new Promise((resolve) => setTimeout(resolve, 500));
        sendToWebSocket({ vehicleID });
        sendToTransmission(transmissionUrl, { vehicleID });
        hasTransmitted = true;
      }

      if (!hasTransmitted) {
        this.processImagesRetryInBackground(vehicleID, mappedData, findResult).catch((err) => {
          console.error("Error in background image/OCR processing retry:", err);
        });
      }
    } catch (err) {
      console.error("DataLogger error handling data message:", err);
    }
  }

  /**
   * Process LPR/Overview images retry in the background if they were missing initially.
   */
  async processImagesRetryInBackground(vehicleID, mappedData, findResult) {
    try {
      const maxRetries = 3;
      const retryDelayMs = 5000;
      let attempt = 0;
      let hasTransmitted = false;

      while (attempt < maxRetries && (!mappedData.overviewPath || !mappedData.platePath)) {
        attempt++;
        console.log(`[Background Retry] Missing images for Vehicle ID: ${vehicleID}. Retrying in ${(retryDelayMs * attempt / 1000).toFixed(0)}s... (Attempt ${attempt}/${maxRetries})`);
        await new Promise((resolve) => setTimeout(resolve, retryDelayMs * attempt));

        const retryResult = await this.findAndProcessSnapshots(
          mappedData,
          findResult ? findResult.lprSnapshots : null,
          findResult ? findResult.overviewSnapshots : null
        );

        if (retryResult && retryResult.isExcluded) {
          console.warn(`[Background Retry] Vehicle ID: ${vehicleID} is excluded by plate on retry. Deleting record...`);
          await pool.execute("DELETE FROM axles WHERE vehicle_id = ?", [vehicleID]);
          await pool.execute("DELETE FROM axles_after_allowance WHERE vehicle_id = ?", [vehicleID]);
          await pool.execute("DELETE FROM plates WHERE vehicle_id = ?", [vehicleID]);
          await pool.execute("DELETE FROM images WHERE vehicle_id = ?", [vehicleID]);
          await pool.execute("DELETE FROM flags WHERE vehicle_id = ?", [vehicleID]);
          await pool.execute("DELETE FROM vehicles WHERE id = ?", [vehicleID]);
          return;
        }

        if (mappedData.overviewPath) {
          await updateOverview(vehicleID, mappedData.overviewPath);
        }
        if (mappedData.platePath) {
          await updatePlates(vehicleID, mappedData.licensePlate, mappedData.platePath, mappedData.province, mappedData.cropPath);
        }

        // If we got both images now, transmit and break out of retry loop
        if (mappedData.overviewPath && mappedData.platePath) {
          // Add 500ms delay to prevent race condition of browser requesting image before server disk write
          await new Promise((resolve) => setTimeout(resolve, 500));
          sendToWebSocket({ vehicleID });
          sendToTransmission(transmissionUrl, { vehicleID });
          hasTransmitted = true;
          break;
        }
      }

      // If we still haven't transmitted (retries exhausted, but some images may still be missing/null), send anyway to prevent data loss
      if (!hasTransmitted) {
        console.log(`[Background Retry] Retries exhausted for Vehicle ID: ${vehicleID}. Transmitting weight data with missing images.`);
        sendToWebSocket({ vehicleID });
        sendToTransmission(transmissionUrl, { vehicleID });
      }
    } catch (err) {
      console.error(`[Background Retry] Error processing images and OCR for vehicle ${vehicleID}:`, err);
    }
  }

  // ฟังก์ชันสำหรับส่งข้อมูลที่ค้างใน Buffer ไปประมวลผลต่อจนจบ (DB, VMS, WS)
  async processFinalVehicle(mappedData) {
    try {
      console.log(`[Straddling] Processing single part for ID: ${mappedData.id} (No partner found)`);
      sendToVMS(this.config.led_url, mappedData);

      // Perform initial snapshot search and OCR
      const findResult = await this.findAndProcessSnapshots(mappedData);

      if (findResult && findResult.isExcluded) {
        console.warn(`[Straddling] Vehicle is excluded by plate. Skipping insert.`);
        return;
      }

      const vehicleID = await insertVehicleWithDetails(mappedData);
      console.log(`[Straddling] Single part saved successfully for Vehicle ID: ${vehicleID}`);

      let hasTransmitted = false;
      if (mappedData.overviewPath && mappedData.platePath) {
        await new Promise((resolve) => setTimeout(resolve, 500));
        sendToWebSocket({ vehicleID });
        sendToTransmission(transmissionUrl, { vehicleID });
        hasTransmitted = true;
      }

      if (!hasTransmitted) {
        this.processImagesRetryInBackground(vehicleID, mappedData, findResult).catch((err) => {
          console.error("Error in background retry loop for final vehicle:", err);
        });
      }
    } catch (err) {
      console.error("Error in processFinalVehicle:", err);
    }
  }

  async handleTriggerMessage(message) {
    try {
      const rawTriggerData = JSON.parse(message);
      const eventId = rawTriggerData["event-id"];
      const channelId = rawTriggerData.data.ChannelId;
      const rawTime = rawTriggerData.data.Time;

      if (eventId != "force-event") return;
      if (!channelId || !rawTime) return;

      if (rawTriggerData.data.TriggerType === "Start") {
        try {
          const lane = normalizeLane(channelId);
          this.lastTriggerTimes.set(lane, Date.now());
          const lprSnapshotConfig = this.config.capture_lpr.find(
            (item) => normalizeLane(item.lane) === lane
          );
          const overviewSnapshotConfig = this.config.capture_overview.find(
            (item) => normalizeLane(item.lane) === lane
          );

          if (!lprSnapshotConfig || !overviewSnapshotConfig) return;

          // Robust date handling for midnight transitions
          let stamp = dayjs(rawTime);
          const now = dayjs();
          
          // If rawTime is just a time string (HH:mm:ss), dayjs defaults to TODAY.
          // At midnight, if trigger is 23:59:59 but server is 00:00:01, dayjs becomes TODAY 23:59:59 (24h in future).
          // If trigger is 00:00:01 but server is 23:59:59, dayjs becomes TODAY 00:00:01 (24h in past).
          if (stamp.isValid()) {
            if (stamp.diff(now, 'hour') > 12) {
              stamp = stamp.subtract(1, 'day');
            } else if (now.diff(stamp, 'hour') > 12) {
              stamp = stamp.add(1, 'day');
            }
          } else {
            stamp = now; // Fallback to current time if invalid
          }

          const metadata = { stamp, lane };

          await Promise.all([
            this.lprSnapshotManager.takeSnapshot(lprSnapshotConfig.snap_code, { ...metadata, type: "lpr" }),
            this.overviewSnapshotManager.takeSnapshot(overviewSnapshotConfig.snap_code, { ...metadata, type: "overview" }),
          ]);
        } catch (err) { console.error("Error processing trigger message:", err); }
      }
    } catch (err) { console.error("DataLogger error handling trigger message:", err); }
  }
}

module.exports = DataLogger;
