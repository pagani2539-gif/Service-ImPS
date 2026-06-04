// src\controllers\WSController.js
const WebSocket = require("ws");
const { takeSnapshot } = require("../utils/snapshot");

class WSController {
  constructor(dataWsUrl, triggerWsUrl, reconnectInterval = 30000) {
    this.dataWsUrl = dataWsUrl;
    this.triggerWsUrl = triggerWsUrl;
    this.reconnectInterval = reconnectInterval;

    this.dataSocket = null;
    this.triggerSocket = null;
    this.shouldReconnect = true; // ตัวแปรควบคุม reconnect

    // Backoff state variables
    this.dataAttempts = 0;
    this.triggerAttempts = 0;
    this.maxReconnectInterval = 60000; // Max reconnect wait time is 60 seconds

    this.initDataSocket();
    this.initTriggerSocket();
  }

  initDataSocket() {
    this.dataSocket = new WebSocket(this.dataWsUrl);

    this.dataSocket.on("open", () => {
      console.log(new Date(), `${this.constructor.name} Data WebSocket Connected`);
      this.dataAttempts = 0; // Reset attempts on success
    });

    this.dataSocket.on("error", (err) => {
      console.error(new Date(), `${this.constructor.name} Data WebSocket Error:`, err);
    });

    this.dataSocket.on("message", this.handleDataMessage.bind(this));

    this.dataSocket.on("close", () => {
      console.log(new Date(), `${this.constructor.name} Data WebSocket Closed`);
      if (this.shouldReconnect) {
        this.dataAttempts++;
        const initialDelay = 5000; // Start at 5 seconds
        const nextDelay = Math.min(
          initialDelay * Math.pow(2, this.dataAttempts - 1),
          this.reconnectInterval,
          this.maxReconnectInterval
        );
        console.log(`[WS] Reconnecting Data WebSocket in ${(nextDelay / 1000).toFixed(1)}s (Attempt ${this.dataAttempts})`);
        setTimeout(() => this.initDataSocket(), nextDelay);
      }
    });
  }

  initTriggerSocket() {
    this.triggerSocket = new WebSocket(this.triggerWsUrl);

    this.triggerSocket.on("open", () => {
      console.log(new Date(), `${this.constructor.name} Trigger WebSocket Connected`);
      this.triggerAttempts = 0; // Reset attempts on success
    });

    this.triggerSocket.on("error", (err) => {
      console.error(new Date(), `${this.constructor.name} Trigger WebSocket Error:`, err);
    });

    this.triggerSocket.on("message", this.handleTriggerMessage.bind(this));

    this.triggerSocket.on("close", () => {
      console.log(new Date(), `${this.constructor.name} Trigger WebSocket Closed`);
      if (this.shouldReconnect) {
        this.triggerAttempts++;
        const initialDelay = 5000; // Start at 5 seconds
        const nextDelay = Math.min(
          initialDelay * Math.pow(2, this.triggerAttempts - 1),
          this.reconnectInterval,
          this.maxReconnectInterval
        );
        console.log(`[WS] Reconnecting Trigger WebSocket in ${(nextDelay / 1000).toFixed(1)}s (Attempt ${this.triggerAttempts})`);
        setTimeout(() => this.initTriggerSocket(), nextDelay);
      }
    });
  }

  async handleDataMessage(message) {
    throw new Error("handleDataMessage must be implemented in the derived class.");
  }

  async handleTriggerMessage(message) {
    throw new Error("handleTriggerMessage must be implemented in the derived class.");
  }

  async takeSnapshot(url, directory, filePrefix) {
    return takeSnapshot(url, directory, filePrefix);
  }

   // ฟังก์ชันสำหรับปิด WebSocket และป้องกัน reconnect
   closeSockets() {
    this.shouldReconnect = false; // หยุด reconnect
    if (this.dataSocket) {
      this.dataSocket.close();
      this.dataSocket = null;
    }
    if (this.triggerSocket) {
      this.triggerSocket.close();
      this.triggerSocket = null;
    }
  }
}

module.exports = WSController;
