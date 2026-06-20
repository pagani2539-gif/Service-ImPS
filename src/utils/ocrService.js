// src\utils\ocrService.js
const axios = require("axios");
const sharp = require("sharp");
const fs = require("fs-extra");
const path = require("path");
const logger = require("./logger");

// เปิด pre-process ภาพก่อนส่ง OCR ด้วย OCR_PREPROCESS=1 (ปิดเป็นค่าเริ่มต้น เพื่อ A/B เทียบได้)
const OCR_PREPROCESS = process.env.OCR_PREPROCESS === "1";
// OCR_DEBUG=1 เปิด log วินิจฉัย ([OCR][raw] response เต็ม + [OCR][Crop] พิกัด) — ปิดเป็นค่าเริ่มต้น
// (ลด disk I/O/CPU บน hot path; เปิดเมื่อต้องไล่ปัญหา OCR/crop ไม่ตรงป้าย)
const OCR_DEBUG = process.env.OCR_DEBUG === "1";

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

  async sendToOCR(snapshot, ocrEndpoint, quiet = false) {
    try {
      const fullPath = snapshot.imageUrl;
      let base64Data;
      if (OCR_PREPROCESS) {
        try {
          const srcBuffer = snapshot.buffer || (await fs.readFile(fullPath));
          const enhanced = await preprocessForOcr(srcBuffer);
          base64Data = `data:image/jpeg;base64,${enhanced.toString("base64")}`;
        } catch (e) {
          // pre-process ล้ม = ส่งภาพต้นฉบับแทน (ไม่ทำให้คันนี้หลุด)
          logger.warn(`[OCR] Preprocess failed, sending original: ${e.message}`);
          base64Data = snapshot.buffer
            ? `data:image/jpeg;base64,${snapshot.buffer.toString("base64")}`
            : await this.loadImageAsBase64(fullPath);
        }
      } else {
        base64Data = snapshot.buffer
          ? `data:image/jpeg;base64,${snapshot.buffer.toString("base64")}`
          : await this.loadImageAsBase64(fullPath);
      }

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
      if (!plate) {
        logger.info(`[OCR] No plate detected (${path.basename(fullPath)})`);
        return null;
      }

      const license_plate = plate.license_plate;
      if (!license_plate) {
        if (!quiet) logger.info(`[OCR] Plate region found but unreadable (${path.basename(fullPath)})`);
        return null;
      }
      if (!quiet) logger.info(`[OCR] Plate: ${license_plate} (${plate.province || "N/A"}) (${path.basename(fullPath)})`);

      let crop_path = null;
      if (plate.position) {
        crop_path = await this.cropImage(
          plate.plate_path,
          plate.position,
          fullPath
        );
      }

      return {
        license_plate,
        province: plate.province,
        position: plate.position,
        plate_path: plate.plate_path || fullPath,
        crop_path,
      };
    } catch (err) {
      if (err.response) {
        logger.error(`[OCR] Error sending snapshot to OCR: ${err.response.status} ${err.message}`);
      } else {
        logger.error(`[OCR] Error sending snapshot to OCR: ${err.message}`);
      }
      return null;
    }
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
