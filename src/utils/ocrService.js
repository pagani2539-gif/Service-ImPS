// src\utils\ocrService.js
const axios = require("axios");
const sharp = require("sharp");
const fs = require("fs-extra");
const path = require("path");
const logger = require("./logger");
const perf = require("./perfMonitor");

// เปิด pre-process ภาพก่อนส่ง OCR ด้วย OCR_PREPROCESS=1 (ปิดเป็นค่าเริ่มต้น เพื่อ A/B เทียบได้)
const OCR_PREPROCESS = process.env.OCR_PREPROCESS === "1";
// OCR_DEBUG=1 เปิด log วินิจฉัย ([OCR][raw] response เต็ม + [OCR][Crop] พิกัด) — ปิดเป็นค่าเริ่มต้น
// (ลด disk I/O/CPU บน hot path; เปิดเมื่อต้องไล่ปัญหา OCR/crop ไม่ตรงป้าย)
const OCR_DEBUG = process.env.OCR_DEBUG === "1";
// Two-pass OCR: รอบแรกอ่านภาพ raw ไม่ออก (no plate) → ลองซ้ำด้วยภาพ enhanced (median/normalise/sharpen)
// แก้เคส "อ่านไม่ออกเลย" ที่ภาพ contrast ต่ำ/มืด/นัว โดยไม่กระทบเคสที่อ่านออกอยู่แล้ว (รอบแรกเป็น raw เหมือนเดิม)
// → จ่าย OCR เพิ่มเฉพาะคันที่ยังไงรอบแรกก็พลาด ไม่ใช่ทุกคัน
// เปิดเป็นค่าเริ่มต้น; ปิดด้วย OCR_RETRY_ENHANCE=0 (ถ้า OCR_PREPROCESS=1 อยู่แล้ว รอบแรกก็ enhanced → ไม่ retry ซ้ำให้เปลือง)
const OCR_RETRY_ENHANCE = process.env.OCR_RETRY_ENHANCE !== "0";
// อันดับสถานะผล OCR ต่อภาพ — ใช้เลือก "ภาพที่ดีที่สุด" เมื่อมีหลายใบ (รถคร่อมเลน): read > region > none
const STATUS_RANK = { read: 3, region: 2, none: 1 };

/**
 * เพิ่มความคมภาพก่อนส่งเข้า OCR — model (YOLO 2 สเตจ) resize crop ป้ายเป็น ~224-256px เสมอ
 * "ภาพคมที่ถูกย่อ" ให้รายละเอียดตัวอักษรดีกว่า "ภาพเบลอที่ถูกย่อ" → สเตจอ่านตัวอักษรพลาดน้อยลง
 * จงใจไม่ upscale/crop/resize — model ย่อเองอยู่แล้ว + คงพิกัด position ของ OCR ให้ map กลับรูปต้นฉบับได้ถูก
 * (median/normalise/sharpen เปลี่ยนแค่ค่าพิกเซล ไม่แตะ geometry → crop ป้ายทีหลังยังตรง)
 */
async function preprocessForOcr(buffer) {
  return sharp(buffer)
    .median(1)              // ลด noise จุดเล็ก (กลางคืน/ISO สูง) โดยไม่เบลอขอบตัวอักษร
    .normalise()            // ยืด contrast อัตโนมัติ แก้ภาพมืด/ย้อนแสง
    .sharpen({ sigma: 1 })  // เพิ่มความคมขอบตัวอักษร
    .jpeg({ quality: 92 })
    .toBuffer();
}

/**
 * แปลง position จาก OCR เป็น { left, top, width, height }
 * รองรับ x1/y1/x2/y2, left/top/right/bottom, left/top/width/height
 */
