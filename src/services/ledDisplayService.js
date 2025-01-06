const sharp = require("sharp");
const axios = require("axios");

async function createAndSendLedDisplayImage(
  overviewPath,
  conditionImage1,
  laneNo,
  ledServerUrl,
  outputPath,
  led_enabled
) {
  try {
    const totalWidth = 320;
    const totalHeight = 480;
    const topHeight = Math.floor(totalHeight * 0.8); // 384px
    const bottomHeight = totalHeight - topHeight; // 96px

    // Resize the overview image (top 80%)
    const topImageBuffer = await sharp(overviewPath)
      .resize(totalWidth, topHeight)
      .toBuffer();

    // Create the bottom part (white background for 320x96)
    const bottomBackground = sharp({
      create: {
        width: totalWidth,
        height: bottomHeight,
        channels: 3,
        background: { r: 255, g: 255, b: 255 }, // White background
      },
    });

    // Resize condition images and place them on the bottom part
    const condition1Buffer = await sharp(conditionImage1)
      .resize(140, 76)
      .toBuffer();

    const bottomImageBuffer = await bottomBackground
      .composite([
        { input: condition1Buffer, left: 10, top: 10 }, // Condition Image 1
      ])
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
        { input: bottomImageBuffer, top: topHeight, left: 0 },
      ])
      .toBuffer();

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

    // Send the image to the LED server
    try {
      if (led_enabled) {
        const response = await axios.post(ledServerUrl, payload);
        console.log("LED display data sent successfully:", response.data);
      }

      // Save the image locally after a successful POST
      await sharp(finalImageBuffer).toFile(outputPath);
      console.log(`Image successfully saved to ${outputPath}`);
    } catch (postError) {
      console.error("Cannot send LED data to LED server:", postError.message);
    }
  } catch (error) {
    console.error("Error creating or sending LED display image:", error);
  }
}

module.exports = { createAndSendLedDisplayImage };
