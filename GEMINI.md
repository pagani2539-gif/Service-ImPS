# GEMINI.md - IMPS Service Context

## Project Overview
**IMPS Service** (Intermediate Station Service) is a Node.js-based industrial IoT application designed for managing vehicle weighing stations. It acts as a middle layer between hardware weighing controllers and central monitoring systems.

### Key Features:
- **Hardware Integration:** Supports **DataLogger** and **InterComp** weighing controllers via WebSocket. Includes reconnect logic with exponential backoff.
- **Dynamic Configuration:** Polls the local MySQL database for configuration changes every 5 seconds and auto-restarts controllers as needed.
- **Visual Intelligence:** Integrates with OCR services for license plate recognition. Features an in-memory **Memory-Cache Buffer (30-second TTL)** in `SnapshotRegistry` to store image buffers directly and bypass disk reads. Uses a software-based on-demand fallback if hardware triggers fail, crops plate regions with `sharp`, and uploads to central servers.
- **Asynchronous Background Flow:** Bypasses synchronous waiting for snapshots/OCR. Immediately inserts weight data to the database (~20ms) and updates LED displays (VMS) to keep the station flowing, then performs image matching, OCR processing, 3D scanning queries, and uploads in the background. WebSocket broadcasts and central HTTP transmissions are executed once the background task completes, ensuring the UI remains dynamic without manual F5 refreshes.
- **Real-time Feedback:** Drives LED displays (VMS) and broadcasts data via WebSockets and HTTP transmission to central servers.
- **Tire Classification:** Integrates with a Raspberry Pi Pico tire sensor to identify single or dual tire configurations per axle.
- **3D Dimensions:** Integrates with a 3D Dimension Scanner to fetch vehicle width, length, and height, registering overheight violations.
- **Straddling Logic:** Buffers and merges vehicle transactions when a vehicle straddles across adjacent lanes. Uses a high-precision matching algorithm comparing millisecond timestamps, adjacent lane differences, speeds, and individual axle spacing (wheelbase) to ensure accurate merging, with detailed logging of axle weight calculations.
- **Automated Maintenance:** Includes a midnight cleanup service for snapshots and database logs to ensure system longevity.

### Tech Stack:
- **Runtime:** Node.js
- **Database:** MySQL (`mysql2` pool)
- **Process Management:** PM2 (Production), Nodemon (Development)
- **Communication:** WebSockets (`ws`), HTTP (`axios`)
- **Image Processing:** `sharp`
- **Utility:** `dayjs` for time, `node-schedule` for tasks.

---

## Building and Running

### Prerequisites:
- Node.js (v14+ recommended)
- MySQL Server
- Environment variables configured in `.env` (refer to `.env.example`).

### Key Commands:
- **Development:** `npm run dev` - Starts the service using `nodemon`.
- **Production:** `npm run prod` - Starts/reloads the service using `pm2` with `src/app.config.js`.
- **Testing:** `npm test` - Runs syntax validation on source files and executes mapper unit tests.

---

## Project Structure & Architecture

- `src/app.config.js`: PM2 process manager configuration file for production environment.
- `src/app.js`: Application entry point, controller initializer, and config change monitoring.
- `src/controllers/`: Contains protocol-specific logic:
    - `WSController.js`: Base class handling WebSocket connection lifecycles, retries, and backoff.
    - `DataLogger.js`: Subclass implementing DataLogger protocols, transaction processing, and trigger fallback.
    - `InterComp.js`: Subclass implementing InterComp protocols, transaction processing, and trigger fallback.
- `src/services/`: Core business logic services:
    - `configurationService.js`: Database-driven configuration retrieval and change polling.
    - `vehiclesService.js`: Database CRUD operations for vehicles, axles, plates, images, and flags.
    - `transmissionService.js`: Syncing finalized vehicle data to central APIs via HTTP POST.
    - `ledDisplayService.js`: Formatting and sending display commands to LED displays (VMS).
    - `picoService.js`: Fetching wheel/tire type details from Raspberry Pi Pico.
    - `threeDimensionService.js`: Interfacing with 3D scanners, validating heights, and mapping warnings.
    - `wsService.js`: Broadcasting real-time updates to dashboard clients via WebSocket.
    - `snapshotCleanupService.js`: Nightly cleanup scheduler deleting expired snapshots and DB log rows.
