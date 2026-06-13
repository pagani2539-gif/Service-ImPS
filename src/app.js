// src/app.js
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
const logger = require("./utils/logger");
let currentController = null; // Store the current controller instance

async function initializeController() {
  try {
    // Fetch all configurations (อิสระต่อกัน — ยิงขนานได้)
    const [configurations, vehicleClasses, singleTires] = await Promise.all([
      getConfiguration(),
      getVehicleClasses(),
      getSingleTires(),
    ]);

    const config = mapConfigurationKeys(configurations);

    // Dynamically update perfMonitor log interval and format
    const perf = require("./utils/perfMonitor");
    perf.updateConfig({
      intervalMs: Number(process.env.METRICS_INTERVAL_MS) || config.metrics_interval_ms || 300000,
      format: process.env.METRICS_FORMAT || config.metrics_format || "pretty"
    });

    if (config.controller_id === 1) {
      logger.info(`Initializing DataLogger for station: ${config.station_name}`);
      return new DataLogger(
        config.controller_data_url,
        config.controller_sensor_url,
        60000, // Reconnect interval
        config, // Pass the configuration to the controller
        vehicleClasses,
        singleTires
      );
    } else if (config.controller_id === 2) {
      logger.info(`Initializing InterComp for station: ${config.station_name}`);
      return new InterComp(
        config.controller_data_url,
        config.controller_sensor_url,
        60000, // Reconnect interval
        config, // Pass the configuration to the controller
        vehicleClasses,
        singleTires
      );
    } else {
      logger.warn(`Unknown controller_id: ${config.controller_id} for station: ${config.station_name}`);
      return null; // Skip unknown controllers
    }

  } catch (err) {
    logger.error("Error initializing controllers:", err);
  }
}

/**
 * Stop the current controller and clean up resources.
 */
async function stopController() {
  if (currentController && typeof currentController.stop === "function") {
    logger.info("Stopping the current controller...");
    await currentController.stop();
    currentController = null;
    logger.info("Current controller stopped.");
  }
}

/**
 * Monitor configuration changes and restart controllers if necessary.
 */
async function monitorConfiguration() {
  logger.info("Starting configuration monitoring...");

  setInterval(async () => {
    try {
      const isUpdated = await checkForConfigUpdates();

      if (isUpdated) {
        logger.info("Configuration change detected. Restarting controllers...");

        // Stop the current controller
        await stopController();

        // Initialize a new controller
        currentController = await initializeController();

        if (currentController) {
          logger.info("New controller initialized successfully.");
        } else {
          logger.warn("No controller initialized. Configuration may be invalid.");
        }
      } else {
        logger.debug("No configuration changes detected.");
      }
    } catch (err) {
      logger.error("Error monitoring configuration updates:", err);
    }
  }, 5000); // Check for updates every 5 seconds
}

/**
 * Main application entry point.
 */
(async () => {
  try {
    logger.info("Initializing application...");

    const pool = require("./config/db");
    if (pool.dbInitializedPromise) {
      logger.info("Waiting for database schema checks to complete...");
      await pool.dbInitializedPromise;
      logger.info("Database schema checks completed.");
    }

    // Initial controller setup
    currentController = await initializeController();

    if (currentController) {
      logger.info("Initial controller setup completed successfully.");
    } else {
      logger.warn("No valid controller initialized at startup.");
    }

    // Start monitoring configuration updates
    monitorConfiguration();
  } catch (err) {
    logger.error("Error during application initialization:", err);
  }
})();
