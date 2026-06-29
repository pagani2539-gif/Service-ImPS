// src/utils/mapConfigurationKeys.js

/**
 * Maps configuration keys to default values if they are null or undefined.
 * @param {Object} config - Configuration object from the database.
 * @returns {Object} - Mapped configuration object with default values.
 */
// [Env override] ให้ปรับจูนผ่าน .env ได้โดยไม่ต้องแตะ DB — ตั้ง env → ใช้ env, ไม่ตั้ง → ใช้ค่า DB/UI เดิม
// ใช้เฉพาะพารามิเตอร์ "จูน" (straddling / timing รูป); ค่าคัดกรอง (gvw_ignored ฯลฯ) คงคุมที่ UI ไม่ override
function envNum(name, dbVal) {
  const v = process.env[name];
  return (v !== undefined && v !== "" && !Number.isNaN(Number(v))) ? Number(v) : dbVal;
}

function mapConfigurationKeys(config) {
    return {
      station_id: config.station_id || 0,
      station_name: config.station_name || "Unknown Station",
      station_ip: config.station_ip || "0.0.0.0",
      controller_id: config.controller_id || 0,
      controller_data_url: config.controller_data_url || "http://default-data-url",
      controller_sensor_url: config.controller_sensor_url || "http://default-sensor-url",
      wheel_base_group_length: config.wheel_base_group_length*100 || 0.0,
      flir_data_url: config.flir_data_url || "http://default-flir-url",
      flux_ip: config.flux_ip || "0.0.0.0",
      flux_video_chanel: config.flux_video_chanel || 0,
      gvw_ignored: config.gvw_ignored || 0,
      vehicle_length_ignored: config.vehicle_length_ignored || 0,
      // หน่วย ms — ช่วงเวลาค้นหารูป snap เทียบกับ stamp รถ (override ผ่าน .env ได้)
      minimum_search: envNum("MINIMUM_SEARCH", config.minimum_search ?? 2000),
      maximum_search: envNum("MAXIMUM_SEARCH", config.maximum_search ?? 8000),
      ocr_url: config.ocr_url || "http://default-ocr-url",
      central_server_url: config.central_server_url || "http://default-central-server-url",
      center_station_url: config.center_station_url || "http://default-center-station-url",
      delay_capture_overview: envNum("DELAY_CAPTURE_OVERVIEW", config.delay_capture_overview || 1000),
      distance_of_axles_between_class_2: config.distance_of_axles_between_class_2 || 0,
      floor_type: config.floor_type || "Concrete",
      thick: config.thick || 0,
      streaming_url: config.streaming_urls || [],
      capture_overview: config.capture_overviews || [],
      capture_lpr: config.capture_lprs || [],
      led_url: config.led_url || '',
      led_enabled: config.led_enabled || 0,
      wheelbase_bus: config.wheelbase_bus || 0,
      vehicle_length_ignored:config.vehicle_length_ignored||0,
      retention_days: config.retention_days ?? 3,
      // เกณฑ์จับคู่รถคร่อมเลน — ปรับผ่าน .env (STRADDLING_*) เท่านั้น
      // หมายเหตุ: คอลัมน์ axle_tol/speed_diff/wheelbase_diff/zero_kg "ไม่ได้ SELECT" ใน configurationService
      // → config.straddling_* เป็น undefined → ใช้ env หรือ default (ตั้งใจให้เป็น env-only, ไม่มีใน UI/UX)
      // ยกเว้น straddling_time_diff ที่ถูก SELECT จาก DB → ตั้งผ่าน DB หรือ env ก็ได้
      straddling_time_diff: envNum("STRADDLING_TIME_DIFF", config.straddling_time_diff ?? 3),
      straddling_axle_tol: envNum("STRADDLING_AXLE_TOL", config.straddling_axle_tol ?? 3),        // เพลาต่างกันได้กี่เพลา (env-only)
      straddling_speed_diff: envNum("STRADDLING_SPEED_DIFF", config.straddling_speed_diff ?? 15),   // กม./ชม.
      straddling_wheelbase_diff: envNum("STRADDLING_WHEELBASE_DIFF", config.straddling_wheelbase_diff ?? 30), // ซม.
      straddling_zero_kg: envNum("STRADDLING_ZERO_KG", config.straddling_zero_kg ?? 100),        // กก. เกณฑ์ "ด้านศูนย์" ต่อล้อ
      // หน้าต่างจับคู่ข้ามเลนด้วย StartTime (±ms) — ใช้จับคู่ครึ่งคันที่ controller ติดธงไม่สมมาตร
      // env-only: ไม่มีคอลัมน์ใน DB (config.straddle_* = undefined เสมอ) → ตั้งผ่าน .env หรือใช้ default
      // straddle_match_ms = หน้าต่าง suppress-dup (ทิ้ง record ซ้ำ = destructive) ต้องแคบ กันทิ้งรถปกติผิด
      straddle_match_ms: envNum("STRADDLE_MATCH_MS", config.straddle_match_ms ?? 50),
      // straddle_confirm_ms = หน้าต่าง confirm-straddle (ติดธง+mirror = non-destructive) ขยายได้ปลอดภัย
      // เพราะตัวกรองชนิดคู่ (gvw-1/dropped) กันจับรถปกติผิด ไม่ใช่ความกว้างหน้าต่าง
      straddle_confirm_ms: envNum("STRADDLE_CONFIRM_MS", config.straddle_confirm_ms ?? 250),
      // straddle_partner_floor = น้ำหนักขั้นต่ำที่จะ "ทิ้งรอย sliver" ของครึ่งคันที่ถูก filter ตัด ให้ B2 หาคู่เจอ
      // แยกจาก gvw_ignored (sliver = ล้อไม่กี่เพลา เบาเป็นธรรมชาติ) — กั้นมอไซค์/noise ออก แต่เก็บครึ่งบรรทุกจริง
      straddle_partner_floor: envNum("STRADDLE_PARTNER_FLOOR", config.straddle_partner_floor ?? 1000),
      snap_match_db_poll_ms: config.snap_match_db_poll_ms ?? 1000,
      snap_match_max_wait_ms: config.snap_match_max_wait_ms ?? 3000,
      trigger_history_window_ms: config.trigger_history_window_ms ?? 3000,
      metrics_interval_ms: config.metrics_interval_ms ?? 300000,
      metrics_format: config.metrics_format || "pretty",
    };
  }
  
  module.exports = mapConfigurationKeys;
  