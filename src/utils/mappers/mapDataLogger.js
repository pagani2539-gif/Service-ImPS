// src\utils\mappers\mapDataLogger.js
// Utildatay to map error flags
function mapWarningFlag(data) {
  const warningFlag = data.warningFlags;
  warningFlag_binary = warningFlag.toString(2).split("").reverse();
  arr_index_warning = warningFlag_binary
    .map((elm, idx) => (elm == 1 ? idx : ""))
    .filter(String);
  arr_index_warning = arr_index_warning.filter((value) =>
    // [4, 9, 10].includes(value)
    [9, 10].includes(value)
  );
  data.warningFlag = arr_index_warning;
  data.isWarningFlagged = arr_index_warning.length > 0;
  return data;
}
function mapErrorFlag(data) {
  const errorFlag = data.errorFlags;
  errorFlag_binary = errorFlag.toString(2).split("");
  arr_index_error = errorFlag_binary
    .map((elm, idx) => (elm == 1 ? idx : ""))
    .filter(String);
  data.errorFlag = arr_index_error;
  data.isErrorFlagged = arr_index_error.length > 0;
  return data;
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
function setViolation(data, vehiclesClass,exemptClassIDs = []) {
  const gvwMax = vehiclesClass[data.vehicleClassID]?.gvw_max || 1; // Default to 1 to avoid division by zero
  if (data.gvw <= gvwMax || exemptClassIDs.includes(data.vehicleClassID) ) {
    data.violation = 0; // No violation
    data.isOverweight = false;
    data.overweight_percentage = 0; // No overweight
  } else {
    data.violation = 1; // Violation detected
    data.isOverweight = true;
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
// function calculateESAL(data, config, vehiclesClass) {
//   let esalTotal = 0;
//   const floor = config.floor_type || "flexible";
//   const thick = config.thick || 10;

//   function safeDivide(numerator, denominator) {
//     return denominator !== 0 ? numerator / denominator : 0; // Avoid division by zero
//   }

//   if (floor === "flexible") {
//     data.axles.forEach((element) => {
//       const gvwMax = vehiclesClass[data.vehicleClassID]?.gvw_max || 1; // Fallback to 1 to avoid division errors
//       const weight = safeDivide(data.gvw * element.weight, gvwMax);
//       const pt = 2.5;
//       const D = thick || 10;
//       const lx = safeDivide(weight * 2.20462262185, 1000);
//       const l2 = element.groupID > 0 ? 2 : 1;

//       const bx0 = 3.63 * Math.pow(lx + l2, 5.2);
//       const bx1 = Math.pow(D + 1, 8.46) * Math.pow(l2, 3.52);
//       const bx = 1 + safeDivide(bx0, bx1);

//       const b18_0 = 3.63 * Math.pow(18 + 1, 5.2);
//       const b18_1 = Math.pow(D + 1, 8.46) * Math.pow(1, 3.52);
//       const b18 = 1 + safeDivide(b18_0, b18_1);

//       const gt = safeDivide(Math.log10((4.5 - pt) / 3), 1); // Avoid invalid log operation
//       const log_wtx_wt18 =
//         5.9078 -
//         4.62 * Math.log10(lx + l2) +
//         3.28 * Math.log10(l2) +
//         safeDivide(gt, bx) -
//         safeDivide(gt, b18);

//       const wtx_wt18 = Math.pow(10, log_wtx_wt18);
//       const wtx = safeDivide(18, wtx_wt18);
//       const ealf = safeDivide(18, wtx);

//       if (isFinite(ealf)) {
//         esalTotal += ealf; // Only add valid values
//       }
//     });
//   }

//   if (floor === "rigid") {
//     data.axles.forEach((element) => {
//       const gvwMax = vehiclesClass[data.vehicleClassID]?.gvw_max || 1;
//       const weight = safeDivide(data.gvw * element.weight, gvwMax);
//       const pt = 2.5;
//       const D = thick || 10;
//       const lx = safeDivide(weight * 2.20462262185, 1000);
//       const l2 = element.groupID > 0 ? 2 : 1;

//       const bx0 = 0.081 * Math.pow(lx + l2, 3.23);
//       const bx1 = Math.pow(D + 1, 5.19) * Math.pow(l2, 3.23);
//       const bx = 0.4 + safeDivide(bx0, bx1);

//       const b18_0 = 0.081 * Math.pow(18 + 1, 3.23);
//       const b18_1 = Math.pow(D + 1, 5.19) * Math.pow(1, 3.23);
//       const b18 = 0.4 + safeDivide(b18_0, b18_1);

//       const gt = safeDivide(Math.log10((4.2 - pt) / 2.7), 1);
//       const log_wtx_wt18 =
//         Math.log10(18 + 1) * 4.79 -
//         Math.log10(lx + l2) * 4.79 +
//         Math.log10(l2) * 4.33 +
//         safeDivide(gt, bx) -
//         safeDivide(gt, b18);

//       const wtx_wt18 = Math.pow(10, log_wtx_wt18);
//       const wtx = safeDivide(18, wtx_wt18);
//       const ealf = safeDivide(18, wtx);

//       if (isFinite(ealf)) {
//         esalTotal += ealf; // Only add valid values
//       }
//     });
//   }

//   data.esal = esalTotal;
//   return data;
// }
// คำนวณ ESAL ต่อ "การวิ่งผ่านหนึ่งครั้ง" ของรถคันหนึ่ง
function calculateESAL(data, config = {}) {
  // ----------------- config -----------------
  const floor = (config.floor_type || "flexible").toLowerCase(); // "flexible" | "rigid"
  const SN = Number(config.SN ?? 5);       // สำหรับ flexible
  const D  = Number(config.D  ?? config.thick ?? 10); // in (นิ้ว) สำหรับ rigid
  const Pt = Number(config.pt ?? 2.5);     // terminal serviceability

  // ----------------- helpers ----------------
  const lbPerKg = 2.20462262185;
  const kgToKip = (kg) => (kg * lbPerKg) / 1000; // 1 kip = 1000 lb
  const log10 = (x) => Math.log10(x);

  // สร้าง "กลุ่มเพลา" จาก pattern groupID (0 = single, ตัวเลขเดียวกันที่ติดกัน = กลุ่มเดียวกัน)
  function buildAxleGroups(axles) {
    const groups = [];
    let cur = null;
    const push = () => {
      if (!cur) return;
      cur.nAxles = cur.axles.length;
      cur.groupLoadKg = cur.axles.reduce((s, a) => s + a.axleLoadKg, 0);
      groups.push(cur);
      cur = null;
    };
    (axles || []).forEach((ax, idx) => {
      const axleLoadKg =
        typeof ax.weight === "number" && ax.weight > 0
          ? ax.weight
          : (ax.weightLeft || 0) + (ax.weightRight || 0);

      const rec = { ...ax, axleIndex: idx, axleLoadKg };
      if (ax.groupID > 0) {
        if (!cur || cur.groupID !== ax.groupID || cur.isSingle) {
          push();
          cur = { groupID: ax.groupID, isSingle: false, axles: [] };
        }
        cur.axles.push(rec);
      } else {
        push();
        cur = { groupID: 0, isSingle: true, axles: [rec] };
        push();
      }
    });
    push();
    return groups;
  }

  // --------- AASHTO 1993: ตามสูตรในรูป ---------
  function EALF_Flexible(Lx_kip, L2, SN, Pt) {
    const Gt   = log10((4.2 - Pt) / (4.2 - 1.5));
    const betx = 0.40 + (0.081 * Math.pow(Lx_kip + L2, 3.23)) /
                          (Math.pow(SN + 1, 5.19) * Math.pow(L2, 3.23));
    const bet18 = 0.40 + (0.081 * Math.pow(18 + 1, 3.23)) /
                           (Math.pow(SN + 1, 5.19) * Math.pow(1, 3.23));
    const log_wtx_w18 =
      4.79 * log10(18 + 1) -
      4.79 * log10(Lx_kip + L2) +
      4.33 * log10(L2) +
      (Gt / betx) -
      (Gt / bet18);

    const wtx_w18 = Math.pow(10, log_wtx_w18);
    return 1 / wtx_w18; // EALF = W18/Wtx
  }

  function EALF_Rigid(Lx_kip, L2, D_in, Pt) {
    const Gt   = log10((4.5 - Pt) / (4.5 - 1.5));
    const betx = 1.00 + (3.63 * Math.pow(Lx_kip + L2, 5.20)) /
                          (Math.pow(D_in + 1, 8.46) * Math.pow(L2, 5.52));
    const bet18 = 1.00 + (3.63 * Math.pow(18 + 1, 5.20)) /
                           (Math.pow(D_in + 1, 8.46) * Math.pow(1, 5.52));
    const log_wtx_w18 =
      4.62 * log10(18 + 1) -
      4.62 * log10(Lx_kip + L2) +
      3.28 * log10(L2) +
      (Gt / betx) -
      (Gt / bet18);

    const wtx_w18 = Math.pow(10, log_wtx_w18);
    return 1 / wtx_w18; // EALF = W18/Wtx
  }

  // --------------- main calc ----------------
  let esalTotal = 0;
  const groups = buildAxleGroups(data.axles);

  groups.forEach((g) => {
    const L2 = g.nAxles;                         // จำนวนเพลาในกลุ่ม
    const Lx_kip = kgToKip(g.groupLoadKg);       // น้ำหนัก "กลุ่มเพลา" (kip)
    if (!Number.isFinite(Lx_kip) || Lx_kip <= 0) return;

    const ealf =
      floor === "rigid"
        ? EALF_Rigid(Lx_kip, L2, D, Pt)
        : EALF_Flexible(Lx_kip, L2, SN, Pt);

    if (Number.isFinite(ealf)) esalTotal += ealf;
  });

  return { ...data, esal: esalTotal };
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
  data.lane = Number(rawData.LaneNo);
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
  data.direction = rawData.Direction || 0

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
    console.log("isBusByWheelbase");
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
    console.log("isBusByLicensePlate");
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
 * Check if the vehicle's wheelbase is ignored based on a minimum length.
 * @param {Number} wheelbase - The wheelbase of the vehicle in millimeters (or appropriate units).
 * @param {Number} minLength - The minimum wheelbase length to not be ignored.
 * @returns {Boolean} - Returns true if the wheelbase is less than the minimum length (ignored), false otherwise.
 */
function isIgnoredLength(wheelbase, minLength) {
  if (
    !wheelbase ||
    typeof wheelbase !== "number" ||
    !minLength ||
    typeof minLength !== "number"
  ) {
    return false; // Invalid input
  }

  // Check if the wheelbase is less than the minimum length
  if (wheelbase < minLength) {
    console.log("isIgnoredLength");
    return true; // Wheelbase is ignored
  }

  return false; // Wheelbase is not ignored
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


/**
 * รวมน้ำหนักรถ 2 คันที่วิ่งคร่อมเลน
 * @param {Object} vehicleLeft - ข้อมูลรถที่ตรวจจับได้ฝั่งซ้าย (มีน้ำหนักฝั่งซ้ายที่ถูกต้อง)
 * @param {Object} vehicleRight - ข้อมูลรถที่ตรวจจับได้ฝั่งขวา (มีน้ำหนักฝั่งขวาที่ถูกต้อง)
 * @returns {Object|null} - ข้อมูลรถที่รวมน้ำหนักแล้ว หรือ null ถ้าจำนวนเพลาไม่ตรงกัน
 */
function mergeStraddlingVehicles(vehicleLeft, vehicleRight) {
  // ตรวจสอบเบื้องต้นว่าจำนวนเพลาเท่ากันหรือไม่
  if (vehicleLeft.axles.length !== vehicleRight.axles.length) {
    console.error("Cannot merge: Axle counts do not match.");
    return null;
  }

  // ใช้โครงสร้างของ vehicleLeft เป็นฐาน (หรือเลือกคันที่สมบูรณ์กว่า)
  let mergedData = { ...vehicleLeft };
  
  let totalGvw = 0;
  let totalLeftWeight = 0;
  let totalRightWeight = 0;

  // วนลูปเพื่อรวมน้ำหนักแต่ละเพลา
  mergedData.axles = vehicleLeft.axles.map((axleL, index) => {
    const axleR = vehicleRight.axles[index];
    
    // รวมน้ำหนักซ้ายจากคันซ้าย และขวาจากคันขวา
    const newWeightLeft = axleL.weightLeft;
    const newWeightRight = axleR.weightRight;
    const newAxleWeight = newWeightLeft + newWeightRight;

    totalLeftWeight += newWeightLeft;
    totalRightWeight += newWeightRight;
    totalGvw += newAxleWeight;

    return {
      ...axleL,
      weightLeft: newWeightLeft,
      weightRight: newWeightRight,
      weight: newAxleWeight,
      // คำนวณความเร็วเฉลี่ยจากทั้งสองฝั่ง (ถ้าจำเป็น)
      speedLeft: axleL.speedLeft,
      speedRight: axleR.speedRight,
    };
  });

  // อัปเดตค่าน้ำหนักรวมของรถ
  mergedData.gvw = totalGvw;
  mergedData.leftWeight = totalLeftWeight;
  mergedData.rightWeight = totalRightWeight;
  
  // ล้างค่า Path รูปภาพหรือป้ายทะเบียนเพื่อให้ระบบไป Process ใหม่
  mergedData.licensePlate = ""; 
  mergedData.isStraddlingMerged = true; // flag ไว้ว่าเกิดจากการรวมข้อมูล

  return mergedData;
}

/**
 * Check if the vehicle is moving in the reverse direction.
 * @param {Number} direction - The direction flag from the data.
 * @returns {Boolean} - Returns true if direction is 1 (reverse), false otherwise.
 */
function isReverseDirection(direction) {
  // ตรวจสอบว่าถ้า direction เท่ากับ 1 ให้ถือว่าเป็นทิศทางย้อนกลับ (True)
  return direction === 1;
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
  isBusByWheelbase,
  isIgnoredLength,
  mergeStraddlingVehicles,
  isReverseDirection
};
