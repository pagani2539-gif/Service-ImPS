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
const axios = require("axios");
const ocrService = require("../utils/ocrService");
const pool = require("../config/db");
const path = require("path");
const logger = require("../utils/logger");
const perf = require("../utils/perfMonitor");
const { insertVehicleWithDetails, updatePlates, updateOverview } = require("../services/vehiclesService");
const baseImagePath = path.join(process.cwd(), "public/snapshots");
const transmissionUrl = process.env.TRANSMISSION_URL || '';
// ซ้าย(ch1)+ขวา(ch2) ของรถคันเดียวยิง trigger แทบพร้อมกัน — ถ่าย snapshot ใบเดียวภายในช่วงนี้พอ
const TRIGGER_DEBOUNCE_MS = Number(process.env.TRIGGER_DEBOUNCE_MS) || 250;
// Watchdog: ถ้ามีรถเข้าแต่ไม่มี trigger เกิน TRIGGER_SILENCE_MS → trigger sensor อาจพังเงียบๆ (ป้ายหาย ไม่มี error)
const TRIGGER_SILENCE_MS  = Number(process.env.TRIGGER_SILENCE_MS)  || 30000; // ไม่มี trigger กี่ ms = เงียบ
const TRIGGER_WATCHDOG_MS = Number(process.env.TRIGGER_WATCHDOG_MS) || 15000; // เช็คทุกกี่ ms
// HEAD readiness check: รอจนไฟล์รูป serve ได้จริงก่อนแจ้ง browser (กันภาพ 404 ต้องกด F5) — ปรับผ่าน env ได้
const TRANSMIT_READY_CAP_MS  = Number(process.env.TRANSMIT_READY_CAP_MS)  || 1500; // เพดานรอสูงสุด (กันค้างถ้า image server ล่ม)
const TRANSMIT_READY_POLL_MS = Number(process.env.TRANSMIT_READY_POLL_MS) || 50;   // ความถี่เช็คไฟล์
// Base ของ image server สำหรับเช็ค servable เมื่อ image server คืน fileUrl แบบ relative
// (กัน F5: เดิม relative URL ทำให้ _waitImagesServable ข้ามเช็คทั้งหมด → แจ้ง browser ก่อนรูปพร้อม serve → ภาพ 404 ต้องกด F5)
// ลำดับหา base: IMAGE_SERVE_BASE_URL (ตั้งเอง) → origin ของ upload URL (overview/lpr) ; ว่าง = เช็คไม่ได้ ข้ามเหมือนเดิม
// หมายเหตุ: เช็คเป็น server→image-server วงใน ไม่เกี่ยวกับเส้นทาง browser → ไม่กระทบ forward port
const _originOf = (u) => { try { return new URL(u).origin; } catch { return ''; } };
const IMAGE_SERVE_BASE = (process.env.IMAGE_SERVE_BASE_URL || '').replace(/\/+$/, '')
  || _originOf(process.env.IMAGE_OVERVIEW_UPLOAD_URL || '')
  || _originOf(process.env.IMAGE_LPR_UPLOAD_URL || '');
const threeDimensionBase = process.env.THREE_DIMENSION_BASE || '';
// ค่าคงที่ทางกายภาพ (สากล ไม่ขึ้นกับสถานี → hardcode, ไม่ต้องตั้ง DB; override ผ่าน env ได้ถ้าจำเป็น)
const FRAGMENT_MAX_GAP_CM = Number(process.env.FRAGMENT_MAX_GAP_CM) || 2500; // รถยาวสุด ~25ม. — เกินนี้ = คนละคัน ไม่ใช่เศษรถเดียว
const MIN_AXLES = Number(process.env.MIN_AXLES) || 2;                        // รถจริงต้องมี ≥2 เพลา — 1 เพลา = noise/จับไม่ครบ
// Sanity check กันข้อมูล WIM เพี้ยน (มอไซค์ล้อแถวเดียว/เพลาผีจากการซอย) — override ผ่าน env ได้
const GVW_AXLE_CONSISTENCY_MIN = Number(process.env.GVW_AXLE_CONSISTENCY_MIN) || 0.5; // gvw กับผลรวมเพลา min/max ratio ต่ำกว่านี้ = เพี้ยน
const MIN_AXLE_SPACING_CM      = Number(process.env.MIN_AXLE_SPACING_CM)      || 40;  // ระยะระหว่างเพลาขั้นต่ำที่เป็นจริง (ซม.) — ต่ำกว่านี้ = เพลาผี

