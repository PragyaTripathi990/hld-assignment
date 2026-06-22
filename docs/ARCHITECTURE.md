# Architecture & Design Decisions

This document explains *why* the system is built the way it is. It's written so I
can defend each choice in a viva.

## Components at a glance

| Component | File | Job |
|---|---|---|
| Primary store | `src/store.js` | Source of truth for counts; prefix index |
| Trie | `src/trie.js` | "starts-with" lookup |
| Consistent hash ring | `src/cache/consistentHash.js` | Map a key → owning cache node |
| Distributed cache | `src/cache/distributedCache.js` | N cache nodes with TTL + LRU |
| Batch writer | `src/batchWriter.js` | Buffer + aggregate writes, invalidate cache |
| HTTP server | `src/server.js` | Routes, wiring |

---

## 1. Data storage and the prefix index

**Decision:** keep two structures side by side.

- A `Map<query, { count, recentScore, lastDecayAt }>` — the source of truth.
  O(1) lookups and updates by exact query.
- A **Trie** (prefix tree) — an index of which queries exist, so I can answer
  "what starts with `iph`" without scanning all 120k rows.

**Why a Trie?** Typeahead is fundamentally a prefix problem. A trie lets me walk
straight to the node for a prefix and then collect the queries beneath it. New
queries (from `/search`) insert naturally, character by character, without any
re-sorting.

**Why keep the counts in the Map and not in the trie?** Separation of concerns:
the trie answers *membership* ("does anything start with this?") and the Map
answers *popularity* ("how popular is it?"). On a lookup I collect candidate
queries from the trie, then read their counts from the Map and rank. Keeping
counts out of the trie also means a count update is a single Map write, not a
tree mutation.

**The ranking step.** For a prefix I gather all matching queries, then sort by
score and keep the top 10. For short prefixes (e.g. `a`) the candidate set can be
a few thousand, so sorting is the expensive part — which is exactly why the cache
sits in front of this path (see §3). There's a safety cap (`maxScan`) on how many
candidates a single lookup will gather, so a pathologically broad prefix can't
walk the whole tree.

**Alternative considered:** a sorted array of queries + binary search for the
prefix range. Lower memory than a trie, but inserting a brand-new query means an
O(n) splice or a re-sort. The trie handles inserts cleanly, which matters because
`/search` can introduce new queries.

---

## 2. Consistent hashing

**The problem.** I have several cache nodes and need to decide which node owns a
given prefix key. The naive `hash(key) % nodeCount` breaks the moment the node
count changes: almost every key remaps and the whole cache is effectively
flushed.

**The solution.** Place each node at many points on a circular keyspace (the
"ring"). To find a key's owner, hash the key and walk clockwise to the first node
point. Adding or removing a node only moves the keys in one arc, so the rest stay
put.

**Implementation** (`src/cache/consistentHash.js`):
- Hash with MD5, taking the first 32 bits as an unsigned int. We don't need
  cryptographic strength, just an even spread.
- The ring is a sorted array of `{ hash, node }`. Lookup is a **binary search**
  for the first point ≥ the key's hash (wrapping to index 0 if we fall off the
  end) → O(log R).
- **Virtual nodes:** each logical node is placed at 150 points. With only 4 nodes
  and no replicas, the arcs would be very uneven and one node would hog the keys.
  150 replicas each smooths the distribution — measured spread was ~12/12/8/12
  keys across the 4 nodes (see `docs/PERFORMANCE.md`).

You can see routing live: `GET /cache/debug?prefix=iph` returns the key, its
hash, the owning node, and whether it's currently a hit.

---

## 3. The distributed cache

**Decision:** cache the *result* of a suggestion lookup, keyed by
`rank::prefix`, spread across `cacheNodeCount` (default 4) logical nodes.

Each node (`CacheNode`) is an in-memory `Map` with:
- **TTL** (30s): entries carry an `expiresAt`, checked lazily on read. This is the
  "don't keep stale data forever" requirement — even with no writes, a cached
  list can't live longer than 30s.
- **LRU bound** (`maxEntriesPerNode`): the Map preserves insertion order, so the
  first key is the oldest. On overflow I evict it. Reads re-insert the key to mark
  it most-recently-used.
- Per-node **hit/miss counters** for `/stats`.

**Read path** (`/suggest`): build the key → consistent hashing picks the node →
`get`. On a hit, return immediately. On a miss, read the primary store, `set` the
result back (so the next identical request is a hit), and return. This is why the
cache-hit p95 (~0.29ms) is ~35× faster than the cache-miss path (~10ms).

**Why include the rank mode in the key?** `popular` and `recent` produce
different lists for the same prefix, so they must be cached separately. Both the
read path and the invalidation path build keys through the same
`suggestionCacheKey()` helper so they never disagree.

### Cache invalidation when rankings change

When a query's count changes (on a batch flush), any cached suggestion list for a
**prefix of that query** may now be wrong. So on flush, for each changed query I
delete the cache entries for its prefixes (length 1..15, both rank modes). This is
*targeted* invalidation — I don't wipe the whole cache, only the keys that could
have moved. Anything not explicitly invalidated still expires on its own via TTL.

