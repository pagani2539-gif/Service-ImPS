const pool = require("../config/db"); // Import database connection pool

// Insert a vehicle into the Vehicles table
async function insertVehicle(data) {
  const [result] = await pool.query(
    `INSERT INTO vehicles (axles_count, gvw, vehicle_id, lane, left_weight, right_weight, length, speed, stamp, is_overweight, error_flags, warning_flags,vehicle_class_id,esal,overweight_percentage)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
      data.vehicleClassID,
      data.esal,
      data.overweight_percentage,
    ]
  );
  return result.insertId; // Return the newly inserted vehicle ID
}

// Insert axles data into the Axles table
async function insertAxles(vehicleID, axles) {
  for (const axle of axles) {
    await pool.query(
      `INSERT INTO axles (vehicle_id, group_id, number, speed_left, speed_right, weight, weight_left, weight_right, wheelbase, dual_tire)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
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
      ]
    );
  }
}

// Insert axles after allowances into the AxlesAfterAllowance table
async function insertAxlesAfterAllowances(vehicleID, axlesAfterAllowance) {
  for (const axle of axlesAfterAllowance) {
    await pool.query(
      `INSERT INTO axles_after_allowance (vehicle_id, allowance, axle_weight, number)
             VALUES (?, ?, ?, ?)`,
      [vehicleID, axle.allowance, axle.axleWeight, axle.number]
    );
  }
}

// Insert license plate data into the Plates table
async function insertPlates(
  vehicleID,
  licensePlate,
  platePath,
  province,
  cropPath
) {
  await pool.query(
    `INSERT INTO plates (vehicle_id, license_plate, plate_path, province, crop_path)
             VALUES (?, ?, ?, ?, ?)`,
    [vehicleID, licensePlate, platePath, province, cropPath]
  );
}

// Insert image data into the Images table
async function insertOverview(vehicleID, image) {
  await pool.query(
    `INSERT INTO images (vehicle_id, path, url)
         VALUES (?, ?, ?)`,
    [vehicleID, image, image]
  );
}

// Insert flags (error or warning) into the Flags table
async function insertFlags(vehicleID, flags, flagType) {
  for (const flag of flags) {
    await pool.query(
      `INSERT INTO flags (vehicle_id, flag_type, flag_value)
             VALUES (?, ?, ?)`,
      [vehicleID, flagType, flag]
    );
  }
}

// Main function to insert a vehicle and all related data
async function insertVehicleWithDetails(vehicleData) {
  const vehicleID = await insertVehicle(vehicleData); // Insert into Vehicles
  await insertAxles(vehicleID, vehicleData.axles); // Insert related axles
  await insertAxlesAfterAllowances(vehicleID, vehicleData.axlesAfterAllowance); // Insert axles after allowances
  await insertPlates(
    vehicleID,
    vehicleData.licensePlate,
    vehicleData.platePath,
    vehicleData.province,
    vehicleData.cropPath
  ); // Insert related plate
  await insertOverview(vehicleID, vehicleData.overviewPath); // Insert related images
  await insertFlags(vehicleID, vehicleData.errorFlag, "error"); // Insert error flags
  await insertFlags(vehicleID, vehicleData.warningFlag, "warning"); // Insert warning flags
  return vehicleID;
}

// Retrieve vehicle classes from the VehicleClasses table
async function getVehicleClasses() {
  const [rows] = await pool.query(`SELECT * FROM vehicle_classes`);
  return rows; // Return all vehicle classes as an array of objects
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

module.exports = {
  insertVehicle,
  insertAxles,
  insertAxlesAfterAllowances,
  insertPlates,
  insertImages: insertOverview,
  insertFlags,
  insertVehicleWithDetails, // Export the main function for convenience
  getVehicleClasses,
  getSingleTires,
};
