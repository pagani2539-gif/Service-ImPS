const axios = require("axios");
async function sendToTransmission(url, data) {
  try {
    const response = await axios.post(url, data, {
      timeout: 3000, // Set timeout to 3000ms
      headers: {
        "Content-Type": "application/json", // Optional: Specify content type
      },
    });
    console.log("POST request successful:", response.data);
    return response.data;
  } catch (error) {
    console.error("Error in sendTotransmission request:", error.message);
    // throw new Error("Failed to send data to VMS");
  }
}

module.exports = {sendToTransmission};