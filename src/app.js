// src\app.js
require("dotenv").config();

// Configure Keep-Alive for Axios to prevent HTTPS timeouts and socket exhaustion under high load
const http = require("http");
const https = require("https");
const axios = require("axios");
axios.defaults.httpAgent = new http.Agent({ keepAlive: true });
axios.defaults.httpsAgent = new https.Agent({ keepAlive: true });

// Require cleanup service to start the midnight schedule job
require("./services/snapshotCleanupService");

const DataLogger = require("./controllers/DataLogger");
const InterComp = require("./controllers/InterComp");
const { getConfiguration,checkForConfigUpdates } = require("./services/configurationService");
const {
  getVehicleClasses,
  getSingleTires,
} = require("./services/vehiclesService");
const mapConfigurationKeys = require("./utils/mappers/mapConfigurationKeys");
let currentController = null; // Store the current controller instance

async function initializeController() {
  try {
    // Fetch all configurations
    const configurations = await getConfiguration();
    const vehicleClasses = await getVehicleClasses();
    const singleTires = await getSingleTires();

    const config = mapConfigurationKeys(configurations);
    if (config.controller_id === 1) {
      // console.log(`Initializing DataLogger for station: ${config.station_name}`);
      return new DataLogger(
        config.controller_data_url,
        config.controller_sensor_url,
        60000, // Reconnect interval
        config, // Pass the configuration to the controller
        vehicleClasses,
        singleTires
      );
    } else if (config.controller_id === 2) {
      console.log(`Initializing InterComp for station: ${config.station_name}`);
      return new InterComp(
        config.controller_data_url,
        config.controller_sensor_url,
        60000, // Reconnect interval
        config, // Pass the configuration to the controller
        vehicleClasses,
        singleTires
      );
    } else {
      console.warn(
        `Unknown controller_id: ${config.controller_id} for station: ${config.station_name}`
      );
      return null; // Skip unknown controllers
    }

  } catch (err) {
    console.error("Error initializing controllers:", err);
  }
}

/**
 * Stop the current controller and clean up resources.
 */
async function stopController() {
  if (currentController && typeof currentController.stop === "function") {
    console.log("Stopping the current controller...");
    await currentController.stop();
    currentController = null;
    console.log("Current controller stopped.");
  }
}

/**
 * Monitor configuration changes and restart controllers if necessary.
 */
async function monitorConfiguration() {
  console.log("Starting configuration monitoring...");

  setInterval(async () => {
    try {
      const isUpdated = await checkForConfigUpdates();

      if (isUpdated) {
        console.log("Configuration change detected. Restarting controllers...");

        // Stop the current controller
        await stopController();

        // Initialize a new controller
        currentController = await initializeController();

        if (currentController) {
          console.log("New controller initialized successfully.");
        } else {
          console.warn("No controller initialized. Configuration may be invalid.");
        }
      } else {
        console.log("No configuration changes detected.");
      }
    } catch (err) {
      console.error("Error monitoring configuration updates:", err);
    }
  }, 5000); // Check for updates every 5 seconds
}

/**
 * Main application entry point.
 */
(async () => {
  try {
    console.log("Initializing application...");

    // Initial controller setup
    currentController = await initializeController();

    if (currentController) {
      console.log("Initial controller setup completed successfully.");
    } else {
      console.warn("No valid controller initialized at startup.");
    }

    // Start monitoring configuration updates
    monitorConfiguration();
  } catch (err) {
    console.error("Error during application initialization:", err);
  }
})();