function normalizePosition(position) {
  if (!position || typeof position !== "object") {
    return null;
  }

  const n = (v) => {
    const x = Number(v);
    return Number.isFinite(x) ? x : null;
  };

  let x1 = null;
  let y1 = null;
  let x2 = null;
  let y2 = null;

  if (position.x1 != null && position.x2 != null) {
    x1 = n(position.x1);
    y1 = n(position.y1);
    x2 = n(position.x2);
    y2 = n(position.y2);
  } else if (
    position.left != null &&
    position.top != null &&
    position.right != null &&
    position.bottom != null
  ) {
    x1 = n(position.left);
    y1 = n(position.top);
    x2 = n(position.right);
    y2 = n(position.bottom);
  } else if (
    position.left != null &&
    position.top != null &&
    position.width != null &&
    position.height != null
  ) {
    x1 = n(position.left);
    y1 = n(position.top);
    x2 = x1 + n(position.width);
    y2 = y1 + n(position.height);
  } else if (
    position.x != null &&
    position.y != null &&
    position.w != null &&
    position.h != null
  ) {
    x1 = n(position.x);
    y1 = n(position.y);
    x2 = x1 + n(position.w);
    y2 = y1 + n(position.h);
  }

  if ([x1, y1, x2, y2].some((v) => v === null)) {
    return null;
  }

  if (x1 > x2) [x1, x2] = [x2, x1];
  if (y1 > y2) [y1, y2] = [y2, y1];

  const width = Math.floor(x2 - x1);
  const height = Math.floor(y2 - y1);

  if (width <= 0 || height <= 0) {
    return null;
  }

  return {
    left: Math.floor(x1),
    top: Math.floor(y1),
    width,
    height,
  };
}

// คืน { rect: {left,top,width,height}, meta: {width,height} } — ส่ง meta กลับไปใช้ซ้ำ
// (เดิมผู้เรียกเปิด sharp().metadata() อีกรอบเพื่อ log = decode ไฟล์เดิมซ้ำ)
async function clampRectToImage(imagePath, rect) {
  const meta = await sharp(imagePath).metadata();
  const imgW = meta.width || 0;
  const imgH = meta.height || 0;

  if (!imgW || !imgH) {
    return null;
  }

  let { left, top, width, height } = rect;
  left = Math.max(0, Math.min(left, imgW - 1));
  top = Math.max(0, Math.min(top, imgH - 1));
  width = Math.min(width, imgW - left);
  height = Math.min(height, imgH - top);

  if (width <= 0 || height <= 0) {
    return null;
  }

  return { rect: { left, top, width, height }, meta: { width: imgW, height: imgH } };
}

function resolveImagePath(preferredPath, fallbackPath) {
  if (preferredPath && fs.existsSync(preferredPath)) {
    return preferredPath;
  }
  if (fallbackPath && fs.existsSync(fallbackPath)) {
    return fallbackPath;
  }
  return null;
}

