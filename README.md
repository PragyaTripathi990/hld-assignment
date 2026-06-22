<div align="center">

# 🔎 Search Typeahead System

### Type a few letters, get the ten queries people actually search for — instantly.

[![Node.js](https://img.shields.io/badge/Node.js-18%2B-339933?logo=node.js&logoColor=white)](https://nodejs.org)
[![Express](https://img.shields.io/badge/Express-4-000000?logo=express&logoColor=white)](https://expressjs.com)
[![No build step](https://img.shields.io/badge/build-none-blue)](#run-it-in-three-commands)
[![Cache hit rate](https://img.shields.io/badge/cache%20hit%20rate-~96%25-success)](#-performance-measured-locally)
[![p95 latency](https://img.shields.io/badge/p95%20(hit)-~0.29ms-success)](#-performance-measured-locally)

<img src="docs/app-ui.png" alt="Search typeahead UI — live suggestions with popular and trending modes" width="680">

<em>Live suggestions as you type, with <strong>Popular</strong> / <strong>Trending</strong> modes and "recent" badges.</em>

</div>

---

## What this is

A **search-as-you-type backend** of the kind that powers the search bar on Google or
an e-commerce site. Each keystroke sends a prefix to the server, which replies with up
to ten matching queries ranked by how **popular** — or how **currently trending** — they
are. Pressing enter records the query, and that feedback loop quietly reshapes the
rankings everyone else sees.

The UI is intentionally minimal. The real engineering lives in the backend: a prefix
index, a sharded cache, a decay-based trending model, and write batching.

<table>
<tr>
<td>📖 <a href="docs/ARCHITECTURE.md"><b>Architecture</b></a><br><sub>the "why" behind every part</sub></td>
<td>🔌 <a href="docs/API.md"><b>API reference</b></a><br><sub>every endpoint, with examples</sub></td>
<td>📊 <a href="docs/PERFORMANCE.md"><b>Performance</b></a><br><sub>measured numbers + how to reproduce</sub></td>
<td>📄 <a href="docs/PROJECT_REPORT.pdf"><b>Project report</b></a><br><sub>the whole project, one PDF</sub></td>
</tr>
</table>

---

## Run it in three commands

> **Requires Node.js 18 or newer** (built and tested on Node 26).

```bash
npm install            # pulls in express
npm run generate-data  # writes data/queries.csv — 120,000 queries
npm start              # serves http://localhost:3000
```

Open **<http://localhost:3000>** and start typing. To reproduce the numbers in the
performance section, keep the server up and run the benchmark in a second terminal:

```bash
npm run benchmark      # latency · hit-rate · write-reduction harness
```

---

## The four ideas behind it

Everything in this repo exists to support one of these four decisions — each one
defended in detail in [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

| # | Idea | What it buys us |
|:-:|------|-----------------|
| **1** | **Map + Trie storage** | O(1) count lookups *and* fast "starts-with" prefix search |
| **2** | **Consistent-hashing cache** | A 4-node cache that survives node changes without a full flush |
| **3** | **Decay-based trending** | Recently-hot queries surface, then fade — no permanent over-ranking |
| **4** | **Batched writes** | Thousands of searches collapse into a handful of store writes |

---

## How a request moves through the system

**The read path** — `GET /suggest`, served from cache whenever possible:

```
 [ Browser ]                                        [ Cache shards ]
  search box ──q="iph"──▶ build key  "rank::prefix"     node-0
                              │                          node-1
                              ▼                          node-2  ◀── hash(key)
                     consistent-hash ring ──────────────▶ node-3      picks one
                              │
                  ┌───────────┴───────────┐
              HIT │                       │ MISS
                  ▼                       ▼
            return cached         Primary store  (Map: count · recency
            list (<1 ms)          + Trie: prefix → queries) → rank top 10
                                          │
                                          └─▶ write result back into the shard
```

**The write path** — `POST /search`, fast now and persisted later:

```
 record(query) ─▶ in-memory buffer (aggregates duplicates)
                       │
                       │  flush when: 50 distinct queries  OR  every 2 s
                       ▼
                 apply counts to store  ──▶  invalidate affected prefix keys
```

> **In short:** reads hit the cache fast-path and only fall through to the trie on a
> cold or expired key. Writes return instantly and let the batch writer fold the change
> in on the next flush.

---

## Endpoints at a glance

| Method & path | What it does |
|---|---|
| `GET /suggest?q=<prefix>&rank=popular\|recent` | Up to 10 ranked prefix matches |
| `POST /search` `{ "query": "..." }` | Records a search → `{ "message": "Searched" }` |
| `GET /trending` | The queries hot *right now* (recency-ranked) |
| `GET /cache/debug?prefix=<prefix>` | Which node owns a key, and hit/miss status |
| `GET /stats` | Hit rate, node spread, store reads/writes, batch stats |
| `POST /admin/flush` | Flush the write buffer on demand (useful in demos) |

📎 Request/response examples for every endpoint live in [`docs/API.md`](docs/API.md).

---

## Where the data comes from

The brief asks for at least 100,000 queries with counts. Instead of committing a giant
CSV, [`scripts/generate-dataset.js`](scripts/generate-dataset.js) builds **120,000
unique queries** on the fly from brands × products × modifiers (think `apple laptop
pro`, `nike running shoes`). Counts follow a skewed, Zipf-like curve, so a handful of
head queries tower over a long tail — which is what makes the typeahead feel like a real
search box. A seeded RNG keeps the file identical on every machine.

```csv
query,count
iphone,1000000
iphone 15,850000
iphone charger,600000
java tutorial,400000
...
```

> **Prefer a real corpus?** Drop any `query,count` CSV at `data/queries.csv` (AOL query
> logs, Wikipedia titles, Amazon product names, …) and skip the generate step — the
> loader only reads those two columns.

---

## Repository tour

```
src/
  config.js                 every tunable knob, in one place
  server.js                 express app + route wiring
  store.js                  primary store (Map + Trie), ranking, recency decay
  trie.js                   prefix tree for "starts-with" lookups
  batchWriter.js            buffered + aggregated writes, cache invalidation
  cache/
    consistentHash.js       the hash ring — virtual nodes + binary search
    distributedCache.js     N cache nodes, each with TTL + an LRU bound
public/
  index.html, styles.css, app.js    the UI — plain JS, no framework, no build
scripts/
  generate-dataset.js       writes data/queries.csv
  benchmark.js              latency / hit-rate / write-reduction harness
docs/
  ARCHITECTURE.md           the "why" behind every component
  API.md                    full endpoint reference
  PERFORMANCE.md            measured numbers + how to reproduce
  PROJECT_REPORT.pdf        the consolidated report
```

---

## How the rubric maps to the code

<details>
<summary><strong>✅ Core implementation (60)</strong></summary>

<br>

- **Dataset ingestion** — CSV streamed into a Map + Trie ([`src/store.js`](src/store.js)).
- **Live search UI** — debounced suggestions and keyboard navigation ([`public/`](public/)).
- **`GET /suggest`** — ≤10 prefix matches ordered by count.
- **`POST /search`** — replies `"Searched"` and records the query.
- **Count updates** — applied through the batch writer.
- **Distributed cache** — 4 nodes with **consistent hashing** ([`src/cache/`](src/cache/)),
  observable via `GET /cache/debug`.
</details>

<details>
<summary><strong>✅ Trending searches (20)</strong></summary>

<br>

Recency is a per-query score that **decays exponentially** (5-minute half-life). The
enhanced ranking blends *log-dampened popularity + decayed recency*, so a fresh burst
can jump to the top yet fades on its own — no query is stuck at #1 forever. It's the
same `/suggest` endpoint with `?rank=recent`. The formula and the spec's five questions
are answered in [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md#trending).
</details>

<details>
<summary><strong>✅ Batch writes (20)</strong></summary>

<br>

Submissions buffer in memory and **aggregate duplicates** before a single store write,
flushing at 50 distinct queries or every 2 seconds. Measured at a **~144× write
reduction** (1008 submissions → 7 writes). The crash trade-off (in-memory buffer loss)
is discussed in [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md#batch-writes).
</details>

---

## 📊 Performance, measured locally

| Metric | Result |
|---|:--:|
| `/suggest` p95 — cache hit | **~0.29 ms** |
| `/suggest` p95 — cache miss | ~10 ms |
| Cache hit rate (typeahead traffic) | **~96%** |
| Key spread across 4 nodes | ~12 / 12 / 8 / 12 |
| Batch write reduction | **~144×** |

The full breakdown and reproduction steps are in
[`docs/PERFORMANCE.md`](docs/PERFORMANCE.md), and a single-file write-up of the whole
project is in [`docs/PROJECT_REPORT.pdf`](docs/PROJECT_REPORT.pdf).

---

## Known limits (and what I'd build next)

- **In-memory state.** Counts reset on restart and the write buffer isn't durable.
  Production would sit on a database plus a write-ahead log.
- **Simulated network.** The cache "nodes" are in-process objects, not real Redis
  shards — the consistent-hashing logic is genuine, the network hop is not.
- **Cold short prefixes.** A one-letter prefix re-scans a large candidate set on a cache
  miss; that's exactly the slow path the cache exists to absorb.
