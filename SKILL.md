---
name: imps-station-management
description: Specialized workflows for managing the IMPS (Intermediate Station Service), including weighing controller integration, data transmission, and automated system maintenance. Use this when working with DataLogger/InterComp controllers, OCR services, or dynamic configuration management.
---

# IMPS Station Management Skill

This skill provides procedural guidance for managing and maintaining the Intermediate Station Service (IMPS).

## Core Workflows

### 1. Weighing Controller Management
The system supports two primary hardware controllers: **DataLogger** and **InterComp**.
- **DataLogger:** Typically uses a specialized protocol for sensor data and weighing events.
- **InterComp:** Uses its own set of data and sensor URLs.
- **Switching Logic:** The controller is initialized in `src/app.js` based on `controller_id` from the database.
- **Action:** When debugging connectivity, first verify the URLs (`controller_data_url`, `controller_sensor_url`) in the database. Use `src/controllers/DataLogger.js` or `src/controllers/InterComp.js` for protocol-specific logic.

### 2. Data Logging & Transmission Pipeline
Every weighing event follows a strict path:
1. **Trigger:** Hardware sensor detects a vehicle.
2. **Collection:** Controller fetches weight, axles, and dimensions.
3. **Enhancement:** `picoService` (wheel classification) and `threeDimensionService` (vehicle dimensions) fetch metadata.
4. **Recording:** `DataLogger` or `InterComp` saves the vehicle details and axle records to the database. If a hardware trigger fails (no snapshot found in the memory registry), a software fallback automatically requests live LPR and Overview snapshots from the cameras on-demand before finalizing the database record.
5. **Transmission:** The system immediately broadcasts the saved `vehicleID` via WebSocket (`wsService`) and sends it to central servers via HTTP (`transmissionService`).
6. **Visual Integration:** In the background, `SnapshotManager` claims matching snapshots, sends them to `ocrService` to read license plates, crops the plates using `sharp`, uploads them to central image hosting, and updates the database record. Once done, a final transmission/broadcast is sent with the updated plate details.
- **Action:** If data is missing in the central system, check `transmissionService.js` for API response logs and the local DB for the initial record.

### 3. Visual Processing (OCR & Snapshots)
- **OCR:** Handled by `src/utils/ocrService.js`. It processes snapshots to extract license plate numbers. It supports receiving binary image buffers directly to bypass disk reads.
- **Snapshot Management:** Managed by `src/utils/snapshotManager.js` and `snapshotRegistry.js`. It includes an in-memory **Memory-Cache Buffer** that stores binary image data with a **30-second TTL (Time-to-Live) auto-eviction** scheme to eliminate disk I/O latency. If a pre-triggered snapshot is missing, the system falls back to fetching live camera snapshots on-demand.
- **Ghost Record Cleanup:** Since weighing records are saved to the database immediately to optimize performance, the system performs a background cleanup (`deleteVehicleFromDatabase`) to delete rows from `vehicles`, `axles`, `plates`, `images`, and `flags` if the background OCR later determines the vehicle is excluded.
- **Cleanup:** `src/services/snapshotCleanupService.js` runs a midnight job to delete old snapshots from disk and clear database records to save space.
- **Action:** To adjust storage retention, modify the `retention_days` column in the `configuration` database table, which is read dynamically during cleanup.

### 4. Dynamic Configuration Polling
The system does not require a manual restart for configuration changes.
- **Mechanism:** `src/services/configurationService.js` polls the database every 5 seconds via `checkForConfigUpdates`.
- **Restart Flow:** If a change is detected, `app.js` stops the current controller and re-initializes with the new settings.
- **Action:** When making configuration changes, apply them directly to the `configurations` table in the database and wait for the system to auto-restart.

### 5. 3D Dimension Scanner Integration
- **Mechanism:** `src/services/threeDimensionService.js` polls `THREE_DIMENSION_BASE/report-3d/transaction` using a time window of `±5 minutes` around the vehicle's weigh-in time.
- **Matching:** Normalizes the license plate string (removes special characters and symbols) to find the corresponding 3D record.
- **Validation:** Compares the vehicle's scanned height against `THREE_DIMENSION_MAXIMUM_HEIGHT`. If it exceeds the limit, it flags `is_over_height` and registers warning code `1` in `three_dimension_warning_map`.

### 6. Pico Tire Classification Integration
- **Mechanism:** `src/services/picoService.js` calls the Pico REST endpoint (`PICO_BASE/wheel-type`) for Lane 1 vehicles.
- **Parameters:** It requests details for Channel A with a search window of `[StartTime - 500ms, EndTime + 500ms]` based on the vehicle's detection timestamps.
- **Recording:** Stores whether axles use single or dual tire configurations (`dual_tire` column in the `axles` table).

### 7. Straddling Merge Logic
- **Mechanism:** Combines weighing transactions when a vehicle straddles two adjacent lanes (warning flags 9/10 in DataLogger, or 27 in InterComp).
- **Matching Criteria:** Enforces a high-precision verification process:
  - Max time separation of 1000 ms.
  - Lane numbers must be adjacent (difference = 1).
  - Wheelbase values of corresponding axles must match within a 30 cm tolerance.
  - Vehicle speeds must match within a 15 km/h tolerance.
- **Merge Operation:** Sums the left and right sensor weights axle-by-axle and logs detailed axle-weight comparisons.

## Technical References
- **Configuration Mapping:** See `src/utils/mappers/mapConfigurationKeys.js`.
- **Database Schema:** Reference `src/config/db.js` for connection details and existing SQL scripts in `docs/sql/`.
- **Logs:** Monitor PM2 logs (if running in prod) or the console for "Configuration change detected" messages.
- **Trigger Fallback Workflow:** Detailed in `src/controllers/DataLogger.js` and `src/controllers/InterComp.js`. If a hardware trigger isn't logged in `lastTriggerTimes` in the last 15 seconds, the search calls `_findSnapshotOnce` instantly to bypass the 5-second match delay and fires an on-demand fallback snapshot immediately.
