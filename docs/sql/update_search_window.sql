-- ช่วงค้นหารูป snap เทียบเวลารถ (หน่วย: มิลลิวินาที)
-- ตาราง: configuration
--
-- minimum_search = ค้นย้อนหลังจาก stamp รถได้ไม่เกินกี่ ms
-- maximum_search = ค้าล่วงหน้าจาก stamp รถได้ไม่เกินกี่ ms
--
-- ค่าเดิมทั่วไป: 1000 / 5000
-- ค่าแนะนำหลังเพิ่ม: 2000 / 8000 (หารูปได้ง่ายขึ้น แต่รถชิดกันอาจผิดคันได้ง่ายขึ้น)

-- ดูค่าปัจจุบัน
SELECT id, station_name, minimum_search, maximum_search, delay_capture_overview
FROM configuration;

-- อัปเดตทุกสถานี (ปรับ WHERE ถ้ามีหลายแถว)
UPDATE configuration
SET
  minimum_search = 2000,
  maximum_search = 8000,
  updated_at = NOW()
WHERE id = 1;

-- หรืออัปเดตเฉพาะสถานี
-- UPDATE configuration
-- SET minimum_search = 2000, maximum_search = 8000, updated_at = NOW()
-- WHERE station_name = 'ชื่อสถานี';
