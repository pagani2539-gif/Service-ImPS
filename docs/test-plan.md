# แผนทดสอบ imps_service V2 (Test Plan)

> อัปเดตล่าสุด: 2026-07-02
> ขอบเขต: ตัวบริการ imps_service V2 ทั้งหมด (WIM data pipeline, snapshot/OCR, straddling, DB, VMS, transmit)
> หลักการ: ทดสอบไล่จากชั้นที่ถูกที่สุด (unit) → แพงที่สุด (soak บนสถานีจริง) และทุกชั้นต้องผ่านก่อนขยับไปชั้นถัดไป

---

## 0. เครื่องมือที่มีอยู่แล้วในโปรเจกต์

| เครื่องมือ | คำสั่ง | ใช้ทดสอบอะไร |
|---|---|---|
| Syntax check | `node scripts/validate.js` | ทุกไฟล์ใน `src/` parse ได้ (กัน typo ก่อน deploy) |
| Unit tests | `node scripts/test-mappers.js` | pure functions ใน `mapDataLogger.js` (15 ชุด) |
| รวมสองอย่าง | `npm test` | รันทั้งคู่ |
| Dead-code check | `node scripts/find-unused.js` | ทุกไฟล์ `src/` ถูก require ถึงจริง |
| Diag analyzer | `node scripts/analyze-diag.js <logfile>` | สรุป `[Diag][*]` จาก log ตอนเปิด `DIAG=1` |
| Metrics | ดู `[Metrics Summary]` ใน log ทุก `METRICS_INTERVAL_MS` | counters/timings/inflight/memory |

---

## Phase 1 — Unit tests (รันได้ทุกเครื่อง ไม่ต้องมี DB/กล้อง)

**สถานะ: มีแล้ว 15 ชุดใน `scripts/test-mappers.js` — ผ่านทั้งหมด**

ครอบคลุมแล้ว:
- `classifyVehicle` (class 1/2 ตาม wheelbase, multi-axle 3–7 เพลา)
- `setSingleTire` (กัน crash เมื่อ config หาย/ว่าง)
- `isVehicleExcludedByPlate` (ป้ายไทย, ป้ายใหม่ digit+ไทย, prefix 10–49 ตัด / 50–99 เก็บ)
- `formatLicensePlate` (6/7 หลัก, ป้ายไทย, edge cases)
- `isReverseDirection`
- `mergeStraddlingVehicles` (order-independence, mixed sensors, เพลาไม่เท่ากัน align/reject)
- `setViolation` (เกิน/ไม่เกิน gvw_max, exempt class 0/19)
- `mapWarningFlag` / `mapErrorFlag` (bit extraction, กรองเฉพาะ bit 9/10)
- `ignoreGVW` / `isIgnoredLength` (threshold filters)
- `mirrorEdgeAxles` (mirror เฉพาะเพลาฝั่งเดียวศูนย์ + no-op เมื่อครบสองฝั่ง)
- `combineSameLaneFragments` (ต่อ axles, renumber, gap→wheelbase, OR warningFlags)
- `calculateESAL` (finite/positive/monotonic, axles ว่างไม่ crash)

**ที่ควรเพิ่มภายหลัง (ยังไม่มี):**
- `mapDataLogger` (mapping ดิบ → รูปแบบภายใน: หน่วย ×100, StartTime→stamp, default flags)
- `normalizePosition` / `clampRectToImage` ใน `ocrService` (พิกัด crop ทั้ง 4 รูปแบบ)
- `SnapshotRegistry` (claimClosest เลือกใบใกล้สุด, ไม่ reuse ใบที่ used, TTL prune, waitForRegister ตื่นเมื่อ register)
- `_implausibleReason` / `_isZeroSideStraddle` / `_zeroSideClass` (ต้อง instantiate DataLogger — แยก logic ออกมาเป็น pure function ก่อนถึงเทสได้ง่าย ดูหมายเหตุ refactor ท้ายไฟล์)

**เกณฑ์ผ่าน:** `npm test` เขียว 100% ทุกครั้งก่อน commit

---

## Phase 2 — Integration test บนเครื่อง dev (mock ปลายทางทั้งหมด)

