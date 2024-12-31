const pool = require("../config/db");

/**
 * Fetch all configurations from the database.
 * @returns {Promise<Array>} - Array of all configuration data.
 */
async function getConfiguration() {
  try {
    const [rows] = await pool.query(
      `SELECT 
       *
      FROM configuration`
    );

    if (rows.length === 0) {
      throw new Error(`No configurations found in the database.`);
    }

    // Return the first configuration
    return rows[0];
  } catch (err) {
    console.error("Error fetching configuration:", err);
    throw err;
  }
}


module.exports = { getConfiguration };
