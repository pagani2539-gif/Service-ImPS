const fs = require("fs");
const path = require("path");
const schedule = require("node-schedule");
const pool = require("../config/db");
const snapshotsDir = path.join(__dirname, "../../public/snapshots");

// Function to remove a directory and its contents recursively with error handling
const removeDirectoryFast = (dirPath) => {
  try {
    if (fs.existsSync(dirPath)) {
      fs.rmSync(dirPath, { recursive: true, force: true }); // Fast removal
      console.log(`Deleted directory and its contents: ${dirPath}`);
    }
  } catch (err) {
    if (err.code === "EPERM") {
      console.error(`Permission error: Unable to delete ${dirPath}`);
    } else {
      console.error(`Error deleting ${dirPath}:`, err.message);
    }
  }
};

// Function to clean up old subfolders in the snapshots directory
const removeOldFolders = async () => {
  const retentionDays = 3; // เก็บได้นานสุด 3 วัน
  const currentDate = new Date();
  const todayUTC = new Date(Date.UTC(currentDate.getFullYear(), currentDate.getMonth(), currentDate.getDate()));
  const thresholdDate = new Date(todayUTC.getTime() - (retentionDays - 1) * 24 * 60 * 60 * 1000);

  if (fs.existsSync(snapshotsDir)) {
    const types = ["lpr", "overview"];
    for (const type of types) {
      const typeDir = path.join(snapshotsDir, type);
      if (!fs.existsSync(typeDir)) continue;

      fs.readdirSync(typeDir).forEach((yearFolder) => {
        const yearPath = path.join(typeDir, yearFolder);
        if (fs.lstatSync(yearPath).isDirectory()) {
          fs.readdirSync(yearPath).forEach((monthFolder) => {
            const monthPath = path.join(yearPath, monthFolder);
            if (fs.lstatSync(monthPath).isDirectory()) {
              fs.readdirSync(monthPath).forEach((dayFolder) => {
                const dayPath = path.join(monthPath, dayFolder);
                if (fs.lstatSync(dayPath).isDirectory()) {
                  const folderDate = new Date(
                    `${yearFolder}-${monthFolder}-${dayFolder}`
                  );

                  // Check if folder date is older than 3 days
                  if (folderDate && folderDate < thresholdDate) {
                    removeDirectoryFast(dayPath); // Fast folder removal
                  }
                }
              });

              // Remove empty month folder
              if (fs.existsSync(monthPath) && fs.readdirSync(monthPath).length === 0) {
                removeDirectoryFast(monthPath);
              }
            }
          });

          // Remove empty year folder
          if (fs.existsSync(yearPath) && fs.readdirSync(yearPath).length === 0) {
            removeDirectoryFast(yearPath);
          }
        }
      });
    }
    console.log("Snapshots cleanup completed.");
  } else {
    console.error("Snapshots directory does not exist.");
  }

  // Delete records older than 3 days from the snapshots table instead of truncating
  try {
    console.log("Deleting old snapshot records from database...");
    await pool.execute("DELETE FROM snapshots WHERE stamp < ?", [thresholdDate]);
    console.log("Old snapshot records deleted successfully.");
  } catch (err) {
    console.error("Error deleting old snapshot records:", err.message);
  }
};

// Schedule the task to run every midnight
schedule.scheduleJob("0 0 * * *", () => {
  console.log("Running snapshots cleanup...");
  removeOldFolders();
});

module.exports = { removeOldFolders };
