// src\utils\ocrService.js
const axios = require("axios");
const sharp = require("sharp");
const fs = require("fs-extra");
const path = require("path");

module.exports = {
  /**
   * Sends snapshots to the OCR service after cropping the plate based on positions.
   * Processes the OCR response to extract license plate details and position.
   * @param {Array} snapshots - Array of snapshots to process.
   * @param {string} ocrEndpoint - The OCR service endpoint URL.
   * @returns {Promise<Object>} - Processed OCR results as an object.
   */
  async sendToOCR(snapshot, ocrEndpoint) {
    try {
      const plates = [];
      const fullPath = snapshot.imageUrl;
      const base64Data = await this.loadImageAsBase64(fullPath);

      plates.push({
        plate_path: fullPath,
        base64: base64Data,
      });

      const requestData = JSON.stringify({ plates: plates });

      // Send to OCR service
      const response = await axios({
        method: "POST",
        maxBodyLength: Infinity,
        url: ocrEndpoint,
        headers: {
          "Content-Type": "application/json",
        },
        data: requestData,
        timeout: 5000,
      });

      // console.log("OCR response:", response.data);

      // Process OCR response
      if (response.data.plate) {
        const ocrResult = {
          license_plate: response.data.plate.license_plate,
          province: response.data.plate.province,
          position: response.data.plate.position,
          plate_path: response.data.plate.plate_path,
          crop_path: await this.cropImage(
            response.data.plate.plate_path,
            response.data.plate.position
          ), // Crop the image based on OCR position
        };

        return ocrResult;
      }

      return null;
    } catch (err) {
      console.error("Error sending snapshots to OCR:", err.message);
      return null;
    }
  },

  /**
   * Loads an image as a Base64 string.
   * @param {string} imagePath - The path to the image file.
   * @returns {Promise<string>} - Base64 encoded string of the image.
   */
  async loadImageAsBase64(imagePath) {
    try {
      const buffer = await fs.readFile(imagePath);
      return `data:image/jpeg;base64,${buffer.toString("base64")}`;
      // return buffer.toString("base64");
    } catch (err) {
      console.error("Error loading image as Base64:", err);
      throw err;
    }
  },

  /**
   * Crops an image based on the provided positions.
   * @param {string} imagePath - The path to the image file.
   * @param {Object} position - Object containing `x1`, `y1`, `x2`, `y2`.
   * @returns {Promise<void>}
   */
  async cropImage(imagePath, position) {
    try {
      const { x1, y1, x2, y2 } = position;
      const width = x2 - x1;
      const height = y2 - y1;

      const croppedImagePath = imagePath.replace(".jpg", "_cropped.jpg");
      // Ensure the image file exists
      if (!fs.existsSync(imagePath)) {
        throw new Error(`Image file not found: ${imagePath}`);
      }

      // Perform cropping
      await sharp(imagePath)
        .extract({ left: x1, top: y1, width, height })
        .toFile(croppedImagePath);

      console.log("Cropped image saved to:", croppedImagePath);

      return croppedImagePath;
    } catch (err) {
      console.error("Error cropping image:", err);
      throw err;
    }
  },
};
