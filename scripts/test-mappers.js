const assert = require('assert');
const {
  classifyVehicle,
  setSingleTire,
  isVehicleExcludedByPlate,
  formatLicensePlate,
  isBusByWheelbase,
  isReverseDirection,
  mergeStraddlingVehicles: mergeDataLogger,
  setViolation,
  mapWarningFlag,
  mapErrorFlag,
  ignoreGVW,
  isIgnoredLength,
  mirrorEdgeAxles,
  combineSameLaneFragments,
  calculateESAL
} = require('../src/utils/mappers/mapDataLogger');

console.log("=== Starting Unit Tests for Mappers ===");

function runTest(name, fn) {
    try {
        fn();
        console.log(`[PASS] ${name}`);
    } catch (err) {
        console.error(`[FAIL] ${name}:`, err.message);
        process.exit(1);
    }
}

// 1. Test classifyVehicle
runTest("classifyVehicle: Class 1 and Class 2 based on wheelbase", () => {
    const config = { distance_of_axles_between_class_2: 400 }; // in cm (4.0m)
    
    // Class 1: 2 axles, wheelbase < 4m
    const vehicle1 = { axles: [ { number: 1 }, { number: 2, wheelbase: 350 } ] };
    const res1 = classifyVehicle(vehicle1, config);
    assert.strictEqual(res1.vehicleClassID, 1, "Should classify as Class 1");

    // Class 2: 2 axles, wheelbase >= 4m
    const vehicle2 = { axles: [ { number: 1 }, { number: 2, wheelbase: 450 } ] };
    const res2 = classifyVehicle(vehicle2, config);
    assert.strictEqual(res2.vehicleClassID, 2, "Should classify as Class 2");
});

runTest("classifyVehicle: Multi-axle vehicles", () => {
    // 3 axles: Class 3
    const vehicle3 = { axles: [ { number: 1 }, { number: 2 }, { number: 3 } ] };
    const res3 = classifyVehicle(vehicle3, {});
    assert.strictEqual(res3.vehicleClassID, 3, "Should classify as Class 3");

    // 4 axles (tandem/tridem checks)
    const vehicle4_tandem = { 
        axles: [ 
            { number: 1, groupID: 0 }, 
            { number: 2, groupID: 0, wheelbase: 150 }, 
            { number: 3, groupID: 1 }, 
            { number: 4, groupID: 1 } 
        ] 
    };
    const res4 = classifyVehicle(vehicle4_tandem, {});
    assert.strictEqual(res4.vehicleClassID, 4, "Should classify as Class 4 when wheelbase < 200");
});

// 2. Test setSingleTire safety checks (regression test for crash bug)
runTest("setSingleTire: Safety check on missing or empty data", () => {
    const mockData = { vehicleClassID: 19, axles: [{ dualTire: true }, { dualTire: true }] };
    
    // Test with undefined singleTires
    let result = setSingleTire(mockData, undefined);
    assert.deepStrictEqual(result.axles[0].dualTire, true, "Should remain true, no crash");

    // Test with empty singleTires array
    result = setSingleTire(mockData, []);
    assert.deepStrictEqual(result.axles[0].dualTire, true, "Should remain true, no crash");

    // Test with matching singleTires configuration
    const singleTiresMock = [
        { vehicle_class_id: 3, axle_positions: [0] }
    ];
    const dataClass3 = { vehicleClassID: 3, axles: [{ dualTire: true }, { dualTire: true }, { dualTire: true }] };
    result = setSingleTire(dataClass3, singleTiresMock);
    assert.strictEqual(result.axles[0].dualTire, false, "Axle 0 should be set to single tire (false)");
    assert.strictEqual(result.axles[1].dualTire, true, "Axle 1 should remain dual tire (true)");
});