หลักการ: service ต่อกับ 5 ปลายทางภายนอก — mock ทั้งหมดได้ด้วย Node ตัวเดียว

| ปลายทาง | ที่ config | วิธี mock |
|---|---|---|
| Controller data WS | `controller_data_url` | `ws` server ยิง JSON ตัวอย่างรถ |
| Trigger WS | `controller_sensor_url` | `ws` server ยิง force-event/Start |
| กล้อง snapshot | `snap_code` URL | HTTP server คืน JPEG คงที่ |
| OCR | `ocr_url` | HTTP server คืน `{plate:{license_plate,...}}` ตามสั่ง |
| Image upload server | `IMAGE_*_UPLOAD_URL` | HTTP server คืน `{fileUrl}` + servable HEAD 200 |
| VMS / Transmission / WS ส่งออก | `led_url`, `TRANSMISSION_URL`, `WS_SERVER_URL` | HTTP/WS server เก็บ payload ไว้ assert |
| MySQL | `.env DB_*` | MySQL local เปล่า (schema เดียวกับสถานี) — **1 process ต่อ 1 DB เท่านั้น** |

### 2.1 เส้นทางปกติ (happy path)
1. รถ class 1 ปกติ → insert ครบ 6 ตาราง (vehicles/axles/axles_after_allowance/plates/images/flags), log แบบสั้น `CAR(class1)`
2. รถบรรทุก class 2+ → log เต็มพร้อม breakdown, ส่ง VMS หลังได้รูป, transmit หลังรูป servable
3. Trigger → snapshot 2 ใบ (lpr burst ตาม `LPR_BURST_FRAMES` + overview 1 ใบ), ลงทะเบียนใน registry, จับคู่กับ data message ที่ตามมา
4. OCR อ่านออก → plates อัปเดต license_plate/province/crop_path; อ่านไม่ออก → ยัง insert พร้อม platePath (ไม่หลุด)

### 2.2 Filter chain (ลำดับสำคัญ — ทดสอบทีละด่านด้วย input เจาะจง)
ลำดับจริงใน `handleDataMessage`:
`dedup → reverse → GVW=-1 → single-axle → implausible → gvw floor → classify → length → bus wheelbase → straddle`

| เคส | Input | ผลที่ต้องได้ |
|---|---|---|
| Duplicate message | ส่ง message เดิมซ้ำใน 60s | drop + counter `dropped_duplicate` |
| Reverse | `Direction: 1` | drop + `dropped_reverse` |
| GVW=-1 | `GrossWeight: -1` | drop + บันทึกรอยใน recentVehicles (type gvw-1) |
| เพลาเดียว | Axles 1 ตัว | drop + `dropped_single_axle` |
| มอเตอร์ไซค์ (phantom-axle) | ล้อแถวเดียว น้ำหนักต่ำกว่า gvw_ignored/2 | drop โดย implausible — **ห้ามกลายเป็นรถ 10 ล้อ** (regression เคสจริง) |
| gvw/axleSum ขัดกัน | gvw 1184, axleSum 190 | drop implausible (ratio < 0.5) |
| เพลาผี | wheelbase < 40cm | drop implausible |
| รถเบา | gvw < gvw_ignored, ไม่ติดธง straddle | drop + `dropped_gvw` |
| ครึ่งคร่อมเลนหนักพอ | gvw < gvw_ignored แต่ ≥ floor/2 + ติดธง 9/10 | **ไม่ drop** — เข้า straddle buffer |
| รถสั้น | class 1/2, wheelbase < vehicle_length_ignored | drop + `dropped_length` |
| บัส (wheelbase) | class 2, wheelbase ≥ wheelbase_bus | drop + `dropped_bus_wheelbase` |
| บัส (ป้าย) | OCR คืน prefix 10–49 หรือป้ายไทย | ลบ record ย้อนหลัง (deleteVehicleFromDatabase ครบ 6 ตาราง) |

