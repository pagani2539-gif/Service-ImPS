# TASK — IMPS Service Performance Optimization

> สรุปงาน optimize ทั้งหมด (ยังไม่ commit ณ ตอนเขียน) — ห้ามแก้ MySQL/schema/SQL, ไม่แตะ WIM calculation, ไม่เปลี่ยน sensor/protocol/API output
> อัปเดตล่าสุด: 2026-06-13

## สถานะรวม

| รอบ | โฟกัส | สถานะ |
|---|---|---|
| 1 | Refactor + snapshot matching (event-driven) | ✅ เสร็จ (uncommitted) |
| 2 | ลด work ซ้ำ + startup + logging | ✅ เสร็จ (uncommitted) |
| 3 | Monitoring/Metrics + Stability + dedup | ✅ เสร็จ (uncommitted) |
| — | งานเสนอแยก (นอก constraints) | ⬜ รออนุมัติ |

---

## รอบ 1 — Refactor & Snapshot Matching ✅

- [x] เปลี่ยน flow เป็น **รอรูปครบก่อน insert** (`waitForImages`) แทน retry หลัง insert → ข้อมูล+รูปขึ้น DB พร้อมกัน
- [x] **Event-driven** snapshot registry (`waitForRegister`) — ตื่นทันทีเมื่อมีรูปใหม่ แทน poll DB ทุก 150ms
- [x] เช็ค DB เฉพาะรอบแรก + ทุก `SNAP_MATCH_DB_POLL_MS` (1s)
- [x] insert snapshot ลง DB แบบไม่บล็อก (memory เป็นแหล่งหลัก)
- [x] Cache config ราย lane (`lprConfigByLane` / `overviewConfigByLane`) แทน `.find()` ทุก trigger
- [x] Cache `ensureDir` + เปลี่ยน `fs.existsSync` → `fs.pathExists` (async)
- [x] console → winston logger (services + utils)

**ไฟล์:** `snapshotManager.js`, `snapshotRegistry.js`, `WSController.js`, `wsService.js`, `transmissionService.js`, `ledDisplayService.js`, `picoService.js`

---

## รอบ 2 — ลด Work ซ้ำ + Startup + Logging ✅

- [x] **OCR in-memory cache** (`ocrResultCache`, key = imageUrl, cap 50) — retry ไม่ re-OCR/re-crop รูปใบเดิม (cache เฉพาะผลสำเร็จ)
- [x] ลบ **dead HTTP call** `getSingleDualTire` (ผลไม่ถูกใช้) + import + `PICO_BASE`
- [x] `Promise.all` startup fetches ใน `app.js` (config / vehicleClasses / singleTires ยิงขนาน)
- [x] console → logger ที่เหลือใน controllers
- [x] แก้ `.env.example`: `SNAP_MATCH_POLL_MS` → `SNAP_MATCH_DB_POLL_MS`

**ไฟล์:** `DataLogger.js`, `InterComp.js`, `app.js`, `.env.example`

**ตัดสินใจไว้:** คงลำดับ `transmitVehicle` ไว้หลัง 3D ตามเดิม (ผู้ใช้เลือก)

---

## รอบ 3 — Monitoring + Stability ✅

- [x] 🔴 **Fix ghost controller** — `WSController` clear reconnect timer ใน `closeSockets()` + guard `shouldReconnect` ที่ `initDataSocket`/`initTriggerSocket` → กัน controller เก่าเปิด socket กลับมาเองหลัง config เปลี่ยน (root cause ของ duplicate + memory leak)
- [x] **Dedup** data message ซ้ำ (`_isDuplicateMessage`, key `lane:id`, window 60s, cap 500) + log `[Dedup]`
- [x] **perfMonitor.js** (ใหม่) — counters / latency p50·p95·max / in-flight gauge / event-loop lag / CPU / RSS → สรุปลง log ทุก `METRICS_INTERVAL_MS` (default 5 นาที)
- [x] Instrument ทุกทางออกของ handler: `received`, `inserted`, `dropped_*` (6 เหตุผล), `straddle_*`, `handler_error`, `trigger_received`
- [x] จับเวลาราย stage ต่อคัน: `find / imageWait / insert / sensorToDb`
- [x] นับ `db_pool_enqueue` (ตัวชี้ connection pool อิ่มตัว)
- [x] `.env.example`: เพิ่ม `METRICS_INTERVAL_MS`

