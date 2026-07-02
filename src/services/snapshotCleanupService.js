const fs = require("fs").promises;
const fsSync = require("fs");
const path = require("path");
const schedule = require("node-schedule");
const pool = require("../config/db");
const dayjs = require("dayjs");
const logger = require("../utils/logger");
const snapshotsDir = path.join(__dirname, "../../public/snapshots");

/**
 * Optimized removal of a directory and its contents (Asynchronous)
 */
const removeDirectoryAsync = async (dirPath) => {
  try {
    if (fsSync.existsSync(dirPath)) {
      await fs.rm(dirPath, { recursive: true, force: true });
      logger.info(`[Cleanup] Deleted directory: ${dirPath}`);
    }
  } catch (err) {
    logger.error(`[Cleanup] Error deleting ${dirPath}:`, err.message);
  }
};

/**
 * Clean up snapshots older than retention period (Non-blocking)
 */
const removeOldFolders = async () => {
  // FIXED retention — เก็บภาพสูงสุด 7 วัน ปรับไม่ได้ผ่าน DB/env (ตัด dependency retention_days)
  const retentionDays = 7;

  // Calculate threshold: anything BEFORE 00:00:00.000 of (today - (retentionDays-1))
  // e.g. Today is 22nd. Retention 3 days means keep 22, 21, 20. Delete 19 and older.
  const thresholdDate = dayjs().startOf('day').subtract(retentionDays - 1, 'day');
  const thresholdTimestamp = thresholdDate.toDate();

  logger.info(`[Cleanup] Starting cleanup. Threshold: ${thresholdDate.format('YYYY-MM-DD')} (Retention: ${retentionDays} days)`);

  if (!fsSync.existsSync(snapshotsDir)) {
    logger.error("[Cleanup] Snapshots directory does not exist.");
    return;
  }

  try {
    const types = ["lpr", "crop", "overview"];
    for (const type of types) {
      const typeDir = path.join(snapshotsDir, type);
      if (!fsSync.existsSync(typeDir)) continue;

      const yearFolders = await fs.readdir(typeDir);
      for (const yearFolder of yearFolders) {
        const yearPath = path.join(typeDir, yearFolder);
        const yearStat = await fs.stat(yearPath);
        if (!yearStat.isDirectory()) continue;

        const monthFolders = await fs.readdir(yearPath);
        for (const monthFolder of monthFolders) {
          const monthPath = path.join(yearPath, monthFolder);
          const monthStat = await fs.stat(monthPath);
          if (!monthStat.isDirectory()) continue;

          const dayFolders = await fs.readdir(monthPath);
          for (const dayFolder of dayFolders) {
            const dayPath = path.join(monthPath, dayFolder);
            const dayStat = await fs.stat(dayPath);
            if (!dayStat.isDirectory()) continue;

            // Construct date: YYYY-MM-DD (treated as local time by dayjs)
            const folderDate = dayjs(`${yearFolder}-${monthFolder}-${dayFolder}`, 'YYYY-MM-DD');
            
            if (folderDate.isValid() && folderDate.isBefore(thresholdDate, 'day')) {
              await removeDirectoryAsync(dayPath);
            }
          }

          // Cleanup empty month folders
          const remainingDays = await fs.readdir(monthPath);
          if (remainingDays.length === 0) {
            await removeDirectoryAsync(monthPath);
          }
        }

        // Cleanup empty year folders
        const remainingMonths = await fs.readdir(yearPath);
        if (remainingMonths.length === 0) {
          await removeDirectoryAsync(yearPath);
        }
      }
    }
    logger.info("[Cleanup] Snapshots file cleanup completed.");
  } catch (err) {
    logger.error("[Cleanup] Error during file cleanup loop:", err.message);
  }

  // Database cleanup
  try {
    logger.info("[Cleanup] Deleting old snapshot records from database...");
    const [result] = await pool.execute(
      "DELETE FROM snapshots WHERE stamp < ?", 
      [thresholdTimestamp]
    );
    logger.info(`[Cleanup] Database cleanup completed. Rows deleted: ${result.affectedRows}`);
  } catch (err) {
    logger.error("[Cleanup] Error deleting old snapshot records:", err.message);
  }
};

// Schedule the task to run every day at 04:00 AM
schedule.scheduleJob("0 4 * * *", async () => {
  logger.info(`[Cleanup] Daily task started at ${new Date().toISOString()}`);
  await removeOldFolders();
});

module.exports = { removeOldFolders };
