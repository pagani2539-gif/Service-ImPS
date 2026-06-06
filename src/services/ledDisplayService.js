const sharp = require("sharp");
const axios = require("axios");


/**
 * Sends data to the VMS server via a POST request.
 * @param {string} url - The URL to send the POST request to.
 * @param {object} data - The payload to include in the POST request.
 * @returns {Promise<object>} - The response data from the POST request.
 */
async function sendToVMS(url, data) {
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
    console.error("Error in sendToVMS request:", error.message);
    // throw new Error("Failed to send data to VMS");
  }
}


async function createAndSendLedDisplayImage(
  overviewPath,
  conditionImage1,
  laneNo,
  ledServerUrl,
  outputPath,
  led_enabled
) {
  const startTime = Date.now();
  try {
    const totalWidth = 320;
    const totalHeight = 480;
    const topHeight = Math.floor(totalHeight * 0.8); // 384px
    const bottomHeight = totalHeight - topHeight; // 96px
    // Extract only the integer part from laneNo
    // const sanitizedLaneNo = parseInt(laneNo.match(/\d+/)?.[0] || "0", 10);

    console.log("Overview Path:", overviewPath);
    console.log("condithion Path:", conditionImage1);
    // Resize the overview image (top 80%)
    const topImageBuffer = await sharp(overviewPath)
      .resize(totalWidth, topHeight)
      .toBuffer();

    // Resize condition image to fit the bottom part (optional resizing)
    const conditionImageBuffer = await sharp(conditionImage1)
      .resize(totalWidth, bottomHeight)
      .toBuffer();

    // Combine the top and bottom images into a single 320x480 image
    const finalImageBuffer = await sharp({
      create: {
        width: totalWidth,
        height: totalHeight,
        channels: 3,
        background: { r: 0, g: 0, b: 0 }, // Black background
      },
    })
      .composite([
        { input: topImageBuffer, top: 0, left: 0 },
        { input: conditionImageBuffer, top: topHeight, left: 0 },
      ])
      //   .toFile(outputPath);
      .jpeg()
      .toBuffer();

    // Send the image to the LED server
    try {
      if (led_enabled) {
        // Convert the final image buffer to a base64 Data URL
        const imageBase64 = `data:image/jpeg;base64,${finalImageBuffer.toString(
          "base64"
        )}`;
        // Prepare the payload
        const payload = {
          lane: laneNo,
          image: imageBase64,
          holding: 9000, // Display duration in milliseconds
        };
        const response = await axios.post(ledServerUrl, payload);
        console.log("LED display data sent successfully:", response.data);
      }

      // Save the image locally after a successful POST
      await sharp(finalImageBuffer).toFile(outputPath);
    } catch (postError) {
      console.error("Cannot send LED data to LED server:", postError.message);
    }
  } catch (error) {
    console.error("Error creating or sending LED display image:", error);
  } finally {
    console.log(`[PERF] createAndSendLedDisplayImage took ${Date.now() - startTime}ms`);
  }
}

module.exports = { createAndSendLedDisplayImage ,sendToVMS};
