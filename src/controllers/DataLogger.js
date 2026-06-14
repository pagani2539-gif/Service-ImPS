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
  isReverseDirection,
  ignoreGVW,
  isIgnoredLength
} = require("../utils/mappers/mapDataLogger");
const SnapshotManager = require("../utils/snapshotManager");
const { snapshotRegistry, normalizeLane } = require("../utils/snapshotRegistry");
const dayjs = require("dayjs");
const ocrService = require("../utils/ocrService");
const pool = require("../config/db");
const path = require("path");
const logger = require("../utils/logger");
const perf = require("../utils/perfMonitor");
const { insertVehicleWithDetails, updatePlates, updateOverview } = require("../services/vehiclesService");
const baseImagePath = path.join(process.cwd(), "public/snapshots");
const baseLedPath = path.join(process.cwd(), "public/leds");
const transmissionUrl = process.env.TRANSMISSION_URL || '';
// ซ้าย(ch1)+ขวา(ch2) ของรถคันเดียวยิง trigger แทบพร้อมกัน — ถ่าย snapshot ใบเดียวภายในช่วงนี้พอ
const TRIGGER_DEBOUNCE_MS = Number(process.env.TRIGGER_DEBOUNCE_MS) || 250;
const threeDimensionBase = process.env.THREE_DIMENSION_BASE || '';

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
    // Lane → snapshot config (สร้างครั้งเดียว แทน .find() ทุก trigger)
    this.lprConfigByLane = new Map(
      (config.capture_lpr || []).map((item) => [normalizeLane(item.lane), item])
    );
    this.overviewConfigByLane = new Map(
      (config.capture_overview || []).map((item) => [normalizeLane(item.lane), item])
    );
    // Cache ผล OCR ต่อรูป — กัน re-OCR/re-crop รูปใบเดิมตอน waitForImages retry (กรณี upload พลาด)
    this.ocrResultCache = new Map();
    // กัน data message ซ้ำ (เช่น controller ส่งซ้ำหลัง WS reconnect) — Key: "lane:id"
    this.recentMessageIds = new Map();
  }

  async stop() {
    logger.info(`Stopping DataLogger for station: ${this.config.station_name}`);
    // ปิด WebSocket connections และหยุด reconnect
    this.closeSockets();
    logger.info("DataLogger stopped successfully.");
  }

  // เคยเห็น message นี้ใน 60s ที่ผ่านมาหรือไม่ — กันแถวซ้ำใน DB จาก message ที่ถูกส่งซ้ำ
  _isDuplicateMessage(key) {
    const now = Date.now();
    const lastSeen = this.recentMessageIds.get(key);
    if (lastSeen && now - lastSeen < 60000) return true;
    this.recentMessageIds.set(key, now);
    if (this.recentMessageIds.size > 500) {
      this.recentMessageIds.delete(this.recentMessageIds.keys().next().value);
    }
    return false;
  }

  // เก็บ metric เวลาประมวลผลต่อคัน + log บรรทัดเดียวไว้ไล่ bottleneck
  _recordVehicleMetrics(mappedData, vehicleID, { totalMs, findMs, imageWaitMs, insertMs }) {
    const sensorToDbMs = Math.max(0, Date.now() - dayjs(mappedData.stamp).valueOf());
    perf.count("inserted");
    perf.observe("vehicle_total_ms", totalMs);
    perf.observe("snapshot_find_ms", findMs);
    perf.observe("image_wait_ms", imageWaitMs);
    perf.observe("db_insert_ms", insertMs);
    perf.observe("sensor_to_db_ms", sensorToDbMs);
    logger.info(`🚗 [Vehicle Saved] ID: ${mappedData.id} | VehicleID: ${vehicleID} | Class: ${mappedData.vehicleClassID} | Plate: ${mappedData.licensePlate || "N/A"} (${mappedData.province || "N/A"}) | GVW: ${mappedData.gvw} kg | Speed: ${mappedData.speed} km/h | Lane: ${mappedData.lane} | Total: ${totalMs}ms (Find: ${findMs}ms, Wait: ${imageWaitMs}ms, Insert: ${insertMs}ms) | Latency: ${sensorToDbMs}ms`);
  }

  // [Instrument] ลายเซ็น "ด้านศูนย์" ต่อเพลา — ฝั่งที่เซ็นเซอร์อ่านได้ ~0 (ล้อเลยขอบเลน)
  // ใช้พิสูจน์สมมุติฐานจับคู่คร่อมเลนด้วยฟิสิกส์: เลนซ้าย R0 ↔ เลนขวา L0 = รถคันเดียวคร่อมขอบ
  _zeroSideSignature(data, zeroKg = 100) {
    return (data.axles || [])
      .map((a, i) => {
        const l0 = (a.weightLeft || 0) < zeroKg;
        const r0 = (a.weightRight || 0) < zeroKg;
        const code = l0 && r0 ? "X" : l0 ? "L0" : r0 ? "R0" : "ok";
        return `A${i + 1}:${code}`;
      })
      .join(" ");
  }

  // straddle จาก "ด้านศูนย์": ทุกเพลามีฝั่งเดียวศูนย์อย่างสม่ำเสมอ (ซ้ายหมด หรือขวาหมด)
  // ใช้เสริมกรณี WIM ไม่ติดธง 9/10 ให้ครึ่งคัน — รถปกติ 2 ฝั่งมีน้ำหนัก = false, รถเบาจะโดน floor ตัดทีหลังอยู่ดี
  _isZeroSideStraddle(data, zeroKg = 100) {
    const axles = data.axles || [];
    if (axles.length === 0) return false;
    let allL0 = true, allR0 = true;
    for (const a of axles) {
      if ((a.weightLeft || 0) >= zeroKg) allL0 = false;
      if ((a.weightRight || 0) >= zeroKg) allR0 = false;
    }
    return (allL0 && !allR0) || (allR0 && !allL0); // ฝั่งเดียวศูนย์สม่ำเสมอ (ไม่ใช่ทั้งคู่ศูนย์ = ไม่มีข้อมูล)
  }

  // ฟังก์ชันสำหรับค้นหาและประมวลผล snapshots
  async findAndProcessSnapshots(mappedData, existingLpr = null, existingOverview = null) {
    // 1. เริ่มค้นหาเฉพาะส่วนที่ยังไม่มีข้อมูล (รองรับการ Retry)
    // Smart Retry: ถ้ามี snapshot เดิมที่เคยหาเจอแล้วแต่ upload พลาด ให้ใช้ใบเดิม
    const lprSearchPromise = !mappedData.platePath 
      ? (existingLpr 
          ? Promise.resolve(existingLpr) 
          : this.lprSnapshotManager.findSnapshots(mappedData, "lpr"))
      : Promise.resolve(null);
      
    const overviewSearchPromise = !mappedData.overviewPath
      ? (existingOverview 
          ? Promise.resolve(existingOverview) 
          : this.overviewSnapshotManager.findSnapshots(mappedData, "overview"))
      : Promise.resolve(null);

    let lprSnapshotsFound = existingLpr;
    let overviewSnapshotsFound = existingOverview;

    // 2. จัดการส่วน LPR
    const lprProcessPromise = lprSearchPromise.then(async (lprSnapshots) => {
      let activeLprSnapshots = lprSnapshots;

      if (!activeLprSnapshots) return null;
      lprSnapshotsFound = activeLprSnapshots;

      // ใช้ผล OCR เดิมถ้าเคยอ่านรูปใบนี้สำเร็จแล้ว (retry เกิดจาก upload พลาด ไม่ใช่ OCR พลาด)
      const cachedOcr = this.ocrResultCache.get(activeLprSnapshots.imageUrl);
      const [ocrResult, lprUploadResult] = await Promise.all([
        cachedOcr
          ? Promise.resolve(cachedOcr)
          : ocrService.sendToOCR(activeLprSnapshots, this.config.ocr_url),
        this.lprSnapshotManager.uploadImage(activeLprSnapshots.imageUrl, "lpr", activeLprSnapshots.buffer)
      ]);
      if (ocrResult && !cachedOcr) {
        this.ocrResultCache.set(activeLprSnapshots.imageUrl, ocrResult);
        if (this.ocrResultCache.size > 50) {
          this.ocrResultCache.delete(this.ocrResultCache.keys().next().value);
        }
      }

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

      if (!activeOverviewSnapshots) return null;
      overviewSnapshotsFound = activeOverviewSnapshots;
      const uploadResult = await this.overviewSnapshotManager.uploadImage(activeOverviewSnapshots.imageUrl, "overview", activeOverviewSnapshots.buffer);
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
    const totalTimer = perf.timer();
    perf.enter();
    perf.count("received");
    try {
      const rawData = JSON.parse(message);
      const { ID } = rawData
      if (this._isDuplicateMessage(`${rawData.LaneNo}:${ID}`)) {
        perf.count("dropped_duplicate");
        logger.warn(`[Dedup] Duplicate data message dropped (Lane: ${rawData.LaneNo}, ID: ${ID})`);
        return;
      }
      logger.info(`[RX] (ID: ${ID}, Lane: ${rawData.LaneNo}) Received data message`);
      let mappedData = mapDataLogger(rawData);
      if(isReverseDirection(mappedData.direction)) {
        logger.info(`[Filter] Dropped reverse direction (ID: ${ID}, Lane: ${mappedData.lane}, Direction: ${mappedData.direction})`);
        perf.count("dropped_reverse"); return;
      }
      // straddle-flagged readings (warning 9/10) carry only one lane's half weight. The WIM often
      // can't total a partial side and reports GVW = -1 even though the per-axle wheel weights are real,
      // so a real truck partner gets dropped before it can merge. Decide keep/drop on the MEASURED wheel
      // weight (sum of axle weights), not the GVW field: a real half-truck sums to thousands of kg
      // (keep), a motorcycle — single wheel track = one side 0 = falsely straddle-flagged — sums to ~0
      // (drop). Floor = gvw_ignored/2 since a half is ~half a vehicle.
      // GVW = -1 คือ error code ของคอนโทรลเลอร์ — reading เสียทั้งใบ (น้ำหนักรายเพลาเชื่อไม่ได้)
      // ห้ามนำไป merge → ตัดทิ้งทันที (ครึ่งคันที่ดีของมันจะกลายเป็น orphan ตามจริง = กู้ไม่ได้)
      if (mappedData.gvw === -1) {
        logger.info(`[Filter] Dropped controller error GVW=-1 (ID: ${ID}, Lane: ${mappedData.lane})`);
        perf.count("dropped_error"); return;
      }
      // ติดธงคร่อมเลนจาก WIM (warning 9/10) หรือจาก "ด้านศูนย์" ที่เราตรวจเอง (เผื่อ WIM ไม่ติดธงให้ครึ่งคัน)
      const isStraddleFlagged = (mappedData.warningFlags & (1 << 9)) || (mappedData.warningFlags & (1 << 10)) || this._isZeroSideStraddle(mappedData);
      // ครึ่งคันรถบรรทุก (GVW จริงแต่ครึ่งเดียว) ยังหนักเป็นพัน กก. → ยกเว้น floor ถึง gvw_ignored/2
      // มอเตอร์ไซค์ (ล้อแถวเดียว = ติดธงหลอก) น้ำหนักต่ำกว่า floor → ตัดทิ้ง
      const straddleFloor = this.config.gvw_ignored / 2;
      if (ignoreGVW(mappedData.gvw, this.config.gvw_ignored)) {
        if (!isStraddleFlagged || mappedData.gvw < straddleFloor) {
          logger.info(`[Filter] Dropped by GVW (ID: ${ID}, Lane: ${mappedData.lane}, GVW: ${mappedData.gvw}kg${isStraddleFlagged ? ", straddle-flagged but below half-floor" : ""})`);
          perf.count("dropped_gvw"); return;
        }
        logger.info(`[Filter] GVW below threshold but straddle-flagged — keeping for merge (ID: ${ID}, Lane: ${mappedData.lane}, GVW: ${mappedData.gvw}kg)`);
        perf.count("straddle_gvw_kept");
      }
      mappedData = classifyVehicle(mappedData, this.config);
      mappedData = setSingleTire(mappedData, this.singleTires);
      mappedData = setViolation(mappedData, this.vehicleClasses, [0, 19]);
      mappedData = calculateESAL(mappedData, this.config, this.vehicleClasses);
      mappedData = mapWarningFlag(mappedData);
      mappedData = mapErrorFlag(mappedData);
      logger.info(`[Pipeline] (ID: ${ID}, Lane: ${mappedData.lane}) Classified: Class ${mappedData.vehicleClassID}, GVW ${mappedData.gvw}kg, Speed ${mappedData.speed}km/h, Axles ${mappedData.axles.length}, Direction ${mappedData.direction}`);

      if ([1, 2].includes(mappedData.vehicleClassID)) {
        if (isIgnoredLength(mappedData.axles[1].wheelbase, this.config.vehicle_length_ignored)) {
          logger.info(`[Filter] Dropped by length (ID: ${ID}, Lane: ${mappedData.lane}, Wheelbase: ${mappedData.axles[1].wheelbase})`);
          perf.count("dropped_length");
          return;
        }
        // คัดรถบัสด้วยฐานล้อทันที (ก่อนไปหารูป)
        if (mappedData.vehicleClassID === 2 && isBusByWheelbase(mappedData.axles[1].wheelbase, this.config.wheelbase_bus)) {
          logger.info(`[Filter] Excluded Bus by wheelbase: ${mappedData.axles[1].wheelbase} (ID: ${ID})`);
          perf.count("dropped_bus_wheelbase");
          return;
        }
      }
      
      // 1. ตรวจสอบเงื่อนไข Straddling (Warning 9 หรือ 10)
      // ใช้ค่าเดียวกับด่าน floor — รวมทั้งธง WIM และ zero-side ที่ตรวจเอง
      const isStraddling = isStraddleFlagged;
      if (isStraddling) {
        const currentTime = dayjs(mappedData.stamp);
        let matchFound = false;

        const maxDiff = this.config.straddling_time_diff || 3;

        // [Instrument] log รถที่ติดธงคร่อมเลน + ลายเซ็นด้านศูนย์ (ไว้พิสูจน์การจับคู่ด้วยฟิสิกส์ - ชั้น 3)
        logger.info(`[Straddling][Candidate] Incoming (ID: ${mappedData.id}, Lane: ${mappedData.lane}, Axles: ${mappedData.axles.length}, Speed: ${Number(mappedData.speed).toFixed(1)}km/h) ZeroSide: ${this._zeroSideSignature(mappedData)} | Buffer: ${this.straddlingBuffer.size}`);

        // ค้นหาคู่ใน Buffer (เทียบเวลา + เลนติดกัน + จำนวนเพลา + ระยะฐานล้อ + ความเร็ว)
        for (let [key, bufferedVehicle] of this.straddlingBuffer) {
          const bufferedTime = dayjs(bufferedVehicle.data.stamp);

          // 1. เวลาห่างกันระดับมิลลิวินาที (ไม่เกิน 1 วินาที หรือตาม config)
          const timeDiffMs = Math.abs(currentTime.diff(bufferedTime, 'millisecond'));
          const maxTimeDiffMs = maxDiff * 1000;
          const isTimeOk = timeDiffMs <= Math.min(1000, maxTimeDiffMs);

          // 2. หมายเลขเลนต้องอยู่ติดกัน
          const isAdjacentLane = Math.abs(Number(bufferedVehicle.data.lane) - Number(mappedData.lane)) === 1;

          // 3. จำนวนเพลาเท่ากัน
          const isAxleCountOk = bufferedVehicle.data.axles.length === mappedData.axles.length;

          // 5. ความเร็วสอดคล้องกัน (ต่างกันไม่เกิน 15 กม./ชม.) — คำนวณเสมอเพื่อเก็บ delta
          const speedDiff = Math.abs(bufferedVehicle.data.speed - mappedData.speed);
          const isSpeedOk = speedDiff <= 15;

          // 4. ระยะฐานล้อทุกเพลาต่างกันไม่เกิน 30 ซม. (เทียบได้เฉพาะเมื่อจำนวนเพลาตรงกัน)
          let wheelbaseMaxDiff = null;
          let isWheelbaseOk = false;
          if (isAxleCountOk) {
            wheelbaseMaxDiff = 0;
            for (let i = 1; i < mappedData.axles.length; i++) {
              const d = Math.abs(bufferedVehicle.data.axles[i].wheelbase - mappedData.axles[i].wheelbase);
              if (d > wheelbaseMaxDiff) wheelbaseMaxDiff = d;
            }
            isWheelbaseOk = wheelbaseMaxDiff <= 30;
          }

          // [Instrument] log delta จริงของทุกคู่ที่สแกน (ผ่าน/ไม่ผ่านแต่ละเงื่อนไข) ไว้เก็บการกระจายไปจูน threshold (ชั้น 1)
          logger.info(`[Straddling][Compare] Buffered Lane ${bufferedVehicle.data.lane} (ID: ${bufferedVehicle.data.id}) vs Incoming Lane ${mappedData.lane} (ID: ${mappedData.id}) | dTime ${timeDiffMs}ms[${isTimeOk ? "Y" : "N"}] Adjacent[${isAdjacentLane ? "Y" : "N"}] Axles ${bufferedVehicle.data.axles.length}vs${mappedData.axles.length}[${isAxleCountOk ? "Y" : "N"}] dWheelbase ${wheelbaseMaxDiff === null ? "-" : wheelbaseMaxDiff + "cm"}[${isWheelbaseOk ? "Y" : "N"}] dSpeed ${speedDiff.toFixed(1)}km/h[${isSpeedOk ? "Y" : "N"}]`);

          // เงื่อนไขตัดสินใจ merge — เทียบเท่าของเดิม (isWheelbaseOk เป็น false เมื่อเพลาไม่ตรง)
          if (isTimeOk && isAdjacentLane && isAxleCountOk && isWheelbaseOk && isSpeedOk) {
            clearTimeout(bufferedVehicle.timeoutHandle);
            let merged = mergeStraddlingVehicles(bufferedVehicle.data, mappedData);
            if (merged) {
              const leftWeights = bufferedVehicle.data.axles.map(a => a.weightLeft + a.weightRight);
              const rightWeights = mappedData.axles.map(a => a.weightLeft + a.weightRight);
              const mergedWeights = merged.axles.map(a => a.weight);
              logger.info(`[Straddling] High-precision Match found! Merging vehicles. Time Diff: ${timeDiffMs}ms, Speed Diff: ${speedDiff}km/h. Left Lane ${bufferedVehicle.data.lane} [${leftWeights.join(', ')}] kg + Right Lane ${mappedData.lane} [${rightWeights.join(', ')}] kg -> Merged GVW ${merged.gvw} kg with Axles [${mergedWeights.join(', ')}] kg`);

              mappedData = merged;
              // re-classify + คำนวณ violation/ESAL ใหม่บนน้ำหนักรวม
              // (ครึ่งคันที่ GVW=-1 จะได้ class 0; พอ merge มีน้ำหนักเต็มต้องจำแนกใหม่
              //  + ก่อน merge violation คิดบนครึ่งเดียว → รถเกินจะถูกบันทึกว่าผ่าน)
              mappedData = classifyVehicle(mappedData, this.config);
              mappedData = setViolation(mappedData, this.vehicleClasses, [0, 19]);
              mappedData = calculateESAL(mappedData, this.config, this.vehicleClasses);
              logger.info(`[Straddling] Recalculated after merge (ID: ${mappedData.id}): Class ${mappedData.vehicleClassID}, GVW ${mappedData.gvw}kg, Violation ${mappedData.violation}, Overweight ${Number(mappedData.overweight_percentage || 0).toFixed(1)}%`);
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
          // [Instrument] เข้า buffer รอคู่ — ถ้าไม่มีคู่มาใน maxDiff วิ จะถูกบันทึกเป็นรถ "ครึ่งคัน"
          logger.info(`[Straddling][Buffered] No partner yet (ID: ${mappedData.id}, Lane: ${mappedData.lane}) ZeroSide: ${this._zeroSideSignature(mappedData)} — holding ${maxDiff}s`);
          perf.count("straddle_buffered");
          return; // หยุดรอคู่ของมัน
        }
      }

      if (this.config.led_enabled && this.config.led_url) {
        logger.info(`[LED] (ID: ${mappedData.id}, Lane: ${mappedData.lane}) Dispatching to VMS`);
        sendToVMS(this.config.led_url, mappedData);
      }

      const insertTimer = perf.timer();
      const vehicleID = await insertVehicleWithDetails(mappedData);
      const insertMs = insertTimer();
      logger.info(`Data saved successfully for Vehicle ID: ${vehicleID} (ID: ${mappedData.id})`);

      // ย้ายส่วนประมวลผลรูปภาพและส่งข้อมูลส่วนกลางไปทำงานเป็น Asynchronous Background Task
      this.processImagesAndOcrInBackground(vehicleID, mappedData, totalTimer, insertMs).catch(err => {
        logger.error(`Error in background processing for Vehicle ID ${vehicleID}: ${err.stack || err}`);
      });
    } catch (err) {
      perf.count("handler_error");
      logger.error(`DataLogger error handling data message: ${err.stack || err}`);
    } finally {
      perf.exit();
    }
  }

  // หน่วง 150ms กัน browser ขอรูปก่อนที่ image server จะเขียนไฟล์เสร็จ (ค่าเดิม) โดยไม่ค้าง handler
  transmitVehicle(vehicleID) {
    setTimeout(() => {
      logger.info(`[Transmit] (VehicleID: ${vehicleID}) Dispatching to WS + central`);
      sendToWebSocket({ vehicleID });
      sendToTransmission(transmissionUrl, { vehicleID });
    }, 150);
  }

  /**
   * รอรูป LPR/Overview ที่ยังขาดให้ครบ "ก่อน" insert (ตาราง retry เดิม: 2s,4s,6s,8s,10s)
   * คืน false เมื่อพบระหว่างรอว่าเป็นรถ excluded (ผู้เรียกต้องข้ามการ insert)
   * ถ้า retry หมดแล้วรูปยังไม่ครบ คืน true เพื่อบันทึกข้อมูลน้ำหนักกันข้อมูลหาย
   */
  async waitForImages(mappedData, findResult) {
    const maxRetries = 5;
    const retryDelayMs = 2000;
    let attempt = 0;
    let lprSnapshots = findResult ? findResult.lprSnapshots : null;
    let overviewSnapshots = findResult ? findResult.overviewSnapshots : null;

    while (attempt < maxRetries && (!mappedData.overviewPath || !mappedData.platePath)) {
      attempt++;
      logger.info(`[Image Wait] Missing images for ID: ${mappedData.id}. Retrying in ${(retryDelayMs * attempt / 1000).toFixed(0)}s... (Attempt ${attempt}/${maxRetries})`);
      await new Promise((resolve) => setTimeout(resolve, retryDelayMs * attempt));

      const retryResult = await this.findAndProcessSnapshots(mappedData, lprSnapshots, overviewSnapshots);

      if (retryResult && retryResult.isExcluded) {
        logger.warn(`[Image Wait] ID: ${mappedData.id} is excluded by plate on retry. Skipping insert.`);
        return false;
      }

      if (retryResult) {
        lprSnapshots = retryResult.lprSnapshots || lprSnapshots;
        overviewSnapshots = retryResult.overviewSnapshots || overviewSnapshots;
      }
    }

    if (!mappedData.overviewPath || !mappedData.platePath) {
      logger.warn(`[Image Wait] Retries exhausted for ID: ${mappedData.id}. Saving with missing images to prevent data loss.`);
    }
    return true;
  }

  // ฟังก์ชันสำหรับส่งข้อมูลที่ค้างใน Buffer ไปประมวลผลต่อจนจบ (DB, VMS, WS)
  async processFinalVehicle(mappedData) {
    const totalTimer = perf.timer();
    perf.enter();
    perf.count("straddle_finalized");
    try {
      logger.warn(`[Straddling][Orphan] No partner found for ID: ${mappedData.id} (Lane: ${mappedData.lane}) ZeroSide: ${this._zeroSideSignature(mappedData)} — saving HALF-weight record (GVW ${mappedData.gvw}kg)`);
      if (this.config.led_enabled && this.config.led_url) {
        sendToVMS(this.config.led_url, mappedData);
      }

      const insertTimer = perf.timer();
      const vehicleID = await insertVehicleWithDetails(mappedData);
      const insertMs = insertTimer();
      logger.info(`[Straddling] Single part saved successfully for Vehicle ID: ${vehicleID}`);

      // ทำงานเบื้องหลังแบบขนาน
      this.processImagesAndOcrInBackground(vehicleID, mappedData, totalTimer, insertMs).catch(err => {
        logger.error(`Error in background processing for Straddling Vehicle ID ${vehicleID}: ${err.stack || err}`);
      });
    } catch (err) {
      perf.count("handler_error");
      logger.error(`Error in processFinalVehicle: ${err.stack || err}`);
    } finally {
      perf.exit();
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
          perf.count("trigger_received");
          const lane = normalizeLane(channelId);
          // Debounce ต่อเลน: ซ้าย(ch1)+ขวา(ch2) ของรถคันเดียวยิงไล่กันแทบพร้อมกัน → ถ่าย snapshot ใบเดียวพอ
          // (หลังเพิ่ม trigger ฝั่งขวา ถ้าถ่าย 2 ใบ/คัน registry แน่นเท่าตัว → จับคู่รูปข้ามคัน → ภาพป้ายเพี้ยน)
          // รถคร่อมเลนที่เหยียบฝั่งเดียว (ห่างจากคันก่อนเกิน debounce) ยัง trigger ได้ตามปกติ
          const nowMs = Date.now();
          const lastTrig = this.lastTriggerTimes.get(lane);
          this.lastTriggerTimes.set(lane, nowMs);
          if (lastTrig && (nowMs - lastTrig) < TRIGGER_DEBOUNCE_MS) {
            perf.count("trigger_debounced");
            return;
          }
          const lprSnapshotConfig = this.lprConfigByLane.get(lane);
          const overviewSnapshotConfig = this.overviewConfigByLane.get(lane);

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

          const snapTimer = perf.timer();
          await Promise.all([
            this.lprSnapshotManager.takeSnapshot(lprSnapshotConfig.snap_code, { ...metadata, type: "lpr" }),
            this.overviewSnapshotManager.takeSnapshot(overviewSnapshotConfig.snap_code, { ...metadata, type: "overview" }),
          ]);
          perf.observe("trigger_snapshot_ms", snapTimer()); // กล้องช้า = รูปจับคู่ไม่ทัน
        } catch (err) { logger.error(`Error processing trigger message: ${err.stack || err}`); }
      }
    } catch (err) { logger.error(`DataLogger error handling trigger message: ${err.stack || err}`); }
  }

  /**
   * ค้นหารูปภาพ, OCR และอัปโหลดในพื้นหลังเพื่อไม่ให้บล็อก Flow หลัก
   */
  async processImagesAndOcrInBackground(vehicleID, mappedData, totalTimer, insertMs) {
    try {
      logger.info(`[Pipeline] (ID: ${mappedData.id}, VehicleID: ${vehicleID}) Background start (find images + OCR)`);
      const findTimer = perf.timer();
      const findResult = await this.findAndProcessSnapshots(mappedData);
      const findMs = findTimer();
      logger.info(`[Pipeline] (ID: ${mappedData.id}, VehicleID: ${vehicleID}) Snapshots resolved: lpr=${mappedData.platePath ? "Y" : "N"}, overview=${mappedData.overviewPath ? "Y" : "N"}`);

      if (findResult && findResult.isExcluded) {
        await this.deleteVehicleFromDatabase(vehicleID);
        return;
      }

      const waitTimer = perf.timer();
      const keepVehicle = await this.waitForImages(mappedData, findResult);
      const imageWaitMs = waitTimer();

      if (!keepVehicle) {
        await this.deleteVehicleFromDatabase(vehicleID);
        return;
      }

      // อัปเดตข้อมูลภาพและทะเบียนลง DB ย้อนหลัง (บันทึกภาพด้วยแม้จะอ่านตัวเลขทะเบียนไม่ได้)
      if (mappedData.licensePlate || mappedData.platePath) {
        await updatePlates(
          vehicleID,
          mappedData.licensePlate || null,
          mappedData.platePath || null,
          mappedData.province || null,
          mappedData.cropPath || null
        );
      }
      if (mappedData.overviewPath) {
        await updateOverview(vehicleID, mappedData.overviewPath);
      }

      logger.info(`Data updated successfully for Vehicle ID: ${vehicleID}`);
      this._recordVehicleMetrics(mappedData, vehicleID, { totalMs: totalTimer(), findMs, imageWaitMs, insertMs });

      // ดึงข้อมูล 3D (ถ้ามีกำหนดไว้)
      if (threeDimensionBase) {
        try {
          const threeDimensionData = await getThreeDimension(threeDimensionBase, mappedData, vehicleID);
          if (threeDimensionData) await insertThreeDimensionWithWarnings(threeDimensionData);
        } catch (err) { logger.error(`Error processing threeDimension: ${err.stack || err}`); }
      }

      // ส่งสัญญาณ WebSocket และส่งข้อมูลไปส่วนกลาง
      this.transmitVehicle(vehicleID);
    } catch (err) {
      logger.error(`Error in processImagesAndOcrInBackground for Vehicle ID ${vehicleID}: ${err.stack || err}`);
    }
  }

  /**
   * ลบข้อมูลรถยนต์ออกจากฐานข้อมูลเมื่อระบุได้ว่าเป็นรถกลุ่ม Exclude ย้อนหลัง (ลบ Ghost Records)
   */
  async deleteVehicleFromDatabase(vehicleID) {
    try {
      logger.warn(`[Filter] Vehicle ID ${vehicleID} is excluded by plate on background OCR. Deleting from DB.`);
      await pool.execute(`DELETE FROM plates WHERE vehicle_id = ?`, [vehicleID]);
      await pool.execute(`DELETE FROM images WHERE vehicle_id = ?`, [vehicleID]);
      await pool.execute(`DELETE FROM flags WHERE vehicle_id = ?`, [vehicleID]);
      await pool.execute(`DELETE FROM axles WHERE vehicle_id = ?`, [vehicleID]);
      await pool.execute(`DELETE FROM axles_after_allowance WHERE vehicle_id = ?`, [vehicleID]);
      await pool.execute(`DELETE FROM vehicles WHERE id = ?`, [vehicleID]);
      perf.count("dropped_excluded_plate");
    } catch (err) {
      logger.error(`Error deleting excluded vehicle ID ${vehicleID}: ${err.stack || err}`);
    }
  }
}

module.exports = DataLogger;
