const pool = require("../config/db");
// Variable to store the current configuration hash
// Variable to store the last known `updated_at` timestamp
let lastUpdatedAt;

(async () => {
  try {
    if (pool.dbInitializedPromise) {
      await pool.dbInitializedPromise;
    }
    lastUpdatedAt = await getLatestUpdatedAt();
  } catch (error) {
    console.error("Error initializing lastUpdatedAt:", error);
    lastUpdatedAt = null; // ตั้งค่าเป็น null ถ้าเกิดข้อผิดพลาด
  }
})();

/**
 * Fetch all configurations from the database.
 * @returns {Promise<Array>} - Array of all configuration data.
 */
async function getConfiguration() {
  const startTime = Date.now();
  try {
    const [rows] = await pool.query(
      `
      SELECT 
          c.id AS configuration_id,
          c.station_id,
          c.station_name,
          c.station_ip,
          c.controller_id,
          c.controller_data_url,
          c.controller_sensor_url,
          c.wheel_base_group_length,
          c.flir_data_url,
          c.flux_ip,
          c.flux_video_chanel,
          c.gvw_ignored,
          c.vehicle_length_ignored,
          c.minimum_search,
          c.maximum_search,
          c.ocr_url,
          c.central_server_url,
          c.center_station_url,
          c.delay_capture_overview,
          c.distance_of_axles_between_class_2,
          c.floor_type,
          c.thick,
          c.led_url,
          c.led_enabled,
          c.wheelbase_bus,
          c.vehicle_length_ignored,
          c.retention_days,
          c.straddling_time_diff,
          -- Subquery for streaming_urls
          (SELECT JSON_ARRAYAGG(JSON_OBJECT('url', su.url))
          FROM streaming_urls su
          WHERE su.configuration_id = c.id) AS streaming_urls,
          -- Subquery for capture_overviews
          (SELECT JSON_ARRAYAGG(JSON_OBJECT('lane', co.lane, 'snap_code', co.snap_code))
          FROM capture_overviews co
          WHERE co.configuration_id = c.id) AS capture_overviews,
          -- Subquery for capture_lprs
          (SELECT JSON_ARRAYAGG(JSON_OBJECT('lane', cl.lane, 'snap_code', cl.snap_code))
          FROM capture_lprs cl
          WHERE cl.configuration_id = c.id) AS capture_lprs
      FROM 
          configuration c;


`
    );

    if (rows.length === 0) {
      throw new Error(`No configurations found in the database.`);
    }

    // Return the first configuration
    return rows[0];
  } catch (err) {
    console.error("Error fetching configuration:", err);
    throw err;
  } finally {
    console.log(`[PERF] getConfiguration took ${Date.now() - startTime}ms`);
  }
}



/**
 * Fetch the latest `updated_at` timestamp from the database.
 * @returns {Promise<Date>} - The latest `updated_at` timestamp.
 */
async function getLatestUpdatedAt() {
  try {
    const [rows] = await pool.query(
      `
      SELECT updated_at
      FROM configuration
      ORDER BY updated_at DESC
      LIMIT 1;
      `
    );

    if (rows.length === 0) {
      throw new Error("No configurations found in the database.");
    }

    return new Date(rows[0].updated_at);
  } catch (err) {
    console.error("Error fetching updated_at timestamp:", err);
    throw err;
  }
}



/**
 * Check for configuration updates by comparing the current configuration hash with the latest configuration hash.
 * @returns {Promise<boolean>} - Returns true if the configuration has changed, false otherwise.
 */
async function checkForConfigUpdates() {
  try {
    // Fetch the latest `updated_at` timestamp
    const latestUpdatedAt = await getLatestUpdatedAt();

    // Compare with the last known `updated_at` timestamp
    if (!lastUpdatedAt || latestUpdatedAt > lastUpdatedAt) {
      lastUpdatedAt = latestUpdatedAt; // Update the last known timestamp
      return true; // Configuration has changed
    }

    return false; // No changes detected
  } catch (err) {
    console.error("Error checking for configuration updates:", err);
    throw err;
  }
}

module.exports = { getConfiguration,checkForConfigUpdates };
