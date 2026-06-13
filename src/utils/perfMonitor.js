// src\utils\perfMonitor.js
// ตัววัด performance แบบเบา (in-memory ล้วน ไม่แตะ DB) สำหรับหา bottleneck และเฝ้า stability
// - count():   นับเหตุการณ์ (received / inserted / dropped_* / error ฯลฯ)
// - observe(): เก็บค่าเวลาเป็น ms (เช่น เวลาประมวลผลต่อคัน, sensor→DB latency)
// - enter()/exit(): วัดจำนวนงานที่ค้างประมวลผลพร้อมกัน (in-flight)
// สรุปลง log ทุก METRICS_INTERVAL_MS (default 5 นาที) พร้อม CPU / memory / event-loop lag
const { monitorEventLoopDelay } = require("perf_hooks");
const logger = require("./logger");

const SUMMARY_INTERVAL_MS = Number(process.env.METRICS_INTERVAL_MS) || 300000;
// จำกัดจำนวน sample ต่อ metric ต่อรอบสรุป — กัน memory โตช่วง traffic หนาแน่น
const MAX_SAMPLES = 500;

class PerfMonitor {
  constructor() {
    /** @type {Map<string, number>} */
    this.counters = new Map();
    /** @type {Map<string, number[]>} */
    this.samples = new Map();
    this.inflight = 0;
    this.inflightPeak = 0;

    this.loopDelay = monitorEventLoopDelay({ resolution: 20 });
    this.loopDelay.enable();
    this.lastCpu = process.cpuUsage();
    this.lastSummary = Date.now();

    this.summaryTimer = setInterval(() => this.logSummary(), SUMMARY_INTERVAL_MS);
    // ไม่ให้ timer ค้ำ process ไว้ตอน shutdown
    if (this.summaryTimer.unref) this.summaryTimer.unref();
  }

  count(name, n = 1) {
    this.counters.set(name, (this.counters.get(name) || 0) + n);
  }

  observe(name, ms) {
    let arr = this.samples.get(name);
    if (!arr) {
      arr = [];
      this.samples.set(name, arr);
    }
    if (arr.length < MAX_SAMPLES) arr.push(ms);
  }

  // เริ่มงานหนึ่งชิ้น (เรียกคู่กับ exit() ใน finally เสมอ)
  enter() {
    this.inflight++;
    if (this.inflight > this.inflightPeak) this.inflightPeak = this.inflight;
  }

  exit() {
    this.inflight = Math.max(0, this.inflight - 1);
  }

  // คืนฟังก์ชันอ่านเวลาที่ผ่านไป (ms) — const t = perf.timer(); ... t()
  timer() {
    const t0 = Date.now();
    return () => Date.now() - t0;
  }

  _stats(arr) {
    if (!arr.length) return null;
    const sorted = [...arr].sort((a, b) => a - b);
    let sum = 0;
    for (const v of sorted) sum += v;
    const pick = (q) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
    return {
      n: sorted.length,
      min: sorted[0],
      avg: Math.round(sum / sorted.length),
      p50: pick(0.5),
      p95: pick(0.95),
      max: sorted[sorted.length - 1],
    };
  }

  logSummary() {
    const now = Date.now();
    const elapsedMs = now - this.lastSummary;

    const cpu = process.cpuUsage(this.lastCpu);
    const cpuPct = ((cpu.user + cpu.system) / 1000 / Math.max(1, elapsedMs)) * 100;
    const mem = process.memoryUsage();

    const counts = {};
    for (const [name, value] of this.counters) counts[name] = value;
    const timings = {};
    for (const [name, arr] of this.samples) timings[name] = this._stats(arr);

    logger.info(
      `[Metrics] interval=${Math.round(elapsedMs / 1000)}s ` +
        `counts=${JSON.stringify(counts)} ` +
        `timings_ms=${JSON.stringify(timings)} ` +
        `inflight=${this.inflight} inflight_peak=${this.inflightPeak} ` +
        `loop_delay_p99_ms=${Math.round(this.loopDelay.percentile(99) / 1e6)} ` +
        `cpu_pct=${cpuPct.toFixed(1)} ` +
        `rss_mb=${Math.round(mem.rss / 1048576)} heap_mb=${Math.round(mem.heapUsed / 1048576)}`
    );

    // เริ่มรอบใหม่
    this.counters.clear();
    this.samples.clear();
    this.inflightPeak = this.inflight;
    this.loopDelay.reset();
    this.lastCpu = process.cpuUsage();
    this.lastSummary = now;
  }
}

module.exports = new PerfMonitor();
