// Mapping logic for InterComp
const dayjs = require("dayjs");
function mapWarning(data) {
  return data.map((bit) => warning.find((item) => item.bit == bit));
}
function isWarning(data) {
  let arr_warning = [];
  if (isCrossingLaneWarning(data)) arr_warning.push(27);
  return arr_warning;
}
function isCrossingLaneWarning(data) {
  let value = false;
  if (data.axles.length > 0)
    if (data.axles[0].weightLeft == 0 || data.axles[0].weightRight == 0)
      value = true;

  if (value) data.warningFlags = 27;
  return data;
}
function convertDataTimeToMillisecond(dateTime) {
  return parseInt(dateTime.replace("/Date(", "").replace(")/", ""), 10);
}

function getWheelbaseGroupId(
  data,
  index,
  groupCount,
  prevGroupId,
  wheelBaseGroup
) {
  let newGroupCount = groupCount;
  if (prevGroupId === 0) {
    newGroupCount = newGroupCount + 1;
  }

  if (index === 0) {
    if (data.AxleSpacing[index] < wheelBaseGroup) {
      return [newGroupCount, newGroupCount];
    } else {
      return [0, groupCount];
    }
  } else if (index === data.AxleSpacing.length) {
    if (data.AxleSpacing[index - 1] < wheelBaseGroup) {
      return [newGroupCount, newGroupCount];
    } else {
      return [0, groupCount];
    }
  } else if (
    data.AxleSpacing[index] < wheelBaseGroup &&
    data.AxleSpacing[index - 1] >= wheelBaseGroup
  ) {
    if (prevGroupId !== 0) {
      return [newGroupCount + 1, newGroupCount + 1];
    }
    return [newGroupCount, newGroupCount];
  } else if (
    data.AxleSpacing[index] < wheelBaseGroup ||
    data.AxleSpacing[index - 1] < wheelBaseGroup
  ) {
    return [newGroupCount, newGroupCount];
  }
  return [0, groupCount];
}

