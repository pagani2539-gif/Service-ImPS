// src\utils\perfMonitor.js
// ตัววัด performance แบบเบา (in-memory ล้วน ไม่แตะ DB) สำหรับหา bottleneck และเฝ้า stability
// - count():   นับเหตุการณ์ (received / inserted / dropped_* / error ฯลฯ)
// - observe(): เก็บค่าเวลาเป็น ms (เช่น เวลาประมวลผลต่อคัน, sensor→DB latency)
// - enter()/exit(): วัดจำนวนงานที่ค้างประมวลผลพร้อมกัน (in-flight)
// สรุปลง log ทุก METRICS_INTERVAL_MS (default 5 นาที) พร้อม CPU / memory / event-loop lag
const { monitorEventLoopDelay } = require("perf_hooks");
const logger = require("./logger");

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

    this.summaryIntervalMs = Number(process.env.METRICS_INTERVAL_MS) || 300000;
    this.format = process.env.METRICS_FORMAT || "pretty";

    this.summaryTimer = setInterval(() => this.logSummary(), this.summaryIntervalMs);
    // ไม่ให้ timer ค้ำ process ไว้ตอน shutdown
    if (this.summaryTimer.unref) this.summaryTimer.unref();
  }

  updateConfig({ intervalMs, format }) {
    if (format && format !== this.format) {
      logger.info(`[Metrics] Changing format: ${this.format} -> ${format}`);
      this.format = format;
    }
    
    if (intervalMs && Number(intervalMs) !== this.summaryIntervalMs) {
      const newInterval = Number(intervalMs);
      logger.info(`[Metrics] Changing interval: ${this.summaryIntervalMs}ms -> ${newInterval}ms`);
      this.summaryIntervalMs = newInterval;
      
      clearInterval(this.summaryTimer);
      this.summaryTimer = setInterval(() => this.logSummary(), this.summaryIntervalMs);
      if (this.summaryTimer.unref) this.summaryTimer.unref();
    }
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

  _formatPretty(elapsedMs, counts, timings, cpuPct, mem) {
    const elapsedSec = Math.round(elapsedMs / 1000);
    const lines = [];
    lines.push(`==================== [Metrics Summary - ${elapsedSec}s] ====================`);
    
    // Counts formatting
    lines.push(`📊 Counts:`);
    const countKeys = Object.keys(counts);
    if (countKeys.length === 0) {
      lines.push(`   • No event counts in this interval`);
    } else {
      // Group counts in triplets for compactness and readability
      const countLines = [];
      for (let i = 0; i < countKeys.length; i += 3) {
        const slice = countKeys.slice(i, i + 3).map(k => `${k}: ${counts[k]}`);
        countLines.push(`   • ${slice.join("  |  ")}`);
      }
      lines.push(...countLines);
    }

    // Timings formatting
    lines.push(`⏱️ Timings (ms):`);
    const timingKeys = Object.keys(timings).filter(k => timings[k] !== null);
    if (timingKeys.length === 0) {
      lines.push(`   • No timing samples in this interval`);
    } else {
      // Find the longest timing key name for alignment
      const maxKeyLen = Math.max(...timingKeys.map(k => k.length), 0);
      for (const key of timingKeys) {
        const t = timings[key];
        const paddedKey = key.padEnd(maxKeyLen, ' ');
        lines.push(`   • ${paddedKey} : n=${t.n.toString().padEnd(4)} | min=${t.min.toString().padEnd(4)} | avg=${t.avg.toString().padEnd(4)} | p50=${t.p50.toString().padEnd(4)} | p95=${t.p95.toString().padEnd(4)} | max=${t.max.toString().padEnd(4)}`);
      }
    }

    // System stats formatting
    lines.push(`⚙️ System:`);
    lines.push(`   • CPU: ${cpuPct.toFixed(1)}% | RSS: ${Math.round(mem.rss / 1048576)} MB | Heap: ${Math.round(mem.heapUsed / 1048576)} MB`);
    lines.push(`   • Inflight: ${this.inflight} (Peak: ${this.inflightPeak}) | Loop Delay P99: ${Math.round(this.loopDelay.percentile(99) / 1e6)} ms`);
    lines.push(`==================================================================`);

    return lines.join("\n");
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

    const format = this.format || process.env.METRICS_FORMAT || "pretty";
    let message = "";

    if (format === "compact") {
      message = `[Metrics] interval=${Math.round(elapsedMs / 1000)}s ` +
        `counts=${JSON.stringify(counts)} ` +
        `timings_ms=${JSON.stringify(timings)} ` +
        `inflight=${this.inflight} inflight_peak=${this.inflightPeak} ` +
        `loop_delay_p99_ms=${Math.round(this.loopDelay.percentile(99) / 1e6)} ` +
        `cpu_pct=${cpuPct.toFixed(1)} ` +
        `rss_mb=${Math.round(mem.rss / 1048576)} heap_mb=${Math.round(mem.heapUsed / 1048576)}`;
    } else {
      message = this._formatPretty(elapsedMs, counts, timings, cpuPct, mem);
    }

    logger.info(message, {
      metrics: {
        interval_s: Math.round(elapsedMs / 1000),
        counts,
        timings,
        inflight: this.inflight,
        inflight_peak: this.inflightPeak,
        loop_delay_p99_ms: Math.round(this.loopDelay.percentile(99) / 1e6),
        cpu_pct: Number(cpuPct.toFixed(1)),
        rss_mb: Math.round(mem.rss / 1048576),
        heap_mb: Math.round(mem.heapUsed / 1048576),
      }
    });

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
