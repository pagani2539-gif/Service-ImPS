---
name: imps-station-management
description: Specialized workflows for managing the IMPS (Intermediate Station Service), including weighing controller integration, data transmission, and automated system maintenance. Use this when working with the DataLogger controller, OCR services, or dynamic configuration management.
---

# IMPS Station Management Skill

This skill provides procedural guidance for managing and maintaining the Intermediate Station Service (IMPS).

## Core Workflows

### 1. Weighing Controller Management
The system uses a single hardware controller: **DataLogger** (Kistler WIM).
- **DataLogger:** Uses a specialized protocol for sensor data and weighing events.
- **Init Logic:** The controller is initialized in `src/app.js` when `controller_id === 1` from the database (any other id is skipped with a warning).
- **Action:** When debugging connectivity, first verify the URLs (`controller_data_url`, `controller_sensor_url`) in the database. Protocol-specific logic lives in `src/controllers/DataLogger.js`.

### 2. Data Logging & Transmission Pipeline
Every weighing event follows a strict path:
1. **Trigger:** Hardware sensor detects a vehicle.
2. **Collection:** Controller fetches weight, axles, and dimensions.
3. **Enhancement:** `threeDimensionService` fetches vehicle dimensions in the background. (`picoService` for wheel/tire classification exists but is **not currently wired into the pipeline** — see §6.)
4. **Recording:** `DataLogger` saves the vehicle details and axle records to the database immediately (axles/axles_after_allowance/flags are batch-inserted within one transaction). Image matching runs in the background; if the snapshot is not yet registered, `waitForImages` retries up to 5 times (2/4/6/8/10s) and then saves the record with missing images rather than losing it.
5. **Background visual + transmission:** In the background, `SnapshotManager` claims matching snapshots, sends them to `ocrService` to read license plates, crops the plates using `sharp`, uploads them to central image hosting, and updates the DB record. The VMS sign is driven here (after images resolve). 3D data is fetched and inserted, and **only then** is the saved `vehicleID` broadcast via WebSocket (`wsService`) and sent to central servers via HTTP (`transmissionService`) — a single transmission at the end (intentional, so central sees 3D rows before being notified).
- **Action:** If data is missing in the central system, check `transmissionService.js` for API response logs and the local DB for the initial record.

### 3. Visual Processing (OCR & Snapshots)
- **OCR:** Handled by `src/utils/ocrService.js`. It processes snapshots to extract license plate numbers. It supports receiving binary image buffers directly to bypass disk reads. Optional pre-processing via `OCR_PREPROCESS=1`. Diagnostic logs (`[OCR][raw]` full response, `[OCR][Crop]` coordinates) are gated behind `OCR_DEBUG=1` (off by default) — turn on to debug a plate crop that does not align.
- **Snapshot Management:** Managed by `src/utils/snapshotManager.js` and `snapshotRegistry.js`. It includes an in-memory **Memory-Cache Buffer** that stores binary image data with a **30-second TTL (Time-to-Live) auto-eviction** scheme to eliminate disk I/O latency. Each found/uploaded snapshot is logged (`[Snapshot] Found ...`, `[Upload] OK ...`). There is no on-demand live capture: a missing snapshot is retried then saved without an image.
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

### 6. Pico Tire Classification Integration — ⚠️ NOT currently wired into the pipeline
- **Status:** `src/services/picoService.js` (`getSingleDualTire`) still exists but is **not imported or called** by `DataLogger` or any pipeline code (the dead HTTP call was removed during optimization round 2). Do not assume Pico data flows in — debugging "missing tire data" should start from here.
- **Where single/dual tire actually comes from today:** the `dual_tire` value on `axles` is set by `setSingleTire()` (`mapDataLogger.js`) using the `single_tires` DB table, **not** from Pico.
- **If re-wiring:** the service is intended to call the Pico REST endpoint (`PICO_BASE`) and store single/dual tire config per axle.

