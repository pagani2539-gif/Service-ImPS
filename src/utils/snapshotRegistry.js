const dayjs = require("dayjs");
const logger = require("./logger");

/**
 * In-memory registry for recent snapshots.
 * Matches by closest timestamp per lane/type and prevents reuse (wrong vehicle).
 */
class SnapshotRegistry {
  constructor(maxPerLaneType = 200) {
    this.maxPerLaneType = maxPerLaneType;
    /** @type {Map<string, Array<{stamp: number, imageUrl: string}>>} */
    this.pending = new Map();
    /** @type {Set<string>} */
    this.usedKeys = new Set();
    this.lastPrune = Date.now();
    /** @type {Map<string, Set<Function>>} ผู้รอ snapshot ใหม่ราย lane/type */
    this.waiters = new Map();
  }

  _key(lane, type) {
    return `${normalizeLane(lane)}:${type}`;
  }

  _entryKey(lane, type, stamp, imageUrl) {
    return `${this._key(lane, type)}:${dayjs(stamp).valueOf()}:${imageUrl}`;
  }

  register({ lane, type, stamp, imageUrl }) {
    const key = this._key(lane, type);
    const entry = {
      stamp: dayjs(stamp).valueOf(),
      imageUrl,
    };
    const list = this.pending.get(key) || [];
    const last = list.length ? list[list.length - 1] : null;
    list.push(entry);
    // รูปมักมาเรียงตามเวลาอยู่แล้ว — sort เฉพาะเมื่อมาไม่เรียง
    if (last && entry.stamp < last.stamp) {
      list.sort((a, b) => a.stamp - b.stamp);
    }
    if (list.length > this.maxPerLaneType) {
      list.splice(0, list.length - this.maxPerLaneType);
    }
    this.pending.set(key, list);

    this._notifyWaiters(key);

    // Auto-prune stale usedKeys every 1 minute OR when it gets too large
    if (Date.now() - this.lastPrune > 60000 || this.usedKeys.size > 500) {
      this.prune();
    }
  }

  _notifyWaiters(key) {
    const set = this.waiters.get(key);
    if (!set || set.size === 0) return;
    const callbacks = [...set];
    set.clear();
    for (const cb of callbacks) cb();
  }

  /**
   * รอจนมี snapshot ใหม่ของ lane/type นี้ถูก register หรือครบ timeoutMs
   * คืน true เมื่อถูกปลุกจากการ register, false เมื่อหมดเวลา
   */
  waitForRegister(lane, type, timeoutMs) {
    return new Promise((resolve) => {
      const key = this._key(lane, type);
      let set = this.waiters.get(key);
      if (!set) {
        set = new Set();
        this.waiters.set(key, set);
      }
      const onRegister = () => {
        clearTimeout(timer);
        resolve(true);
      };
      const timer = setTimeout(() => {
        set.delete(onRegister);
        resolve(false);
      }, timeoutMs);
      set.add(onRegister);
    });
  }

  /**
   * Remove usedKeys entries older than 5 minutes to prevent memory leak.
   */
  prune() {
    const now = Date.now();
    const expiryMs = 5 * 60 * 1000; // 5 minutes
    const initialSize = this.usedKeys.size;
    
    for (const key of this.usedKeys) {
      const parts = key.split(":");
      const stampVal = Number(parts[2]);
      if (Number.isFinite(stampVal) && (now - stampVal) > expiryMs) {
        this.usedKeys.delete(key);
      }
    }
    this.lastPrune = now;
    if (initialSize > 500) {
        logger.debug(`[Registry] Pruned usedKeys. Size: ${initialSize} -> ${this.usedKeys.size}`);
    }
  }

  isUsed(lane, type, stamp, imageUrl) {
    return this.usedKeys.has(this._entryKey(lane, type, stamp, imageUrl));
  }

  markUsed(lane, type, stamp, imageUrl) {
    this.usedKeys.add(this._entryKey(lane, type, stamp, imageUrl));
    const key = this._key(lane, type);
    const list = this.pending.get(key);
    if (!list) return;
    const stampMs = dayjs(stamp).valueOf();
    const next = list.filter(
      (e) => !(e.stamp === stampMs && e.imageUrl === imageUrl)
    );
    if (next.length) this.pending.set(key, next);
    else this.pending.delete(key);
  }

  /**
   * Claim the unused snapshot closest in time to the vehicle stamp.
   */
  claimClosest(mappedData, type, minimumSearchMs, maximumSearchMs) {
    const lane = normalizeLane(mappedData.lane);
    const target = dayjs(mappedData.stamp).valueOf();
    const min = target - minimumSearchMs;
    const max = target + maximumSearchMs;
    const list = this.pending.get(this._key(lane, type)) || [];

    let best = null;
    let bestDiff = Infinity;

    for (const entry of list) {
      if (entry.stamp < min || entry.stamp > max) continue;
      if (this.isUsed(lane, type, entry.stamp, entry.imageUrl)) continue;
      const diff = Math.abs(entry.stamp - target);
      if (diff < bestDiff) {
        bestDiff = diff;
        best = entry;
      }
    }

    if (!best) return null;

    this.markUsed(lane, type, best.stamp, best.imageUrl);
    return {
      stamp: new Date(best.stamp),
      lane,
      type,
      imageUrl: best.imageUrl,
    };
  }
}

function normalizeLane(lane) {
  const n = Number(lane);
  return Number.isNaN(n) ? lane : n;
}

const snapshotRegistry = new SnapshotRegistry();

module.exports = {
  snapshotRegistry,
  normalizeLane,
};