**ไฟล์:** `WSController.js`, `perfMonitor.js` (ใหม่), `DataLogger.js`, `InterComp.js`, `db.js`, `.env.example`

---

## Verification ✅

- [x] `npm test` — syntax check 24 ไฟล์ + mapper unit tests ผ่านครบ (ยืนยัน business logic ไม่เปลี่ยน)
- [x] Smoke test `perfMonitor` — `[Metrics]` แสดง counts/timings/inflight/cpu/mem ถูกต้อง
- [ ] e2e จริง — ต้องมีตาชั่ง/กล้อง/MySQL จริง (รันที่หน้างาน)

---

## งานเสนอแยก (นอก constraints) ⬜

- [ ] **Batch INSERT `axles_after_allowance`** (`vehiclesService.js:73`) — ตอนนี้ INSERT ทีละแถวใน loop (รถ 7 เพลา = 7 round trips/transaction) → ต้องเปลี่ยนข้อความ SQL จึงขัด "Do NOT change SQL"
- [ ] ทบทวน `SET TRANSACTION ISOLATION LEVEL` ต่อ insert ทุกคัน (+1 RTT) — เปลี่ยน transaction semantics
- [ ] ย้าย `transmitVehicle` ขึ้นก่อน 3D — ต้องให้ปลายทาง (frontend/transmission) รองรับว่า 3D rows อาจยังไม่มีตอนรับแจ้ง

## จูนได้เองที่ config (ไม่ต้องแก้โค้ด)

- `THREE_DIMENSION_DELAY` (env) — ปัจจุบันตัวอย่าง 5000ms
- `delay_capture_overview` (ตาราง configuration)
- `LOG_LEVEL=info` ใน production (กัน debug log ท่วม)
- `METRICS_INTERVAL_MS` — รอบสรุป metrics

## นอกขอบเขต repo นี้

- Frontend / API / pagination / bundle — อยู่คนละ service (:4000 / :3007)

---

## Task 1 — แก้ภาพ LPR ไม่ตรงตำแหน่ง (อ่านป้ายไม่ได้) 🔬 instrument แล้ว รอ tune

**อาการ:** ภาพหน้ารถถ่ายไม่ตรง อ่านป้ายไม่ได้ — สุ่ม (ข้อ 1 เห็นท้ายรถ + ข้อ 3 รูปคนละคัน)
**Root cause:** mis-claim ใน `claimClosest` — forward window `maximum_search` (+8s) กว้างไป รถคันหนึ่งคว้ารูปของคันถัดไป → คันถัดไปตก live fallback (ภาพท้ายรถ)

- [x] Match window override ผ่าน env (`SNAP_MATCH_BACK_MS`/`SNAP_MATCH_FWD_MS`) — ไม่ต้องแก้ DB
- [x] Trigger-history window ปรับได้ (`TRIGGER_HISTORY_WINDOW_MS`, โค้ดเดิม 3000 / design 15000)
- [x] Diagnostic: `snap_offset_lpr/overview_ms` (p50/p95/min/max) + counter `snap_fallback_lpr/overview` ใน `[Metrics]`
- [x] perfMonitor `_stats` เพิ่ม `min`
- [ ] **รัน → อ่าน `snap_offset_*_ms` → ตั้ง `SNAP_MATCH_FWD_MS` ให้พอครอบ p95** (ตัด outlier ที่คว้าคันถัดไป)
- [ ] ยืนยัน `snap_fallback_*` ลดลงหลัง tune

**ไฟล์:** `snapshotManager.js`, `snapshotRegistry.js` (window), `DataLogger.js`, `InterComp.js`, `perfMonitor.js`, `.env.example`

## ขั้นต่อไป

- [ ] Commit งาน 3 รอบ (แนะนำแยก 3 commit ตามรอบ เพื่อ rollback ง่าย)
- [ ] Deploy + เฝ้าดู `[Metrics]` 1 รอบ (5 นาที) หา bottleneck จริงหน้างาน
