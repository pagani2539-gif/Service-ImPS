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
  const currentDate = new Date();

  if (fs.existsSync(snapshotsDir)) {
    fs.readdirSync(snapshotsDir).forEach((yearFolder) => {
      const yearPath = path.join(snapshotsDir, yearFolder);
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

                // Check if folder date is older than current date
                if (folderDate && folderDate < currentDate) {
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
    console.log("Snapshots cleanup completed.");
  } else {
    console.error("Snapshots directory does not exist.");
  }

  // Truncate the snapshot table
  try {
    console.log("Truncating snapshot table...");
    await pool.execute("TRUNCATE TABLE snapshot");
    console.log("Snapshot table truncated successfully.");
  } catch (err) {
    console.error("Error truncating snapshot table:", err.message);
  }
};

// Schedule the task to run every midnight
schedule.scheduleJob("0 0 * * *", () => {
  console.log("Running snapshots cleanup...");
  removeOldFolders();
});

module.exports = { removeOldFolders };
