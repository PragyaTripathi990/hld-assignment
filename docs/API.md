# API Reference

Base URL: `http://localhost:3000`

All responses are JSON.

---

## `GET /suggest`

Return up to 10 suggestions whose query starts with the given prefix.

**Query parameters**

| param | required | default | description |
|---|---|---|---|
| `q` | yes | — | the typed prefix (case-insensitive) |
| `rank` | no | `popular` | `popular` (all-time count) or `recent` (recency-aware) |

**Example**

```bash
curl "http://localhost:3000/suggest?q=iph&rank=popular"
```

```json
{
  "prefix": "iph",
  "rank": "popular",
  "cached": false,
  "suggestions": [
    { "query": "iphone", "count": 1000000, "recent": 0, "score": 1000000 },
    { "query": "iphone 15", "count": 850000, "recent": 0, "score": 850000 },
    { "query": "iphone charger", "count": 600000, "recent": 0, "score": 600000 }
  ]
}
```

- `cached` tells you whether this came from the distributed cache or the store.
- `score` is what the result was ranked by (equals `count` in `popular` mode).
- `recent` is the decayed recent-activity score; the UI shows a "recent" badge
  when it's above ~0.5. In `recent` mode these items rise to the top.

**Edge cases (all handled gracefully, no 500s):**
- Missing/empty `q` → `{ "suggestions": [] }`.
- Prefix with no matches → `{ "suggestions": [] }`.
- Mixed case (`IpH`) → normalized to lowercase.

---

## `POST /search`

Record a submitted search and return the dummy response. The query goes into the
batch writer; its effect on rankings appears after the next flush.

**Body**

```json
{ "query": "iphone 15" }
```

**Example**

```bash
curl -X POST http://localhost:3000/search \
  -H "Content-Type: application/json" \
  -d '{"query":"iphone 15"}'
```

```json
{ "message": "Searched", "query": "iphone 15" }
```

- New queries are inserted; existing ones have their count incremented.
- Empty/missing `query` → `400 { "error": "query is required" }`.

---

## `GET /trending`

Currently-hot queries, ranked purely by decayed recent activity. Empty until some
searches have been submitted and flushed.

**Query parameters**

| param | required | default | description |
|---|---|---|---|
| `limit` | no | 10 | how many to return (max 50) |

```bash
curl "http://localhost:3000/trending?limit=5"
```

```json
{
  "trending": [
    { "query": "iphone charger", "recentScore": 7.68, "count": 600008 },
    { "query": "nike shoes", "recentScore": 2.49, "count": 300003 }
  ]
}
```

---

## `GET /cache/debug`

Show how a prefix key is routed and whether it's currently cached. This is the
window into consistent hashing.

**Query parameters**

| param | required | default | description |
|---|---|---|---|
| `prefix` | yes | — | the prefix to inspect |
| `rank` | no | `popular` | which rank-mode key to inspect |

```bash
curl "http://localhost:3000/cache/debug?prefix=iph"
```

```json
{
  "key": "popular::iph",
  "keyHash": 3628440234,
  "node": "cache-node-2",
  "status": "hit",
  "expiresInMs": 29866
}
```

- `node` is the cache node the ring assigned this key to.
- `status` is `hit` if the key is currently cached and unexpired, else `miss`.

---

## `GET /stats`

Everything reported in the performance section: cache hit rate + per-node spread,
store read/write counters, and batch write-reduction.

```bash
curl "http://localhost:3000/stats"
```

```json
{
  "store": { "totalQueries": 120000, "dbReads": 62, "dbWrites": 7 },
  "cache": {
    "hits": 1438, "misses": 60, "hitRate": 0.96, "totalKeys": 44,
    "perNode": [
      { "node": "cache-node-0", "keys": 12, "hits": 359, "misses": 16, "hitRate": 0.957 }
    ]
  },
  "batch": {
    "submissionsReceived": 1008, "flushCount": 2, "rowsWritten": 7,
    "pendingInBuffer": 0, "writeReductionFactor": 144
  }
}
```

---

## `POST /admin/flush`

Force the batch writer to flush immediately. Useful in demos so you don't have to
wait for the 2-second timer before rankings update.

```bash
curl -X POST http://localhost:3000/admin/flush
```

```json
{ "flushed": 3, "reason": "manual" }
```