### 2.3 Straddling (จุดที่ logic ซับซ้อนสุด — ต้องเทสครบทุก branch)
| เคส | จำลอง | ผลที่ต้องได้ |
|---|---|---|
| Merge ปกติ | 2 record เลนติดกัน ติดธง 9/10 เวลาห่าง < time_diff, เพลาเท่ากัน | 1 record, gvw รวม, re-classify + violation คิดบนน้ำหนักรวม, `STRADDLE` tag |
| เพลาไม่เท่ากัน (ใน tol + evidence) | 3 เพลา vs 2 เพลา zero-side ตรงข้าม | merge แบบ align, `straddleAxleMismatch=true` (STRADDLE?) |
| Align ไม่ลง (null) | เพลาตำแหน่งขัดกัน | pick-heavier + mirror, ไม่นับ overweight, `straddle_align_fallback` |
| Same-lane fragment | 2 record เลนเดียวกัน zero-side เดียวกัน gap < 25m | รวมเป็นคันเดียวแล้ว re-buffer |
| Fragment gap เกิน | gap > FRAGMENT_MAX_GAP_CM | ไม่รวม (คนละคัน) |
| Orphan | ติดธงแต่ไม่มีคู่ใน buffer+recent | บันทึก unmerged + log Orphan |
| B1 claim | รถไม่ติดธง insert ขณะครึ่งติดธงรอใน buffer | เลือกใบหนัก 1 record (`crossLane_dupSuppressed`) |
| B2 suppress-dup | ครึ่งติดธง timeout, มีคู่ type real ใน ±match_ms | ไม่ insert ซ้ำ |
| B2 confirm | คู่ type gvw-1/dropped ใน ±confirm_ms | mirror + STRADDLE?, violation=0 |
| Type-2 mirror | ฝั่งเดียวศูนย์ ไม่มีคู่เลย | mirror เติมฝั่งหาย, ไม่นับ overweight |
| Timeout ทำงานจริง | ครึ่งเข้า buffer แล้วเงียบ | processFinalVehicle ถูกเรียกหลัง maxDiff วินาที, buffer ไม่ค้าง (size กลับ 0) |

### 2.4 รูปภาพ / OCR / F5 regression
- รูปมาช้ากว่า data → `waitForImages` retry (IMAGE_RETRY_COUNT×DELAY) แล้วได้รูป → updatePlates/updateOverview ย้อนหลัง
- รูปไม่มาเลย → save แบบไม่มีรูป (ห้ามหลุดทั้งคัน) + log `Retries exhausted`
- upload พลาดครั้งแรก → retry ใช้ snapshot ใบเดิม + OCR cache (ห้าม re-OCR: นับจำนวน call ที่ mock OCR)
- **F5 case:** mock upload คืน `fileUrl` แบบ relative → ต้องเติม `IMAGE_SERVE_BASE` แล้ว HEAD จนกว่า 200 ก่อน transmit; ไม่ตั้ง base → warn ครั้งเดียวและ transmit เลย
- HEAD ไม่เคย 200 → transmit หลัง `TRANSMIT_READY_CAP_MS` (กันค้าง)
- burst 2 เฟรม: เฟรมแรกอ่านไม่ออก เฟรมสองอ่านออก → `plate_recovered_by_extra_frame` + upload ใบที่ชนะ
- trigger debounce: 2 trigger เลนเดียวกันห่าง < 250ms → ถ่ายชุดเดียว (`trigger_debounced`)
- trigger เลนที่ไม่มี config → warn บอกเลนที่มี (ไม่เงียบ)

### 2.5 ความทนทาน (resilience)
- ปิด data WS → reconnect แบบ exponential backoff; `stop()` แล้ว **ต้องไม่มี** socket ใหม่ (ghost controller — regression)
- แก้ `configuration.updated_at` ใน DB → controller ตัวเก่า stop + ตัวใหม่ขึ้น ภายใน ~5s; ทำซ้ำ 10 รอบแล้ว connection/timer ไม่รั่ว (ดู handle count)
- DB ล่มชั่วคราว → pool error แค่ log (ไม่ crash) แล้วฟื้นเอง; insert ระหว่างล่ม → error ถูกจับ ไม่ทำ process ตาย
- Deadlock (จำลองด้วย 2 connection ล็อกไขว้) → retry 1 ครั้งสำเร็จ
- OCR/upload/VMS/3D endpoint timeout → คันนั้นได้ผลลัพธ์ตาม fallback ของแต่ละส่วน แต่ pipeline โดยรวมไม่ค้าง
- Trigger watchdog: ส่ง data โดยไม่ส่ง trigger > 30s → error `[Trigger][Watchdog]` ครั้งเดียว + `trigger_sensor_silent`; trigger กลับมา → log recovered

