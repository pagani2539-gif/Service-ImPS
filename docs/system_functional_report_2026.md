# รายงานฟังก์ชันการทำงานระบบ IMPS Service (ฉบับปรับปรุง 2026)

**วันที่จัดทำ:** 22 พฤษภาคม 2026
**สถานะระบบ:** ทำงานปกติ (แก้ไขปัญหา Global Variable และ Midnight Cleanup แล้ว)

## 1. การเริ่มต้นและควบคุมระบบ (System Orchestration)
- **Initialization:** โหลด Configuration, Vehicle Classes, และ Single Tires จาก Database เมื่อเริ่มระบบ
- **Dynamic Controller:** รองรับ Controller 2 รูปแบบ (DataLogger และ InterComp) ตาม `controller_id`
- **Configuration Monitoring:** ตรวจสอบการเปลี่ยนแปลงค่า Config ใน DB ทุก 5 วินาที และ Restart Controller อัตโนมัติหากมีการเปลี่ยนแปลง

## 2. ช่องทางการรับข้อมูล (Data Ingestion)
- **Trigger WebSocket:** รับสัญญาณ "Start" จากกล้องเพื่อจับภาพทันที
- **Data WebSocket:** รับข้อมูลน้ำหนัก, เพลา, ความเร็ว และเวลาจากระบบ WIM

## 3. ระบบจัดการรูปภาพ (Snapshot Management)
- **Dual Capture:** จับภาพ LPR และ Overview พร้อมกัน
- **Snapshot Registry:** ระบบคิวในหน่วยความจำ (In-memory) ช่วยให้จับคู่รูปกับข้อมูลน้ำหนักได้รวดเร็วและแม่นยำ
- **Closest Match Logic:** ค้นหารูปที่เวลาใกล้เวลารถที่สุด (Closest Timestamp) เพื่อลดปัญหา "ผิดคัน"
- **Cleanup Service:** ลบรูปภาพและข้อมูลเก่า (เกิน 3 วัน) ทุกเที่ยงคืน 
    - *Update:* ปรับปรุงเป็นระบบ Asynchronous (Non-blocking) เพื่อไม่ให้ระบบหยุดทำงานช่วง 00:00 - 00:05 น.

## 4. การประมวลผลข้อมูลรถ (Vehicle Data Processing)
- **Classification:** จำแนกประเภทรถตามจำนวนเพลาและระยะฐานล้อ
- **Violation Check:** ตรวจสอบน้ำหนักเกินตามพิกัดประเภทรถ
- **ESAL Calculation:** คำนวณค่าการทำลายผิวทางตามมาตรฐาน AASHTO 1993
- **Straddling Merge:** ระบบรวมน้ำหนักอัตโนมัติกรณีรถวิ่งคร่อมเลน

## 5. ระบบ OCR และการจัดการภาพป้ายทะเบียน
- **OCR Integration:** ส่งภาพวิเคราะห์เลขทะเบียนและจังหวัดอัตโนมัติ
- **Smart Crop:** ตัดภาพเฉพาะส่วนป้ายทะเบียนเก็บแยกไฟล์
- **Thai Plate Handling:** รองรับการอ่านและจัดรูปแบบป้ายทะเบียนภาษาไทย

## 6. การส่งออกและเชื่อมต่อภายนอก (Integration)
- **Database:** บันทึกข้อมูลลงฐานข้อมูล MySQL (7 ตารางหลัก)
- **VMS (LED):** ส่งข้อมูลไปแสดงผลที่ป้ายหน้าด่านทันที
- **External Transmission:** ส่งข้อมูลไปยัง Server ส่วนกลาง
- **3D & Pico Integration:** รองรับข้อมูลขนาดรถ 3 มิติ และประเภทล้อ (Single/Dual Tire)
