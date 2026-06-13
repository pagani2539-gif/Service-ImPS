const axios = require("axios");
const logger = require("../utils/logger");
async function sendToTransmission(url, data) {
  try {
    const response = await axios.post(url, data, {
      timeout: 3000, // Set timeout to 3000ms
      headers: {
        "Content-Type": "application/json", // Optional: Specify content type
      },
    });
    logger.debug("sendToTransmission successful", { response: response.data });
    return response.data;
  } catch (error) {
    logger.error(`Error in sendToTransmission request: ${error.message}`);
    // throw new Error("Failed to send data to VMS");
  }
}

module.exports = {sendToTransmission};