### 2.6 ข้ามเที่ยงคืน (midnight)
- trigger เวลา 23:59:59 ประมวลผลตอน 00:00:01 (และกลับกัน) → stamp ถูกวัน (logic ±12h ใน handleTriggerMessage)
- cleanup 04:00 → ลบโฟลเดอร์ lpr/crop/overview เกิน 7 วัน + แถว snapshots ใน DB; โฟลเดอร์วันปัจจุบันอยู่ครบ

**เกณฑ์ผ่าน Phase 2:** ทุกเคสได้ผลตามตาราง, ไม่มี unhandled rejection, counter ใน `[Metrics Summary]` ตรงกับจำนวนที่ยิง

---

## Phase 3 — Replay / shadow test ด้วยข้อมูลจริง

1. ใช้ log raw WIM ที่เก็บจากสีคิ้ว (3-lane tap) เขียน replayer ยิงเข้า mock WS ตาม timestamp จริง (เร่ง 10× ได้)
2. เปิด `DIAG=1` แล้วรันทั้งวันของข้อมูล → `node scripts/analyze-diag.js logs/info-*.log`
3. เทียบตัวเลขกับ baseline ที่รู้แล้ว (จาก memory/รอบก่อน):
   - straddle merge ~เท่าเดิม, orphan ไม่เพิ่ม (เป้า: ~62/67 orphan อธิบายได้ว่าเป็น straddle)
   - `dropped_implausible` จับมอเตอร์ไซค์ครบ, **ไม่มี** class 3+ ที่ axleCount ผิดธรรมชาติหลุดเข้า DB
   - จำนวน `inserted` ต่อวัน ±2% ของรอบ V2 ก่อนหน้า (กันตัวกรองเปลี่ยนพฤติกรรมโดยไม่ตั้งใจ)
4. สุ่ม 20 คันจาก DB เทียบมือกับ raw log: gvw, axles, class, violation, ป้าย

**เกณฑ์ผ่าน:** ตัวเลขรวมไม่เบี่ยงจาก baseline เกินที่ตกลง และไม่มี record ประหลาด (ครึ่งคัน/รถผี) ที่อธิบายไม่ได้

---

## Phase 4 — Performance / soak (เครื่องเทสหรือสถานีนอกเวลาใช้งาน)

- **Load:** replay อัดรถ ~2×peak (เช่น 1 คัน/วินาที ทุกเลน) 30 นาที → ใน `[Metrics Summary]`: `vehicle_total_ms` p95 ไม่โตต่อเนื่อง, `db_pool_enqueue` ≈ 0, loop delay p99 < 100ms
- **Soak 24 ชม.:** RSS/Heap ไม่ไต่ (กราฟจาก Metrics ทุก 5 นาที), `inflight` กลับ 0 ช่วงว่าง, `straddlingBuffer`/`recentVehicles`/`recentMessageIds`/registry ไม่โต (ดูผ่าน heap snapshot หรือเพิ่ม gauge ชั่วคราว)
- **Restart ระหว่างโหลด:** `pm2 restart` กลางโหลด → กลับมาประมวลผลต่อ, รูปที่ค้างใน DB snapshots ถูกกู้มาใช้ (DB recovery path)

---

## Phase 5 — Field test บนสถานีจริง (ก่อนตัดจาก V1)

Checklist ก่อนเปิด:
1. `.env` ครบ: `DB_*`, `IMAGE_*_UPLOAD_URL`, `IMAGE_SERVE_BASE_URL` (กัน F5), `TRANSMISSION_URL`, `WS_SERVER_URL`, ค่าจูน `STRADDLING_*`/`STRADDLE_*`
2. **ปิด V1 ก่อนเปิด V2 เสมอ** (ห้าม 2 process ต่อ 1 DB — กฎเหล็กโปรเจกต์)
3. `pm2 startOrReload src/app.config.js --env production` (ชื่อ app `imps_service_v2`)

