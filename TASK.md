# TASK — IMPS Service Performance Optimization

> สรุปงาน optimize ทั้งหมด — ห้ามแก้ schema เชิงโครงสร้าง, ไม่แตะ WIM calculation, ไม่เปลี่ยน sensor/protocol/API output
> อัปเดตล่าสุด: 2026-06-20

## สถานะรวม

| รอบ | โฟกัส | สถานะ |
|---|---|---|
| 1 | Refactor + snapshot matching (event-driven) | ✅ เสร็จ |
| 2 | ลด work ซ้ำ + startup + logging | ✅ เสร็จ |
| 3 | Monitoring/Metrics + Stability + dedup | ✅ เสร็จ |
| 4 | Pipeline logging + Straddle violation recalc + ลบ InterComp | ✅ เสร็จ (`78bb0b8`) |
| 5 | Documentation update | ✅ เสร็จ (2026-06-16) |
| — | Straddle finish (error-drop / zero-side / re-classify / trigger debounce / edge-mirror) | ✅ เสร็จ (`fdce4f5`) |
| 6 | Bottleneck fixes (P1–P4) + doc sync | ✅ เสร็จ (2026-06-20) |

---

## รอบ 6 — Bottleneck Fixes (P1–P4) ✅ (2026-06-20)

ตรวจ bottleneck ทั้ง pipeline แล้วแก้เฉพาะที่ "ลดงานซ้ำซ้อน คงพฤติกรรมเดิม" (เทียบ risk กับ SKILL.md):

- [x] **P1** — `snapshotRegistry.register()` throttle buffer-prune (ทุก ~5s แทนทุกรูป) ผ่าน `lastBufferPrune`
  — เดิมกวาดทั้ง map ทุก register บน main thread; prune รัน *หลัง* `_notifyWaiters` จึงไม่กระทบความเร็วจับคู่รูป
- [x] **P2** — `ocrService.clampRectToImage` คืน `{rect, meta}` ใช้ meta ซ้ำใน crop (เดิม decode ภาพเดิม 3 รอบ/ป้าย)
- [x] **P3** — gate `[OCR][raw]` + `[OCR][Crop]` ไว้หลัง `OCR_DEBUG=1` (ปิด default) — ลด disk I/O/CPU ต่อป้าย
- [x] **P4** — `vehiclesService.insertAxlesAfterAllowances` เปลี่ยนเป็น batch `VALUES ?` (เดิม INSERT ทีละเพลา)

**ไฟล์:** `snapshotRegistry.js`, `ocrService.js`, `vehiclesService.js`
**ผล:** `vehicle_total_ms`/`db_insert_ms`/`ocr_ms` ทรงหรือลดลง, `Loop Delay P99` นิ่งขึ้นช่วงรถถี่ — ผลลัพธ์ใน DB/รูปเท่าเดิม

### พิจารณาแล้ว — คงเดิม/เลื่อน
- **P5 (isolation level → connection event):** เลื่อน — แตะ `db.js` (ไฟล์อ่อนไหว, รัน migration) กำไรแค่ ~1 RTT/คัน ไม่คุ้มเสี่ยง
- **P6 (ย้าย transmit ก่อน 3D):** **คงเดิม** — ลำดับ 3D→transmit ปัจจุบันการันตีว่าส่วนกลางเห็น 3D ก่อนถูกแจ้ง (ย้ายแล้วเสี่ยงข้อมูลหาย)
- **P7 (pool recreate ไม่อัปเดต export ref ใน `db.js`):** note resilience — รอยืนยันก่อนแตะ

---

## commit `fdce4f5` — Straddle finish ✅

