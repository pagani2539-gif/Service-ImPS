// src\utils\mappers\mapDataLogger.js
// Utildatay to map error flags
function mapWarningFlag(data) {
  const warningFlag = data.warningFlags;
  warningFlag_binary = warningFlag.toString(2).split("");
  arr_index_warning = warningFlag_binary
    .map((elm, idx) => (elm == 1 ? idx : ""))
    .filter(String);
  arr_index_warning = arr_index_warning.filter((value) =>
    // [4, 9, 10].includes(value)
    [4, 10].includes(value)
  );
  data.warningFlag = arr_index_warning;
  return data;
  // return arr_index_warning.map((item) => (warning[item] ? warning[item] : []));
}
function mapErrorFlag(data) {
  const errorFlag = data.errorFlags;
  errorFlag_binary = errorFlag.toString(2).split("");
  arr_index_error = errorFlag_binary
    .map((elm, idx) => (elm == 1 ? idx : ""))
    .filter(String);
  data.errorFlag = arr_index_error;
  return data;
  // return arr_index_error.map((item) => (error[item] ? error[item] : []));
}

// Function to classify the vehicle based on the data
function classifyVehicle(data, config) {
  // Implement classification logic here (reusing your classification logic)
  let classifiedVehicle = { ...data };

  if (data.gvw === -1) {
    classifiedVehicle.vehicleClassID = 0;
  } else if (data.axles.length === 2) {
    if (data.axles[1].wheelbase < config.distance_of_axles_between_class_2) {
      classifiedVehicle.vehicleClassID = 1;
    } else {
      classifiedVehicle.vehicleClassID = 2;
    }
  } else if (data.axles.length === 3) {
    classifiedVehicle.vehicleClassID = 3;
  } else if (data.axles.length == 4) {
    if (data.axles[2].groupID == 0 && data.axles[3].groupID == 0) {
      classifiedVehicle.vehicleClassID = 14;
    } else {
      if (data.axles[1].wheelbase < 200) {
        classifiedVehicle.vehicleClassID = 4;
      } else {
        classifiedVehicle.vehicleClassID = 5;
      }
    }
  } else if (data.axles.length == 5) {
    if (
      data.axles[2].groupID == data.axles[3].groupID &&
      data.axles[3].groupID == data.axles[4].groupID
    ) {
      classifiedVehicle.vehicleClassID = 6;
    } else {
      if (
        data.axles[3].groupID == data.axles[4].groupID &&
        data.axles[3].groupID == 0
      ) {
        classifiedVehicle.vehicleClassID = 15;
      } else classifiedVehicle.vehicleClassID = 7;
    }
  } else if (data.axles.length == 6) {
    if (
      data.axles[3].groupID == data.axles[4].groupID &&
      data.axles[4].groupID == data.axles[5].groupID
    ) {
      classifiedVehicle.vehicleClassID = 9;
    } else {
      if (
        data.axles[4].groupID == data.axles[5].groupID &&
        data.axles[4].groupID == 0
      ) {
        classifiedVehicle.vehicleClassID = 16;
      } else if (data.axles[2].groupID == data.axles[3].groupID)
        classifiedVehicle.vehicleClassID = 8;
      else classifiedVehicle.vehicleClassID = 17;
    }
  } else if (data.axles.length == 7) {
    if (
      data.axles[4].groupID == data.axles[5].groupID &&
      data.axles[5].groupID == data.axles[6].groupID
    ) {
      classifiedVehicle.vehicleClassID = 13;
    } else {
      classifiedVehicle.vehicleClassID = 18;
    }
  } else {
    //ประเภทอื่นๆ
    classifiedVehicle.vehicleClassID = 19;
  }
  // Add more classification rules here as needed...

  return classifiedVehicle;
}

// Function to assign violation status
function setViolation(data, vehiclesClass) {
  const gvwMax = vehiclesClass[data.vehicleClassID]?.gvw_max || 1; // Default to 1 to avoid division by zero
  if (data.gvw <= gvwMax) {
    data.violation = 0; // No violation
    data.overweight_percentage = 0; // No overweight
  } else {
    data.violation = 1; // Violation detected
    // Calculate overweight percentage
    data.overweight_percentage = ((data.gvw - gvwMax) / gvwMax) * 100;
  }
  return data;
}

function setSingleTire(data, singleTires) {
  const vehicleClass = singleTires.find(
    (item) => item.vehicle_class_id === data.vehicleClassID
  );
  vehicleClass.axle_positions.forEach((element) => {
    data.axles[element].dualTire = false;
  });
  return data;
}

