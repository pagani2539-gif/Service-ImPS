const axios = require("axios");
const logger = require("../utils/logger");
async function sendToTransmission(url, data) {
  // กัน url ว่าง (TRANSMISSION_URL ไม่ได้ตั้ง → ค่า '' ) — เดิมยิง POST ไป '' ทุกคัน = error noise
  // (เทียบเท่า guard ใน sendToVMS)
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
    logger.info("[Transmit] sendToTransmission successful", { response: response.data });
    return response.data;
  } catch (error) {
    logger.error(`Error in sendToTransmission request: ${error.message}`);
    // throw new Error("Failed to send data to VMS");
  }
}

module.exports = {sendToTransmission};