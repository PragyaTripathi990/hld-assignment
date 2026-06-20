// Consistent hashing ring.
//
// The problem: with several cache nodes, we must decide which node owns a given
// key (a prefix). The naive `hash(key) % nodeCount` breaks badly -- changing the
// node count remaps *almost every* key and effectively wipes the cache.
//
// Consistent hashing instead lays nodes out on a circular keyspace (the "ring").
// A key belongs to the first node found walking clockwise from the key's hash.
// Adding or removing a node only disturbs the keys in a single arc, so most keys
// stay where they were.
//
// Virtual nodes: each node is placed at many points on the ring (replicas).
// Without them, a handful of nodes carve the ring into very uneven arcs and one
// node ends up owning far more keys than the rest. More replicas -> smoother load.

const crypto = require('crypto');

function hashToInt(str) {
  // md5 -> first 8 hex chars (32 bits) read as an unsigned integer. No
  // cryptographic strength needed here, just a nice even spread.
  const digest = crypto.createHash('md5').update(str).digest('hex').slice(0, 8);
  return parseInt(digest, 16);
}

class ConsistentHashRing {
  constructor(nodes = [], virtualNodes = 150) {
    this.virtualNodes = virtualNodes;
    this.ring = [];        // sorted array of { hash, node }
    this.nodes = new Set();
    for (const node of nodes) this.addNode(node);
  }

  addNode(node) {
    if (this.nodes.has(node)) return;
    this.nodes.add(node);
    for (let i = 0; i < this.virtualNodes; i++) {
      this.ring.push({ hash: hashToInt(`${node}#${i}`), node });
    }
    this.ring.sort((a, b) => a.hash - b.hash);
  }

  removeNode(node) {
    if (!this.nodes.has(node)) return;
    this.nodes.delete(node);
    this.ring = this.ring.filter((point) => point.node !== node);
  }

  // Resolve the owning node for `key`: first ring point clockwise from hash(key).
  getNode(key) {
    if (this.ring.length === 0) return null;
    const target = hashToInt(key);

    // Binary search for the first ring entry whose hash >= target.
    let low = 0;
    let high = this.ring.length - 1;
    let pos = 0;
    if (target > this.ring[high].hash) {
      pos = 0; // wrapped past the end -> back to the first point on the ring
    } else {
      while (low < high) {
        const center = (low + high) >> 1;
        if (this.ring[center].hash >= target) high = center;
        else low = center + 1;
      }
      pos = low;
    }
    return this.ring[pos].node;
  }

  // Helper for /cache/debug: which ring point did the key land on?
  describe(key) {
    return {
      key,
      keyHash: hashToInt(key),
      node: this.getNode(key),
    };
  }
}

module.exports = { ConsistentHashRing, hashToInt };