- `src/utils/mappers/`: Complex mapping logic:
    - `mapConfigurationKeys.js`: Formats database configurations into camelCase properties.
    - `mapDataLogger.js`: Parses DataLogger payloads, performs vehicle classification, ESAL calculation, and warning/error checks.
    - `mapInterComp.js`: Parses InterComp payloads.
- `src/utils/`: Utility and helper modules:
    - `logger.js`: Configures winston daily rotating logger.
    - `ocrService.js`: Queries OCR APIs and handles image cropping.
    - `snapshot.js`: Lightweight buffer snapshot collector.
    - `snapshotManager.js`: Handles IP camera snapshot requests and uploads.
    - `snapshotRegistry.js`: In-memory index for fast snapshot lookup by timestamp and lane.
- `scripts/generate-snap-doc-pdf.js`: Generates PDF documents from HTML reports using Puppeteer.

---

## Development Conventions

### Coding Style:
- **Asynchronous Patterns:** Strict use of `async/await` for database and network operations.
- **Scope Safety:** All variables in mappers and controllers must be properly scoped (`const`/`let`) to avoid race conditions during concurrent vehicle processing.
- **Error Handling:** Use `try/catch` blocks extensively, especially around hardware communication and database queries.

### Data Flow:
1. **Trigger & Cache**: Camera is triggered by hardware sensor, saving LPR/Overview snapshots into the disk and registering their binary data in `SnapshotRegistry`'s memory cache (30s TTL).
2. **Weighing Transaction**: Weighing scale controller receives raw vehicle weight/axle data via WebSocket.
3. **Classification & Mapping**: Data is parsed, class/axle allowances/ESAL calculated, and speed/lane verified.
4. **Immediate Database Save & VMS Update**: Vehicle data is inserted into the local DB immediately (~20ms) and the LED display (VMS) is updated to notify the driver.
5. **Background Visual Processing (Async Task)**: 
   - `SnapshotManager` claims closest matched snapshots from memory/disk. If missing (sensor failure), it triggers live fallback snapshots immediately.
   - Binary buffer is passed to `ocrService` to detect license plate numbers.
   - Plates and crops are uploaded to image servers, and DB records are updated.
   - If plate classification indicates an excluded vehicle (bus/passenger car), the row is deletedย้อนหลัง (Ghost Record Cleanup).
   - If 3D scanner integration is enabled, height/width/length is retrieved and linked.
6. **Transmission & WebSocket Broadcast**: Once background tasks are finalized, WebSocket signals and HTTP API requests are transmitted to central servers.

### Maintenance & Operations:
- **Configuration Updates:** Changes to the `configuration` table in the database are detected automatically. No manual restart is typically required.
- **Logs:** Monitor PM2 logs for "Configuration change detected" or "Initializing [Controller]" messages.
- **Cleanup:** Snapshots older than the defined threshold are deleted daily at midnight.

---

## Zero-Delay On-Demand Trigger Fallback

### Importance:
Ensures legal compliance and data completeness by guaranteeing that every overweight vehicle transaction recorded by the weighing scales has associated physical evidence (Overview and LPR images), even if the vehicle straddled or missed the hardware trigger sensors.

### Working Principle:
1. **Trigger Tracking:** The controller stores the timestamp of the last hardware trigger message received for each lane in a memory map (`this.lastTriggerTimes`).
2. **Failure Check:** When a weighing transaction completes, the system computes the time difference since the last trigger. If it exceeds 15 seconds, a hardware sensor trigger failure is diagnosed.
3. **Instant Capture:** The system skips the default 5-second polling delay for image matching, instantly queries the memory registry once (`_findSnapshotOnce`), and immediately fires an HTTP command to capture snapshots on-demand, minimizing vehicle displacement before the photo is taken.