// 3. Test isVehicleExcludedByPlate (passenger / bus exclusions)
runTest("isVehicleExcludedByPlate: Exclusions and Inclusions", () => {
    // Passenger plate starting with Thai character: กข 1234 -> should exclude
    assert.strictEqual(isVehicleExcludedByPlate("กข 1234"), true, "Should exclude Thai letter prefix plates");
    assert.strictEqual(isVehicleExcludedByPlate("1หป 9999"), true, "Should exclude modern Thai digit+letter prefix plates");

    // Bus prefixes 10-49 -> should exclude
    assert.strictEqual(isVehicleExcludedByPlate("10-1234"), true, "Should exclude prefix 10");
    assert.strictEqual(isVehicleExcludedByPlate("35-9999"), true, "Should exclude prefix 35");

    // Truck prefixes 50-99 -> should keep (exclude = false)
    assert.strictEqual(isVehicleExcludedByPlate("80-1234"), false, "Should keep truck prefix 80");
    assert.strictEqual(isVehicleExcludedByPlate("99-9999"), false, "Should keep truck prefix 99");
});

// 4. Test formatLicensePlate
runTest("formatLicensePlate: Standard formatting checks", () => {
    // Numeric plates (DLT truck/buses)
    assert.strictEqual(formatLicensePlate("801234"), "80-1234", "6-digit numeric plate should have dash");
    assert.strictEqual(formatLicensePlate("1019999"), "101-9999", "7-digit numeric plate should have dash");

    // Thai prefix plates (Passenger)
    assert.strictEqual(formatLicensePlate("กข1234"), "กข 1234", "Thai letter prefix plate should have space");
    assert.strictEqual(formatLicensePlate("1หป9999"), "1หป 9999", "Modern Thai digit+letter prefix plate should have space");
});

// 5. Test direction checks
runTest("isReverseDirection: Direction checking", () => {
    assert.strictEqual(isReverseDirection(0), false, "Direction 0 is normal");
    assert.strictEqual(isReverseDirection(1), true, "Direction 1 is reverse");
});

// 6. Test Straddling Merge (DataLogger)
runTest("mergeStraddlingVehicles: DataLogger merge order-independence", () => {
    const vehicleLeft = {
        lane: 1,
        licensePlate: "80-1234",
        platePath: "/snap/lpr1.jpg",
        axles: [
            { weightLeft: 0, weightRight: 1000, speedLeft: 0, speedRight: 40, wheelbase: 0 }
        ]
    };
    const vehicleRight = {
        lane: 2,
        licensePlate: "",
        platePath: "",
        axles: [
            { weightLeft: 1200, weightRight: 0, speedLeft: 42, speedRight: 0, wheelbase: 0 }
        ]
    };

    // Test DataLogger merge where Left is first parameter
    const resDataLoggerLeftFirst = mergeDataLogger(vehicleLeft, vehicleRight);
    assert.ok(resDataLoggerLeftFirst, "Should merge successfully");
    assert.strictEqual(resDataLoggerLeftFirst.gvw, 2200, "GVW should be 2200 when left is first");
    assert.strictEqual(resDataLoggerLeftFirst.leftWeight, 1000, "leftWeight should be 1000");
    assert.strictEqual(resDataLoggerLeftFirst.rightWeight, 1200, "rightWeight should be 1200");
    assert.strictEqual(resDataLoggerLeftFirst.axles[0].weight, 2200, "Axle weight should be 2200");
    assert.strictEqual(resDataLoggerLeftFirst.axles[0].weightLeft, 1000, "Axle weightLeft should be 1000");
    assert.strictEqual(resDataLoggerLeftFirst.axles[0].weightRight, 1200, "Axle weightRight should be 1200");

    // Test DataLogger merge where Right is first parameter (the buggy case)
    const resDataLoggerRightFirst = mergeDataLogger(vehicleRight, vehicleLeft);
    assert.ok(resDataLoggerRightFirst, "Should merge successfully");
    assert.strictEqual(resDataLoggerRightFirst.gvw, 2200, "GVW should be 2200 when right is first");
    assert.strictEqual(resDataLoggerRightFirst.leftWeight, 1000, "leftWeight should be 1000");
    assert.strictEqual(resDataLoggerRightFirst.rightWeight, 1200, "rightWeight should be 1200");
    assert.strictEqual(resDataLoggerRightFirst.axles[0].weight, 2200, "Axle weight should be 2200");
    assert.strictEqual(resDataLoggerRightFirst.axles[0].weightLeft, 1000, "Axle weightLeft should be 1000");
    assert.strictEqual(resDataLoggerRightFirst.axles[0].weightRight, 1200, "Axle weightRight should be 1200");

    // --- Test Case 2: Partial/mixed sensor activation on both lanes ---
    const vehicleLeftMixed = {
        lane: 1,
        licensePlate: "80-1234",
        platePath: "/snap/lpr1.jpg",
        axles: [
            { weightLeft: 300, weightRight: 700, speedLeft: 40, speedRight: 40, wheelbase: 0 }
        ]
    };
    const vehicleRightMixed = {
        lane: 2,
        licensePlate: "",
        platePath: "",
        axles: [
            { weightLeft: 1100, weightRight: 100, speedLeft: 42, speedRight: 42, wheelbase: 0 }
        ]
    };

    const resMixed = mergeDataLogger(vehicleLeftMixed, vehicleRightMixed);
    assert.ok(resMixed, "Should merge mixed sensors successfully");
    assert.strictEqual(resMixed.leftWeight, 1000, "leftWeight should sum all sensors of left lane (300 + 700)");
    assert.strictEqual(resMixed.rightWeight, 1200, "rightWeight should sum all sensors of right lane (1100 + 100)");
    assert.strictEqual(resMixed.gvw, 2200, "GVW should be 2200");
    assert.strictEqual(resMixed.axles[0].weightLeft, 1000, "Axle weightLeft should be 1000");
    assert.strictEqual(resMixed.axles[0].weightRight, 1200, "Axle weightRight should be 1200");
    assert.strictEqual(resMixed.axles[0].weight, 2200, "Axle weight should be 2200");
});

