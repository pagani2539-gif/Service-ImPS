const pool = require("../config/db"); // Import database connection pool

/**
 * PHASE 1 Refactoring: Optimized Database Insertion
 * Senior Backend Engineer: Implementation of Batch Inserts and Transactions
 */

// Batch size for chunking inserts
const DB_BATCH_SIZE = parseInt(process.env.DB_BATCH_SIZE) || 50;
const IS_DEV = process.env.NODE_ENV === 'development';

// Insert a vehicle into the Vehicles table
async function insertVehicle(connection, data) {
  const [result] = await connection.query(
    `INSERT INTO vehicles (axles_count, gvw, vehicle_id, lane, left_weight, right_weight, length, speed, stamp, is_overweight, error_flags, warning_flags,is_error_flagged,is_warning_flagged,vehicle_class_id,esal,overweight_percentage)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      data.axlesCount,
      data.gvw,
      data.id,
      data.lane,
      data.leftWeight,
      data.rightWeight,
      data.length,
      data.speed,
      data.stamp,
      data.violation,
      data.errorFlags,
      data.warningFlags,
      data.isErrorFlagged,
      data.isWarningFlagged,
      data.vehicleClassID,
      data.esal,
      data.overweight_percentage,
    ]
  );
  return result.insertId;
}

// Optimized: Insert axles data using Batch Insert with Chunking
async function insertAxles(connection, vehicleID, axles) {
  if (!axles || !Array.isArray(axles) || axles.length === 0) return;

  const startTime = Date.now();
  const values = axles.map(axle => [
    vehicleID,
    axle.groupID,
    axle.number,
    axle.speedLeft,
    axle.speedRight,
    axle.weight,
    axle.weightLeft,
    axle.weightRight,
    axle.wheelbase,
    axle.dualTire,
  ]);

  for (let i = 0; i < values.length; i += DB_BATCH_SIZE) {
    const chunk = values.slice(i, i + DB_BATCH_SIZE);
    await connection.query(
      `INSERT INTO axles (vehicle_id, group_id, number, speed_left, speed_right, weight, weight_left, weight_right, wheelbase, dual_tire)
       VALUES ?`,
      [chunk]
    );
  }

  if (IS_DEV) {
    console.log(`[PERF] insertAxles (Batch) took ${Date.now() - startTime}ms for ${axles.length} axles`);
  }
}

// Helper: Maintains connection for transaction (Logic preserved as per Phase 1 rules)
async function insertAxlesAfterAllowances(connection, vehicleID, axlesAfterAllowance) {
  if (!axlesAfterAllowance || !Array.isArray(axlesAfterAllowance)) return;
  for (const axle of axlesAfterAllowance) {
    await connection.query(
      `INSERT INTO axles_after_allowance (vehicle_id, allowance, axle_weight, number)
             VALUES (?, ?, ?, ?)`,
      [vehicleID, axle.allowance, axle.axleWeight, axle.number]
    );
  }
}

// Helper: Maintains connection for transaction
async function insertPlates(connection, vehicleID, licensePlate, platePath, province, cropPath) {
  await connection.query(
    `INSERT INTO plates (vehicle_id, license_plate, plate_path, province, crop_path)
             VALUES (?, ?, ?, ?, ?)`,
    [vehicleID, licensePlate, platePath, province, cropPath]
  );
}

// Helper: Maintains connection for transaction
async function insertOverview(connection, vehicleID, image) {
  await connection.query(
    `INSERT INTO images (vehicle_id, path, url)
         VALUES (?, ?, ?)`,
    [vehicleID, image, image]
  );
}

// Optimized: Insert flags using Batch Insert with Chunking
async function insertFlags(connection, vehicleID, flags, flagType) {
  if (!flags || !Array.isArray(flags) || flags.length === 0) return;

  const startTime = Date.now();
  const values = flags.map(flag => [vehicleID, flagType, flag]);

  for (let i = 0; i < values.length; i += DB_BATCH_SIZE) {
    const chunk = values.slice(i, i + DB_BATCH_SIZE);
    await connection.query(
      `INSERT INTO flags (vehicle_id, flag_type, flag_value)
       VALUES ?`,
      [chunk]
    );
  }

  if (IS_DEV) {
    console.log(`[PERF] insertFlags (Batch: ${flagType}) took ${Date.now() - startTime}ms for ${flags.length} flags`);
  }
}

/**
 * Refactored: Main function to insert vehicle with full transaction safety and batching.
 * Includes Read Committed isolation level and Deadlock retry logic.
 */
async function insertVehicleWithDetails(vehicleData) {
  const totalStartTime = Date.now();
  const connection = await pool.getConnection();

  const executeTransaction = async (isRetry = false) => {
    try {
      // Step 1: Set Isolation Level
      await connection.query("SET TRANSACTION ISOLATION LEVEL READ COMMITTED");
      
      // Step 2: Begin Transaction
      await connection.beginTransaction();

      // Step 3: Sequential execution within transaction
      const vehicleID = await insertVehicle(connection, vehicleData);
      
      await insertAxles(connection, vehicleID, vehicleData.axles);
      await insertAxlesAfterAllowances(connection, vehicleID, vehicleData.axlesAfterAllowance);
      
      await insertPlates(
        connection,
        vehicleID,
        vehicleData.licensePlate,
        vehicleData.platePath,
        vehicleData.province,
        vehicleData.cropPath
      );

      await insertOverview(connection, vehicleID, vehicleData.overviewPath);
      
      await insertFlags(connection, vehicleID, vehicleData.errorFlag, "error");
      await insertFlags(connection, vehicleID, vehicleData.warningFlag, "warning");

      // Step 4: Commit
      await connection.commit();
      
      if (IS_DEV) {
        console.log(`[PERF] insertVehicleWithDetails (Total Transaction) took ${Date.now() - totalStartTime}ms`);
      }
      
      return vehicleID;

    } catch (err) {
      // Step 5: Rollback on any failure
      await connection.rollback();

      // Step 6: Deadlock Retry Logic (Only once)
      if (err.code === 'ER_LOCK_DEADLOCK' && !isRetry) {
        if (IS_DEV) console.warn(`[DB] Deadlock detected for Vehicle ID: ${vehicleData.id}. Retrying once...`);
        return executeTransaction(true);
      }

      console.error(`[DB Error] Failed to insert vehicle ${vehicleData.id}:`, err.message);
      throw err;
    }
  };

  try {
    return await executeTransaction();
  } finally {
    // Step 7: Always release connection
    connection.release();
  }
}

// Exported for backward compatibility but modified internally to use pool.query if called directly
// (Though typically only insertVehicleWithDetails is used by controllers)
async function getVehicleClasses() {
  const [rows] = await pool.query(`SELECT * FROM vehicle_classes`);
  return rows;
}

async function getSingleTires() {
  const query = `
        SELECT 
            vehicle_class_id,
            JSON_ARRAYAGG(axle_position) AS axle_positions
        FROM 
            single_tires
        GROUP BY 
            vehicle_class_id;
    `;
  const [rows] = await pool.query(query);
  return rows;
}

// Maintain backward compatibility for update functions
async function updatePlates(vehicleID, licensePlate, platePath, province, cropPath) {
  const [result] = await pool.query(
    `UPDATE plates
     SET license_plate = ?, plate_path = ?, province = ?, crop_path = ?
     WHERE vehicle_id = ?`,
    [licensePlate, platePath, province, cropPath, vehicleID]
  );
  return result.affectedRows > 0;
}

async function updateOverview(vehicleID, image) {
  const [result] = await pool.query(
    `UPDATE images 
     SET path = ?, url = ?
     WHERE vehicle_id = ?`,
    [image, image, vehicleID]
  );
  return result.affectedRows > 0;
}

module.exports = {
  insertVehicleWithDetails,
  getVehicleClasses,
  getSingleTires,
  updateOverview,
  updatePlates
};
