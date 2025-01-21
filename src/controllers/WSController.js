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


    this.initDataSocket();
    this.initTriggerSocket();
  }

  initDataSocket() {
    this.dataSocket = new WebSocket(this.dataWsUrl);

    this.dataSocket.on("open", () => {
      console.log(new Date(), `${this.constructor.name} Data WebSocket Connected`);
    });

    this.dataSocket.on("error", (err) => {
      console.error(new Date(), `${this.constructor.name} Data WebSocket Error:`, err);
    });

    this.dataSocket.on("message", this.handleDataMessage.bind(this));

    this.dataSocket.on("close", () => {
      console.log(new Date(), `${this.constructor.name} Data WebSocket Closed`);
      if (this.shouldReconnect) {
        setTimeout(() => this.initDataSocket(), this.reconnectInterval);
      }
    });
  }

  initTriggerSocket() {
    this.triggerSocket = new WebSocket(this.triggerWsUrl);

    this.triggerSocket.on("open", () => {
      console.log(new Date(), `${this.constructor.name} Trigger WebSocket Connected`);
    });

    this.triggerSocket.on("error", (err) => {
      console.error(new Date(), `${this.constructor.name} Trigger WebSocket Error:`, err);
    });

    this.triggerSocket.on("message", this.handleTriggerMessage.bind(this));

    this.triggerSocket.on("close", () => {
      console.log(new Date(), `${this.constructor.name} Trigger WebSocket Closed`);
      if (this.shouldReconnect) {
        setTimeout(() => this.initTriggerSocket(), this.reconnectInterval);
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
