const winston = require("winston");
require("winston-daily-rotate-file");
const path = require("path");

const logDirectory = path.join(process.cwd(), "logs");

// console เท่านั้น: ซ่อนบรรทัด chatter รายสเต็ปเพื่อให้จอตอนเฝ้าเทสอ่านง่าย
// (ไฟล์ info-*.log ยังเก็บครบทุกบรรทัด) — ตั้ง CONSOLE_VERBOSE=1 เพื่อดูเต็ม
// กรองเฉพาะ level info/debug/verbose; warn/error ไม่โดนกรองเสมอ
const CONSOLE_QUIET_PATTERNS = [
  /^\[RX\]/, // รับ data message
  /^\[Pipeline\]/, // ทุกสเต็ป: Classified / Background start / Snapshots resolved
  /^\[Straddling\]\[Candidate\]/,
  /^\[Straddling\]\[Buffered\]/,
  /^\[Straddling\] Recalculated after merge/,
  /^\[Straddling\] Single part saved/,
  /^\[LED\]/, // Dispatching / sendToVMS successful / Display data sent / took (warn ยังเด้ง)
  /^\[Transmit\]/, // Dispatching / Data sent / sendToTransmission successful
  /^Data saved successfully for Vehicle ID/,
  /^Data updated successfully for Vehicle ID/,
  /^\[OCR\]/, // Plate: / No plate / Crop region debug
  /^\[Snapshot\] Found/,
  /^\[Upload\] OK/,
  /^\[Registry\] Pruned/,
  /^\[Straddling\]\[Compare\]/, // ทุกคู่ที่สแกน (noisy)
  /^\[Straddling\] High-precision/, // รายละเอียดตอน merge
  /^\[EdgeMirror\]\[Skip\]/, // เหตุผลที่ไม่ mirror รถไหลทาง (เก็บครบในไฟล์ log, ซ่อนจาก console)
  /^\[Image Wait\]/, // retry รอรูป
  /^\[Metrics\] Changing/, // เปลี่ยน format/interval (เก็บเฉพาะ summary)
  /^\[PERF\]/, // เวลา insert/query รายคัน
  /^\[Cleanup\]/, // งานลบไฟล์รายวัน
  /^\[Filter\] Excluded/, // คัดออกด้วย prefix/bus (เก็บ "Dropped" ไว้โชว์)
];

const consoleVerbose = process.env.CONSOLE_VERBOSE === "1";

// filter format: คืน false เพื่อ "ทิ้ง" บรรทัดนี้ก่อนถึง printf (เฉพาะ console)
// ต้องวางก่อน printf ใน combine — winston จะข้าม log ที่ format คืน falsy
const consoleQuietFilter = winston.format((info) => {
  if (
    !consoleVerbose &&
    info.level !== "warn" &&
    info.level !== "error" &&
    typeof info.message === "string" &&
    CONSOLE_QUIET_PATTERNS.some((re) => re.test(info.message))
  ) {
    return false;
  }
  return info;
});

const consoleFormat = winston.format.combine(
  consoleQuietFilter(),
  winston.format.timestamp({ format: "HH:mm:ss" }),
  winston.format.printf(({ timestamp, level, message, ...meta }) => {
    // Aligns log levels (e.g. INFO, WARN, ERROR)
    const paddedLevel = level.toUpperCase().padEnd(5);
    const colorizer = winston.format.colorize();
    const colorizedLevel = colorizer.colorize(level, paddedLevel);

    // คง stack trace ของ error ไว้ debug; meta อื่นๆ ตัดออกจาก console (ไฟล์ JSON ยังเก็บครบ)
    const stackStr = meta && meta.stack ? `\n${meta.stack}` : "";

    return `[${timestamp}] [${colorizedLevel}]: ${message}${stackStr}`;
  })
);

// Formatter for files (JSON format)
// timestamp เป็นเวลาท้องถิ่น (ไทย) ให้ตรงกับ console — เดิม default เป็น UTC (ลงท้าย Z) ช้ากว่า 7 ชม.
const fileFormat = winston.format.combine(
  winston.format.timestamp({ format: "YYYY-MM-DD HH:mm:ss.SSS" }),
  winston.format.json()
);

const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || "info",
  transports: [
    // Console transport
    new winston.transports.Console({
      format: consoleFormat,
    }),
    // Rotating info file transport
    new winston.transports.DailyRotateFile({
      dirname: logDirectory,
      filename: "info-%DATE%.log",
      datePattern: "YYYY-MM-DD",
      maxSize: "20m",
      maxFiles: "14d",
      level: "info",
      format: fileFormat,
    }),
    // Rotating error file transport
    new winston.transports.DailyRotateFile({
      dirname: logDirectory,
      filename: "error-%DATE%.log",
      datePattern: "YYYY-MM-DD",
      maxSize: "20m",
      maxFiles: "30d",
      level: "error",
      format: fileFormat,
    }),
  ],
});

module.exports = logger;
