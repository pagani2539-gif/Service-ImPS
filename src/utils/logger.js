const winston = require("winston");
require("winston-daily-rotate-file");
const path = require("path");

const logDirectory = path.join(process.cwd(), "logs");

const consoleFormat = winston.format.combine(
  winston.format.timestamp({ format: "YYYY-MM-DD HH:mm:ss.SSS" }),
  winston.format.printf(({ timestamp, level, message, ...meta }) => {
    // Aligns log levels (e.g. INFO, WARN, ERROR)
    const paddedLevel = level.toUpperCase().padEnd(5);
    const colorizer = winston.format.colorize();
    const colorizedLevel = colorizer.colorize(level, paddedLevel);

    const printMeta = { ...meta };
    delete printMeta.metrics; // Exclude structured metrics from console string

    let metaStr = "";
    if (printMeta.stack) {
      // Print stack traces on new lines for easy debugging
      metaStr = `\n${printMeta.stack}`;
    } else if (Object.keys(printMeta).length) {
      metaStr = ` | Meta: ${JSON.stringify(printMeta)}`;
    }

    return `[${timestamp}] [${colorizedLevel}]: ${message}${metaStr}`;
  })
);

// Formatter for files (JSON format)
const fileFormat = winston.format.combine(
  winston.format.timestamp(),
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
