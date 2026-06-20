const assert = require('assert');
const { 
  classifyVehicle, 
  setSingleTire, 
  isVehicleExcludedByPlate, 
  formatLicensePlate,
  isBusByWheelbase,
  isReverseDirection,
  mergeStraddlingVehicles: mergeDataLogger
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

console.log("=== All Unit Tests Passed Successfully ===");
