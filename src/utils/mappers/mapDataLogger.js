// src\utils\mappers\mapDataLogger.js
const logger = require("../logger");
// Utildatay to map error flags
function mapWarningFlag(data) {
  const warningFlag = data.warningFlags;
  const warningFlag_binary = warningFlag.toString(2).split("").reverse();
  const arr_index_warning = warningFlag_binary
    .map((elm, idx) => (elm == 1 ? idx : ""))
    .filter(String);
  const filtered_warning = arr_index_warning.filter((value) =>
    // [4, 9, 10].includes(value)
    [9, 10].includes(value)
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
  if (!singleTires || !Array.isArray(singleTires)) {
    return data;
  }
  const vehicleClass = singleTires.find(
    (item) => item.vehicle_class_id === data.vehicleClassID
  );
  if (vehicleClass && Array.isArray(vehicleClass.axle_positions)) {
    vehicleClass.axle_positions.forEach((element) => {
      if (data.axles && data.axles[element]) {
        data.axles[element].dualTire = false;
      }
    });
  }
  return data;
}

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
 * Revised license plate filter based on Thai DLT standards.
 * 1. Filters out plates with Thai character prefixes (Passenger cars).
 * 2. Filters out numeric prefixes 10-49 (Buses/Passenger vehicles).
 * 3. Keeps numeric prefixes 50-99 (Trucks).
 * 4. Filters out new format (e.g., 1หป 1234).
 */
function isVehicleExcludedByPlate(licensePlate) {
  if (!licensePlate || typeof licensePlate !== "string") return false;

  const cleanPlate = licensePlate.replace(/[-\s]/g, "");
  if (cleanPlate.length === 0) return false;

  // 1. Starts with Thai character (e.g., กข 1234) -> Exclude
  const firstChar = cleanPlate.charCodeAt(0);
  if (firstChar >= 0x0E01 && firstChar <= 0x0E2E) {
    logger.info(`[Filter] Excluded by Thai prefix: ${licensePlate}`);
    return true;
  }

  // 2. Starts with digit
  if (/^\d/.test(cleanPlate)) {
    // Check for new format: Digit + Thai char (e.g., 1หป 1234) -> Exclude
    if (cleanPlate.length > 1) {
      const secondChar = cleanPlate.charCodeAt(1);
      if (secondChar >= 0x0E01 && secondChar <= 0x0E2E) {
        logger.info(`[Filter] Excluded by modern Thai prefix (digit+char): ${licensePlate}`);
        return true;
      }
    }

    // DLT standard prefixes for trucks/buses
    const prefix = parseInt(cleanPlate.substring(0, 2), 10);
    if (prefix >= 10 && prefix <= 49) {
      logger.info(`[Filter] Excluded by Bus/Passenger prefix: ${prefix} (${licensePlate})`);
      return true;
    }
    
    // Truck ranges (50-99) -> Keep
    if (prefix >= 50 && prefix <= 99) {
      return false; 
    }
  }

  // Default: Keep if it doesn't clearly match exclusion criteria
  return false;
}



/**
 * รวมน้ำหนักรถ 2 คันที่วิ่งคร่อมเลน
 * - เพลาเท่ากัน: รวม index ต่อ index (เลนซ้ายให้น้ำหนักล้อฝั่งซ้ายของรถ, เลนขวาให้ฝั่งขวา)
 * - เพลาไม่เท่ากัน: align ด้วย "ตำแหน่งเพลาสะสม" (wheelbase = ระยะห่างจากเพลาก่อนหน้า) แล้วรวม
 *   เพลาที่จับคู่ได้; เพลาที่อยู่ในเลนเดียว (อีกเลนอ่านไม่เจอ) นับด้านเดียวเท่าที่มี + flag ไว้ให้รีวิว
 * @param {Object} vehicleLeft - ข้อมูลรถที่ตรวจจับได้ (ฝั่งหนึ่ง)
 * @param {Object} vehicleRight - ข้อมูลรถที่ตรวจจับได้ (อีกฝั่ง)
 * @param {number} axleTolCm - ระยะคลาดเคลื่อนตำแหน่งเพลาที่ยอมให้จับคู่กันได้ (ซม.)
 * @returns {Object|null} - ข้อมูลรถที่รวมน้ำหนักแล้ว หรือ null ถ้า align ไม่ลงตัว (น่าจะคนละคัน)
 */
function mergeStraddlingVehicles(vehicleLeft, vehicleRight, axleTolCm = 30) {
  // กำหนดว่าฝั่งไหนอยู่ซ้าย ฝั่งไหนอยู่ขวา ตามหมายเลขเลน (เลนน้อย = ซ้าย)
  let leftPart = vehicleLeft;
  let rightPart = vehicleRight;
  if (vehicleLeft.lane > vehicleRight.lane) {
    leftPart = vehicleRight;
    rightPart = vehicleLeft;
  }

  // รวมเพลาที่จับคู่กันได้: เลนซ้ายให้ฝั่งซ้ายของรถ (sensor ซ้าย+ขวาในเลนซ้าย), เลนขวาให้ฝั่งขวา
  const sumAxle = (axleL, axleR) => {
    const newWeightLeft = axleL.weightLeft + axleL.weightRight;
    const newWeightRight = axleR.weightLeft + axleR.weightRight;
    return {
      ...axleL,
      weightLeft: newWeightLeft,
      weightRight: newWeightRight,
      weight: newWeightLeft + newWeightRight,
      speedLeft: axleL.speedLeft,
      speedRight: axleR.speedRight,
    };
  };

  let mergedAxles;
  let axleMismatch = false;

  if (leftPart.axles.length === rightPart.axles.length) {
    // ----- เพลาเท่ากัน: รวม index ต่อ index (พฤติกรรมเดิม) -----
    mergedAxles = leftPart.axles.map((axleL, i) => sumAxle(axleL, rightPart.axles[i]));
  } else {
    // ----- เพลาไม่เท่ากัน: align ด้วยตำแหน่งเพลาสะสม + เลื่อนหา offset ที่ดีที่สุด -----
    // ตำแหน่งสะสมเทียบจากเพลาแรก (เพลาแรก = 0; เพลาถัดไป = บวก wheelbase = ระยะจากเพลาก่อนหน้า)
    // ปัญหาเดิม: ยึดเพลาแรกของทั้งสองลิสต์ = 0 → ถ้าเลนที่จับได้น้อย "พลาดเพลาหน้า"
    // ตำแหน่งจะเลื่อนทั้งแถว จับคู่เพลาผิด แล้วตกเป็น orphan ทั้งที่เป็นรถคันเดียว
    // แก้: เลื่อนลิสต์สั้นไปทุกตำแหน่งเทียบลิสต์ยาว เลือก offset ที่จับคู่ได้ครบ+ระยะรวมน้อยสุด
    const cumPos = (axles) => {
      let acc = 0;
      return axles.map((a, i) => (i === 0 ? 0 : (acc += a.wheelbase || 0)));
    };

    // เพลาที่อยู่ในเลนเดียว (อีกเลนอ่านไม่เจอด้านเดียว) → นับน้ำหนักด้านเดียวเท่าที่มี
    const oneSided = (axle, fromLeftLane) => {
      const w = (axle.weightLeft || 0) + (axle.weightRight || 0);
      return {
        ...axle,
        weightLeft: fromLeftLane ? w : 0,
        weightRight: fromLeftLane ? 0 : w,
        weight: w,
        oneSided: true, // flag เพลานี้ว่ามาจากเลนเดียว (น้ำหนักอาจไม่ครบ)
      };
    };

    // ลิสต์ยาว = เลนที่จับเพลาได้ครบกว่า (เป็นโครงหลัก), ลิสต์สั้น = เลื่อนไปจับ
    const leftIsLong = leftPart.axles.length >= rightPart.axles.length;
    const longPart = leftIsLong ? leftPart : rightPart;
    const shortPart = leftIsLong ? rightPart : leftPart;
    const longPos = cumPos(longPart.axles);
    const shortPos = cumPos(shortPart.axles);

    // ลองเลื่อนเพลาแรกของลิสต์สั้นไปตรงกับเพลาที่ k ของลิสต์ยาว (delta = longPos[k] - shortPos[0])
    // เลือก offset ที่จับคู่ครบทุกเพลาของลิสต์สั้น แล้วระยะรวมน้อยสุด
    let best = { matched: -1, totalDist: Infinity, pairs: null };
    for (let k = 0; k < longPos.length; k++) {
      const delta = longPos[k] - shortPos[0];
      const pairs = new Array(longPos.length).fill(-1); // index ลิสต์ยาว → index ลิสต์สั้นที่จับคู่
      let s = 0, matched = 0, totalDist = 0;
      for (let l = 0; l < longPos.length && s < shortPos.length; l++) {
        const d = Math.abs((shortPos[s] + delta) - longPos[l]);
        if (d <= axleTolCm) { pairs[l] = s; matched++; totalDist += d; s++; }
      }
      // ใช้ offset นี้ได้ก็ต่อเมื่อจับคู่เพลาของลิสต์สั้นได้ "ครบทุกเพลา"
      if (s === shortPos.length &&
          (matched > best.matched || (matched === best.matched && totalDist < best.totalDist))) {
        best = { matched, totalDist, pairs };
      }
    }

    // จับคู่ครบทุกเพลาของลิสต์สั้นไม่ได้เลย = ลำดับเพลาเพี้ยน ไม่น่าใช่คันเดียวกัน → ไม่ merge ปล่อยเป็น orphan
    if (!best.pairs) {
      return null;
    }

    // สร้างเพลารวมตามลำดับลิสต์ยาว: เพลาที่จับคู่ได้ = รวม 2 ฝั่ง, ที่เหลือ = ด้านเดียว (เลนยาวเห็นข้างเดียว)
    mergedAxles = longPart.axles.map((axleLong, l) => {
      const s = best.pairs[l];
      if (s === -1) return oneSided(axleLong, leftIsLong);
      const axleShort = shortPart.axles[s];
      // เรียง (เลนซ้าย, เลนขวา) ให้ถูกตาม sumAxle: เลนซ้าย→ฝั่งซ้ายรถ, เลนขวา→ฝั่งขวารถ
      return leftIsLong ? sumAxle(axleLong, axleShort) : sumAxle(axleShort, axleLong);
    });
    axleMismatch = true;
  }

  // ----- รวมผลลัพธ์ -----
  let mergedData = { ...leftPart };
  let totalGvw = 0, totalLeftWeight = 0, totalRightWeight = 0;
  for (const a of mergedAxles) {
    totalLeftWeight += a.weightLeft;
    totalRightWeight += a.weightRight;
    totalGvw += a.weight;
  }
  mergedData.axles = mergedAxles;
  mergedData.gvw = totalGvw;
  mergedData.leftWeight = totalLeftWeight;
  mergedData.rightWeight = totalRightWeight;

  // เก็บป้ายทะเบียนและรูปภาพจากฝั่งที่หาเจอ (ถ้ามี)
  mergedData.licensePlate = vehicleLeft.licensePlate || vehicleRight.licensePlate || "";
  mergedData.platePath = vehicleLeft.platePath || vehicleRight.platePath || "";
  mergedData.overviewPath = vehicleLeft.overviewPath || vehicleRight.overviewPath || "";
  mergedData.cropPath = vehicleLeft.cropPath || vehicleRight.cropPath || "";
  mergedData.province = vehicleLeft.province || vehicleRight.province || "";

  mergedData.isStraddlingMerged = true; // flag ไว้ว่าเกิดจากการรวมข้อมูล
  mergedData.straddleAxleMismatch = axleMismatch; // true = รวมแบบเพลาไม่เท่ากัน (มีเพลานับด้านเดียว — ควรรีวิว)
  mergedData.originalLanes = [vehicleLeft.lane, vehicleRight.lane];

  return mergedData;
}

/**
 * Mirror "รายเพลา" สำหรับรถไหลทาง/เฉียง ที่ล้อบางเพลาพ้นเซ็นเซอร์ออกขอบถนน/เกาะกลาง
 * รถจริงมักเฉียง → เพลาแค่บางส่วน (หัว/กลาง/ท้าย) ฝั่งเดียวศูนย์ ที่เหลืออยู่ในเลนเต็ม
 * จึง mirror "เฉพาะเพลาที่ฝั่งหายหันออกขอบ" (leftEdge/rightEdge) เก็บเพลาที่ครบไว้ตามจริง
 * - leftEdge:  เพลาที่ซ้าย < zeroKg และขวา ≥ zeroKg → เอาขวามาใส่ซ้าย (weight = 2× ค่าที่วัด)
 * - rightEdge: เพลาที่ขวา < zeroKg และซ้าย ≥ zeroKg → เอาซ้ายมาใส่ขวา
 * - เพลาครบ 2 ฝั่ง / ศูนย์ทั้งคู่ (เพลายก/ไม่มีข้อมูล) → คงเดิม
 * คืน { data, mirrored: [เลขเพลาที่ mirror] } — mirrored.length === 0 = ไม่มีเพลาเข้าเงื่อนไข (ไม่แตะ data)
 */
function mirrorEdgeAxles(data, leftEdge, rightEdge, zeroKg = 100) {
  const mirrored = [];
  let gvw = 0, leftWeight = 0, rightWeight = 0;
  data.axles = (data.axles || []).map((a, i) => {
    const l = a.weightLeft || 0;
    const r = a.weightRight || 0;
    let axle = a;
    if (leftEdge && l < zeroKg && r >= zeroKg) {
      axle = { ...a, weightLeft: r, weight: r * 2 };
      mirrored.push(a.number ?? i + 1);
    } else if (rightEdge && r < zeroKg && l >= zeroKg) {
      axle = { ...a, weightRight: l, weight: l * 2 };
      mirrored.push(a.number ?? i + 1);
    }
    gvw += (axle.weightLeft || 0) + (axle.weightRight || 0);
    leftWeight += axle.weightLeft || 0;
    rightWeight += axle.weightRight || 0;
    return axle;
  });
  if (mirrored.length) {
    data.gvw = gvw;
    data.leftWeight = leftWeight;
    data.rightWeight = rightWeight;
  }
  return { data, mirrored };
}

/**
 * รวม "เศษ" ของรถคันเดียวที่คอนโทรลเลอร์เลนเดียวกันตัดเป็น 2 record (เช่น รถยาวที่มีช่องว่าง bogie)
 * front = ท่อนที่มาก่อน (เพลาหน้า), rear = ท่อนที่มาทีหลัง (เพลาท้าย); ต่อ axles หน้า→หลัง
 * gapCm = ระยะประมาณระหว่างท่อน (จาก timeGap × speed) ใส่เป็น wheelbase ของเพลาแรกท่อนหลัง
 * คืน record ใหม่ axles ต่อกัน + รวม gvw/น้ำหนัก + ตั้ง fragmentsCombined=true (ใช้ข้าม strict wheelbase ตอน match อีกเลน)
 */
function combineSameLaneFragments(front, rear, gapCm = 0) {
  const axles = [
    ...front.axles.map((a) => ({ ...a })),
    ...rear.axles.map((a, i) => ({ ...a, wheelbase: i === 0 ? gapCm : a.wheelbase })),
  ].map((a, i) => ({ ...a, number: i + 1 }));
  let gvw = 0, leftWeight = 0, rightWeight = 0;
  for (const a of axles) {
    gvw += (a.weightLeft || 0) + (a.weightRight || 0);
    leftWeight += a.weightLeft || 0;
    rightWeight += a.weightRight || 0;
  }
  return {
    ...front,
    axles,
    axlesCount: axles.length,
    gvw,
    leftWeight,
    rightWeight,
    warningFlags: (front.warningFlags || 0) | (rear.warningFlags || 0),
    fragmentsCombined: true,
  };
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

/**
 * Check if the GVW should be ignored (too light / no data).
 * @param {Number} gvw - Gross vehicle weight.
 * @param {Number} gvwIgnored - Minimum GVW threshold below which the record is dropped.
 * @returns {Boolean} - true if the record should be ignored.
 */
function ignoreGVW(gvw, gvwIgnored) {
  if (!gvw || typeof gvw === "undefined") return true; // Ignore if no GVW data
  if (gvw < gvwIgnored) {
    return true;
  }
  return false; // GVW is valid
}

/**
 * Check if the vehicle's wheelbase is below the minimum length (ignored).
 * @param {Number} wheelbase - The wheelbase of the vehicle.
 * @param {Number} minLength - The minimum wheelbase length to not be ignored.
 * @returns {Boolean} - true if the wheelbase is less than the minimum length.
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
  return wheelbase < minLength;
}

module.exports = {
  mapDataLogger,
  classifyVehicle,
  calculateESAL,
  setViolation,
  mapWarningFlag,
  mapErrorFlag,
  setSingleTire,
  isVehicleExcludedByPlate,
  formatLicensePlate,
  isBusByWheelbase,
  mergeStraddlingVehicles,
  mirrorEdgeAxles,
  combineSameLaneFragments,
  isReverseDirection,
  ignoreGVW,
  isIgnoredLength
};
