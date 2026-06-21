// Batch writer.
//
// Writing to the store on every single /search request is wasteful: the same
// query is often searched many times in a short window, and each write would
// also force a cache invalidation. Instead we buffer submissions in memory,
// aggregate repeats, and flush them together -- either on a timer or once the
// buffer is large enough.
//
// Aggregation is the big win: 200 searches for "iphone" collapse into one store
// update of +200 rather than 200 separate writes.
//
// Trade-off (worth raising in the viva): the buffer is in memory. If the process
// crashes before a flush, the buffered submissions are lost. That's acceptable
// here -- counts are approximate popularity signals, not money, so losing a few
// seconds of increments breaks nothing. A durable variant would append each
// submission to a write-ahead log first and replay it on restart.

const config = require('./config');
const { suggestionCacheKey } = require('./cache/distributedCache');

// We only cache/invalidate prefixes up to this length. Users rarely type past
// ~15 chars before picking, and bounding it keeps invalidation cheap.
const PREFIX_DEPTH = 15;
const RANKINGS = ['popular', 'recent'];

class BatchWriter {
  constructor(store, cache) {
    this.store = store;
    this.cache = cache;
    this.pending = new Map(); // query -> buffered count

    // Stats that let us prove the write reduction.
    this.submissionsReceived = 0; // every /search call
    this.flushCount = 0;
    this.rowsWritten = 0;         // distinct-query writes actually sent to store
    this.timer = null;
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => this.flush('interval'), config.batch.flushIntervalMs);
    // Don't let this timer keep the process alive by itself.
    if (this.timer.unref) this.timer.unref();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  // Called by POST /search. Records the intent only; the real work happens at
  // flush time. Returns immediately so the request stays fast.
  record(query) {
    query = query.trim().toLowerCase();
    if (!query) return;

    this.submissionsReceived++;
    this.pending.set(query, (this.pending.get(query) || 0) + 1);

    // Size-based flush: don't wait for the timer once we're full.
    if (this.pending.size >= config.batch.maxSize) {
      this.flush('size');
    }
  }

  flush(reason = 'manual') {
    if (this.pending.size === 0) return { flushed: 0, reason };

    const now = Date.now();
    const snapshot = this.pending;
    this.pending = new Map(); // swap in a fresh buffer so new searches keep flowing

    for (const [query, delta] of snapshot) {
      this.store.applySearch(query, delta, now);
      this.evictStalePrefixes(query);
      this.rowsWritten++;
    }

    this.flushCount++;
    return { flushed: snapshot.size, reason };
  }

  // When a query's count changes, any cached suggestion list for one of its
  // prefixes may now be stale, so we drop those keys. They get recomputed (and
  // re-cached) on the next request. This is targeted invalidation -- we don't
  // wipe the whole cache, only the prefixes that could have shifted.
  evictStalePrefixes(query) {
    const depth = Math.min(query.length, PREFIX_DEPTH);
    for (let i = 1; i <= depth; i++) {
      const prefix = query.slice(0, i);
      for (const rank of RANKINGS) {
        this.cache.delete(suggestionCacheKey(prefix, rank));
      }
    }
  }

  stats() {
    const ratio = this.rowsWritten
      ? +(this.submissionsReceived / this.rowsWritten).toFixed(2)
      : 0;
    return {
      submissionsReceived: this.submissionsReceived,
      flushCount: this.flushCount,
      rowsWritten: this.rowsWritten,
      pendingInBuffer: this.pending.size,
      // e.g. 4.0 means we wrote 1 row for every 4 search submissions.
      writeReductionFactor: ratio,
    };
  }
}

module.exports = { BatchWriter };
