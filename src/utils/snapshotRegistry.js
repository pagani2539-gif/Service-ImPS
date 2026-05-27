const dayjs = require("dayjs");

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
    list.push(entry);
    list.sort((a, b) => a.stamp - b.stamp);
    if (list.length > this.maxPerLaneType) {
      list.splice(0, list.length - this.maxPerLaneType);
    }
    this.pending.set(key, list);

    // Auto-prune stale usedKeys every 1 minute OR when it gets too large
    if (Date.now() - this.lastPrune > 60000 || this.usedKeys.size > 500) {
      this.prune();
    }
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
        console.log(`[Registry] Pruned usedKeys. Size: ${initialSize} -> ${this.usedKeys.size}`);
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