- [x] **Drop controller error (GVW=-1):** ตัดทิ้งทันที (reading เสียทั้งใบ ห้าม merge)
- [x] **Zero-side detection** (`_isZeroSideStraddle`/`_zeroSideClass`): ตรวจ "ฝั่งศูนย์" เอง เผื่อ WIM ไม่ติดธงให้ครึ่งคัน + ใช้ L0↔R0 เป็นหลักฐานจับคู่ (evidence gate)
- [x] **Re-classify หลัง merge/edge-mirror:** คำนวณ class/violation/ESAL/flags ใหม่บนน้ำหนักรวม
- [x] **Same-lane fragment combine** (`combineSameLaneFragments`): รวมรถยาวที่ controller เลนเดียวตัดเป็น 2 ท่อน ก่อนรอจับคู่ข้ามเลน
- [x] **Edge-drift mirror** (`_tryEdgeMirror`/`mirrorEdgeAxles`): กู้รถไหลทางชิดขอบเป็น "ค่าประมาณ" (`is_estimated`, ไม่ตรวจน้ำหนักเกิน) เปิดผ่าน `mirror_edge_zones` ใน DB
- [x] **Trigger debounce ต่อเลน** (`TRIGGER_DEBOUNCE_MS`, default 250): ซ้าย+ขวาของคันเดียวยิงแทบพร้อมกัน → ถ่าย snapshot ใบเดียว
- [x] **MIN_AXLES filter:** ตัดรถ <2 เพลา (noise/มอไซค์/จับไม่ครบ) ตั้งแต่ต้น

**ไฟล์:** `DataLogger.js`, `mapDataLogger.js`, `db.js` (auto-add คอลัมน์ straddle/edge), `mapConfigurationKeys.js`
**เอกสาร:** `docs/straddling-detection.md`, `docs/config-guide.md`

---

## รอบ 1–5 (สรุปย่อ)

- **รอบ 1 — Refactor & Snapshot Matching:** รอรูปครบก่อน insert (`waitForImages`), event-driven registry (`waitForRegister`), เช็ค DB เฉพาะรอบแรก + ทุก `SNAP_MATCH_DB_POLL_MS`, insert snapshot ลง DB แบบไม่บล็อก, cache config ราย lane, `fs.existsSync`→`fs.pathExists`, console→winston
- **รอบ 2 — ลด work ซ้ำ:** OCR in-memory cache (`ocrResultCache`, cap 50), `Promise.all` startup fetches ใน `app.js`, แก้ `.env.example` (`SNAP_MATCH_DB_POLL_MS`)
- **รอบ 3 — Monitoring + Stability:** 🔴 fix ghost controller (clear reconnect timer + `shouldReconnect` guard), dedup data message ซ้ำ (`_isDuplicateMessage`), **perfMonitor.js** (counters/latency p50·p95·max/in-flight/event-loop lag/CPU/RSS), นับ `db_pool_enqueue`
- **รอบ 4 — Pipeline logging + Straddle bugfix:** pipeline logging ครอบทั้ง DataLogger, 🔴 คำนวณ `setViolation`/`calculateESAL` ใหม่หลัง merge (เดิมรถคร่อมเลนน้ำหนักเกินถูกบันทึกว่า "ผ่าน"), straddle instrument (`[Compare]`/`[Orphan]`), **ลบ InterComp ทั้งหมด** (หน้างานใช้แค่ DataLogger; ย้าย `ignoreGVW`/`isIgnoredLength` เข้า `mapDataLogger`)
- **รอบ 5 — Documentation:** อัปเดต README/SKILL + docs (straddling/config-guide)
- **รอบ 6 — Cross-lane straddle (B2) + 2 ประเภท:** (กล้องยืนยัน ~62/67 orphans = คร่อมเลน) จับคู่ครึ่งคันที่ filter ตัดทิ้งผ่าน `recentVehicles` (record reading ที่ถูก drop), แยกหน้าต่าง `STRADDLE_MATCH_MS`(50, suppress) / `STRADDLE_CONFIRM_MS`(250→หน้างาน 400, confirm+mirror), **Type 2 mirror** (เซ็นเซอร์ออกเลนเดียว → เติมฝั่งหายทุกเลน, `violation=0`), **align-null fallback** (รวมเพลาไม่ลง → pick-heavier+mirror), `STRADDLE_PARTNER_FLOOR`(1000, แยกจาก gvw_ignored). **deploy แล้ว: orphan 68→0, ใบสั่งผิด 0, error 0**. ดู `docs/straddling-detection.md` ข้อ B2
- **รอบ 7 — Cleanup:** ลบ dead code — `picoService.js`+env `PICO_BASE`, EdgeMirror (`_tryEdgeMirror`/`mirror_edge_zones`/env `MIRROR_EDGE_ZONES`/`parseEdgeZones`), `real-straddle` type (redundant). เก็บ `VMS_URL`, `mirrorEdgeAxles` (ใช้จริง), db.js column. อัปเดต docs ทั้งหมด

