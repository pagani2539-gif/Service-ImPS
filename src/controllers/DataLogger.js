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
  isVehicleExcludedByPlate,
  formatLicensePlate,
  isBusByWheelbase,
  mergeStraddlingVehicles,
  mirrorEdgeAxles,
  combineSameLaneFragments,
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
// ค่าคงที่ทางกายภาพ (สากล ไม่ขึ้นกับสถานี → hardcode, ไม่ต้องตั้ง DB; override ผ่าน env ได้ถ้าจำเป็น)
const FRAGMENT_MAX_GAP_CM = Number(process.env.FRAGMENT_MAX_GAP_CM) || 2500; // รถยาวสุด ~25ม. — เกินนี้ = คนละคัน ไม่ใช่เศษรถเดียว
const MIN_AXLES = Number(process.env.MIN_AXLES) || 2;                        // รถจริงต้องมี ≥2 เพลา — 1 เพลา = noise/จับไม่ครบ

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
    // log ค่า VMS/LED ที่โหลดมาจริง — VMS ไม่ขึ้นมักเพราะ led_enabled=0 หรือ led_url ว่างในค่าที่โหลด
    // (V2 ส่ง VMS เฉพาะเมื่อ led_enabled && led_url; ต่างจาก V1 ที่ส่งเสมอ)
    if (this.config.led_url) {
      logger.info(`[LED] config loaded: led_enabled=${this.config.led_enabled}, led_url=${this.config.led_url}`);
    } else {
      logger.warn(`[LED] LED-URL-EMPTY: led_url not set, VMS will not work (set configuration.led_url then restart)`);
    }
    // log ค่าจูน straddle/mirror ที่โหลดมาจริง — ยืนยันว่าฟีเจอร์เปิดและอ่านจาก DB ตัวที่ถูกต้อง
    // (ถ้า edgeZones เป็น [] = edge-mirror ปิด; ใช้เช็คเวลา "ตั้ง config แล้วแต่ไม่ทำงาน" = ตั้งผิด DB)
    const edgeZones = this.config.mirror_edge_zones || [];
    logger.info(`[Straddling] config loaded: axle_tol=${this.config.straddling_axle_tol}, time_diff=${this.config.straddling_time_diff}s, speed_diff=${this.config.straddling_speed_diff}, wheelbase_diff=${this.config.straddling_wheelbase_diff}cm, zero_kg=${this.config.straddling_zero_kg}`);
    if (edgeZones.length) {
      logger.info(`[EdgeMirror] config loaded: ON — mirror_edge_zones=${JSON.stringify(edgeZones)}`);
    } else {
      logger.warn(`[EdgeMirror] config loaded: OFF — mirror_edge_zones empty (set configuration.mirror_edge_zones on the DB this runtime uses)`);
    }
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

  // class 1 = รถยนต์/กระบะ (2 เพลาฐานล้อสั้น) → log สั้น; class 2+ = รถบรรทุก → log เต็ม
  _isTruck(classID) { return Number(classID) >= 2; }

  // เก็บ metric เวลาประมวลผลต่อคัน + log บรรทัดเดียวไว้ไล่ bottleneck
  // รถบรรทุก: เต็ม + breakdown ราย stage (ชี้คอขวด) · รถยนต์: บรรทัดเดียวสั้นๆ
  _recordVehicleMetrics(mappedData, vehicleID, { totalMs, findMs, imageWaitMs, insertMs, ocrMs = 0, uploadMs = 0, snapMs = 0 }) {
    const sensorToDbMs = Math.max(0, Date.now() - dayjs(mappedData.stamp).valueOf());
    perf.count("inserted");
    perf.observe("vehicle_total_ms", totalMs);
    perf.observe("snapshot_find_ms", findMs);
    perf.observe("image_wait_ms", imageWaitMs);
    perf.observe("db_insert_ms", insertMs);
    perf.observe("sensor_to_db_ms", sensorToDbMs);

    const plate = mappedData.licensePlate || "-";
    // บรรทัดกระชับ ASCII ล้วน (cmd หน้างานไม่ใช่ UTF-8 — emoji/ไทยกลายเป็นกล่อง)

    if (!this._isTruck(mappedData.vehicleClassID)) {
      // รถยนต์/กระบะ (class 1) → บรรทัดเดียว สั้น (ตัด log ละเอียดออกแล้วใน pipeline)
      logger.info(`CAR(class1) #${vehicleID} L${mappedData.lane} ${plate} ${mappedData.gvw}kg ${mappedData.speed}km/h ${totalMs}ms`);
      return;
    }

    // รถบรรทุก (class 2+) → เต็ม + breakdown ชี้คอขวดรายคัน
    const head = mappedData.isOverweight
      ? `*OVER +${Number(mappedData.overweight_percentage || 0).toFixed(0)}%*`
      : "TRUCK";
    const tags = [];
    if (mappedData.isStraddlingMerged) tags.push(mappedData.straddleAxleMismatch ? "STRADDLE?" : "STRADDLE");
    if (mappedData.isEstimated) tags.push("EST");
    if (!mappedData.licensePlate) tags.push("NOPLATE");
    const tagStr = tags.length ? " " + tags.join(" ") : "";
    const breakdown = `total=${totalMs}ms (insert=${insertMs} find=${findMs}[ocr=${ocrMs} up=${uploadMs} snap=${snapMs}] wait=${imageWaitMs})`;
    logger.info(`${head}${tagStr} #${vehicleID} L${mappedData.lane} cls${mappedData.vehicleClassID} ${plate} ${mappedData.gvw}kg ${mappedData.speed}km/h | ${breakdown}`);
  }

  // [Instrument] ลายเซ็น "ด้านศูนย์" ต่อเพลา — ฝั่งที่เซ็นเซอร์อ่านได้ ~0 (ล้อเลยขอบเลน)
  // ใช้พิสูจน์สมมุติฐานจับคู่คร่อมเลนด้วยฟิสิกส์: เลนซ้าย R0 ↔ เลนขวา L0 = รถคันเดียวคร่อมขอบ
  _zeroSideSignature(data, zeroKg = this.config.straddling_zero_kg || 100) {
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
  _isZeroSideStraddle(data, zeroKg = this.config.straddling_zero_kg || 100) {
    const axles = data.axles || [];
    if (axles.length === 0) return false;
    let allL0 = true, allR0 = true;
    for (const a of axles) {
      if ((a.weightLeft || 0) >= zeroKg) allL0 = false;
      if ((a.weightRight || 0) >= zeroKg) allR0 = false;
    }
    return (allL0 && !allR0) || (allR0 && !allL0); // ฝั่งเดียวศูนย์สม่ำเสมอ (ไม่ใช่ทั้งคู่ศูนย์ = ไม่มีข้อมูล)
  }

  // จัดประเภท "ด้านศูนย์" ของทั้งคัน: "L0" (ซ้ายศูนย์หมด) | "R0" (ขวาศูนย์หมด) | "mixed"
  // ใช้เป็นหลักฐานจับคู่คร่อมเลน: เลนซ้าย R0 ↔ เลนขวา L0 (ตรงข้ามกัน) = รถคันเดียวคร่อมขอบ
  _zeroSideClass(data, zeroKg = this.config.straddling_zero_kg || 100) {
    const axles = data.axles || [];
    if (axles.length === 0) return "mixed";
    let allL0 = true, allR0 = true;
    for (const a of axles) {
      if ((a.weightLeft || 0) >= zeroKg) allL0 = false;
      if ((a.weightRight || 0) >= zeroKg) allR0 = false;
    }
    if (allL0 && !allR0) return "L0";
    if (allR0 && !allL0) return "R0";
    return "mixed";
  }

  // รถ "ไหลทาง" ชิดขอบถนน/เกาะกลาง: ล้อข้างหนึ่งพ้นเซ็นเซอร์ → ไม่มีคู่ให้ merge
  // กู้ด้วยการ mirror น้ำหนักฝั่งที่วัดได้ไปใส่ฝั่งที่หาย = ค่า "ประมาณ" (ติด flag, ไม่ใช้ตรวจน้ำหนักเกิน)
  // ทำเฉพาะตอน orphan + ฝั่งที่หายตรงกับ edge zone ที่ตั้งใน config (กันสับสนกับรถคร่อมเลนจริง)
  // คืน { mirrored, data } — data อาจเป็น object ใหม่ (classifyVehicle สร้างใหม่) จึงต้องรับกลับไปใช้
  _tryEdgeMirror(data) {
    const zones = this.config.mirror_edge_zones || [];
    if (!zones.length) return { mirrored: false, data };            // ฟีเจอร์ปิด (default) — ไม่ log กัน noise
    // [Instrument] เมื่อเปิดฟีเจอร์แล้ว ทุกครั้งที่ไม่ mirror จะ log เหตุผลไว้ไล่ดู (ไม่ต้องเดา)
    const tag = `(ID: ${data.id}, Lane: ${data.lane})`;
    if (data.vehicleClassID === 0) {                                 // reading เสีย (gvw=-1) — ห้าม mirror
      logger.info(`[EdgeMirror][Skip] ${tag} reason=reading เสีย (class 0 / GVW=-1)`);
      return { mirrored: false, data };
    }
    // หาว่าเลนนี้มีขอบถนนด้านไหน (รองรับรถเฉียง: mirror รายเพลา ไม่บังคับทั้งคันเป็นฝั่งเดียวศูนย์)
    const lane = Number(data.lane);
    const leftEdge = zones.some((z) => Number(z.lane) === lane && String(z.side).toUpperCase() === "L");
    const rightEdge = zones.some((z) => Number(z.lane) === lane && String(z.side).toUpperCase() === "R");
    if (!leftEdge && !rightEdge) {                                   // เลนนี้ไม่ได้ตั้งขอบไว้
      logger.info(`[EdgeMirror][Skip] ${tag} reason=เลนนี้ไม่ได้ตั้งขอบใน mirror_edge_zones`);
      return { mirrored: false, data };
    }

    const zeroKg = this.config.straddling_zero_kg || 100;
    const measuredGvw = data.gvw;
    const res = mirrorEdgeAxles(data, leftEdge, rightEdge, zeroKg);  // mirror เฉพาะเพลาที่ฝั่งหายหันออกขอบ
    if (!res.mirrored.length) {                                     // ไม่มีเพลาฝั่งหายหันออกขอบ → ครึ่งคันเดิม
      logger.info(`[EdgeMirror][Skip] ${tag} reason=ไม่มีเพลาฝั่งหายตรงขอบ (edge L=${leftEdge} R=${rightEdge}, zeroKg=${zeroKg}) ZeroSig: ${this._zeroSideSignature(data)}`);
      return { mirrored: false, data: res.data };
    }

    perf.count("edge_mirrored");
    data = res.data;
    data = classifyVehicle(data, this.config);                       // คลาส/ESAL ใหม่บนน้ำหนัก (ประมาณ)
    data = setSingleTire(data, this.singleTires);
    data = calculateESAL(data, this.config, this.vehicleClasses);
    // กันออกใบสั่ง: มีน้ำหนักประมาณปน — ห้ามตัดสินน้ำหนักเกิน
    data.violation = 0;
    data.isOverweight = false;
    data.overweight_percentage = 0;
    data.isEstimated = true;
    data = mapWarningFlag(data);
    data = mapErrorFlag(data);
    logger.info(`[EdgeMirror] รถไหลทาง/เฉียง (ID: ${data.id}, Lane: ${data.lane}) — mirror เพลา [${res.mirrored.join(",")}] ${measuredGvw}kg → ~${data.gvw}kg (ค่าประมาณ, ไม่ตรวจน้ำหนักเกิน) Class ${data.vehicleClassID}`);
    return { mirrored: true, data };
  }

  // ฟังก์ชันสำหรับค้นหาและประมวลผล snapshots
  async findAndProcessSnapshots(mappedData, existingLpr = null, existingOverview = null) {
    // รถยนต์ (class 1) = quiet → service ไม่ log per-image (ลด noise); รถบรรทุก = log + จับเวลาราย stage
    const quiet = !this._isTruck(mappedData.vehicleClassID);
    const timings = { ocrMs: 0, uploadMs: 0, snapMs: 0 };
    // จับเวลาขั้นนั้นๆ → observe (เข้า [Metrics]) + สะสมลง timings (ไปโชว์ใน breakdown รายคัน)
    const timed = async (label, bucket, fn) => {
      const t = perf.timer();
      try { return await fn(); }
      finally { const ms = t(); perf.observe(label, ms); timings[bucket] += ms; }
    };

    // 1. เริ่มค้นหาเฉพาะส่วนที่ยังไม่มีข้อมูล (รองรับการ Retry)
    // Smart Retry: ถ้ามี snapshot เดิมที่เคยหาเจอแล้วแต่ upload พลาด ให้ใช้ใบเดิม
    const lprSearchPromise = !mappedData.platePath
      ? (existingLpr
          ? Promise.resolve(existingLpr)
          : timed("snap_find_lpr_ms", "snapMs", () => this.lprSnapshotManager.findSnapshots(mappedData, "lpr", quiet)))
      : Promise.resolve(null);

    const overviewSearchPromise = !mappedData.overviewPath
      ? (existingOverview
          ? Promise.resolve(existingOverview)
          : timed("snap_find_overview_ms", "snapMs", () => this.overviewSnapshotManager.findSnapshots(mappedData, "overview", quiet)))
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
          : timed("ocr_ms", "ocrMs", () => ocrService.sendToOCR(activeLprSnapshots, this.config.ocr_url, quiet)),
        timed("upload_lpr_ms", "uploadMs", () => this.lprSnapshotManager.uploadImage(activeLprSnapshots.imageUrl, "lpr", activeLprSnapshots.buffer, quiet))
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
          ? await timed("upload_crop_ms", "uploadMs", () => this.cropSnapshotManager.uploadImage(ocrResult.crop_path, "crop", null, quiet))
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
      const uploadResult = await timed("upload_overview_ms", "uploadMs", () => this.overviewSnapshotManager.uploadImage(activeOverviewSnapshots.imageUrl, "overview", activeOverviewSnapshots.buffer, quiet));
      if (uploadResult.success) {
        mappedData.overviewPath = uploadResult.data.fileUrl;
      }
      return activeOverviewSnapshots;
    });

    const [lprRes, overviewRes] = await Promise.all([lprProcessPromise, overviewProcessPromise]);

    // ถ้าตรวจเจอว่าเป็นรถบัสจากป้ายทะเบียน
    if (lprRes && lprRes.exclude) {
      return { continueProcessing: false, isExcluded: true, timings };
    }

    return {
      continueProcessing: true,
      isExcluded: false,
      lprSnapshots: lprSnapshotsFound,
      overviewSnapshots: overviewSnapshotsFound,
      timings
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
      // [Fix F] รถจริงต้องมี ≥2 เพลาเสมอ — 1 เพลา (ล้อเดี่ยว) = noise/มอไซค์/เซ็นเซอร์จับไม่ครบ
      // ตัดทิ้งตั้งแต่ต้น (ก่อนเข้า straddle) → ไม่เป็น orphan ขยะ / ไม่บันทึกเป็นรถ class 19 ที่แสดงผลเพี้ยน
      if ((mappedData.axles?.length || 0) < MIN_AXLES) {
        logger.info(`[Filter] Dropped single-axle (ID: ${ID}, Lane: ${mappedData.lane}, axles=${mappedData.axles?.length || 0})`);
        perf.count("dropped_single_axle"); return;
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
      if (this._isTruck(mappedData.vehicleClassID)) logger.info(`[Pipeline] (ID: ${ID}, Lane: ${mappedData.lane}) Classified: Class ${mappedData.vehicleClassID}, GVW ${mappedData.gvw}kg, Speed ${mappedData.speed}km/h, Axles ${mappedData.axles.length}, Direction ${mappedData.direction}`);

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
        const maxSpeedDiff = this.config.straddling_speed_diff || 15;        // กม./ชม. (fallback = ค่าเดิม)
        const maxWheelbaseDiff = this.config.straddling_wheelbase_diff || 30; // ซม. (fallback = ค่าเดิม)
        const axleTol = this.config.straddling_axle_tol ?? 3;                 // ยอมให้จำนวนเพลาต่างกันได้กี่เพลา (เซ็นเซอร์ 2 เลนนับไม่ตรงกัน) — diff ≥2 ต้องมี zero-side ตรงข้ามยืนยัน


        // [Instrument] log รถที่ติดธงคร่อมเลน + ลายเซ็นด้านศูนย์ (ไว้พิสูจน์การจับคู่ด้วยฟิสิกส์ - ชั้น 3)
        logger.info(`[Straddling][Candidate] Incoming (ID: ${mappedData.id}, Lane: ${mappedData.lane}, Axles: ${mappedData.axles.length}, Speed: ${Number(mappedData.speed).toFixed(1)}km/h) ZeroSide: ${this._zeroSideSignature(mappedData)} | Buffer: ${this.straddlingBuffer.size}`);

        // ค้นหาคู่ใน Buffer (เทียบเวลา + เลนติดกัน + จำนวนเพลา + ระยะฐานล้อ + ความเร็ว)
        for (let [key, bufferedVehicle] of this.straddlingBuffer) {
          const bufferedTime = dayjs(bufferedVehicle.data.stamp);

          // 1. เวลาห่างกันระดับมิลลิวินาที (ไม่เกิน 1 วินาที หรือตาม config)
          const timeDiffMs = Math.abs(currentTime.diff(bufferedTime, 'millisecond'));
          // หน้าต่างจับคู่ = หน้าต่างถือใน buffer (maxDiff วิ) คุมด้วย config ค่าเดียวกัน
          // เดิม cap ที่ 1000ms ทำให้ปรับ config เกิน 1 วิไม่ได้ และคู่ที่มาถึงช่วง 1–3 วิจะหลุดเป็นครึ่งคัน 2 record
          const maxTimeDiffMs = maxDiff * 1000;
          const isTimeOk = timeDiffMs <= maxTimeDiffMs;

          // 2. หมายเลขเลนต้องอยู่ติดกัน
          const isAdjacentLane = Math.abs(Number(bufferedVehicle.data.lane) - Number(mappedData.lane)) === 1;

          // 3. จำนวนเพลาต่างกันได้ไม่เกิน axleTol (รถคร่อมเลนคันเดียวกัน เซ็นเซอร์ 2 เลนมักนับเพลาต่างกัน)
          const axleCountDiff = Math.abs(bufferedVehicle.data.axles.length - mappedData.axles.length);
          const isAxleCountOk = axleCountDiff <= axleTol;
          // เพลาต่างกันมาก (≥2) ต้องมีหลักฐานยืนยันว่าเป็นคันเดียวคร่อมขอบ ก่อนยอม merge (กัน false merge ตอนเปิด axleTol กว้าง)
          // หลักฐานรับได้ 2 อย่าง: (ก) "ด้านศูนย์ตรงข้าม" L0↔R0  หรือ  (ข) ทั้งสอง record ติดธง WIM straddle (bit 9/10)
          // (ข) จำเป็นเพราะรถที่ load มาแค่ 1-2 เพลา เพลาที่เหลือมีน้ำหนัก 2 ฝั่ง → zero-side = "mixed" (ไม่ complementary)
          //     แต่ WIM ยังติดธงถูก → ใช้ธง WIM เป็นหลักฐานแทนได้ (diff ≤1 ใช้เกณฑ์เดิม ไม่ต้องบังคับ)
          const zsBuffered = this._zeroSideClass(bufferedVehicle.data);
          const zsIncoming = this._zeroSideClass(mappedData);
          const isComplementary = (zsBuffered === "L0" && zsIncoming === "R0") || (zsBuffered === "R0" && zsIncoming === "L0");
          const wimStraddle = (d) => !!((d.warningFlags & (1 << 9)) || (d.warningFlags & (1 << 10)));
          const bothWimStraddle = wimStraddle(bufferedVehicle.data) && wimStraddle(mappedData);
          const isAxleEvidenceOk = axleCountDiff <= 1 || isComplementary || bothWimStraddle;

          // ── เศษรถเลนเดียวกัน: controller เลนนี้ตัดรถยาว (ช่องว่าง bogie) เป็น 2 record ───────────
          // อาการ: เลนเดียวกัน + ฝั่งศูนย์เดียวกัน (L0/L0 หรือ R0/R0) + เวลาใกล้กัน
          // → รวม axles หน้า→หลัง เป็นคันเดียวก่อน แล้ว re-buffer รอ match อีกเลน (กัน phantom orphan + เพลาขาด)
          const isSameLane = Number(bufferedVehicle.data.lane) === Number(mappedData.lane);
          const isSameZeroSide = zsBuffered !== "mixed" && zsBuffered === zsIncoming;
          // [Fix E] ระยะห่างประมาณระหว่าง 2 record (เวลา×ความเร็ว) — กันรวมเกิน:
          // ห่างเกินความยาวรถ (FRAGMENT_MAX_GAP_CM) = รถคนละคันบนเลนเดียวกัน ไม่ใช่เศษรถเดียว → ไม่รวม
          const fragGapCm = Math.round((timeDiffMs / 1000) * ((mappedData.speed || 0) / 3.6) * 100);
          if (isTimeOk && isSameLane && isSameZeroSide && fragGapCm <= FRAGMENT_MAX_GAP_CM) {
            clearTimeout(bufferedVehicle.timeoutHandle);
            this.straddlingBuffer.delete(key);
            const [front, rear] = bufferedTime.isBefore(currentTime)
              ? [bufferedVehicle.data, mappedData]
              : [mappedData, bufferedVehicle.data];
            let combined = combineSameLaneFragments(front, rear, fragGapCm);
            combined = classifyVehicle(combined, this.config);
            combined = setSingleTire(combined, this.singleTires);
            combined = mapWarningFlag(combined);
            combined = mapErrorFlag(combined);
            logger.info(`[Straddling][Fragment] Combined same-lane fragments Lane ${combined.lane} (IDs ${front.id}+${rear.id}) → ${combined.axles.length} axles, GVW ${combined.gvw}kg, gap ~${fragGapCm}cm — re-buffering ${maxDiff}s for cross-lane match`);
            perf.count("straddle_fragment_combined");
            const combinedKey = `straddle_${combined.lane}_${combined.stamp.getTime()}_c`;
            const combinedTimeout = setTimeout(async () => {
              const pending = this.straddlingBuffer.get(combinedKey);
              if (pending) { this.straddlingBuffer.delete(combinedKey); await this.processFinalVehicle(pending.data); }
            }, maxDiff * 1000);
            this.straddlingBuffer.set(combinedKey, { data: combined, timeoutHandle: combinedTimeout });
            return; // รวมแล้ว หยุดรอคู่อีกเลน
          }

          // 5. ความเร็วสอดคล้องกัน (ต่างกันไม่เกิน 15 กม./ชม.) — คำนวณเสมอเพื่อเก็บ delta
          const speedDiff = Math.abs(bufferedVehicle.data.speed - mappedData.speed);
          const isSpeedOk = speedDiff <= maxSpeedDiff;

          // 4. ระยะฐานล้อ: เพลาเท่ากัน → เทียบ index ต่อ index; เพลาต่างกัน(ใน tol) → ปล่อยให้ merge align
          //    ด้วยตำแหน่งเพลาสะสมแล้วตัดสิน (คืน null ถ้าจริงๆ เป็นคนละคัน → ตกเป็น orphan ปลอดภัย)
          let wheelbaseMaxDiff = null;
          let isWheelbaseOk = false;
          if (bufferedVehicle.data.fragmentsCombined || mappedData.fragmentsCombined) {
            isWheelbaseOk = true; // เศษที่รวมแล้ว: ตำแหน่งเพลาจุดต่อเป็นค่าประมาณ → ไม่เช็ค strict, อิง axle count + evidence
          } else if (axleCountDiff === 0) {
            wheelbaseMaxDiff = 0;
            for (let i = 1; i < mappedData.axles.length; i++) {
              const d = Math.abs(bufferedVehicle.data.axles[i].wheelbase - mappedData.axles[i].wheelbase);
              if (d > wheelbaseMaxDiff) wheelbaseMaxDiff = d;
            }
            isWheelbaseOk = wheelbaseMaxDiff <= maxWheelbaseDiff;
          } else if (isAxleCountOk) {
            isWheelbaseOk = true; // เลื่อนการตรวจไปที่ merge (align ด้วยตำแหน่งเพลา)
          }

          // [Instrument] log delta จริงของทุกคู่ที่สแกน (ผ่าน/ไม่ผ่านแต่ละเงื่อนไข) ไว้เก็บการกระจายไปจูน threshold (ชั้น 1)
          logger.info(`[Straddling][Compare] Buffered Lane ${bufferedVehicle.data.lane} (ID: ${bufferedVehicle.data.id}) vs Incoming Lane ${mappedData.lane} (ID: ${mappedData.id}) | dTime ${timeDiffMs}ms[${isTimeOk ? "Y" : "N"}] Adjacent[${isAdjacentLane ? "Y" : "N"}] Axles ${bufferedVehicle.data.axles.length}vs${mappedData.axles.length}[${isAxleCountOk ? "Y" : "N"}] Evidence ${zsBuffered}/${zsIncoming}${bothWimStraddle ? "+wim" : ""}[${isAxleEvidenceOk ? "Y" : "N"}] dWheelbase ${wheelbaseMaxDiff === null ? "-" : wheelbaseMaxDiff + "cm"}[${isWheelbaseOk ? "Y" : "N"}] dSpeed ${speedDiff.toFixed(1)}km/h[${isSpeedOk ? "Y" : "N"}]`);

          // เงื่อนไขตัดสินใจ merge — เพลาต่างกันมากต้องมีหลักฐาน (zero-side ตรงข้าม หรือ ติดธง WIM ทั้งคู่) ยืนยัน (isAxleEvidenceOk)
          if (isTimeOk && isAdjacentLane && isAxleCountOk && isAxleEvidenceOk && isWheelbaseOk && isSpeedOk) {
            clearTimeout(bufferedVehicle.timeoutHandle);
            let merged = mergeStraddlingVehicles(bufferedVehicle.data, mappedData, maxWheelbaseDiff);
            if (merged) {
              const leftWeights = bufferedVehicle.data.axles.map(a => a.weightLeft + a.weightRight);
              const rightWeights = mappedData.axles.map(a => a.weightLeft + a.weightRight);
              const mergedWeights = merged.axles.map(a => a.weight);
              const axleNote = merged.straddleAxleMismatch
                ? ` ⚠️AXLE-MISMATCH ${bufferedVehicle.data.axles.length}vs${mappedData.axles.length} (align by position, มีเพลานับด้านเดียว — ควรรีวิว)`
                : "";
              logger.info(`[Straddling] High-precision Match found! Merging vehicles. Time Diff: ${timeDiffMs}ms, Speed Diff: ${speedDiff}km/h.${axleNote} Left Lane ${bufferedVehicle.data.lane} [${leftWeights.join(', ')}] kg + Right Lane ${mappedData.lane} [${rightWeights.join(', ')}] kg -> Merged GVW ${merged.gvw} kg with Axles [${mergedWeights.join(', ')}] kg`);

              mappedData = merged;
              // re-classify + คำนวณ violation/ESAL ใหม่บนน้ำหนักรวม
              // (ครึ่งคันที่ GVW=-1 จะได้ class 0; พอ merge มีน้ำหนักเต็มต้องจำแนกใหม่
              //  + ก่อน merge violation คิดบนครึ่งเดียว → รถเกินจะถูกบันทึกว่าผ่าน)
              mappedData = classifyVehicle(mappedData, this.config);
              mappedData = setSingleTire(mappedData, this.singleTires);
              mappedData = setViolation(mappedData, this.vehicleClasses, [0, 19]);
              mappedData = calculateESAL(mappedData, this.config, this.vehicleClasses);
              // คำนวณ flag ใหม่บนน้ำหนักรวม — single-tire/warning/error อิงน้ำหนักต่อล้อที่เปลี่ยนหลัง merge
              mappedData = mapWarningFlag(mappedData);
              mappedData = mapErrorFlag(mappedData);
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

      // VMS ย้ายไปส่งใน processImagesAndOcrInBackground หลังได้รูป/ป้ายครบ
      // (เดิมส่งตรงนี้ก่อน insert = mappedData ยังไม่มี platePath/overviewPath → จอ VMS ไม่ขึ้นรถ)

      const insertTimer = perf.timer();
      const vehicleID = await insertVehicleWithDetails(mappedData);
      const insertMs = insertTimer();
      if (this._isTruck(mappedData.vehicleClassID)) logger.info(`Data saved successfully for Vehicle ID: ${vehicleID} (ID: ${mappedData.id})`);

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
  transmitVehicle(vehicleID, isTruck = true) {
    setTimeout(() => {
      if (isTruck) logger.info(`[Transmit] (VehicleID: ${vehicleID}) Dispatching to WS + central`);
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
      // ลองกู้รถ "ไหลทาง" ชิดขอบถนนก่อน (mirror เป็นค่าประมาณ) — ถ้าไม่เข้าเงื่อนไขค่อยบันทึกครึ่งคันตามเดิม
      const mirrorResult = this._tryEdgeMirror(mappedData);
      mappedData = mirrorResult.data;
      if (!mirrorResult.mirrored) {
        logger.warn(`[Straddling][Orphan] No partner found for ID: ${mappedData.id} (Lane: ${mappedData.lane}) ZeroSide: ${this._zeroSideSignature(mappedData)} — saving UNMERGED record as-is (อาจเป็นครึ่งคันจริง หรือรถปกติที่ติดธงหลอก) (GVW ${mappedData.gvw}kg)`);
      }
      // VMS ย้ายไปส่งใน processImagesAndOcrInBackground หลังได้รูป/ป้ายครบ (เหมือน path ปกติ)

      const insertTimer = perf.timer();
      const vehicleID = await insertVehicleWithDetails(mappedData);
      const insertMs = insertTimer();
      if (this._isTruck(mappedData.vehicleClassID)) logger.info(`[Straddling] Single part saved successfully for Vehicle ID: ${vehicleID}`);

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

          // เดิม return เงียบ → ป้ายไม่ขึ้นแบบไร้ร่องรอย (V1 มี warn ตรงนี้)
          // log ให้เห็นว่า trigger เลนไหนเข้ามา และ config กล้องมีเลนอะไรบ้าง — ถ้าไม่ตรง = สาเหตุที่ป้ายไม่ขึ้น
          if (!lprSnapshotConfig || !overviewSnapshotConfig) {
            logger.warn(`[Trigger] ไม่มี snapshot config สำหรับ lane ${lane} (lpr=${lprSnapshotConfig ? "Y" : "N"}, overview=${overviewSnapshotConfig ? "Y" : "N"}) — config มี lpr lanes=[${[...this.lprConfigByLane.keys()]}] overview lanes=[${[...this.overviewConfigByLane.keys()]}] → ไม่ถ่ายภาพ`);
            return;
          }

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
    const isTruck = this._isTruck(mappedData.vehicleClassID); // รถยนต์ = log สั้น, รถบรรทุก = log เต็ม
    try {
      if (isTruck) logger.info(`[Pipeline] (ID: ${mappedData.id}, VehicleID: ${vehicleID}) Background start (find images + OCR)`);
      const findTimer = perf.timer();
      const findResult = await this.findAndProcessSnapshots(mappedData);
      const findMs = findTimer();
      const stage = (findResult && findResult.timings) || { ocrMs: 0, uploadMs: 0, snapMs: 0 };
      if (isTruck) logger.info(`[Pipeline] (ID: ${mappedData.id}, VehicleID: ${vehicleID}) Snapshots resolved: lpr=${mappedData.platePath ? "Y" : "N"}, overview=${mappedData.overviewPath ? "Y" : "N"}`);

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
      const dbUpdateTimer = perf.timer();
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
      perf.observe("db_update_ms", dbUpdateTimer());

      if (isTruck) logger.info(`Data updated successfully for Vehicle ID: ${vehicleID}`);
      this._recordVehicleMetrics(mappedData, vehicleID, { totalMs: totalTimer(), findMs, imageWaitMs, insertMs, ocrMs: stage.ocrMs, uploadMs: stage.uploadMs, snapMs: stage.snapMs });

      // ส่ง VMS หลังได้รูป/ป้ายครบ — mappedData มี platePath/overviewPath/licensePlate แล้ว (เทียบเท่า V1)
      // ส่งเมื่อมี led_url (ไม่พึ่ง led_enabled); sendToVMS no-op เองถ้า url ว่าง
      if (this.config.led_url) {
        // ปัญหาเงียบที่เคยเจอ: ถ้าไม่มี overview -> imps_vms ตอบ 200 แต่ป้ายไม่ขึ้นรูป -> เด้ง warn ให้เห็นสาเหตุ
        if (!mappedData.overviewPath) {
          logger.warn(`[LED] NO-OVERVIEW: sent to VMS but no overview image, sign won't show vehicle (ID: ${mappedData.id}, Lane: ${mappedData.lane})`);
        }
        if (isTruck) logger.info(`[LED] (ID: ${mappedData.id}, Lane: ${mappedData.lane}) Dispatching to VMS`);
        sendToVMS(this.config.led_url, mappedData);
      } else {
        logger.warn(`[LED] LED-URL-EMPTY: vehicle passed but led_url not set, VMS off (ID: ${mappedData.id})`);
      }

      // ดึงข้อมูล 3D (ถ้ามีกำหนดไว้)
      if (threeDimensionBase) {
        try {
          const threedTimer = perf.timer();
          const threeDimensionData = await getThreeDimension(threeDimensionBase, mappedData, vehicleID);
          perf.observe("threed_ms", threedTimer());
          if (threeDimensionData) await insertThreeDimensionWithWarnings(threeDimensionData);
        } catch (err) { logger.error(`Error processing threeDimension: ${err.stack || err}`); }
      }

      // ส่งสัญญาณ WebSocket และส่งข้อมูลไปส่วนกลาง
      this.transmitVehicle(vehicleID, isTruck);
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