รัน 3–7 วันคู่การเฝ้าดู:
- วันแรกเปิด `DIAG=1`, ปกติแล้วปิด
- ทุกเช้า: `analyze-diag`/Metrics — dropped_*, orphan, straddle merge, image_missing, F5 (ต้องเป็น 0), trigger_sensor_silent
- เทียบภาพ VMS หน้างานกับ DB วันละ ~10 คัน
- เทียบยอดรถ/วัน กับ V1 ช่วงเดียวกันของสัปดาห์ก่อน (คลาดเคลื่อนอธิบายได้จาก filter ใหม่เท่านั้น)

**เกณฑ์ตัดจบ:** 3 วันติดไม่มี crash/restart อัตโนมัติ, ไม่มี F5 complaint, ยอดรถ+overweight สอดคล้อง baseline

---

## Regression checklist (ผูกกับบั๊กที่เคยเจอ — ต้องเช็คทุกรอบ release)

| บั๊กเดิม | วิธีเช็คซ้ำ |
|---|---|
| F5 (ภาพ 404 ต้องกดรีเฟรช) | Phase 2.4 relative fileUrl + field: ไม่มี complaint |
| มอเตอร์ไซค์กลายเป็นรถ 10 ล้อ | Phase 2.2 implausible + Phase 3 ไม่มี class สูง axle เพี้ยน |
| Straddle ครึ่งคันซ้ำ 2 record | Phase 2.3 B1/B2 suppress |
| Ghost controller หลัง config เปลี่ยน | Phase 2.5 restart 10 รอบ ไม่มี socket/timer รั่ว |
| VMS ไม่ขึ้นรูป | log `[LED] NO-OVERVIEW` / `LED-URL-EMPTY` ต้องไม่โผล่ในสถานีที่ตั้งค่าแล้ว |
| Buffer ค้างถาวร (merge null เคลียร์ timeout ผิดจังหวะ) | Phase 2.3 align-null + timeout: buffer size กลับ 0 เสมอ |
| ยิง POST ไป url ว่าง | ไม่ตั้ง TRANSMISSION_URL/led_url → ไม่มี error noise ใน log |

---

## หมายเหตุ refactor รอบนี้ (2026-07-02) — ไม่มีผลต่อพฤติกรรม

ลบ dead code + จัดระเบียบ dependency (ยืนยันด้วย `npm test` + `find-unused` ก่อน/หลัง):
- `DataLogger.js`: ลบตัวแปร `baseLedPath` ที่ไม่ได้ใช้
- `ledDisplayService.js`: ลบ `createAndSendLedDisplayImage` (เส้นทาง LED เก่า ไม่มีใคร require; V2 ใช้ `sendToVMS` ผ่าน led_url แทน) — import `sharp` ของไฟล์นี้หายไปด้วย
- `snapshotRegistry.js`: ลบ `hasUnusedImageInWindow` (ไม่มีผู้เรียก)
- `snapshotManager.js`: ลบ `moveFile` (ไม่มีผู้เรียก)
- `mapConfigurationKeys.js` + `configurationService.js`: ตัด `vehicle_length_ignored` ที่ประกาศ/SELECT ซ้ำสองครั้ง
- `package.json`: เพิ่ม `form-data` เป็น dependency ตรง (เดิมพึ่งของแถมจาก axios — เสี่ยงพังเงียบถ้า axios เปลี่ยน internal), ย้าย `nodemon` ไป devDependencies
- เพิ่ม unit tests 8 ชุด (7 → 15) ใน `scripts/test-mappers.js`

จุดที่ *ตั้งใจไม่แตะ* (พฤติกรรมเดิมตาม V1 / ปิดประเด็นไปแล้ว):
- `calculateESAL(mappedData, this.config, this.vehicleClasses)` — อาร์กิวเมนต์ที่ 3 ไม่ถูกใช้ (signature รับ 2 ตัว) คงไว้ตามเดิม
- `setViolation` index vehicleClasses ด้วย class ID — เหมือน V1 (ปิดว่าไม่ใช่บั๊ก)
- SN/pt ของ ESAL ใช้ default (optional ค้างไว้)
- ห้ามแก้ MySQL schema / 3D service ตามข้อจำกัดโปรเจกต์