// [Diag] เก็บข้อมูลวินิจฉัยเชิงลึก (เฟส 1) — เปิดด้วย env DIAG=1 เท่านั้น
// ปิด (ค่าเริ่มต้น) = ไม่มี log/overhead เพิ่ม, พฤติกรรมระบบเหมือนเดิมเป๊ะ (อ่านอย่างเดียว ไม่แตะ flow ตัด/เก็บ/merge)
const DIAG = process.env.DIAG === "1";
// log บรรทัด diag เป็น `[Diag][Tag] {json}` — parse ง่ายด้วย analyze-diag.js; gate ด้วย DIAG
const diag = (tag, payload) => { if (DIAG) logger.info(`[Diag][${tag}] ${JSON.stringify(payload)}`); };
// counter/sample เฉพาะตอน DIAG เปิด (โผล่ใน [Metrics Summary] เอง) — ปิดแล้วไม่เพิ่ม metric
const diagCount = (name, n = 1) => { if (DIAG) perf.count(name, n); };
const diagObserve = (name, ms) => { if (DIAG) perf.observe(name, ms); };

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
    // [task1] ดัชนีรถที่เพิ่งผ่าน (insert/GVW=-1) ไว้จับคู่ครึ่งคันคร่อมเลนที่ controller ติดธงไม่สมมาตร
    // เก็บ { lane, stampMs(StartTime), gvw, type:'real'|'gvw-1', at } อายุสั้น (prune ตามหน้าต่างจับคู่)
    this.recentVehicles = [];
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
    // ค่าจูน straddle ปรับผ่าน .env เท่านั้น (ไม่ได้ SELECT จาก DB/UI) — log โชว์ชื่อ env var ของแต่ละค่า
    // ยกเว้น time_diff (STRADDLING_TIME_DIFF) ที่ SELECT จาก DB ได้ด้วย; ที่เหลือ = env หรือ default
    logger.info(`[Straddling] tuning (env/default, ไม่ผ่าน DB/UI): axle_tol=${this.config.straddling_axle_tol}[STRADDLING_AXLE_TOL] time_diff=${this.config.straddling_time_diff}s[STRADDLING_TIME_DIFF/DB] speed_diff=${this.config.straddling_speed_diff}[STRADDLING_SPEED_DIFF] wheelbase_diff=${this.config.straddling_wheelbase_diff}cm[STRADDLING_WHEELBASE_DIFF] zero_kg=${this.config.straddling_zero_kg}[STRADDLING_ZERO_KG] | B2: match_ms=${this.config.straddle_match_ms}[STRADDLE_MATCH_MS] confirm_ms=${this.config.straddle_confirm_ms}[STRADDLE_CONFIRM_MS] partner_floor=${this.config.straddle_partner_floor}[STRADDLE_PARTNER_FLOOR]`);

    // Watchdog เตือน trigger sensor เงียบ (socket เปิดแต่ไม่ส่ง trigger ทั้งที่มีรถเข้า)
    this.lastTriggerAt = 0;          // เวลา trigger ล่าสุด (นับทุก trigger แม้โดน debounce)
    this.lastDataAt = 0;             // เวลามีรถเข้าล่าสุด (data message)
    this.triggerSilentWarned = false;
    this._startTriggerWatchdog();
  }

  // เฝ้าดู: มีรถเข้าแต่ trigger เงียบเกิน TRIGGER_SILENCE_MS → เตือนครั้งเดียว (sensor พังจริง ไม่ใช่สถานีว่าง)
  _startTriggerWatchdog() {
    this.triggerWatchdog = setInterval(() => {
      const now = Date.now();
      const dataRecent = this.lastDataAt && (now - this.lastDataAt) < TRIGGER_SILENCE_MS;
      const triggerSilent = !this.lastTriggerAt || (now - this.lastTriggerAt) > TRIGGER_SILENCE_MS;
      if (dataRecent && triggerSilent) {
        if (!this.triggerSilentWarned) {
          const secs = this.lastTriggerAt ? `${Math.round((now - this.lastTriggerAt) / 1000)}s` : "(ไม่เคยมา)";
          logger.error(`[Trigger][Watchdog] ไม่มี trigger ${secs} ทั้งที่มีรถเข้า — trigger sensor อาจพัง (ภาพป้ายจะไม่ขึ้น)`);
          perf.count("trigger_sensor_silent");
          this.triggerSilentWarned = true;
        }
      } else if (this.triggerSilentWarned && !triggerSilent) {
        logger.info(`[Trigger][Watchdog] trigger กลับมาแล้ว (recovered)`);
        this.triggerSilentWarned = false;
      }
    }, TRIGGER_WATCHDOG_MS);
    if (this.triggerWatchdog.unref) this.triggerWatchdog.unref();
  }

  async stop() {
    logger.info(`Stopping DataLogger for station: ${this.config.station_name}`);
    if (this.triggerWatchdog) clearInterval(this.triggerWatchdog);
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
    // [Diag] ทุกคันที่บันทึกจริง (หลังได้ป้าย/รูป) — Veh (E, บัส) + WIM (I, คาลิเบรต) + per-lane (H)
    if (DIAG) {
      const axleSum = this._axleWeightSum(mappedData);
      const gvw = Number(mappedData.gvw) || 0;
      const ratio = gvw > 0 && axleSum > 0 ? Number((Math.min(gvw, axleSum) / Math.max(gvw, axleSum)).toFixed(2)) : null;
      const plate = mappedData.licensePlate || "";
      const prefix = plate.replace(/[-\s]/g, "").slice(0, 2);
      diag("Veh", {
        id: mappedData.id, vehId: vehicleID, lane: mappedData.lane, cls: mappedData.vehicleClassID,
        axleCount: (mappedData.axles || []).length, frontWb: mappedData.axles?.[1]?.wheelbase ?? null,
        gvw, plateRead: !!mappedData.licensePlate, prefix, merged: !!mappedData.isStraddlingMerged,
      });
      diag("WIM", { id: mappedData.id, lane: mappedData.lane, gvw, axleSum, ratio });
      diagCount(`lane${mappedData.lane}_inserted`);
      // บัสต้องสงสัย class 3+ ที่ป้ายอ่านไม่ออก (กลุ่มที่หลุดได้)
      if (mappedData.vehicleClassID >= 3 && !mappedData.licensePlate) diagCount("diag_bus_class3plus_noplate");
    }
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
    if (!mappedData.licensePlate) tags.push("NOPLATE");
    const tagStr = tags.length ? " " + tags.join(" ") : "";
    const breakdown = `total=${totalMs}ms (insert=${insertMs} find=${findMs}[ocr=${ocrMs} up=${uploadMs} snap=${snapMs}] wait=${imageWaitMs})`;
    logger.info(`${head}${tagStr} #${vehicleID} L${mappedData.lane} cls${mappedData.vehicleClassID} ${plate} ${mappedData.gvw}kg ${mappedData.speed}km/h | ${breakdown}`);
  }

  // ───── [task1] จับคู่ครึ่งคันคร่อมเลนข้ามเลน (controller ติดธงไม่สมมาตร) ─────
  // TTL ของดัชนี = หน้าต่างถือ buffer + เผื่อ 2 วิ
  _recentTtlMs() { return ((this.config.straddling_time_diff || 3) + 2) * 1000; }

  // บันทึกรถที่เพิ่งผ่าน (insert จริง หรือ GVW=-1 ที่ถูก drop) — ใช้ให้ครึ่งติดธงที่มาทีหลังหาคู่เจอ
  _recordRecentVehicle(lane, stampMs, gvw, type) {
    this.recentVehicles.push({ lane: Number(lane), stampMs, gvw, type, at: Date.now() });
    if (this.recentVehicles.length > 300) {
      const now = Date.now(), ttl = this._recentTtlMs();
      this.recentVehicles = this.recentVehicles.filter((r) => now - r.at <= ttl);
    }
  }

  // หา "คู่ข้ามเลน" ที่เพิ่งผ่าน: เลนติดกัน (|Δ|=1) + StartTime ห่าง ≤ win — prune ของเก่าด้วย
  // win = หน้าต่างเวลา (ms); typeFilter = predicate เลือกชนิดคู่ (เช่น เฉพาะ "real" หรือเฉพาะสัญญาณคร่อมเลน)
  _findCrossLanePartner(lane, stampMs, win = this.config.straddle_match_ms || 50, typeFilter = null) {
    const now = Date.now(), ttl = this._recentTtlMs();
    this.recentVehicles = this.recentVehicles.filter((r) => now - r.at <= ttl);
    return this.recentVehicles.find(
      (r) => Math.abs(r.lane - Number(lane)) === 1 && Math.abs(r.stampMs - stampMs) <= win &&
             (!typeFilter || typeFilter(r.type))
    ) || null;
  }

  // [B1] รถ "ไม่ติดธง" กำลังจะ insert — เช็คว่ามีครึ่ง "ติดธง" รออยู่ใน buffer เลนติดกัน StartTime ตรงไหม
  // เจอ = รถคร่อมเลนที่ controller ติดธงครึ่งเดียว → resolve เป็นคันเดียว (เลือกใบหนักกว่า) คืน record ตัวจริง; ไม่เจอคืน null
  _tryClaimBufferedPartner(incoming) {
    const win = this.config.straddle_match_ms || 50;
    const stampMs = incoming.stamp.getTime();
    for (const [key, buffered] of this.straddlingBuffer) {
      const b = buffered.data;
      if (Math.abs(Number(b.lane) - Number(incoming.lane)) !== 1) continue;
      if (Math.abs(b.stamp.getTime() - stampMs) > win) continue;
      // เจอคู่ — ยกเลิก timeout ครึ่งที่รอ + เอาออกจาก buffer (ไม่ให้มันกลายเป็น orphan/mirror แยก)
      clearTimeout(buffered.timeoutHandle);
      this.straddlingBuffer.delete(key);
      // เลือกใบ gvw สูงกว่า = อ่านครบกว่า (ครึ่งฝั่งเดียวมักเบากว่าใบสองฝั่ง) — กัน double-count จากการทับซ้อน
      const incGvw = Number(incoming.gvw) || 0, bGvw = Number(b.gvw) || 0;
      const heavier = incGvw >= bGvw ? incoming : b;
      heavier.isStraddlingMerged = true;
      heavier.straddleAxleMismatch = true; // ไม่สมมาตร (เลือกใบ ไม่ได้รวมเพลา) — ให้รีวิว/แสดงผลรู้
      heavier.originalLanes = [Number(b.lane), Number(incoming.lane)];
      diag("CrossLane", { id: incoming.id, lane: incoming.lane, partnerId: b.id, partnerLane: b.lane, dTime: Math.abs(b.stamp.getTime() - stampMs), partnerFound: true, partnerType: "real", action: "pick-heavier", chosenGvw: heavier.gvw, partnerGvw: heavier === incoming ? bGvw : incGvw, enforced: true });
      perf.count("crossLane_realPartner");
      perf.count("crossLane_dupSuppressed");
      logger.info(`[Straddling][CrossLane] Asymmetric pair Lane ${b.lane}(${b.id}) + Lane ${incoming.lane}(${incoming.id}) → เลือกใบหนัก ${heavier.gvw}kg (กัน record ซ้ำ)`);
      return heavier;
    }
    return null;
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

  // ผลรวมน้ำหนักจากเพลาจริง (ซ้าย+ขวา ทุกเพลา) — ใช้เทียบกับ gvw ดิบของ WIM
  _axleWeightSum(data) {
    return (data.axles || []).reduce((s, a) => s + (a.weightLeft || 0) + (a.weightRight || 0), 0);
  }

  // [Diag] ฟิลด์พื้นฐานที่ใช้ซ้ำในหลาย diag log (id/lane/น้ำหนัก/ลายเซ็นคร่อมเลน) — อ่านอย่างเดียว ไม่แก้ data
  _diagBase(data) {
    return {
      id: data.id,
      lane: data.lane,
      gvw: data.gvw,
      axleSum: this._axleWeightSum(data),
      axleCount: (data.axles || []).length,
      frontWb: data.axles?.[1]?.wheelbase ?? null,           // ฐานล้อหน้า (เพลา1→2) ใช้ดูบัส
      wim: !!((data.warningFlags & (1 << 9)) || (data.warningFlags & (1 << 10))), // WIM ติดธงคร่อมเลน
      zero: this._zeroSideSignature(data),                   // ลายเซ็นด้านศูนย์
      stampMs: data.stamp instanceof Date ? data.stamp.getTime() : null,
    };
  }

  // ตรวจ reading ที่ "เป็นไปไม่ได้ทางกายภาพ" (WIM อ่านเพี้ยน/มอไซค์ถูกซอยเป็นเพลาผี)
  // คืน "เหตุผล" (string) ถ้าเพี้ยน, คืน null ถ้าปกติ
  _implausibleReason(data) {
    const axles = data.axles || [];
    const axleSum = this._axleWeightSum(data);
    const gvw = Number(data.gvw) || 0;

    // (1) gvw ดิบขัดกับผลรวมเพลาเกินทน — ตัวชี้ขาดที่ดีสุด (เช่น gvw 1184 vs ผลรวม 190 → ratio 0.16)
    if (gvw > 0 && axleSum > 0) {
      const ratio = Math.min(gvw, axleSum) / Math.max(gvw, axleSum);
      if (ratio < GVW_AXLE_CONSISTENCY_MIN)
        return `gvw/axle mismatch (gvw=${gvw}, axleSum=${axleSum}, ratio=${ratio.toFixed(2)})`;
    }

    // (2) ล้อแถวเดียว (ฝั่งหนึ่งศูนย์สนิททุกเพลา) + น้ำหนักจริงต่ำกว่า half-floor = มอเตอร์ไซค์
    //     (รถบรรทุกคร่อมขอบจริง: ฝั่งที่วัดได้ยังหนักเป็นพัน กก. → ไม่โดนตัด รอ merge ตามเดิม)
    const leftTotal  = axles.reduce((s, a) => s + (a.weightLeft  || 0), 0);
    const rightTotal = axles.reduce((s, a) => s + (a.weightRight || 0), 0);
    const oneSided = (leftTotal === 0) !== (rightTotal === 0);
    const halfFloor = (this.config.gvw_ignored || 0) / 2;
    if (oneSided && Math.max(leftTotal, rightTotal) < halfFloor)
      return `single wheel-track too light (detected=${Math.max(leftTotal, rightTotal)}kg < ${halfFloor})`;

    // (3) ระยะเพลาเป็นไปไม่ได้ (เพลาผีจากการซอย) — wheelbase[i] = ระยะจากเพลา i-1 (ซม.)
    for (let i = 1; i < axles.length; i++) {
      const wb = axles[i].wheelbase;
      if (wb > 0 && wb < MIN_AXLE_SPACING_CM)
        return `impossible axle spacing (axle ${i + 1} = ${wb}cm)`;
    }
    return null;
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

  // (ลบ _tryEdgeMirror (edge-zone) — Type-2 mirror ใน processFinalVehicle แทนแล้ว: mirror by zero-side ทุกเลน)

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
          : timed("snap_find_lpr_ms", "snapMs", () => this.lprSnapshotManager.findSnapshotCandidates(mappedData, "lpr", quiet)))
      : Promise.resolve(null);

    const overviewSearchPromise = !mappedData.overviewPath
      ? (existingOverview
          ? Promise.resolve(existingOverview)
          : timed("snap_find_overview_ms", "snapMs", () => this.overviewSnapshotManager.findSnapshots(mappedData, "overview", quiet)))
      : Promise.resolve(null);

    let lprSnapshotsFound = existingLpr;
    let overviewSnapshotsFound = existingOverview;

    // 2. จัดการส่วน LPR — parallel-first: เฟรม1 OCR ‖ upload (รถปกติเร็วเท่าเดิม); เฟรม1 พลาดค่อย escalate เฟรมอื่น
    const lprProcessPromise = lprSearchPromise.then(async (lprFound) => {
      // findSnapshotCandidates คืน array (อาจหลายเฟรม/burst หรือหลายเลน/คร่อม); retry (existingLpr) คืนใบเดียว → normalize
      const candidates = Array.isArray(lprFound) ? lprFound.filter(Boolean) : (lprFound ? [lprFound] : []);
      if (candidates.length === 0) return null;
      const primary = candidates[0];
      lprSnapshotsFound = primary;

      // --- retry: เคย OCR รูปนี้สำเร็จแล้ว (cache) → reuse ไม่ OCR ซ้ำ ---
      const cachedOcr = this.ocrResultCache.get(primary.imageUrl);
      if (cachedOcr) {
        const up = await timed("upload_lpr_ms", "uploadMs", () => this.lprSnapshotManager.uploadImage(primary.imageUrl, "lpr", primary.buffer, quiet));
        if (isVehicleExcludedByPlate(cachedOcr.license_plate)) {
          if (DIAG) diag("Plate", { id: mappedData.id, lane: mappedData.lane, cls: mappedData.vehicleClassID, axleCount: (mappedData.axles || []).length, frontWb: mappedData.axles?.[1]?.wheelbase ?? null, plate: cachedOcr.license_plate });
          return { exclude: true };
        }
        const cropUp = cachedOcr.crop_path
          ? await timed("upload_crop_ms", "uploadMs", () => this.cropSnapshotManager.uploadImage(cachedOcr.crop_path, "crop", null, quiet))
          : { success: false };
        if (up.success) mappedData.platePath = up.data.fileUrl;
        if (cropUp.success) mappedData.cropPath = cropUp.data.fileUrl;
        mappedData.licensePlate = formatLicensePlate(cachedOcr.license_plate);
        mappedData.province = cachedOcr.province;
        return { exclude: false, snapshots: primary };
      }

      // --- เฟรม 1: OCR ‖ upload (ขนานกัน เหมือน flow เดิม → รถ ~93% ที่อ่านออกเฟรมแรกไม่ช้าลง) ---
      let [ev, winnerUpload] = await Promise.all([
        timed("ocr_ms", "ocrMs", () => ocrService.evaluateSnapshot(primary, this.config.ocr_url, quiet)),
        timed("upload_lpr_ms", "uploadMs", () => this.lprSnapshotManager.uploadImage(primary.imageUrl, "lpr", primary.buffer, quiet)),
      ]);
      let winner = primary;
      let winnerIdx = 0; // เฟรม/ใบที่ชนะ (0 = เฟรมแรก) — ใช้ log [frame x/y]

      // --- escalate: เฟรม 1 อ่านไม่ออก + ยังมีเฟรม/เลนอื่น → OCR ใบที่เหลือ เลือกใบดีที่สุดตามตาราง ---
      if (ev.status !== "read" && candidates.length > 1) {
        perf.count("lpr_escalated");
        const evals = [ev];
        for (let i = 1; i < candidates.length; i++) {
          evals.push(await timed("ocr_ms", "ocrMs", () => ocrService.evaluateSnapshot(candidates[i], this.config.ocr_url, quiet)));
          if (evals[i].status === "read" && evals[i].province) break; // ดีสุด (อ่านออก+จังหวัด) หยุด
        }
        const idx = ocrService.pickBestPlate(evals, candidates.slice(0, evals.length));
        if (idx !== 0) {
          if (evals[idx].status === "read") perf.count("plate_recovered_by_extra_frame"); // เฟรมอื่นกู้ป้ายได้
          winner = candidates[idx];
          winnerIdx = idx;
          ev = evals[idx];
          lprSnapshotsFound = winner;
          // upload ใบที่ชนะ (เฟรม1 อัปโหลดไปแล้วแต่ไม่ใช่ตัวชนะ)
          winnerUpload = await timed("upload_lpr_ms", "uploadMs", () => this.lprSnapshotManager.uploadImage(winner.imageUrl, "lpr", winner.buffer, quiet));
        }
      }

      // --- ผลลัพธ์ ---
      if (ev.status === "read" && ev.license_plate) {
        const cropPath = ev.position ? await ocrService.cropImage(ev.plate_path, ev.position, winner.imageUrl) : null;
        // cache ผล winner แบบ single-shape ให้ retry path reuse
        this.ocrResultCache.set(winner.imageUrl, {
          license_plate: ev.license_plate, province: ev.province,
          position: ev.position, plate_path: ev.plate_path, crop_path: cropPath,
        });
        if (this.ocrResultCache.size > 50) {
          this.ocrResultCache.delete(this.ocrResultCache.keys().next().value);
        }
        if (!quiet) logger.info(`[OCR] Plate: ${ev.license_plate} (${ev.province || "N/A"}) [frame ${winnerIdx + 1}/${candidates.length}] (${path.basename(winner.imageUrl)})`);

        if (isVehicleExcludedByPlate(ev.license_plate)) {
          // [Diag][Plate] (F) — บัส/รถโดยสารที่รู้แน่จากป้าย
          if (DIAG) diag("Plate", { id: mappedData.id, lane: mappedData.lane, cls: mappedData.vehicleClassID, axleCount: (mappedData.axles || []).length, frontWb: mappedData.axles?.[1]?.wheelbase ?? null, plate: ev.license_plate });
          return { exclude: true };
        }
        const cropUploadResult = cropPath
          ? await timed("upload_crop_ms", "uploadMs", () => this.cropSnapshotManager.uploadImage(cropPath, "crop", null, quiet))
          : { success: false };
        if (winnerUpload.success) mappedData.platePath = winnerUpload.data.fileUrl;
        if (cropUploadResult.success) mappedData.cropPath = cropUploadResult.data.fileUrl;
        mappedData.licensePlate = formatLicensePlate(ev.license_plate);
        mappedData.province = ev.province;
      } else {
        // อ่านไม่ออกทุกเฟรม → ใช้ภาพ winner (ดีสุดเท่าที่มี) เป็น platePath (คัดกรองบัสด้วยฐานล้อทำที่ handleDataMessage แล้ว)
        if (!quiet) logger.info(`[OCR] No plate detected [frame ${winnerIdx + 1}/${candidates.length}] (${path.basename(winner.imageUrl)})`);
        if (winnerUpload.success) mappedData.platePath = winnerUpload.data.fileUrl;
      }
      return { exclude: false, snapshots: winner };
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
    this.lastDataAt = Date.now(); // watchdog: มีรถเข้า (ใช้เทียบกับ lastTriggerAt)
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
        if (DIAG) diag("Drop", { ...this._diagBase(mappedData), reason: "reverse", dir: mappedData.direction });
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
        // [task1] บันทึกเป็น "สัญญาณคู่คร่อมเลน" — ครึ่งติดธงอีกเลนที่มาทีหลังจะรู้ว่ามีคู่ (แม้ -1 ใช้น้ำหนักไม่ได้)
        this._recordRecentVehicle(mappedData.lane, mappedData.stamp.getTime(), -1, "gvw-1");
        // [Diag][GVW-1] (B) — เก็บน้ำหนักล้อรายเพลาตอน GVW=-1 เพื่อพิสูจน์ว่า "เชื่อได้" หรือเป็นขยะ (ก่อนตัดสินกู้ในเฟส 2)
        if (DIAG) {
          const reason = this._implausibleReason(mappedData);
          const perAxle = (mappedData.axles || []).map(a => ({ l: a.weightLeft || 0, r: a.weightRight || 0, wb: a.wheelbase || 0 }));
          diag("GVW-1", { ...this._diagBase(mappedData), perAxle, implausible: reason });
          // plausible = กู้ได้ (ผ่าน implausible + ฝั่งศูนย์ข้างเดียว + axleSum ≥ floor) / junk = ทิ้งถูกแล้ว
          const okFloor = this._axleWeightSum(mappedData) >= (this.config.gvw_ignored / 2);
          diagCount(!reason && this._isZeroSideStraddle(mappedData) && okFloor ? "diag_gvw1_plausible" : "diag_gvw1_junk");
          diagCount(`lane${mappedData.lane}_gvw1`);
        }
        perf.count("dropped_error"); return;
      }
      // [Round5 A] คำนวณ isStraddleFlagged + floor "ก่อน" noise filters → ใช้ทิ้งรอยคู่คร่อมเลนทุก drop path
      // ติดธงคร่อมเลนจาก WIM (warning 9/10) หรือจาก "ด้านศูนย์" ที่เราตรวจเอง (เผื่อ WIM ไม่ติดธงให้ครึ่งคัน)
      const isStraddleFlagged = (mappedData.warningFlags & (1 << 9)) || (mappedData.warningFlags & (1 << 10)) || this._isZeroSideStraddle(mappedData);
      const straddleFloor = this.config.gvw_ignored / 2; // ครึ่งคันรถบรรทุกยังหนักเป็นพัน กก.; มอไซค์ต่ำกว่านี้
      // [Round6] floor ของ "ทิ้งรอย sliver" แยกจาก gvw_ignored — sliver = ล้อไม่กี่เพลา เบาเป็นธรรมชาติ
      // (1 เพลา = sliver เสมอ, มอไซค์ = 2 เพลา ถูก implausible ตัดอยู่แล้ว) → floor ต่ำได้ปลอดภัย, ปรับ env STRADDLE_PARTNER_FLOOR ได้
      const partnerFloor = this.config.straddle_partner_floor || 1000;
      // ทิ้งรอยครึ่งคร่อมเลนที่หนักพอ (≥partnerFloor) ก่อน filter ตัด → B2 (อีกครึ่ง) หาคู่เจอ ไม่บันทึกครึ่งเดี่ยว/รถผี
      const _recordDroppedPartner = () => {
        if ((Number(mappedData.gvw) || 0) >= partnerFloor)
          this._recordRecentVehicle(mappedData.lane, mappedData.stamp.getTime(), Number(mappedData.gvw) || 0, "dropped");
      };

      // [Fix F] รถจริงต้องมี ≥2 เพลาเสมอ — 1 เพลา (ล้อเดี่ยว) = noise/มอไซค์/เซ็นเซอร์จับไม่ครบ
      // ตัดทิ้งตั้งแต่ต้น (ก่อนเข้า straddle) → ไม่เป็น orphan ขยะ / ไม่บันทึกเป็นรถ class 19 ที่แสดงผลเพี้ยน
      if ((mappedData.axles?.length || 0) < MIN_AXLES) {
        logger.info(`[Filter] Dropped single-axle (ID: ${ID}, Lane: ${mappedData.lane}, axles=${mappedData.axles?.length || 0})`);
        if (DIAG) { diag("Drop", { ...this._diagBase(mappedData), reason: "single-axle" }); diagCount(`lane${mappedData.lane}_single_axle`); }
        // [Round5 A] sliver 1 เพลาที่ติดธงคร่อมเลน = ครึ่งของรถคร่อมเลน → ทิ้งรอย (1 เพลา ≠ มอไซค์ 2 เพลา)
        if (isStraddleFlagged) _recordDroppedPartner();
        perf.count("dropped_single_axle"); return;
      }
      // [Fix] ตัด reading ที่ "เป็นไปไม่ได้ทางกายภาพ" ก่อนเข้า straddle — กันมอไซค์/ข้อมูลเพี้ยน
      // ถูกมองเป็นครึ่งคันแล้วบันทึกเป็น orphan (เช่น gvw 1184 แต่ผลรวมเพลา 190 / ล้อแถวเดียว / เพลาผี)
      const implausible = this._implausibleReason(mappedData);
      if (implausible) {
        logger.info(`[Filter] Dropped implausible reading (ID: ${ID}, Lane: ${mappedData.lane}) — ${implausible}`);
        if (DIAG) { diag("Drop", { ...this._diagBase(mappedData), reason: "implausible", detail: implausible }); diagCount(`lane${mappedData.lane}_implausible`); }
        // [Round5 A] "ตัวรถหลัก 2-ฝั่งหนัก" ที่ระยะเพลาเพี้ยนเพราะคร่อมเลน (เคส body 29,820 ถูก drop) → ทิ้งรอย
        // gate ด้วย floor เท่านั้น (ไม่บังคับ flagged เพราะ body 2-ฝั่งไม่ติดธง) → B2 รู้ว่ามีคู่ ไม่สร้างรถผี
        _recordDroppedPartner();
        perf.count("dropped_implausible"); return;
      }
      if (ignoreGVW(mappedData.gvw, this.config.gvw_ignored)) {
        if (!isStraddleFlagged || mappedData.gvw < straddleFloor) {
          logger.info(`[Filter] Dropped by GVW (ID: ${ID}, Lane: ${mappedData.lane}, GVW: ${mappedData.gvw}kg${isStraddleFlagged ? ", straddle-flagged but below half-floor" : ""})`);
          // [Diag][Drop] — log เต็มเฉพาะที่ "ติดธงคร่อมเลน" (อาจเป็นคู่ครึ่งคันที่หาย); รถเล็กปกติ (ไม่ flagged ~9k/วัน) นับรวมพอ กัน log ท่วม
          if (DIAG && isStraddleFlagged) {
            diag("Drop", { ...this._diagBase(mappedData), reason: "gvw-floor", floor: straddleFloor, gvwIgnored: this.config.gvw_ignored });
            diagCount("diag_drop_straddle_flagged");
            diagCount(`lane${mappedData.lane}_junk`);
          }
          // [task1 B2] ครึ่งคันคร่อมเลนของแท้ (controller ติดธงเอง) แต่เบากว่า floor — ตัดทิ้งน้ำหนัก
          // แต่ทิ้งรอย lane+StartTime ไว้ใน recentVehicles เป็น "dropped" → ครึ่งอีกด้าน (B2) จะหาคู่เจอ ไม่บันทึกครึ่งเดี่ยว
          if (isStraddleFlagged) {
            this._recordRecentVehicle(mappedData.lane, mappedData.stamp.getTime(), Number(mappedData.gvw) || 0, "dropped");
          }
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

      // [Diag][Class] (M) — pattern เพลา class ≥3: ตรวจ misclassification (มอไซค์→รถ10ล้อ) + แยกลายเซ็นบัส vs รถบรรทุกใหญ่
      if (DIAG && mappedData.vehicleClassID >= 3) {
        diag("Class", {
          id: mappedData.id, lane: mappedData.lane, cls: mappedData.vehicleClassID, gvw: mappedData.gvw,
          axleCount: mappedData.axles.length,
          groupIDs: mappedData.axles.map(a => a.groupID),
          wheelbases: mappedData.axles.map(a => a.wheelbase),
        });
      }

      if ([1, 2].includes(mappedData.vehicleClassID)) {
        if (isIgnoredLength(mappedData.axles[1].wheelbase, this.config.vehicle_length_ignored)) {
          logger.info(`[Filter] Dropped by length (ID: ${ID}, Lane: ${mappedData.lane}, Wheelbase: ${mappedData.axles[1].wheelbase})`);
          if (DIAG) { diag("Drop", { ...this._diagBase(mappedData), reason: "length", cls: mappedData.vehicleClassID }); diagCount(`lane${mappedData.lane}_length`); }
          // [task1 B2] ครึ่งคันคร่อมเลนที่จับล้อได้น้อย (2 เพลาชิด → ฐานล้อสั้น → classify เป็นรถสั้น) ถูกตัดที่นี่
          // ทิ้งรอย lane+StartTime เป็น "dropped" → ครึ่งอีกด้าน (B2 confirm 250ms) หาคู่เจอ ไม่บันทึกครึ่งเดี่ยว
          // เฉพาะครึ่งที่หนักพอ (≥ partnerFloor) — กันมอไซค์/รถเล็กที่ติดธงหลอก (ฝั่งเดียวศูนย์) ปน recentVehicles
          if (isStraddleFlagged && (Number(mappedData.gvw) || 0) >= partnerFloor) {
            this._recordRecentVehicle(mappedData.lane, mappedData.stamp.getTime(), Number(mappedData.gvw) || 0, "dropped");
          }
          perf.count("dropped_length");
          return;
        }
        // คัดรถบัสด้วยฐานล้อทันที (ก่อนไปหารูป)
        if (mappedData.vehicleClassID === 2 && isBusByWheelbase(mappedData.axles[1].wheelbase, this.config.wheelbase_bus)) {
          logger.info(`[Filter] Excluded Bus by wheelbase: ${mappedData.axles[1].wheelbase} (ID: ${ID})`);
          // [Diag][Bus] — บัสที่รู้แน่จากฐานล้อ: เก็บลายเซ็น (class/ฐานล้อ/เพลา) ไว้ตั้งเกณฑ์ class 3+
          if (DIAG) diag("Bus", { id: ID, lane: mappedData.lane, cls: mappedData.vehicleClassID, frontWb: mappedData.axles[1].wheelbase, axleCount: mappedData.axles.length, src: "wheelbase" });
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

          // [Diag][Buffer] (D) — ตอน buffer มี ≥2 ตัว: เก็บ score ของทุกคู่ที่เทียบ เพื่อดูว่า first-match เคยต่างจาก best-match ไหม
          if (DIAG && this.straddlingBuffer.size >= 2) {
            const pass = isTimeOk && isAdjacentLane && isAxleCountOk && isAxleEvidenceOk && isWheelbaseOk && isSpeedOk;
            diag("Buffer", {
              incoming: mappedData.id, incomingLane: mappedData.lane, bufSize: this.straddlingBuffer.size,
              candidate: bufferedVehicle.data.id, candidateLane: bufferedVehicle.data.lane,
              dTime: timeDiffMs, dSpeed: Number(speedDiff.toFixed(1)), dWb: wheelbaseMaxDiff, axleDiff: axleCountDiff, pass,
            });
            diagCount("diag_buffer_ge2");
          }

          // เงื่อนไขตัดสินใจ merge — เพลาต่างกันมากต้องมีหลักฐาน (zero-side ตรงข้าม หรือ ติดธง WIM ทั้งคู่) ยืนยัน (isAxleEvidenceOk)
          if (isTimeOk && isAdjacentLane && isAxleCountOk && isAxleEvidenceOk && isWheelbaseOk && isSpeedOk) {
            // [Diag] เก็บ violation ของ 2 ครึ่งก่อน merge ไว้เทียบ (J) — ครึ่งเดียวมัก "ผ่าน" เพราะน้ำหนักครึ่งเดียว
            const preViolation = Math.max(bufferedVehicle.data.violation || 0, mappedData.violation || 0);
            let merged = mergeStraddlingVehicles(bufferedVehicle.data, mappedData, maxWheelbaseDiff);
            if (merged) {
              // [Fix] ล้าง timeout เฉพาะตอน merge "สำเร็จ" เท่านั้น — ถ้า mergeStraddlingVehicles คืน null (align เพลาไม่ลงตัว)
              // ต้องปล่อย timeout เดิมไว้ให้ buffered คนนี้ time out เป็น orphan ตามปกติ (เดิมล้างก่อนเช็ค → entry ค้าง buffer ถาวร)
              clearTimeout(bufferedVehicle.timeoutHandle);
              // [Diag][Pair] (K) — Δ ของคู่ที่ merge สำเร็จ → ดูว่าคู่จริงห่างกันแค่ไหน (อาจลดหน้าต่าง 3 วิ)
              if (DIAG) {
                diag("Pair", { id: mappedData.id, laneBuf: bufferedVehicle.data.lane, laneInc: mappedData.lane, dTime: timeDiffMs, dSpeed: Number(speedDiff.toFixed(1)), dWb: wheelbaseMaxDiff, axleDiff: axleCountDiff, mismatch: !!merged.straddleAxleMismatch });
                diagObserve("diag_pair_dtime_ms", timeDiffMs);
                diagObserve("diag_pair_dspeed", Math.round(speedDiff));
              }
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
              // [Diag][Violation] (J) — น้ำหนักเกินที่จับได้ "เพราะ merge": ครึ่งคันผ่าน (0) แต่รวมแล้วเกิน (1) → ถ้าไม่ merge รถนี้รอด
              if (DIAG && mappedData.violation === 1 && preViolation === 0) {
                diag("Violation", { id: mappedData.id, cls: mappedData.vehicleClassID, gvw: mappedData.gvw, overweightPct: Number(mappedData.overweight_percentage || 0).toFixed(1), lanes: mappedData.originalLanes });
                diagCount("diag_violation_caught_by_merge");
              }
              this.straddlingBuffer.delete(key);
              matchFound = true;
              break;
            } else {
              // [Round5 C] Compare ผ่านทุกเงื่อนไข (หลักฐานแน่น) แต่ align เพลาไม่ลงตัว (เช่น 6vs5) → คืน null
              //   ไม่ปล่อย orphan ทั้งคู่ → pick-heavier + mirror เป็นค่าประมาณเต็มคัน (กัน double-count)
              clearTimeout(bufferedVehicle.timeoutHandle);
              this.straddlingBuffer.delete(key);
              const incGvw = Number(mappedData.gvw) || 0, bGvw = Number(bufferedVehicle.data.gvw) || 0;
              let heavier = incGvw >= bGvw ? mappedData : bufferedVehicle.data;
              heavier.isStraddlingMerged = true;
              heavier.straddleAxleMismatch = true;
              heavier.originalLanes = [Number(bufferedVehicle.data.lane), Number(mappedData.lane)];
              const resF = mirrorEdgeAxles(heavier, true, true, this.config.straddling_zero_kg || 100);
              if (resF.mirrored.length) {
                heavier = resF.data;
                heavier = classifyVehicle(heavier, this.config);
                heavier = setSingleTire(heavier, this.singleTires);
                heavier = calculateESAL(heavier, this.config, this.vehicleClasses);
                heavier = mapWarningFlag(heavier);
                heavier = mapErrorFlag(heavier);
              }
              heavier.violation = 0; heavier.isOverweight = false; heavier.overweight_percentage = 0;
              perf.count("straddle_align_fallback");
              logger.info(`[Straddling] Align-null fallback (ID ${bufferedVehicle.data.id} L${bufferedVehicle.data.lane} ${bGvw}kg ↔ ID ${mappedData.id} L${mappedData.lane} ${incGvw}kg, ${bufferedVehicle.data.axles.length}vs${mappedData.axles.length} เพลา align ไม่ลง) → pick-heavier+mirror ~${heavier.gvw}kg (STRADDLE?, ไม่ตรวจน้ำหนักเกิน)`);
              if (DIAG) diag("CrossLane", { id: mappedData.id, lane: mappedData.lane, partnerId: bufferedVehicle.data.id, partnerLane: bufferedVehicle.data.lane, dTime: timeDiffMs, partnerFound: true, partnerType: "align-null", action: "pick-heavier-mirror", chosenGvw: Number(heavier.gvw) || 0, partnerGvw: heavier === mappedData ? bGvw : incGvw, enforced: false });
              mappedData = heavier;
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

      // [task1 B1] รถ "ไม่ติดธง" (อ่าน 2 ฝั่ง) กำลังจะ insert — เช็คว่าเป็นคู่ของครึ่ง "ติดธง" ที่รออยู่ใน buffer ไหม
      // (controller ติดธงครึ่งเดียวตอนคร่อมเลน) → ถ้าใช่ resolve เป็นคันเดียว (เลือกใบหนัก) กัน record ซ้ำ
      if (!isStraddleFlagged) {
        const claimed = this._tryClaimBufferedPartner(mappedData);
        if (claimed) mappedData = claimed;
      }

      // VMS ย้ายไปส่งใน processImagesAndOcrInBackground หลังได้รูป/ป้ายครบ
      // (เดิมส่งตรงนี้ก่อน insert = mappedData ยังไม่มี platePath/overviewPath → จอ VMS ไม่ขึ้นรถ)

      const insertTimer = perf.timer();
      const vehicleID = await insertVehicleWithDetails(mappedData);
      const insertMs = insertTimer();
      // [task1] บันทึกรถที่เพิ่งผ่าน (type "real") → ใช้ B2 suppress-dup ครึ่งซ้ำที่มาทีหลัง
      this._recordRecentVehicle(mappedData.lane, mappedData.stamp.getTime(), Number(mappedData.gvw) || 0, "real");
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

  // แจ้ง browser เมื่อ "ไฟล์รูป serve ได้จริง" แทนการหน่วงตายตัว (กันภาพ 404 ต้องกด F5)
  // รถปกติไฟล์พร้อมเร็ว → แจ้งเกือบทันที; image server ช้า → รอจนพร้อม (มี cap กันค้าง)
  async transmitVehicle(vehicleID, mappedData, isTruck = true) {
    await this._waitImagesServable(mappedData);
    if (isTruck) logger.info(`[Transmit] (VehicleID: ${vehicleID}) Dispatching to WS + central`);
    sendToWebSocket({ vehicleID });
    sendToTransmission(transmissionUrl, { vehicleID });
  }

  // แปลง fileUrl → absolute http(s) URL สำหรับ HEAD เช็ค: absolute อยู่แล้วใช้เลย,
  // relative เติม IMAGE_SERVE_BASE ข้างหน้า (กัน F5), ไม่มี base → null (เช็คไม่ได้)
  _toServableUrl(u) {
    if (!u) return null;
    if (/^https?:\/\//i.test(u)) return u;
    if (!IMAGE_SERVE_BASE) return null;
    return `${IMAGE_SERVE_BASE}${u.startsWith("/") ? "" : "/"}${u}`;
  }

  // รอจนรูปทุกใบ (overview/lpr) เปิดได้จริงผ่าน HTTP หรือครบ cap แล้วแจ้งไปเลย (กันรถหาย)
  async _waitImagesServable(mappedData) {
    const all = [mappedData.overviewPath, mappedData.platePath].filter(Boolean);
    // relative URL ก็เช็คได้ด้วยการเติม IMAGE_SERVE_BASE (เดิมกรองทิ้ง → ข้ามเช็ค → F5)
    const urls = all.map((u) => this._toServableUrl(u)).filter(Boolean);
    if (all.length && !urls.length && !this._warnedRelativeUrl) {
      logger.warn(`[Transmit] เช็ค servable ไม่ได้ — fileUrl เป็น relative และหา IMAGE_SERVE_BASE ไม่ได้ (ID: ${mappedData.id}); ตั้ง env IMAGE_SERVE_BASE_URL เพื่อกัน F5`);
      this._warnedRelativeUrl = true;
    }
    if (!urls.length) return; // ไม่มีรูป หรือเช็คไม่ได้ → แจ้งทันที
    const deadline = Date.now() + TRANSMIT_READY_CAP_MS;
    while (Date.now() < deadline) {
      const ok = await Promise.all(urls.map((u) => this._isServable(u)));
      if (ok.every(Boolean)) return; // พร้อมครบ → แจ้งทันที
      await new Promise((r) => setTimeout(r, TRANSMIT_READY_POLL_MS));
    }
    logger.warn(`[Transmit] images not servable within ${TRANSMIT_READY_CAP_MS}ms (ID: ${mappedData.id}) — notifying anyway`);
  }

  // HEAD เช็คว่าไฟล์เปิดได้ไหม + cache-bust กัน proxy แคชผล 404 ของ probe ไปทับ URL จริงที่ browser โหลด
  async _isServable(url) {
    try {
      const probe = `${url}${url.includes("?") ? "&" : "?"}_probe=${Date.now()}`;
      const res = await axios.head(probe, { timeout: 1000 });
      return res.status >= 200 && res.status < 300;
    } catch {
      return false;
    }
  }

  /**
   * รอรูป LPR/Overview ที่ยังขาดให้ครบ — retry IMAGE_RETRY_COUNT รอบ ห่าง IMAGE_RETRY_DELAY_MS
   * (default 3×0.5s; findSnapshots รอแบบ event-driven ~3s/รอบให้อยู่แล้ว จึงไม่ต้อง backoff ยาว)
   * คืน false เมื่อพบระหว่างรอว่าเป็นรถ excluded (ผู้เรียกต้องข้ามการ insert)
   * ถ้า retry หมดแล้วรูปยังไม่ครบ คืน true เพื่อบันทึกข้อมูลน้ำหนักกันข้อมูลหาย
   */
  async waitForImages(mappedData, findResult) {
    const maxRetries = Number(process.env.IMAGE_RETRY_COUNT) || 3;       // เดิม 5 (ตัด tail 8/10s)
    const retryDelayMs = Number(process.env.IMAGE_RETRY_DELAY_MS) || 500; // คงที่ ไม่ไต่ขึ้น (เดิม 2000*attempt)
    let attempt = 0;
    let lprSnapshots = findResult ? findResult.lprSnapshots : null;
    let overviewSnapshots = findResult ? findResult.overviewSnapshots : null;

    while (attempt < maxRetries && (!mappedData.overviewPath || !mappedData.platePath)) {
      attempt++;
      logger.info(`[Image Wait] Missing images for ID: ${mappedData.id}. Retrying in ${(retryDelayMs / 1000).toFixed(1)}s... (Attempt ${attempt}/${maxRetries})`);
      await new Promise((resolve) => setTimeout(resolve, retryDelayMs));

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
      // [Diag][Image] (L) — รูปหายหลัง retry หมด → โยงปัญหา F5/ภาพไม่ขึ้น (แยกว่าขาด overview/lpr ใบไหน)
      if (DIAG) { diag("Image", { id: mappedData.id, lane: mappedData.lane, missOverview: !mappedData.overviewPath, missLpr: !mappedData.platePath, cls: mappedData.vehicleClassID }); diagCount("diag_image_missing"); }
    }
    return true;
  }

  // ฟังก์ชันสำหรับส่งข้อมูลที่ค้างใน Buffer ไปประมวลผลต่อจนจบ (DB, VMS, WS)
  async processFinalVehicle(mappedData) {
    const totalTimer = perf.timer();
    perf.enter();
    perf.count("straddle_finalized");
    try {
      // [task1 B2] ครึ่ง "ติดธง" หาคู่ใน buffer ไม่เจอ — เช็คคู่เลนติดกัน StartTime ใกล้กันที่เพิ่งผ่าน (recentVehicles)
      // (กันกรณี controller ติดธงครึ่งเดียว → คู่อีกฝั่งถูก insert/drop ไปแล้ว → ไม่เข้า buffer)
      const stampMs = mappedData.stamp.getTime();
      const matchMs = this.config.straddle_match_ms || 50;
      const confirmMs = this.config.straddle_confirm_ms || 250;

      // [A] suppress-dup (ทิ้ง record = destructive) — หน้าต่างแคบ + เฉพาะ "real" (รถปกติ/ครึ่งเต็มที่ insert แล้ว)
      const _xReal = this._findCrossLanePartner(mappedData.lane, stampMs, matchMs, (t) => t === "real");
      if (_xReal) {
        // คู่เป็นรถน้ำหนักจริงที่บันทึกไปแล้ว + อยู่ใกล้มาก → ครึ่งนี้คือของซ้ำ → suppress กัน record ซ้ำ
        diag("CrossLane", { id: mappedData.id, lane: mappedData.lane, partnerLane: _xReal.lane, dTime: Math.abs(_xReal.stampMs - stampMs), partnerFound: true, partnerType: "real", action: "suppress-dup", chosenGvw: _xReal.gvw, partnerGvw: Number(mappedData.gvw) || 0, enforced: true });
        perf.count("crossLane_realPartner"); perf.count("crossLane_dupSuppressed");
        logger.info(`[Straddling][CrossLane] ครึ่งคัน Lane ${mappedData.lane} (ID ${mappedData.id}, ${mappedData.gvw}kg) มีคู่เลน ${_xReal.lane} บันทึกแล้ว (${_xReal.gvw}kg) → suppress กัน record ซ้ำ`);
        return; // ไม่ insert/mirror ครึ่งนี้ (finally จะ perf.exit ให้)
      }

      // [B] confirm-straddle (ติดธง+mirror = non-destructive) — หน้าต่างกว้าง + เฉพาะคู่ที่มี "สัญญาณคร่อมเลน"
      const _xConfirm = this._findCrossLanePartner(mappedData.lane, stampMs, confirmMs,
        (t) => t === "gvw-1" || t === "dropped");
      // [Round5 B] Type 2 — คร่อมนุ่ม/ไหลทาง: ไม่มีคู่ในข้อมูล (เซ็นเซอร์เลนข้างไม่ออก record) แต่ reading
      //   เป็น "ฝั่งเดียวศูนย์" → กู้ด้วย mirror เติมฝั่งหายเหมือนกัน (จับคู่ไม่ได้ ต้องเดา = ค่าประมาณ)
      const _oneSidedNoPartner = !_xConfirm && this._isZeroSideStraddle(mappedData);
      if (_xConfirm || _oneSidedNoPartner) {
        mappedData.isStraddlingMerged = true;
        if (_xConfirm) { mappedData.originalLanes = [Number(mappedData.lane), _xConfirm.lane]; perf.count("crossLane_confirmPartner"); }
        else { perf.count("crossLane_type2Mirror"); }
        // mirror รายเพลาที่ฝั่งเดียวศูนย์ (เปิด 2 ฝั่ง) — เติมฝั่งที่หาย = ค่าประมาณเต็มคัน
        // (ถ้าอ่าน 2 ฝั่งครบอยู่แล้ว → mirrored ว่าง → คงน้ำหนักจริงตามเดิม)
        const res = mirrorEdgeAxles(mappedData, true, true, this.config.straddling_zero_kg || 100);
        if (res.mirrored.length) {
          mappedData = res.data;
          mappedData = classifyVehicle(mappedData, this.config);
          mappedData = setSingleTire(mappedData, this.singleTires);
          mappedData = calculateESAL(mappedData, this.config, this.vehicleClasses);
          mappedData = mapWarningFlag(mappedData);
          mappedData = mapErrorFlag(mappedData);
          perf.count("crossLane_mirrored");
          // mirror = น้ำหนัก "ประมาณ" → ห้ามออกใบสั่งน้ำหนักเกิน
          // (ถ้าไม่ mirror = อ่าน 2 ฝั่งครบ/น้ำหนักจริง → คงผลตรวจน้ำหนักเกินเดิมไว้ กันพลาดรถเกินพิกัด)
          mappedData.violation = 0;
          mappedData.isOverweight = false;
          mappedData.overweight_percentage = 0;
        }
        mappedData.straddleAxleMismatch = true; // ครึ่งคร่อมเลน (ค่าประมาณ) → แสดง "STRADDLE?" ให้รีวิว
        if (_xConfirm) {
          diag("CrossLane", { id: mappedData.id, lane: mappedData.lane, partnerLane: _xConfirm.lane, dTime: Math.abs(_xConfirm.stampMs - stampMs), partnerFound: true, partnerType: _xConfirm.type, action: "mirror-straddle", chosenGvw: Number(mappedData.gvw) || 0, partnerGvw: _xConfirm.gvw, enforced: false });
          logger.info(`[Straddling][CrossLane] ยืนยันคร่อมเลน Lane ${mappedData.lane} (ID ${mappedData.id}) ↔ คู่เลน ${_xConfirm.lane} (${_xConfirm.type}) → mirror เป็นค่าประมาณ ~${mappedData.gvw}kg (STRADDLE?, ไม่ตรวจน้ำหนักเกิน)`);
        } else {
          diag("CrossLane", { id: mappedData.id, lane: mappedData.lane, partnerLane: null, partnerFound: false, partnerType: "none", action: "mirror-type2", chosenGvw: Number(mappedData.gvw) || 0, partnerGvw: 0, enforced: false });
          logger.info(`[Straddling][CrossLane] คร่อมนุ่ม/ไหลทาง Lane ${mappedData.lane} (ID ${mappedData.id}) ฝั่งเดียวศูนย์ ไม่มีคู่ในข้อมูล → mirror เติมฝั่งหาย ~${mappedData.gvw}kg (STRADDLE?, ไม่ตรวจน้ำหนักเกิน)`);
        }
      } else {
        perf.count("crossLane_noPartner");
      }

      // เหลือเฉพาะ "ไม่มีคู่ + อ่าน 2 ฝั่ง" (รถเดี่ยวจริง หายาก) → บันทึกตามจริง (one-sided no-partner ถูก Type-2 mirror ไปแล้ว)
      const _straddleHandled = _xConfirm || _oneSidedNoPartner;
      if (!_straddleHandled) {
        logger.warn(`[Straddling][Orphan] No partner found for ID: ${mappedData.id} (Lane: ${mappedData.lane}) ZeroSide: ${this._zeroSideSignature(mappedData)} — saving UNMERGED record as-is (อาจเป็นครึ่งคันจริง หรือรถปกติที่ติดธงหลอก) (GVW ${mappedData.gvw}kg)`);
        // [Diag][Orphan] (C) — ครึ่งคันที่หาคู่ไม่เจอ + บันทึกจริง: ดูน้ำหนักเทียบ floor
        if (DIAG) {
          const belowFloor = Number(mappedData.gvw) < (this.config.gvw_ignored || 0);
          diag("Orphan", { ...this._diagBase(mappedData), belowFloor, gvwIgnored: this.config.gvw_ignored, cls: mappedData.vehicleClassID });
          if (belowFloor) diagCount("diag_orphan_below_floor");
          diagCount(`lane${mappedData.lane}_orphan`);
        }
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
          this.lastTriggerAt = Date.now(); // watchdog: sensor ยังเป็น (นับก่อน debounce)
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

      // ส่งสัญญาณ WebSocket และส่งข้อมูลไปส่วนกลาง (รอไฟล์ servable ก่อนแจ้ง)
      await this.transmitVehicle(vehicleID, mappedData, isTruck);
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