### 7. Straddling Merge Logic (รถคร่อมเลน)
Combines two half-weight transactions when one vehicle straddles the line between two adjacent lanes (each lane's sensor weighs only its wheels). Physics signature: the left lane reads **L0** (left side ≈0) and the right lane reads **R0** — opposite ("complementary"). Logic in `src/controllers/DataLogger.js` (match loop) + `mergeStraddlingVehicles()` in `src/utils/mappers/mapDataLogger.js`.
- **Detection:** flagged as straddle if WIM warning bit 9/10 is set **OR** the software zero-side check `_isZeroSideStraddle` finds every axle one-sided. Half-trucks below `gvw_ignored` are kept down to `gvw_ignored/2`.
- **Matching Criteria (all must pass):**
  - Time ≤ `straddling_time_diff` (default 3s).
  - Lanes adjacent (number difference = 1).
  - Axle-count difference ≤ `straddling_axle_tol` (**default 3** — raised from 1; the two lane sensors often count axles differently for one vehicle).
  - Speed ≤ `straddling_speed_diff` (default 15 km/h).
  - Wheelbase ≤ `straddling_wheelbase_diff` (default 30cm) when axle counts are equal.
  - **Evidence gate (when axle diff ≥2):** require **either** complementary zero-side (one half L0, the other R0) **or** both halves WIM-straddle-flagged. Prevents false merges while allowing big axle-count gaps. (`isAxleEvidenceOk`)
- **Axle Alignment (`mergeStraddlingVehicles`):** Uses **best-shift** — slides the shorter axle list along the longer by cumulative wheelbase position and picks the offset that matches the most axles (within `straddling_wheelbase_diff`). Handles a lane that "missed the front axles" (naive index-0 anchoring failed here). Unmatched axles are kept one-sided; if the lists cannot fully align it returns `null` (treated as different vehicles → orphan).
- **Merge Operation:** Sums left+right per matched axle, then **re-runs classify / violation / ESAL on the merged full weight** (a half had wrong class & under-reported overweight).
- **align-null fallback (Round 5):** when all 6 conditions pass but `mergeStraddlingVehicles` returns `null` (axle lists can't align, e.g. 6vs5), pick the heavier half + mirror it (`violation=0`) instead of letting both become orphans (`straddle_align_fallback`).
- **B2 cross-lane layer (Round 5):** a buffered half that times out is NOT saved immediately — `processFinalVehicle` checks `recentVehicles` (which records the lane+time+gvw of **every reading that was filter-dropped** too: gvw-1/single-axle/implausible/length/gvw-floor with `gvw≥floor`, via `_recordDroppedPartner`). If a partner with a **straddle signal** (`gvw-1`/`dropped`/`real-straddle`) is found → `suppress-dup` (real, 50ms `straddle_match_ms`) or `confirm-straddle` + mirror (250ms `straddle_confirm_ms`). The type-filter (partner must carry a straddle signal), **not** the window width, is what prevents false matches.
- **Instrumentation:** `[Straddling][Candidate]` → `[Straddling][Compare]` (per-condition Y/N incl. `Evidence`) → `[Straddling] High-precision Match found!`. B2 → `[Straddling][CrossLane]` (`suppress`/`mirror`) and `[Diag][CrossLane]` with `action` (`suppress-dup`/`mirror-straddle`/`mirror-type2`/`pick-heavier-mirror`). Genuine no-partner 2-sided → `[Straddling][Orphan]`.

### 8. Type 2 Mirror (คร่อมนุ่ม / รถไหลทาง — one-side, no partner)
Camera ground-truth (2026-06-26): ~62/67 orphans are straddles, only ~1 is true edge-drift. Straddles split into **two data-types**: *Type 1* both lanes register (→ paired by buffer/B2); *Type 2* only **one** lane registers because the vehicle is barely over the line / hugging the edge so the adjacent lane's sensor emits **no record at all** (verified: no raw reading within ±2s). A Type-2 reading is one-sided with no partner → recovered by mirror. Logic: `processFinalVehicle` → `_oneSidedNoPartner` branch → `mirrorEdgeAxles(data, true, true)` (`mapDataLogger.js`).
- **Per-axle mirror, by zero-side (not edge-zone):** for each axle one side ≈0, copy the measured side onto the zero side (`weight = 2× measured`); 2-sided axles kept real. Works on **all lanes** (incl. middle lane 2) without configuring road edges.
- **Safety — estimate only:** forced `violation=0`/`is_overweight=0`, tagged `straddleAxleMismatch` (displays `STRADDLE?`). Approximation for counting/statistics/ESAL — **never used for overweight enforcement** (±20%, vehicles not laterally symmetric).
- **Instrumentation:** `[Straddling][CrossLane] คร่อมนุ่ม/ไหลทาง ... → mirror เติมฝั่งหาย`; `[Diag][CrossLane] action:"mirror-type2"`; counter `crossLane_type2Mirror`.
- **Removed:** the old edge-zone `_tryEdgeMirror` method + `mirror_edge_zones`/`MIRROR_EDGE_ZONES` config are **deleted** (Type-2 mirror by zero-side supersedes them — no L/R edge config needed). 2-sided-no-partner now saves as-is. (DB column `mirror_edge_zones` left in place but unused.)
- **Schema:** mirrored records still set `is_estimated=true` (auto-added by `src/config/db.js` migration). Always deploy the **whole `src/`**, not individual files.

### 9. Performance Monitoring & System Metrics
- **Mechanism:** `src/utils/perfMonitor.js` tracks in-memory counters and latency samples.
- **Metrics Summary:** Logs a summary every `METRICS_INTERVAL_MS` (default 5 min) containing:
  - **Counts:** Received, inserted, dropped (filtered), straddle merged, errors.
  - **Timings (ms):** P50, P95, and Max latencies for image wait, DB insert, and end-to-end processing.
  - **System:** CPU usage %, Resident Set Size (RSS), Heap usage, Event Loop lag, and In-flight task count.
- **Action:** Use these summaries to identify database bottlenecks or network latency issues.
- **Hot-path optimizations already in place (do not re-introduce the old patterns):** `snapshotRegistry` buffer-prune is throttled (~5s, not every register); `axles`/`axles_after_allowance`/`flags` are batch-inserted per transaction; OCR crop reuses image metadata instead of re-decoding. Watch `db_insert_ms`, `ocr_ms`, `vehicle_total_ms`, Loop Delay P99, Inflight Peak.

## Technical References
- **Deep-dive docs:** Straddling working principle (B2 cross-lane + Type-2 mirror) in `docs/straddling-detection.md`; config (`straddling_*`, `STRADDLE_MATCH_MS`/`STRADDLE_CONFIRM_MS`/`STRADDLE_PARTNER_FLOOR`) in `docs/config-guide.md`.
- **Configuration Mapping:** See `src/utils/mappers/mapConfigurationKeys.js` (`straddling_*` from DB + `STRADDLE_*` env overrides; defaults applied if null).
- **Database Schema:** Reference `src/config/db.js` for connection details and existing SQL scripts in `docs/sql/`.
- **Logs:** Monitor PM2 logs or the console for "Configuration change detected" messages. Every transaction has a consistent pipeline ID for tracing.
- **Image Wait Workflow:** Detailed in `src/controllers/DataLogger.js` (`waitForImages`). If snapshots are missing after the initial find, it retries up to 5 times (2/4/6/8/10s). There is no software on-demand capture.
- **Pipeline Logging:** Every stage carries the same correlation tag so one vehicle can be traced end-to-end by grepping its ID: `[RX]` → `[Pipeline] Classified` → `[Filter] Dropped <reason>` (if filtered) → `Data saved` → `[Pipeline] Background start` → `[Snapshot] Found` → `[OCR]` → `[Upload]` → `Data updated` → per-vehicle metrics line (`CAR(class1)…` / `TRUCK…` / `*OVER…*` with stage breakdown) → `[LED] Dispatching to VMS` → `[Transmit] Dispatching`. (There is no `🚗 [Vehicle Saved]` line — the per-vehicle metrics line is the end-of-pipeline summary.)