module.exports = {
  normalizePosition,

  // สร้าง base64 ของ "ภาพ enhanced" (median/normalise/sharpen) สำหรับส่ง OCR — คืน null ถ้า preprocess ล้ม
  async buildEnhancedBase64(snapshot, fullPath) {
    try {
      const srcBuffer = snapshot.buffer || (await fs.readFile(fullPath));
      const enhanced = await preprocessForOcr(srcBuffer);
      return `data:image/jpeg;base64,${enhanced.toString("base64")}`;
    } catch (e) {
      logger.warn(`[OCR] Preprocess failed: ${e.message}`);
      return null;
    }
  },

  // ยิง OCR หนึ่งครั้ง → คืนสถานะ 3 ระดับ (ตรงกับตารางเลือกภาพ):
  //   read   = มี plate + license_plate (อ่านออก)
  //   region = มี plate แต่ไม่มี license_plate (เจอกรอบป้ายแต่อ่านตัวอักษรไม่ออก)
  //   none   = ไม่มี plate (ไม่เจอป้าย)
  async ocrRequestOnce(base64Data, fullPath, ocrEndpoint) {
    const response = await axios({
      method: "POST",
      maxBodyLength: Infinity,
      url: ocrEndpoint,
      headers: {
        "Content-Type": "application/json",
      },
      data: JSON.stringify({
        plates: [{ plate_path: fullPath, base64: base64Data }],
      }),
      timeout: 3000,
    });

    // [Capture] ดู response ดิบจาก model (มี score/confidence ไหม) — gate ด้วย OCR_DEBUG=1
    // (สรุปแล้วว่า model ไม่คืน confidence; เปิดไว้เผื่อไล่ปัญหา response แปลกๆ ภายหลัง)
    if (OCR_DEBUG) logger.info(`[OCR][raw] ${JSON.stringify(response.data)}`);

    const plate = response.data?.plate;
    if (!plate) return { status: "none" };
    if (!plate.license_plate) {
      return { status: "region", position: plate.position, plate_path: plate.plate_path || fullPath };
    }
    return {
      status: "read",
      license_plate: plate.license_plate,
      province: plate.province,
      position: plate.position,
      plate_path: plate.plate_path || fullPath,
    };
  },

  // ประเมินภาพหนึ่งใบด้วย two-pass (raw → enhanced ถ้ายังอ่านไม่ออก) → คืนผลที่ดีที่สุด { status, ... }
  // counter ([Metrics]): ocr_no_plate (รอบแรกไม่ read) / ocr_recovered_by_enhance / ocr_retry_ms
  async evaluateSnapshot(snapshot, ocrEndpoint, quiet = false) {
    const fullPath = snapshot.imageUrl;
    try {
      // ---- Pass 1: ภาพ raw (เว้นแต่ตั้ง OCR_PREPROCESS=1 ให้รอบแรกเป็น enhanced เลย) ----
      let base64Data;
      let firstPassEnhanced = false;
      if (OCR_PREPROCESS) {
        base64Data = await this.buildEnhancedBase64(snapshot, fullPath);
        if (base64Data) {
          firstPassEnhanced = true;
        } else {
          // preprocess ล้ม = ส่งภาพต้นฉบับแทน (ไม่ทำให้คันนี้หลุด)
          base64Data = snapshot.buffer
            ? `data:image/jpeg;base64,${snapshot.buffer.toString("base64")}`
            : await this.loadImageAsBase64(fullPath);
        }
      } else {
        base64Data = snapshot.buffer
          ? `data:image/jpeg;base64,${snapshot.buffer.toString("base64")}`
          : await this.loadImageAsBase64(fullPath);
      }

      let ev = await this.ocrRequestOnce(base64Data, fullPath, ocrEndpoint);

      // ---- Pass 2: รอบแรกยังไม่ read → ลองซ้ำด้วยภาพ enhanced (เฉพาะเมื่อรอบแรกยังเป็น raw) ----
      if (ev.status !== "read") {
        perf.count("ocr_no_plate"); // baseline: อ่านไม่ออกรอบแรก ต่อรอบสรุป [Metrics]
        if (OCR_RETRY_ENHANCE && !firstPassEnhanced) {
          const retryTimer = perf.timer();
          const enhanced64 = await this.buildEnhancedBase64(snapshot, fullPath);
          if (enhanced64) {
            const ev2 = await this.ocrRequestOnce(enhanced64, fullPath, ocrEndpoint);
            perf.observe("ocr_retry_ms", retryTimer()); // ต้นทุนเวลาที่เพิ่ม เฉพาะเคสพลาด
            if ((STATUS_RANK[ev2.status] || 1) > (STATUS_RANK[ev.status] || 1)) {
              if (ev2.status === "read") {
                perf.count("ocr_recovered_by_enhance"); // กู้กลับมาอ่านออกได้จากที่พลาด
                if (!quiet) logger.info(`[OCR] Recovered by enhance: ${ev2.license_plate} (${ev2.province || "N/A"}) (${path.basename(fullPath)})`);
              }
              ev = ev2;
            }
          }
        }
      }
      return ev;
    } catch (err) {
      if (err.response) {
        logger.error(`[OCR] Error sending snapshot to OCR: ${err.response.status} ${err.message}`);
      } else {
        logger.error(`[OCR] Error sending snapshot to OCR: ${err.message}`);
      }
      return { status: "none" };
    }
  },

  // ขนาดไฟล์ภาพ (ไบต์) — proxy ความคม/ความสมบูรณ์ สำหรับ tie-break ลำดับ 3 (ไม่เจอป้ายทั้งคู่)
  _snapshotSizeBytes(snapshot) {
    if (snapshot && snapshot.buffer) return snapshot.buffer.length;
    try { return fs.statSync(snapshot.imageUrl).size; } catch (e) { return 0; }
  },

  // a ดีกว่า b ไหม ตามตาราง: read > region > none ; เสมอที่ read → มีจังหวัดชนะ ; เสมอที่ none → ไฟล์ใหญ่กว่าชนะ
  _isBetterPlate(a, snapA, b, snapB) {
    const ra = STATUS_RANK[a.status] || 1;
    const rb = STATUS_RANK[b.status] || 1;
    if (ra !== rb) return ra > rb;
    if (a.status === "read") {
      const pa = a.province ? 1 : 0, pb = b.province ? 1 : 0;
      if (pa !== pb) return pa > pb;
      return false; // เสมอ → คงใบแรก (เลนแรก/ใกล้เวลาสุด)
    }
    if (a.status === "none") {
      return this._snapshotSizeBytes(snapA) > this._snapshotSizeBytes(snapB);
    }
    return false; // region เสมอ → คงใบแรก
  },

  // เลือก index ของภาพที่ดีที่สุดจากผล OCR หลายใบ (ตามตารางลำดับ)
  pickBestPlate(evals, snapshots) {
    let bestIdx = 0;
    for (let i = 1; i < evals.length; i++) {
      if (this._isBetterPlate(evals[i], snapshots[i], evals[bestIdx], snapshots[bestIdx])) bestIdx = i;
    }
    return bestIdx;
  },

  async loadImageAsBase64(imagePath) {
    const buffer = await fs.readFile(imagePath);
    return `data:image/jpeg;base64,${buffer.toString("base64")}`;
  },

  /**
   * Crops plate region. Returns cropped file path or null (does not throw).
   * @param {string} imagePath - preferred image path
   * @param {object} position - OCR position object
   * @param {string} [fallbackPath] - local snapshot path if imagePath missing
   */
  async cropImage(imagePath, position, fallbackPath) {
    try {
      const sourcePath = resolveImagePath(imagePath, fallbackPath);
      if (!sourcePath) {
        logger.warn(`[OCR] Crop skipped: image file not found: ${imagePath}`);
        return null;
      }

      const rect = normalizePosition(position);
      if (!rect) {
        return null;
      }

      const clampResult = await clampRectToImage(sourcePath, rect);
      if (!clampResult) {
        logger.warn(`[OCR] Crop skipped: region outside image or zero size ${JSON.stringify(position)}`);
        return null;
      }
      const clamped = clampResult.rect;

      // [Diag] ภาพ crop ไม่ตรงป้าย — log พิกัดดิบจาก OCR เทียบขนาดรูปจริง + rect ที่ตัด
      // ถ้า rect ถูก clamp เยอะ/อยู่มุมรูป = OCR คืนพิกัดคนละ coordinate space (เช่นรูปย่อ)
      // gate ด้วย OCR_DEBUG=1 — ใช้ meta จาก clamp ซ้ำ (ไม่เปิด sharp รอบใหม่)
      if (OCR_DEBUG) {
        const meta = clampResult.meta;
        const clampedHard = rect && clamped && (rect.left !== clamped.left || rect.top !== clamped.top || rect.width !== clamped.width || rect.height !== clamped.height);
        logger.info(`[OCR][Crop] src=${path.basename(sourcePath)} img=${meta.width}x${meta.height} pos=${JSON.stringify(position)} rect=${JSON.stringify(rect)} clamped=${JSON.stringify(clamped)}${clampedHard ? " ⚠️CLAMPED" : ""}`);
      }

      const croppedImagePath = sourcePath.replace(/\.jpg$/i, "_cropped.jpg");

      await sharp(sourcePath).extract(clamped).toFile(croppedImagePath);

      return croppedImagePath;
    } catch (err) {
      logger.error(`[OCR] Error cropping image: ${err.message}`);
      return null;
    }
  },
};