function mapWarningFlag(data) {
  const warningFlag = data.warningFlags;
  const warningFlag_binary = warningFlag.toString(2).split("").reverse();
  const arr_index_warning = warningFlag_binary
    .map((elm, idx) => (elm == 1 ? idx : ""))
    .filter(String);
  const filtered_warning = arr_index_warning.filter((value) =>
    // [4, 9, 10].includes(value)
    [4, 10].includes(value)
  );
  data.warningFlag = filtered_warning;
  data.isWarningFlagged = filtered_warning.length > 0;
  return data;
}
function mapErrorFlag(data) {
  const errorFlag = data.errorFlags;
  const errorFlag_binary = errorFlag.toString(2).split("").reverse();
  const arr_index_error = errorFlag_binary
    .map((elm, idx) => (elm == 1 ? idx : ""))
    .filter(String);
  data.errorFlag = arr_index_error;
  data.isErrorFlagged = arr_index_error.length > 0;
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

/**
 * Inserts a space or dash into the license plate.
 * - If numeric (Truck/Bus), inserts a dash (e.g., 70-1234).
 * - If contains Thai characters (Passenger), inserts a space (e.g., 1หป 1234, กข 1234).
 * @param {string} licensePlate - The license plate string.
 * @returns {string} - Formatted license plate string.
 */
function formatLicensePlate(licensePlate) {
  if (!licensePlate) return "";
  const clean = licensePlate.replace(/[-\s]/g, "");

  // 1. Truck/Bus (Numeric only, 6-7 digits)
  if (/^\d+$/.test(clean)) {
    if (clean.length === 6) return clean.slice(0, 2) + "-" + clean.slice(2);
    if (clean.length === 7) return clean.slice(0, 3) + "-" + clean.slice(3);
    return clean;
  }

  // 2. Passenger (Thai characters present)
  // Pattern: (Optional digit + 1-3 Thai letters) + (Remaining digits)
  const match = clean.match(/^([0-9]?[\u0E01-\u0E2E]{1,3})([0-9]+)$/);
  if (match) {
    return match[1] + " " + match[2];
  }

  return licensePlate;
}

/**
 * Check if the vehicle is a bus based on the wheelbase.
 * @param {Number} wheelbase - The wheelbase of the vehicle in millimeters (or appropriate units).
 * @param {Number} minimumWheelbase - The minimum wheelbase required to classify the vehicle as a bus.
 * @returns {Boolean} - Returns true if the vehicle is identified as a bus, false otherwise.
 */
function isBusByWheelbase(wheelbase, minimumWheelbase) {
  if (
    !wheelbase ||
    typeof wheelbase !== "number" ||
    !minimumWheelbase ||
    typeof minimumWheelbase !== "number"
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
/**
 * Check if the vehicle is a bus based on the license plate.
 * Refined for Thai DLT regulations:
 * - Trucks use 70-79 or 80-89 (Keep)
 * - Buses use 10-19 or 30-35 (Filter)
 */
function isBusByLicensePlate(licensePlate) {
  if (!licensePlate || typeof licensePlate !== "string") return false;

  const plate = licensePlate.replace(/-/g, ""); // Remove dashes for check
  if (plate.length >= 2) {
    const prefix = plate.substring(0, 2);
    // Standard DLT bus prefixes
    if (["10", "11", "12", "13", "14", "15", "16", "17", "18", "19", 
         "30", "31", "32", "33", "34", "35"].includes(prefix)) {
      console.log(`[Filter] Classified as Bus by prefix: ${prefix}`);
      return true;
    }
  }

  return false; 
}

/**
 * Revised license plate filter based on Thai DLT standards.
 */
function isVehicleExcludedByPlate(licensePlate) {
  if (!licensePlate || typeof licensePlate !== "string") return false;

  const cleanPlate = licensePlate.replace(/[-\s]/g, "");
  if (cleanPlate.length === 0) return false;

  // 1. Starts with Thai character (e.g., กข 1234) -> Exclude
  const firstChar = cleanPlate.charCodeAt(0);
  if (firstChar >= 0x0E01 && firstChar <= 0x0E2E) {
    console.log(`[Filter] Excluded by Thai prefix: ${licensePlate}`);
    return true;
  }

  // 2. Starts with digit
  if (/^\d/.test(cleanPlate)) {
    // Check for new format: Digit + Thai char (e.g., 1หป 1234) -> Exclude
    if (cleanPlate.length > 1) {
      const secondChar = cleanPlate.charCodeAt(1);
      if (secondChar >= 0x0E01 && secondChar <= 0x0E2E) {
        console.log(`[Filter] Excluded by modern Thai prefix (digit+char): ${licensePlate}`);
        return true;
      }
    }

    // DLT standard prefixes for trucks/buses
    const prefix = parseInt(cleanPlate.substring(0, 2), 10);
    if (prefix >= 10 && prefix <= 49) {
      console.log(`[Filter] Excluded by Bus/Passenger prefix: ${prefix} (${licensePlate})`);
      return true;
    }
    
    // Truck ranges (50-99) -> Keep
    if (prefix >= 50 && prefix <= 99) {
      return false; 
    }
  }

  return false;
}

/**
 * Check if the license plate contains non-numeric characters (Passenger Car check).
 * @param {String} licensePlate - The license plate of the vehicle.
 * @param {Number} vehicleClassID - To distinguish heavy vehicles from passenger cars.
 */
function hasNonNumericCharacters(licensePlate, vehicleClassID) {
  if (!licensePlate || typeof licensePlate !== "string") return false;

  // FAILSAFE: If it's a multi-axle vehicle (Class 3-19), it's definitely a truck, not a car.
  if (vehicleClassID >= 3) {
    return false;
  }

  // Allow numeric and dashes
  const cleanPlate = licensePlate.replace(/-/g, "").trim();
  
  // If it contains Thai letters (e.g. "กข 1234"), it's likely a passenger car
  if (/[^0-9]/.test(cleanPlate)) {
    console.log(`[Filter] Potential passenger car detected: ${licensePlate}`);
    return true; 
  }

  return false;
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



function mapInterComp(rawData, config) {
  let groupCount = 0;
  let prevGroupId = 0;
  let groupWeight = [];
  let tempGroup = -1;
  const divideWeight = 2.205;
  rawData.AxleSpacing = rawData.AxleSpacing.map((axleSpace) => {
    return axleSpace * 0.3048;
  });
  const axles = rawData.AxleWeight.map((weight, index) => {
    const [groupId, newGroupCount] = getWheelbaseGroupId(
      rawData,
      index,
      groupCount,
      prevGroupId,
      config.wheel_base_group_length/100
    );
    groupCount = newGroupCount;
    prevGroupId = groupId;
    //ESAL
    if (groupId == 0) {
      groupWeight.unshift({ weight, numAxles: 1 });
      tempGroup = groupId;
    } else {
      if (groupId != tempGroup) {
        groupWeight.unshift({ weight, numAxles: 1 });
        tempGroup = groupId;
      } else {
        groupWeight[0].weight += weight;
        groupWeight[0].numAxles++;
      }
    }

    return {
      number:index+1,
      speedLeft: 0,
      speedRight: 0,
      weight: weight / divideWeight,
      wheelbase:
        (index == 0 || !rawData.AxleSpacing[index - 1]
          ? 0
          : rawData.AxleSpacing[index - 1]) * 100,
      groupID: groupId,
      weightLeft:
        (rawData.ScaleAxleIdWeight[index]
          ? rawData.ScaleAxleIdWeight[index]
          : 0 + rawData.ScaleAxleIdWeight[index + rawData.AxleWeight.length * 2]
          ? rawData.ScaleAxleIdWeight[index + rawData.AxleWeight.length * 2]
          : 0) / divideWeight,
      weightRight:
        (rawData.ScaleAxleIdWeight[index + rawData.AxleWeight.length]
          ? rawData.ScaleAxleIdWeight[index + rawData.AxleWeight.length]
          : 0 + rawData.ScaleAxleIdWeight[index + rawData.AxleWeight.length * 3]
          ? rawData.ScaleAxleIdWeight[index + rawData.AxleWeight.length * 3]
          : 0) / divideWeight,
      dualTire: true,
      // dualTire: rawData.DualTires[index]? rawData.DualTires[index] : false
    };
  });
  const wheelBase = rawData.AxleSpacing.length
    ? rawData.AxleSpacing.reduce(
        (accumulator, currentValue) => accumulator + currentValue,
        0
      )
    : 0;
  let data = {};
  // newData.esal = ESAL(group_weight).toFixed(2)
  data.axles = axles;
  data.axlesAfterAllowance = [];
  data.gvw = rawData.TotalWeight / divideWeight;
  data.axlesCount = rawData.AxleWeight.length;
  data.id = rawData.id;
  data.lane = Number(rawData.LaneNo);
  data.leftWeight =  axles.reduce((sum, item) => sum + item.weightLeft, 0);
  data.rightWeight = axles.reduce((sum, item) => sum + item.weightRight, 0);

  data.esal = 0;

  data.length =
    ((convertDataTimeToMillisecond(rawData.TimeStamp_End) -
      convertDataTimeToMillisecond(rawData.TimeStamp_Start)) /
      1000) *
    (rawData.Speed * 0.44704) *
    100;
  data.speed = rawData.Speed * 1.609344;
  data.overviewPath = "";
  data.platePath = "";
  data.licensePlate = "";
  data.province = "";
  data.cropPath = "";
  data.stamp = dayjs(convertDataTimeToMillisecond(rawData.TimeStamp_Start)).format('YYYY-MM-DD HH:mm:ss.SSS');
  data.violation = 0;
  data.WheelBase = wheelBase * 100;
  data.vehicleClassID = 0;
  data.errorFlags = 0;
  data.warningFlags = 0;

  return data;
}

module.exports = {
  mapInterComp,
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
  isCrossingLaneWarning,
  convertDataTimeToMillisecond,
  isIgnoredLength
};