// 7. Test setViolation (overweight decision)
runTest("setViolation: Overweight detection and exemptions", () => {
    // vehicleClasses indexed by class ID (same shape the app passes in)
    const classes = [];
    classes[2] = { gvw_max: 10000 };

    // Under limit -> no violation
    let res = setViolation({ vehicleClassID: 2, gvw: 9000 }, classes, [0, 19]);
    assert.strictEqual(res.violation, 0);
    assert.strictEqual(res.isOverweight, false);
    assert.strictEqual(res.overweight_percentage, 0);

    // Over limit -> violation with percentage
    res = setViolation({ vehicleClassID: 2, gvw: 12000 }, classes, [0, 19]);
    assert.strictEqual(res.violation, 1);
    assert.strictEqual(res.isOverweight, true);
    assert.ok(Math.abs(res.overweight_percentage - 20) < 1e-9, "Should be 20% over");

    // Exempt class (0, 19) -> never a violation even if heavy
    res = setViolation({ vehicleClassID: 19, gvw: 99999 }, classes, [0, 19]);
    assert.strictEqual(res.violation, 0);
});

// 8. Test warning/error flag mapping
runTest("mapWarningFlag / mapErrorFlag: Bit extraction", () => {
    // Warning: only bits 9/10 (straddling) are kept
    let res = mapWarningFlag({ warningFlags: (1 << 9) | (1 << 4) });
    assert.deepStrictEqual(res.warningFlag, [9], "Only bit 9 kept, bit 4 filtered out");
    assert.strictEqual(res.isWarningFlagged, true);

    res = mapWarningFlag({ warningFlags: (1 << 4) });
    assert.deepStrictEqual(res.warningFlag, [], "Bit 4 alone is filtered out");
    assert.strictEqual(res.isWarningFlagged, false);

    // Error: all set bits are kept as indices
    res = mapErrorFlag({ errorFlags: 0b101 });
    assert.deepStrictEqual(res.errorFlag, [0, 2]);
    assert.strictEqual(res.isErrorFlagged, true);

    res = mapErrorFlag({ errorFlags: 0 });
    assert.deepStrictEqual(res.errorFlag, []);
    assert.strictEqual(res.isErrorFlagged, false);
});

