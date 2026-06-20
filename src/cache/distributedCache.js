// A distributed cache built from several logical nodes. Each node is just an
// in-memory Map with TTL and a simple size bound, standing in for something like
// a Redis shard. The consistent hash ring decides which node owns each key, so a
// given prefix always reads/writes the same node ("sticky" routing) and the load
// spreads roughly evenly.
//
// We cache the *result* of a suggestion lookup, keyed by the prefix (plus its
// ranking mode). The suggestion flow checks here first and only falls through to
// the primary store on a miss.

const { ConsistentHashRing } = require('./consistentHash');

class CacheNode {
  constructor(name, { ttlMs, maxEntries }) {
    this.name = name;
    this.ttlMs = ttlMs;
    this.maxEntries = maxEntries;
    this.entries = new Map(); // key -> { value, expiresAt }
    this.hits = 0;
    this.misses = 0;
  }

  get(key, now) {
    const rec = this.entries.get(key);
    if (!rec) {
      this.misses++;
      return undefined;
    }
    if (rec.expiresAt <= now) {
      // Lazy expiry: a stale key is only noticed when someone asks for it.
      this.entries.delete(key);
      this.misses++;
      return undefined;
    }
    // Touch for LRU: re-inserting moves the key to the "newest" end of the Map.
    this.entries.delete(key);
    this.entries.set(key, rec);
    this.hits++;
    return rec.value;
  }

  set(key, value, now) {
    if (this.entries.has(key)) this.entries.delete(key);
    this.entries.set(key, { value, expiresAt: now + this.ttlMs });

    // Evict the oldest entry once over the bound. Map keeps insertion order, so
    // the first key is the least-recently-used one.
    if (this.entries.size > this.maxEntries) {
      const evictKey = this.entries.keys().next().value;
      this.entries.delete(evictKey);
    }
  }

  delete(key) {
    return this.entries.delete(key);
  }

  stats() {
    const total = this.hits + this.misses;
    return {
      node: this.name,
      keys: this.entries.size,
      hits: this.hits,
      misses: this.misses,
      hitRate: total ? +(this.hits / total).toFixed(3) : 0,
    };
  }
}

class DistributedCache {
  constructor({ nodeCount, virtualNodes, ttlMs, maxEntriesPerNode }) {
    this.nodeNames = [];
    this.nodes = new Map(); // name -> CacheNode

    for (let i = 0; i < nodeCount; i++) {
      const id = `cache-node-${i}`;
      this.nodeNames.push(id);
      this.nodes.set(id, new CacheNode(id, { ttlMs, maxEntries: maxEntriesPerNode }));
    }

    this.ring = new ConsistentHashRing(this.nodeNames, virtualNodes);
  }

  shardFor(key) {
    return this.nodes.get(this.ring.getNode(key));
  }

  get(key, now = Date.now()) {
    return this.shardFor(key).get(key, now);
  }

  set(key, value, now = Date.now()) {
    this.shardFor(key).set(key, value, now);
  }

  delete(key) {
    return this.shardFor(key).delete(key);
  }

  // Used by /cache/debug: report routing plus whether the key is cached now.
  inspect(key, now = Date.now()) {
    const node = this.shardFor(key);
    const rec = node.entries.get(key);
    const present = !!rec && rec.expiresAt > now;
    return {
      key,
      ...this.ring.describe(key),
      status: present ? 'hit' : 'miss',
      expiresInMs: present ? rec.expiresAt - now : null,
    };
  }

  stats() {
    const summaries = this.nodeNames.map((n) => this.nodes.get(n).stats());
    const hits = summaries.reduce((sum, n) => sum + n.hits, 0);
    const misses = summaries.reduce((sum, n) => sum + n.misses, 0);
    const total = hits + misses;
    return {
      hits,
      misses,
      hitRate: total ? +(hits / total).toFixed(3) : 0,
      totalKeys: summaries.reduce((sum, n) => sum + n.keys, 0),
      perNode: summaries,
    };
  }
}

// Suggestion cache keys embed the ranking mode, because "popular" and "recent"
// yield different result lists for the same prefix. The read path and the
// invalidation path both build keys here so they always line up.
function suggestionCacheKey(prefix, rank) {
  return `${rank}::${prefix}`;
}

module.exports = { DistributedCache, CacheNode, suggestionCacheKey };
