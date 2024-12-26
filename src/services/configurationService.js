const pool = require("../config/db");

/**
 * Fetch all configurations from the database.
 * @returns {Promise<Array>} - Array of all configuration data.
 */
async function getAllConfigurations() {
  try {
    const [rows] = await pool.query(
      `SELECT 
       *
      FROM configuration`
    );

    if (rows.length === 0) {
      throw new Error(`No configurations found in the database.`);
    }

    return rows;
  } catch (err) {
    console.error("Error fetching configurations:", err);
    throw err;
  }
}

module.exports = { getAllConfigurations };
