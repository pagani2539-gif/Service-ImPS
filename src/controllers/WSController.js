// src\controllers\WSController.js
const WebSocket = require("ws");
const logger = require("../utils/logger");

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

    // เก็บ handle ของ reconnect timer ไว้ clear ตอน stop — กัน timer ค้างเปิด socket ใหม่
    // บน controller ที่ถูกปิดแล้ว (ghost controller ประมวลผลซ้ำ + memory leak)
    this.dataReconnectTimer = null;
    this.triggerReconnectTimer = null;

    this.initDataSocket();
    this.initTriggerSocket();
  }

  initDataSocket() {
    if (!this.shouldReconnect) return; // ถูกสั่งปิดไปแล้ว — ห้ามเปิด socket ใหม่
    this.dataSocket = new WebSocket(this.dataWsUrl);

    this.dataSocket.on("open", () => {
      logger.info(`${this.constructor.name} Data WebSocket Connected`);
      this.dataAttempts = 0; // Reset attempts on success
    });

    this.dataSocket.on("error", (err) => {
      logger.error(`${this.constructor.name} Data WebSocket Error: ${err.message}`);
    });

    this.dataSocket.on("message", this.handleDataMessage.bind(this));

    this.dataSocket.on("close", () => {
      logger.warn(`${this.constructor.name} Data WebSocket Closed`);
      if (this.shouldReconnect) {
        this.dataAttempts++;
        const initialDelay = 5000; // Start at 5 seconds
        const nextDelay = Math.min(
          initialDelay * Math.pow(2, this.dataAttempts - 1),
          this.reconnectInterval,
          this.maxReconnectInterval
        );
        logger.info(`[WS] Reconnecting Data WebSocket in ${(nextDelay / 1000).toFixed(1)}s (Attempt ${this.dataAttempts})`);
        this.dataReconnectTimer = setTimeout(() => this.initDataSocket(), nextDelay);
      }
    });
  }

  initTriggerSocket() {
    if (!this.shouldReconnect) return; // ถูกสั่งปิดไปแล้ว — ห้ามเปิด socket ใหม่
    this.triggerSocket = new WebSocket(this.triggerWsUrl);

    this.triggerSocket.on("open", () => {
      logger.info(`${this.constructor.name} Trigger WebSocket Connected`);
      this.triggerAttempts = 0; // Reset attempts on success
    });

    this.triggerSocket.on("error", (err) => {
      logger.error(`${this.constructor.name} Trigger WebSocket Error: ${err.message}`);
    });

    this.triggerSocket.on("message", this.handleTriggerMessage.bind(this));

    this.triggerSocket.on("close", () => {
      logger.warn(`${this.constructor.name} Trigger WebSocket Closed`);
      if (this.shouldReconnect) {
        this.triggerAttempts++;
        const initialDelay = 5000; // Start at 5 seconds
        const nextDelay = Math.min(
          initialDelay * Math.pow(2, this.triggerAttempts - 1),
          this.reconnectInterval,
          this.maxReconnectInterval
        );
        logger.info(`[WS] Reconnecting Trigger WebSocket in ${(nextDelay / 1000).toFixed(1)}s (Attempt ${this.triggerAttempts})`);
        this.triggerReconnectTimer = setTimeout(() => this.initTriggerSocket(), nextDelay);
      }
    });
  }

  async handleDataMessage(message) {
    throw new Error("handleDataMessage must be implemented in the derived class.");
  }

  async handleTriggerMessage(message) {
    throw new Error("handleTriggerMessage must be implemented in the derived class.");
  }

   // ฟังก์ชันสำหรับปิด WebSocket และป้องกัน reconnect
   closeSockets() {
    this.shouldReconnect = false; // หยุด reconnect
    // ยกเลิก reconnect timer ที่ค้างอยู่ — ไม่งั้น timer จะเปิด socket ใหม่หลัง stop (ghost controller)
    clearTimeout(this.dataReconnectTimer);
    clearTimeout(this.triggerReconnectTimer);
    this.dataReconnectTimer = null;
    this.triggerReconnectTimer = null;
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