---

## งานเสนอแยก (นอก constraints)

- [x] **Batch INSERT `axles_after_allowance`** — เสร็จในรอบ 6 (P4)
- [~] `SET TRANSACTION ISOLATION LEVEL` ต่อ insert (+1 RTT) — พิจารณาแล้ว เลื่อน (P5)
- [~] ย้าย `transmitVehicle` ขึ้นก่อน 3D — พิจารณาแล้ว คงเดิม (P6: ปลายทางต้องรองรับ 3D ที่ยังไม่มา)
- [ ] P7: `db.js` pool recreate ไม่อัปเดต reference ที่ export — resilience รอยืนยัน

## จูนได้เองที่ config (ไม่ต้องแก้โค้ด)

- `THREE_DIMENSION_DELAY` (env)
- `delay_capture_overview`, `straddling_*` (ตาราง `configuration`) · `STRADDLE_MATCH_MS`/`STRADDLE_CONFIRM_MS` (env) · ~~`mirror_edge_zones`~~ (เลิกใช้)
- `LOG_LEVEL=info` ใน production (กัน debug ท่วม) · `OCR_DEBUG=1` เมื่อต้องไล่ปัญหา crop
- `METRICS_INTERVAL_MS` — รอบสรุป metrics

## นอกขอบเขต repo นี้
- Frontend / API / pagination — อยู่คนละ service (:4000 / :3007)

---

## Verification ✅
- [x] `npm test` — syntax check **20 ไฟล์** + mapper unit tests ผ่านครบ (ยืนยัน business logic ไม่เปลี่ยน)
- [x] Smoke `perfMonitor` — `[Metrics]` แสดง counts/timings/inflight/cpu/mem ถูกต้อง
- [ ] e2e จริง — ต้องมีตาชั่ง/กล้อง/MySQL จริง (รันที่หน้างาน) + เทียบ `[Metrics]` ก่อน/หลังรอบ 6

---

## งานค้าง — Task: ภาพ LPR ไม่ตรงตำแหน่ง (อ่านป้ายไม่ได้) 🔬 instrument แล้ว รอ tune หน้างาน

**อาการ:** ภาพหน้ารถถ่ายไม่ตรง อ่านป้ายไม่ได้ (สุ่ม: เห็นท้ายรถ / รูปคนละคัน)
**Root cause:** mis-claim ใน `claimClosest` — forward window `maximum_search` (+8s) กว้างไป รถคันหนึ่งคว้ารูปของคันถัดไป

- [x] Match window override ผ่าน env (`SNAP_MATCH_BACK_MS`/`SNAP_MATCH_FWD_MS`)
- [x] Diagnostic: `snap_offset_lpr/overview_ms` (p50/p95/min/max) ใน `[Metrics]`
- [ ] **รัน → อ่าน `snap_offset_*_ms` → ตั้ง `SNAP_MATCH_FWD_MS` ให้พอครอบ p95** (ตัด outlier ที่คว้าคันถัดไป)

**ไฟล์:** `snapshotManager.js`, `snapshotRegistry.js`, `DataLogger.js`, `perfMonitor.js`, `.env.example`
