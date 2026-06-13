// src/utils/mapConfigurationKeys.js

/**
 * Maps configuration keys to default values if they are null or undefined.
 * @param {Object} config - Configuration object from the database.
 * @returns {Object} - Mapped configuration object with default values.
 */
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
      // หน่วย ms — ช่วงเวลาค้นหารูป snap เทียบกับ stamp รถ (ดูตาราง configuration)
      minimum_search: config.minimum_search ?? 2000,
      maximum_search: config.maximum_search ?? 8000,
      ocr_url: config.ocr_url || "http://default-ocr-url",
      central_server_url: config.central_server_url || "http://default-central-server-url",
      center_station_url: config.center_station_url || "http://default-center-station-url",
      delay_capture_overview: config.delay_capture_overview || 1000,
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
      straddling_time_diff: config.straddling_time_diff ?? 3,
      snap_match_db_poll_ms: config.snap_match_db_poll_ms ?? 1000,
      snap_match_max_wait_ms: config.snap_match_max_wait_ms ?? 3000,
      trigger_history_window_ms: config.trigger_history_window_ms ?? 3000,
      metrics_interval_ms: config.metrics_interval_ms ?? 300000,
      metrics_format: config.metrics_format || "pretty",
    };
  }
  
  module.exports = mapConfigurationKeys;
  