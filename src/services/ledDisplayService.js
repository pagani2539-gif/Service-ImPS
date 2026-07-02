const axios = require("axios");
const logger = require("../utils/logger");


/**
 * Sends data to the VMS server via a POST request.
 * @param {string} url - The URL to send the POST request to.
 * @param {object} data - The payload to include in the POST request.
 * @returns {Promise<object>} - The response data from the POST request.
 */
async function sendToVMS(url, data) {
  if (!url || url.trim() === "" || url === "null" || url === "undefined") {
    return;
  }
  try {
    const response = await axios.post(url, data, {
      timeout: 3000, // Set timeout to 3000ms
      headers: {
        "Content-Type": "application/json", // Optional: Specify content type
      },
    });
    logger.info("[LED] sendToVMS successful", { response: response.data });
    return response.data;
  } catch (error) {
    logger.error(`Error in sendToVMS request: ${error.message}`);
    // throw new Error("Failed to send data to VMS");
  }
}

module.exports = { sendToVMS };
