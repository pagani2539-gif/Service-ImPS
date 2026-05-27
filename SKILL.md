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
3. **Enhancement:** `vehiclesService` and `threeDimensionService` add metadata.
4. **Recording:** `DataLogger` or `InterComp` saves the record to the database.
5. **Transmission:** `transmissionService` sends data to external APIs, and `wsService` broadcasts to connected clients.
- **Action:** If data is missing in the central system, check `transmissionService.js` for API response logs and the local DB for the initial record.

### 3. Visual Processing (OCR & Snapshots)
- **OCR:** Handled by `src/utils/ocrService.js`. It processes snapshots to extract license plate numbers.
- **Snapshot Management:** Managed by `src/utils/snapshotManager.js` and `snapshotRegistry.js`.
- **Cleanup:** `src/services/snapshotCleanupService.js` runs a midnight job to delete old snapshots and clear database records to save space.
- **Action:** To adjust storage retention, modify the `CLEANUP_THRESHOLD` or similar constants in the cleanup service.

### 4. Dynamic Configuration Polling
The system does not require a manual restart for configuration changes.
- **Mechanism:** `src/services/configurationService.js` polls the database every 5 seconds via `checkForConfigUpdates`.
- **Restart Flow:** If a change is detected, `app.js` stops the current controller and re-initializes with the new settings.
- **Action:** When making configuration changes, apply them directly to the `configurations` table in the database and wait for the system to auto-restart.

## Technical References
- **Configuration Mapping:** See `src/utils/mappers/mapConfigurationKeys.js`.
- **Database Schema:** Reference `src/config/db.js` for connection details and existing SQL scripts in `docs/sql/`.
- **Logs:** Monitor PM2 logs (if running in prod) or the console for "Configuration change detected" messages.