// 9. Test ignoreGVW / isIgnoredLength (noise filters)
runTest("ignoreGVW / isIgnoredLength: Threshold filters", () => {
    assert.strictEqual(ignoreGVW(0, 1000), true, "GVW 0 (falsy) is ignored");
    assert.strictEqual(ignoreGVW(undefined, 1000), true, "Missing GVW is ignored");
    assert.strictEqual(ignoreGVW(500, 1000), true, "Below threshold is ignored");
    assert.strictEqual(ignoreGVW(1500, 1000), false, "Above threshold is kept");

    assert.strictEqual(isIgnoredLength(250, 300), true, "Wheelbase below min is ignored");
    assert.strictEqual(isIgnoredLength(350, 300), false, "Wheelbase above min is kept");
    assert.strictEqual(isIgnoredLength(undefined, 300), false, "Invalid input is not ignored (kept)");
    assert.strictEqual(isIgnoredLength(250, undefined), false, "Missing min is not ignored (kept)");
});

// 10. Test mirrorEdgeAxles (straddle Type-2 recovery)
runTest("mirrorEdgeAxles: Mirror one-sided axles only", () => {
    // Axle 1 left side is zero -> mirrored; axle 2 has both sides -> untouched
    const data = {
        gvw: 7100,
        axles: [
            { number: 1, weightLeft: 0, weightRight: 3000 },
            { number: 2, weightLeft: 2000, weightRight: 2100 },
        ],
    };
    const res = mirrorEdgeAxles(data, true, true, 100);
    assert.deepStrictEqual(res.mirrored, [1], "Only axle 1 mirrored");
    assert.strictEqual(res.data.axles[0].weightLeft, 3000, "Missing side filled from measured side");
    assert.strictEqual(res.data.axles[0].weight, 6000);
    assert.strictEqual(res.data.axles[1].weight, undefined, "Complete axle untouched");
    assert.strictEqual(res.data.gvw, 6000 + 2000 + 2100, "GVW recomputed after mirror");

    // No one-sided axles -> no-op (gvw unchanged)
    const noop = {
        gvw: 4100,
        axles: [{ number: 1, weightLeft: 2000, weightRight: 2100 }],
    };
    const res2 = mirrorEdgeAxles(noop, true, true, 100);
    assert.deepStrictEqual(res2.mirrored, []);
    assert.strictEqual(res2.data.gvw, 4100, "GVW untouched when nothing mirrored");
});

// 11. Test combineSameLaneFragments (long vehicle split into 2 records)
runTest("combineSameLaneFragments: Join front+rear fragments", () => {
    const front = {
        id: "A", lane: 2, warningFlags: (1 << 9),
        axles: [
            { number: 1, weightLeft: 1000, weightRight: 1000, wheelbase: 0 },
            { number: 2, weightLeft: 1500, weightRight: 1500, wheelbase: 300 },
        ],
    };
    const rear = {
        id: "B", lane: 2, warningFlags: (1 << 10),
        axles: [{ number: 1, weightLeft: 2000, weightRight: 2000, wheelbase: 130 }],
    };
    const res = combineSameLaneFragments(front, rear, 400);
    assert.strictEqual(res.axles.length, 3, "Axles joined front->rear");
    assert.deepStrictEqual(res.axles.map(a => a.number), [1, 2, 3], "Axles renumbered");
    assert.strictEqual(res.axles[2].wheelbase, 400, "Gap becomes wheelbase of first rear axle");
    assert.strictEqual(res.gvw, 9000, "GVW is sum of both fragments");
    assert.strictEqual(res.axlesCount, 3);
    assert.strictEqual(res.warningFlags, (1 << 9) | (1 << 10), "Warning flags OR-ed");
    assert.strictEqual(res.fragmentsCombined, true);
});