Trade-off: invalidating per-prefix on every flush costs a handful of `delete`s per
changed query. It's cheap because flushes are batched and counts are aggregated,
so a flush typically touches only a few distinct queries.

---

## 4. Trending (recency-aware ranking) {#trending}

The basic ranking is pure all-time `count`. The enhanced ranking has to let
*recently* popular queries rise without letting a brief spike rank forever. Here's
how the spec's five questions are answered.

**1. How are recent searches tracked?**
Each query record has a `recentScore` and a `lastDecayAt` timestamp. There's no
background job — the score is decayed *lazily* whenever it's read or updated.

**2. How does recent activity affect ranking?**
Enhanced score for a query under a prefix:

```
score = log10(count + 1) + recencyWeight * decayedRecentScore
```

`decayedRecentScore = recentScore * 0.5 ^ (elapsed / halfLife)`.

**Why log the count?** Counts span 1 to 1,000,000. If I added recency to the raw
count, an all-time giant would sit on top forever and recency could never move it.
`log10` compresses popularity into ~0..6, so a burst of recent searches (each
worth `recencyWeight = 3`) can actually compete and reorder items — even lifting a
freshly-searched query above the all-time leaders. The basic mode still uses the
raw count, so the two orderings are clearly different — demo below.

**3. How is permanent over-ranking avoided?**
The recency term **decays exponentially** (5-minute half-life). A query that was
hot an hour ago has had its boost halved ~12 times (≈ negligible), so it drifts
back to its historical rank on its own. Nothing has to actively "demote" it.

**4. How is the cache updated when rankings change?**
Rankings change on a batch flush, and that's exactly when the batch writer
invalidates the affected prefix keys (§3). On top of that, recent-mode entries
expire via the 30s TTL, so even pure time-based drift can't serve a stale order
for long.

**5. Trade-offs (freshness vs latency vs complexity).**
- A short TTL / aggressive invalidation = fresher rankings but more cache misses
  (more store reads). 30s is a middle ground.
- Lazy decay keeps things simple (no scheduler) at the cost of recomputing the
  decay factor on each read — cheap (one `Math.pow`).
- Log-dampening is a deliberately simple, explainable formula. A fancier model
  (e.g. a true sliding-window count per minute) would be more precise but more
  code and more state to maintain.

### Demo: same prefix, two orderings

```
$ curl ".../suggest?q=iphone&rank=popular"
  iphone (1,000,000), iphone 15 (850,000), iphone charger (600,000), iphone 17 (2)

# ...submit "iphone 17" twice, then flush...

$ curl ".../suggest?q=iphone&rank=recent"
  iphone 17 (count 2, recent 2)  <- jumps to #1
  iphone (1,000,000), iphone 15 (850,000), iphone charger (600,000)
```

A query with a count of **2** outranks one with a count of **1,000,000** purely
because it was just searched — that's recency winning. Leave it for a few minutes
and the decay pulls `iphone 17` back down to the bottom on its own, so nothing is
permanently over-ranked. `GET /trending` shows the same recency signal globally,
and in the UI these boosted items carry a "recent" badge in both modes (they only
*move* in Trending mode).

---

## 5. Batch writes {#batch-writes}

**The problem.** Writing to the store on every `/search` is wasteful: the same
query is searched repeatedly, and each write also triggers cache invalidation.

**The design** (`src/batchWriter.js`):
- `/search` just calls `record(query)`, which increments an in-memory
  `Map<query, pendingCount>` and returns immediately — so the request stays fast.
- **Aggregation:** 200 searches for `iphone` become one `+200` update, not 200
  updates. This is the big win.
- **Flush triggers:** either the buffer reaches `maxSize` (50 distinct queries)
  or a 2-second timer fires — whichever comes first.
- On flush, each distinct query is applied to the store once and its prefix cache
  keys are invalidated.

**Measured result:** 1008 submissions collapsed into 7 store writes — a ~144×
reduction (see `docs/PERFORMANCE.md`). `/stats` reports
`submissionsReceived`, `rowsWritten`, and the `writeReductionFactor`.

**Failure trade-off (asked for explicitly).** The buffer lives in memory. If the
process crashes between flushes, the buffered submissions are lost — at most a
couple of seconds of count increments. I accept this because counts here are
approximate popularity signals, not transactions; losing a few is harmless and
self-corrects as searches continue. A durable version would append each
submission to a **write-ahead log** on disk before buffering and replay
un-flushed entries on restart, trading a bit of write latency for durability.

---

## Why these defaults? (`src/config.js`)

| Knob | Value | Reasoning |
|---|---|---|
| `cache.nodeCount` | 4 | Enough to show distribution without noise |
| `cache.virtualNodes` | 150 | Smooth key spread across only 4 nodes |
| `cache.ttlMs` | 30s | Balance freshness vs hit rate |
| `batch.maxSize` | 50 | Flush promptly under load |
| `batch.flushIntervalMs` | 2s | Bound staleness when traffic is light |
| `trending.halfLifeMs` | 5 min | A spike stays relevant for minutes, not forever |
| `trending.recencyWeight` | 3 | a couple of recent searches can top even the all-time leaders |
