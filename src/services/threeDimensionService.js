const axios = require('axios');
const dayjs = require('dayjs');
const pool = require('../config/db');
const logger = require('../utils/logger');

const threeDimensionDelay = process.env.THREE_DIMENSION_DELAY || 0
const threeDimensionMaximumHeight = process.env.THREE_DIMENSION_MAXIMUM_HEIGHT || 350
// ฟังก์ชัน normalize plate เพื่อลบอักษรพิเศษ
function normalizePlate(plate) {
  if (!plate) return '';
  return plate.replace(/[^a-zA-Z0-9ก-ฮ]/g, '').toUpperCase();
}

/** คำนวณสูงเกิน โดยเทียบ cm ต่อ cm */
function isOverHeight(heightRaw, limitCm = threeDimensionMaximumHeight) {
  const heightCm = Number(heightRaw);
  const lim = Number(limitCm);

  // ถ้าค่าไม่ใช่ตัวเลขหรือ limit ไม่ถูกต้อง ให้ถือว่า "ไม่เกิน"
  if (!Number.isFinite(heightCm) || !Number.isFinite(lim) || lim <= 0) {
    return false;
  }
  return heightCm > lim; // true = สูงเกิน, false = ไม่เกิน/เท่ากับ
}

function warning_map(isOverHeight) {
  const warnings = [];
  if (isOverHeight) warnings.push(1); // 1 = สูงเกิน
  return warnings;
}


/**
 * อัพเดท vehicle.threeDimension จาก API
 * @param {string} tdBase - endpoint ของ API
 * @param {{ id?: number|string, vehicle_id?: number|string, stamp: string|number|Date, license_plate?: string }} vehicle
 * @returns {Promise<Object>} vehicle (ที่มี field threeDimension เพิ่มเข้ามา)
 */
async function getThreeDimension(tdBase, vehicle, vehicleID) {
  const startTime = Date.now();
  try {
    if (threeDimensionDelay > 0) {
      await new Promise((resolve) => setTimeout(resolve, threeDimensionDelay));
    }
    if (!vehicle?.stamp) {
      throw new Error('vehicle.stamp is required');
    }

    const minStamp = dayjs(vehicle.stamp)
      .subtract(5, 'minute')
      .format('DD-MM-YYYY HH:mm');

    const maxStamp = dayjs(vehicle.stamp)
      .add(5, 'minute')
      .format('DD-MM-YYYY HH:mm');

    const payload = {
      startDate: minStamp,
      stopDate: maxStamp,
    };

    try {
      const { data: res } = await axios.post(`${tdBase}/report-3d/transaction`, payload, {
        timeout: 3000 // 3 วินาที
      });
      const rows = Array.isArray(res?.data) ? res.data : [];

      const vehiclePlate = normalizePlate(vehicle.licensePlate);
      let found = null;
      for (const item of rows) {
        const threeDimensionLicensePlate = normalizePlate(item.license_plate);
        if (threeDimensionLicensePlate && vehiclePlate && threeDimensionLicensePlate === vehiclePlate) {
          const rawHeight = item.hight ?? item.height ?? null;
          const overHeight = isOverHeight(rawHeight);
          found = {
            vehicle_id: vehicleID,
            three_dimension_id: item.id || item._id,
            stamp: item.timestamp,
            pcd_image: `${tdBase}/${item.pathPCDImage}`,
            plate_image: `${tdBase}/${item.pathImage}`,
            license_plate: item.license_plate,
            province: item.province,
            vehicle_width: item.width,
            vehicle_length: item.long,
            vehicle_height: item.hight,
            is_over_height: overHeight,
            warning: warning_map(overHeight),
          };
          break; // เจอแล้วก็หยุดเลย
        }
      }

      return found;
    } catch (err) {
      err.message = `getThreeDimension failed: ${err.message}`;
      throw err;
    }
  } finally {
    logger.info(`[PERF] getThreeDimension took ${Date.now() - startTime}ms`);
  }
}


/**
 * เพิ่มแถวใน three_dimension_warning_map (เวอร์ชันตรงไปตรงมา)
 * @param {{ three_dimension_id: number|string, warning_id: number|string }} data
 * @returns {Promise<number>} insertId
 */
async function insertThreeDimensionWarningMap(data) {
  const [result] = await pool.query(
    `INSERT INTO three_dimension_warning_map (three_dimension_id, warning_id)
     VALUES (?, ?)`,
    [data.three_dimension_id, data.warning_id]
  );
  return result.insertId;
}

/** แปลง boolean -> 0/1 */
const b2i = (v) => (v ? 1 : 0);

/**
 * บันทึกแถวลงตาราง three_dimension
 * @param {{
 *  vehicle_id:number|string,
 *  three_dimension_id:string,
 *  stamp:string|Date,
 *  pcd_image?:string|null,
 *  plate_image?:string|null,
 *  license_plate?:string|null,
 *  province?:string|null,
 *  vehicle_width?:number|null,
 *  vehicle_length?:number|null,
 *  vehicle_height?:number|null,
 *  is_over_height?:boolean|0|1,
 *  is_over_length?:boolean|0|1,
 *  is_over_width?:boolean|0|1,
 *  is_ver?:boolean|0|1,
 *  warnings?: number[]            // ไม่ใช่คอลัมน์ของตาราง (ใช้กับฟังก์ชันถัดไป)
 * }} row
 * @returns {Promise<number>} insertId
 */
async function insertThreeDimension(row) {
  const [result] = await pool.query(
    `INSERT INTO three_dimension (
        vehicle_id,
        three_dimension_id,
        stamp,
        pcd_image,
        plate_image,
        license_plate,
        province,
        vehicle_width,
        vehicle_length,
        vehicle_height,
        is_over_height,
        is_over_length,
        is_over_width
   
     ) VALUES ( ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      row.vehicle_id,
      row.three_dimension_id,
      row.stamp ? new Date(row.stamp) : new Date(), // DATETIME
      row.pcd_image ?? null,
      row.plate_image ?? null,
      row.license_plate ?? null,
      row.province ?? null,
      row.vehicle_width ?? null,
      row.vehicle_length ?? null,
      row.vehicle_height ?? null,
      row.is_over_height ?? 0,
      row.is_over_length ?? 0,
      row.is_over_width ?? 0,

    ]
  );
  return result.insertId;
}

/**
 * บันทึก three_dimension และแนบ warnings (ถ้ามี) ลงใน three_dimension_warning_map
 * @param {object} row - โครงสร้างเดียวกับ insertThreeDimension โดยสามารถมี row.warnings = [warning_id,...]
 * @returns {Promise<{threeDimensionId:number, mapped:number}>} mapped = จำนวนเรคคอร์ดใน map ที่ถูกสร้าง
 */
async function insertThreeDimensionWithWarnings(row) {
  const threeDimensionId = await insertThreeDimension(row);

  let mapped = 0;
  if (Array.isArray(row.warnings) && row.warnings.length) {
    for (const warning_id of row.warnings) {
      // ใช้ฟังก์ชัน map แบบตรงไปตรงมา (หรือเปลี่ยนเป็น IfAbsent ถ้าต้องการกันซ้ำ)
      await insertThreeDimensionWarningMap({
        three_dimension_id: threeDimensionId,
        warning_id,
      });
      mapped += 1;
    }
  }
  return { threeDimensionId, mapped };
}


module.exports = { getThreeDimension, insertThreeDimensionWithWarnings };
