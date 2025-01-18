const fs = require('fs');
const path = require('path');
const schedule = require('node-schedule');

const snapshotsDir = path.join(__dirname, '../../public/snapshots');

// Function to remove a directory and its contents recursively
const removeDirectory = (dirPath) => {
  if (fs.existsSync(dirPath)) {
    fs.readdirSync(dirPath).forEach((file) => {
      const currentPath = path.join(dirPath, file);
      if (fs.lstatSync(currentPath).isDirectory()) {
        // Recursively remove subdirectory
        removeDirectory(currentPath);
      } else {
        // Remove file
        fs.unlinkSync(currentPath);
      }
    });
    // Remove the empty directory
    fs.rmdirSync(dirPath);
    console.log(`Deleted directory: ${dirPath}`);
  }
};

// Function to clean up all subfolders in the snapshots directory
const removeAllSubfolders = () => {
  if (fs.existsSync(snapshotsDir)) {
    fs.readdirSync(snapshotsDir).forEach((folder) => {
      const folderPath = path.join(snapshotsDir, folder);
      if (fs.lstatSync(folderPath).isDirectory()) {
        removeDirectory(folderPath);
      }
    });
    console.log('Snapshots cleanup completed.');
  } else {
    console.error('Snapshots directory does not exist.');
  }
};

// Schedule the task to run every midnight
schedule.scheduleJob('0 0 * * *', () => {
  console.log('Running snapshots cleanup...');
//   removeAllSubfolders();
});

module.exports = { removeAllSubfolders };