// 12. Test mergeStraddlingVehicles with unequal axle counts (align by position)
runTest("mergeStraddlingVehicles: Unequal axles align / reject", () => {
    const left3 = {
        lane: 1, licensePlate: "80-1234", platePath: "", overviewPath: "", cropPath: "", province: "",
        axles: [
            { weightLeft: 500, weightRight: 500, speedLeft: 40, speedRight: 40, wheelbase: 0 },
            { weightLeft: 800, weightRight: 800, speedLeft: 40, speedRight: 40, wheelbase: 400 },
            { weightLeft: 900, weightRight: 900, speedLeft: 40, speedRight: 40, wheelbase: 130 },
        ],
    };
    // Right lane missed the front axle: positions align to left's axles 2-3
    const right2 = {
        lane: 2, licensePlate: "", platePath: "", overviewPath: "", cropPath: "", province: "",
        axles: [
            { weightLeft: 700, weightRight: 700, speedLeft: 41, speedRight: 41, wheelbase: 0 },
            { weightLeft: 600, weightRight: 600, speedLeft: 41, speedRight: 41, wheelbase: 130 },
        ],
    };
    const merged = mergeDataLogger(left3, right2, 30);
    assert.ok(merged, "Should merge when short list aligns at an offset");
    assert.strictEqual(merged.straddleAxleMismatch, true, "Mismatch flagged for review");
    assert.strictEqual(merged.axles.length, 3, "Long list is the merged skeleton");
    assert.strictEqual(merged.axles[0].oneSided, true, "Unmatched front axle counted one-sided");
    // gvw = one-sided axle (1000) + merged axle2 (1600+1400) + merged axle3 (1800+1200)
    assert.strictEqual(merged.gvw, 1000 + 3000 + 3000);

    // Positions that cannot align at any offset -> null (likely different vehicles)
    const rightBad = {
        lane: 2, licensePlate: "", platePath: "", overviewPath: "", cropPath: "", province: "",
        axles: [
            { weightLeft: 700, weightRight: 700, speedLeft: 41, speedRight: 41, wheelbase: 0 },
            { weightLeft: 600, weightRight: 600, speedLeft: 41, speedRight: 41, wheelbase: 700 },
        ],
    };
    assert.strictEqual(mergeDataLogger(left3, rightBad, 30), null, "Should reject unalignable axles");
});

// 13. Test calculateESAL sanity (AASHTO formula behaviour, not exact values)
runTest("calculateESAL: Finite, positive, monotonic with load", () => {
    const mkTruck = (w) => ({
        axles: [
            { groupID: 0, weight: w * 0.4 },
            { groupID: 0, weight: w * 0.6 },
        ],
    });
    const light = calculateESAL(mkTruck(10000), { floor_type: "flexible" });
    const heavy = calculateESAL(mkTruck(20000), { floor_type: "flexible" });
    assert.ok(Number.isFinite(light.esal) && light.esal > 0, "ESAL is finite and positive");
    assert.ok(heavy.esal > light.esal, "Heavier vehicle produces higher ESAL");

    // Zero/empty axles -> esal 0, no crash
    const empty = calculateESAL({ axles: [] }, {});
    assert.strictEqual(empty.esal, 0);
});

// 14. Test formatLicensePlate edge cases
runTest("formatLicensePlate: Edge cases", () => {
    assert.strictEqual(formatLicensePlate(""), "", "Empty stays empty");
    assert.strictEqual(formatLicensePlate(null), "", "Null becomes empty string");
    assert.strictEqual(formatLicensePlate("80-1234"), "80-1234", "Already formatted numeric re-formats identically");
    assert.strictEqual(formatLicensePlate("12345"), "12345", "5-digit numeric returned without dash");
    assert.strictEqual(formatLicensePlate("ABC123"), "ABC123", "Unrecognized pattern returned as-is");
});

console.log("=== All Unit Tests Passed Successfully ===");