// Function to calculate ESAL (Equivalent Single Axle Load)
function calculateESAL(data, config, vehiclesClass) {
  let esalTotal = 0;
  const floor = config.floor_type || "flexible";
  const thick = config.thick || 10;

  function safeDivide(numerator, denominator) {
    return denominator !== 0 ? numerator / denominator : 0; // Avoid division by zero
  }

  if (floor === "flexible") {
    data.axles.forEach((element) => {
      const gvwMax = vehiclesClass[data.vehicleClassID]?.gvw_max || 1; // Fallback to 1 to avoid division errors
      const weight = safeDivide(data.gvw * element.weight, gvwMax);
      const pt = 2.5;
      const D = thick || 10;
      const lx = safeDivide(weight * 2.20462262185, 1000);
      const l2 = element.groupID > 0 ? 2 : 1;

      const bx0 = 3.63 * Math.pow(lx + l2, 5.2);
      const bx1 = Math.pow(D + 1, 8.46) * Math.pow(l2, 3.52);
      const bx = 1 + safeDivide(bx0, bx1);

      const b18_0 = 3.63 * Math.pow(18 + 1, 5.2);
      const b18_1 = Math.pow(D + 1, 8.46) * Math.pow(1, 3.52);
      const b18 = 1 + safeDivide(b18_0, b18_1);

      const gt = safeDivide(Math.log10((4.5 - pt) / 3), 1); // Avoid invalid log operation
      const log_wtx_wt18 =
        5.9078 -
        4.62 * Math.log10(lx + l2) +
        3.28 * Math.log10(l2) +
        safeDivide(gt, bx) -
        safeDivide(gt, b18);

      const wtx_wt18 = Math.pow(10, log_wtx_wt18);
      const wtx = safeDivide(18, wtx_wt18);
      const ealf = safeDivide(18, wtx);

      if (isFinite(ealf)) {
        esalTotal += ealf; // Only add valid values
      }
    });
  }

  if (floor === "rigid") {
    data.axles.forEach((element) => {
      const gvwMax = vehiclesClass[data.vehicleClassID]?.gvw_max || 1;
      const weight = safeDivide(data.gvw * element.weight, gvwMax);
      const pt = 2.5;
      const D = thick || 10;
      const lx = safeDivide(weight * 2.20462262185, 1000);
      const l2 = element.groupID > 0 ? 2 : 1;

      const bx0 = 0.081 * Math.pow(lx + l2, 3.23);
      const bx1 = Math.pow(D + 1, 5.19) * Math.pow(l2, 3.23);
      const bx = 0.4 + safeDivide(bx0, bx1);

      const b18_0 = 0.081 * Math.pow(18 + 1, 3.23);
      const b18_1 = Math.pow(D + 1, 5.19) * Math.pow(1, 3.23);
      const b18 = 0.4 + safeDivide(b18_0, b18_1);

      const gt = safeDivide(Math.log10((4.2 - pt) / 2.7), 1);
      const log_wtx_wt18 =
        Math.log10(18 + 1) * 4.79 -
        Math.log10(lx + l2) * 4.79 +
        Math.log10(l2) * 4.33 +
        safeDivide(gt, bx) -
        safeDivide(gt, b18);

      const wtx_wt18 = Math.pow(10, log_wtx_wt18);
      const wtx = safeDivide(18, wtx_wt18);
      const ealf = safeDivide(18, wtx);

      if (isFinite(ealf)) {
        esalTotal += ealf; // Only add valid values
      }
    });
  }

  data.esal = esalTotal;
  return data;
}

// Mapping logic for DataLogger
function mapDataLogger(rawData) {
  let axles = [];
  let axlesAfterAllowance = [];
  let data = {};

  let groupWeight = [];
  let tempGroup = -1;

  for (let i = rawData.Axles.length; i > 0; i--) {
    let element = rawData.Axles[i - 1];
    axles.unshift({
      number: i,
      speedLeft: element.Velocity,
      speedRight: element.Velocity,
      weightLeft: element.LeftWheelWeight,
      weightRight: element.RightWheelWeight,
      wheelbase: element.Distance * 100,
      weight: element.Weight,
      groupID: element.GroupID,
      dualTire: true,
    });

    axlesAfterAllowance.push({
      allowance: 0,
      axleWeight: element.Weight,
      number: i,
    });

    if (element.GroupID === 0) {
      groupWeight.unshift({ weight: element.Weight, numAxles: 1 });
      tempGroup = element.GroupID;
    } else {
      if (element.GroupID !== tempGroup) {
        groupWeight.unshift({ weight: element.Weight, numAxles: 1 });
        tempGroup = element.GroupID;
      } else {
        groupWeight[0].weight += element.Weight;
        groupWeight[0].numAxles++;
      }
    }
  }

  data.axles = axles;
  data.axlesAfterAllowance = axlesAfterAllowance;
  data.gvw = rawData.GrossWeight;
  data.axlesCount = rawData.AxlesCount;
  data.id = rawData.ID;
  data.lane = "TH" + rawData.LaneNo;
  data.leftWeight = rawData.LeftWeight;
  data.rightWeight = rawData.RightWeight;
  data.length = rawData.VehicleLength * 100;
  data.speed = rawData.Velocity;
  data.overviewPath = "";
  data.platePath = "";
  data.licensePlate = "";
  data.province = "";
  data.cropPath = "";
  data.stamp = new Date(parseInt(rawData.StartTime));
  data.violation = 0;
  data.wheelBase = rawData.WheelBase * 100;
  data.vehicleClassID = 0;
  data.errorFlags = rawData.ErrorFlag || 0;
  data.warningFlags = rawData.WarningFlag || 0;

  return data;
}

