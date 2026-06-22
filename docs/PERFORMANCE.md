# Performance Report

All numbers below were produced by `npm run benchmark` against a locally running
server (Node 26, Apple Silicon, 120,000-query dataset). Your absolute numbers
will vary by machine, but the *shape* — cache hits an order of magnitude faster
than misses, very high hit rate, large write reduction — should hold.

## How to reproduce

```bash
npm install
npm run generate-data
npm start            # terminal 1
npm run benchmark    # terminal 2
```

The benchmark drives three things: cold-prefix (cache-miss) latency, warm-prefix
(cache-hit) latency, and a burst of 1000+ searches to measure write reduction. It
then reads `/stats` for the cache/store/batch counters.

---

## 1. Suggestion latency (`/suggest`)

| Traffic | p50 | p95 | p99 | max |
|---|---|---|---|---|
| Cache **miss** (cold prefixes) | 0.374 ms | 10.107 ms | 42.398 ms | 42.398 ms |
| Cache **hit** (warm prefixes)  | 0.136 ms | 0.288 ms | 0.527 ms | 0.912 ms |

**Reading this:** the first time a prefix is requested we pay for the trie walk +
ranking (the cache-miss column). Once cached, repeats are served in well under a
millisecond — a **~35× p95 improvement**. Short prefixes (huge candidate sets)
dominate the cache-miss tail, which is precisely the cost the cache is there to
hide.

---

## 2. Cache hit rate and key distribution

```
hit rate: 96.0%
total keys cached: 44
per-node key spread:
  cache-node-0: 12 keys, 95.7% hit rate
  cache-node-1: 12 keys, 95.6% hit rate
  cache-node-2:  8 keys, 97.3% hit rate
  cache-node-3: 12 keys, 95.4% hit rate
```

- **96% hit rate** on typeahead-style traffic (the same prefixes get typed over
  and over), so the store is read only on the ~4% cold/expired requests.
- **Consistent hashing spreads the keys** roughly evenly across the 4 nodes
  (~12/12/8/12). With 150 virtual nodes per physical node, no single node hot-spots.
  This is the evidence for the consistent-hashing requirement — you can also watch
  individual keys route live with `GET /cache/debug?prefix=...`.

---

## 3. Store read/write counters

```
total queries: 120,000
db reads (suggest fell through to store): 62
db writes (rows touched): 7
```

Out of ~1500 suggestion requests in the run, only **62 reached the primary
store** — the cache absorbed the rest.

---

## 4. Batch write reduction

```
search submissions: 1008
rows actually written: 7
flushes: 2
write reduction factor: 144x
```

1008 `/search` submissions (with heavy repeats, as real search traffic has)
collapsed into just **7 store writes** thanks to aggregation — a **~144×**
reduction. In a real database this is the difference between 1008 row updates and
7. The exact factor depends on how repetitive the traffic is: the more a popular
query is searched within a flush window, the higher the reduction.

---

## Summary

| Metric | Result |
|---|---|
| `/suggest` p95 — cache hit | ~0.29 ms |
| `/suggest` p95 — cache miss | ~10 ms |
| Cache hit rate | ~96% |
| Key spread (4 nodes) | ~12 / 12 / 8 / 12 |
| Store reads avoided by cache | ~96% of requests |
| Batch write reduction | ~144× |
