// src\app.js
require("dotenv").config();
const DataLogger = require("./controllers/DataLogger");
const InterComp = require("./controllers/InterComp");
const { getConfiguration } = require("./services/configurationService");
const {
  getVehicleClasses,
  getSingleTires,
} = require("./services/vehiclesService");
const mapConfigurationKeys = require("./utils/mappers/mapConfigurationKeys");

async function initializeControllers() {
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

    console.log("Controllers initialized:", controllers.filter(Boolean));
  } catch (err) {
    console.error("Error initializing controllers:", err);
  }
}

initializeControllers();