/**
 * Inserts a dash into the license plate if all characters are numeric.
 * - If length is 6, inserts a dash at index 3.
 * - If length is 7, inserts a dash at index 4.
 * @param {string} licensePlate - The license plate string.
 * @returns {string} - Modified license plate string with a dash or the original string.
 */
function formatLicensePlate(licensePlate) {
  if (/^\d+$/.test(licensePlate)) {
    // Check if all characters are numbers
    if (licensePlate.length === 6) {
      return licensePlate.slice(0, 2) + "-" + licensePlate.slice(2);
    }
    if (licensePlate.length === 7) {
      return licensePlate.slice(0, 3) + "-" + licensePlate.slice(3);
    }
  }
  return licensePlate; // Return the original string if conditions are not met
}

/**
 * Check if the vehicle is a bus based on the wheelbase.
 * @param {Number} wheelbase - The wheelbase of the vehicle in millimeters (or appropriate units).
 * @param {Number} minimumWheelbase - The minimum wheelbase required to classify the vehicle as a bus.
 * @returns {Boolean} - Returns true if the vehicle is identified as a bus, false otherwise.
 */
function isBusByWheelbase(wheelbase, minimumWheelbase) {
  if (
    !wheelbase || typeof wheelbase !== "number" || 
    !minimumWheelbase || typeof minimumWheelbase !== "number"
  ) {
    return false; // Invalid input
  }

  // Check if the wheelbase meets the minimum requirement for a bus
  if (wheelbase >= minimumWheelbase) {
    return true; // It's a bus
  }

  return false; // Not a bus
}


/**
 * Check if the vehicle is a bus based on the license plate.
 * @param {String} licensePlate - The license plate of the vehicle.
 * @returns {Boolean} - Returns true if the vehicle is identified as a bus, false otherwise.
 */
function isBusByLicensePlate(licensePlate) {
  if (!licensePlate || typeof licensePlate !== "string") return false;

  // Split the license plate into characters
  const licensePlateArr = licensePlate.split("");

  // Check if it meets the bus criteria
  if (
    licensePlateArr.length > 1 &&
    (["1", "2", "3", "4"].includes(licensePlateArr[0]) || // Starts with specific numbers
      isNaN(parseInt(licensePlateArr[0])) || // First character is not a number
      isNaN(parseInt(licensePlateArr[1]))) // Second character is not a number
  ) {
    return true; // It's a bus
  }

  return false; // Not a bus
}

/**
 * Check if the GVW should be ignored based on predefined conditions.
 * @param {Object} data - The mapped data object containing GVW and other details.
 * @returns {Boolean} - Returns true if GVW should be ignored, false otherwise.
 */
function ignoreGVW(gvw, gvwIgnored) {
  if (!gvw || typeof gvw === "undefined") return true; // Ignore if no GVW data

  // Example conditions for ignoring GVW
  if (gvw < gvwIgnored) {
    return true;
  }
  return false; // GVW is valid
}

/**
 * Check if the license plate contains non-numeric characters.
 * @param {String} licensePlate - The license plate of the vehicle.
 * @returns {Boolean} - Returns true if the license plate contains non-numeric characters, false otherwise.
 */
function hasNonNumericCharacters(licensePlate) {
  if (!licensePlate || typeof licensePlate !== "string") return false; // Handle null or invalid input

  // Check if the license plate contains any non-numeric character
  return /[^0-9]/.test(licensePlate); // Matches any character that is not a digit (0-9)
}

module.exports = {
  mapDataLogger,
  classifyVehicle,
  calculateESAL,
  setViolation,
  mapWarningFlag,
  mapErrorFlag,
  setSingleTire,
  isBusByLicensePlate,
  ignoreGVW,
  hasNonNumericCharacters,
  formatLicensePlate,
  isBusByWheelbase
};
