# คู่มือตั้งค่า: ระบบคร่อมเลน (straddling)

ค่าตั้งส่วนใหญ่อยู่ใน **1 แถว** ของตาราง `configuration` (ระบบอ่านใหม่ทุก 5 วินาที → แก้แล้วมีผลทันที ไม่ต้อง restart) · บางตัวปรับผ่าน **.env** ได้ (มีผลตอน restart)

---

## ค่าที่ตั้งได้

| คอลัมน์/env | ที่ตั้ง | default | หมายเหตุ |
|---|---|---|---|
| `straddling_axle_tol` | DB | 3 | ยอมจำนวนเพลาต่างกันได้กี่เพลา |
| `straddling_time_diff` | DB | 3 | วินาที — หน้าต่างเวลาจับคู่ใน buffer |
| `straddling_speed_diff` | DB | 15 | กม./ชม. — ความเร็วต่างได้ |
| `straddling_wheelbase_diff` | DB | 30 | ซม. — ฐานล้อต่างได้ |
| `straddling_zero_kg` | DB | 100 | กก. — เกณฑ์ตัดสิน "ฝั่งศูนย์" ต่อล้อ |
| `STRADDLE_MATCH_MS` | env | 50 | ms — หน้าต่าง B2 **suppress-dup** (ทิ้งครึ่งซ้ำ — destructive ควรแคบ) |
| `STRADDLE_CONFIRM_MS` | env | 250 | ms — หน้าต่าง B2 **confirm-straddle** (ติดธง+mirror — คู่จริงเคยเจอถึง ~345ms, หน้างานตั้ง 400) |
| `STRADDLE_PARTNER_FLOOR` | env | 1000 | กก. — น้ำหนักขั้นต่ำที่ทิ้งรอย sliver ครึ่งคันที่ filter ตัด (แยกจาก gvw_ignored) |

> `straddling_*` มี default อัตโนมัติ (ดู `src/config/db.js`) · `STRADDLE_*` ตั้งใน `.env` ไม่ต้องแตะ DB

---

## วิธีปรับหน้างาน (กรณีพบบ่อย)

- **คร่อมเลนยังหลุด (คู่ห่างเกินหน้าต่าง):** เพิ่ม `STRADDLE_CONFIRM_MS` (เช่น 400) — ดู `[Diag][CrossLane] dTime` ว่าคู่จริงห่างเท่าไร
- **มอไซค์/รถเล็กโดนติดธง STRADDLE? ผิด:** เพิ่ม `STRADDLE_PARTNER_FLOOR`
- **รถปกติเลนข้างโดน suppress ผิด (record หาย):** ลด `STRADDLE_MATCH_MS` (คงแคบ)
- **2 ครึ่งมาถึงห่างกันเกิน 3 วิ:** เพิ่ม `straddling_time_diff`

---

## หมายเหตุสำคัญ

- น้ำหนักที่ได้จาก **mirror** (คร่อมนุ่ม/confirm/align-fallback) เป็น **ค่าประมาณ** (ติด flag `STRADDLE?` / `is_estimated`) — ใช้นับรถ/สถิติ/ESAL เท่านั้น **ห้ามใช้เป็นหลักฐานน้ำหนักเกิน** (record พวกนี้ถูกบังคับ `violation=0` / `is_overweight=0`)
- **EdgeMirror (edge-zone) `mirror_edge_zones` เลิกใช้แล้ว** — Type-2 mirror กู้ "ไหลทาง + คร่อมนุ่ม" อัตโนมัติทุกเลนโดยไม่ต้องตั้งขอบ L/R (คอลัมน์ใน DB ยังอยู่แต่ไม่ถูกใช้)
- ดูหลักการทำงานเต็มได้ที่ [straddling-detection.md](straddling-detection.md)
