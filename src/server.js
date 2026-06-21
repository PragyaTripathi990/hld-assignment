// HTTP layer. Wires the store, distributed cache and batch writer together and
// exposes the API the UI (and the benchmark) talk to.

const path = require('path');
const express = require('express');

const config = require('./config');
const { Store } = require('./store');
const { DistributedCache, suggestionCacheKey } = require('./cache/distributedCache');
const { BatchWriter } = require('./batchWriter');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

// Assemble the pieces.
const store = new Store();
const cache = new DistributedCache(config.cache);
const batchWriter = new BatchWriter(store, cache);

// Only two ranking modes are valid; anything else falls back to "popular".
function parseRank(rank) {
  return rank === 'recent' ? 'recent' : 'popular';
}

// GET /suggest?q=<prefix>&rank=popular|recent
// The hot read path: cache first, primary store on miss.
app.get('/suggest', (req, res) => {
  const qParam = (req.query.q || '').toString();
  const prefix = qParam.trim().toLowerCase();
  const rank = parseRank(req.query.rank);

  // Empty / missing input -> nothing to suggest. Handled gracefully, no error.
  if (!prefix) {
    return res.json({ prefix: '', rank, cached: false, suggestions: [] });
  }

  const cacheKey = suggestionCacheKey(prefix, rank);
  const now = Date.now();

  const hit = cache.get(cacheKey, now);
  if (hit !== undefined) {
    return res.json({ prefix, rank, cached: true, suggestions: hit });
  }

  const suggestions = store.suggest(prefix, { rank, limit: config.suggestionLimit, now });
  cache.set(cacheKey, suggestions, now);
  res.json({ prefix, rank, cached: false, suggestions });
});

// POST /search  { "query": "iphone 15" }
// Records the search (via the batch writer) and returns the dummy response.
app.post('/search', (req, res) => {
  const query = (req.body && req.body.query ? req.body.query : '').toString().trim();
  if (!query) {
    return res.status(400).json({ error: 'query is required' });
  }

  batchWriter.record(query);
  res.json({ message: 'Searched', query });
});

// GET /trending  -> what's hot right now (recency-ranked)
app.get('/trending', (req, res) => {
  const limit = Math.min(parseInt(req.query.limit, 10) || config.suggestionLimit, 50);
  res.json({ trending: store.trending(limit) });
});

// GET /cache/debug?prefix=<prefix>&rank=popular|recent
// Shows which cache node owns the prefix key and whether it's a hit or miss.
app.get('/cache/debug', (req, res) => {
  const prefix = (req.query.prefix || '').toString().trim().toLowerCase();
  const rank = parseRank(req.query.rank);
  if (!prefix) {
    return res.status(400).json({ error: 'prefix is required' });
  }
  const cacheKey = suggestionCacheKey(prefix, rank);
  res.json(cache.inspect(cacheKey));
});

// GET /stats -> everything we report on: cache hit rate + node spread,
// db read/write counts, and batch write-reduction.
app.get('/stats', (req, res) => {
  res.json({
    store: {
      totalQueries: store.size(),
      dbReads: store.dbReads,
      dbWrites: store.dbWrites,
    },
    cache: cache.stats(),
    batch: batchWriter.stats(),
  });
});

// Manual flush hook -- handy for demos so you don't have to wait for the timer.
app.post('/admin/flush', (req, res) => {
  res.json(batchWriter.flush('manual'));
});

async function start() {
  console.log('Loading dataset...');
  const loaded = await store.load(config.dataFile);
  console.log(`Loaded ${loaded.toLocaleString()} queries into the store.`);

  batchWriter.start();

  app.listen(config.port, () => {
    console.log(`Typeahead server running at http://localhost:${config.port}`);
    console.log(`Cache: ${config.cache.nodeCount} nodes, ${config.cache.virtualNodes} virtual nodes each`);
  });
}

start().catch((err) => {
  console.error('Failed to start:', err.message);
  process.exit(1);
});

// Export for tests / benchmark reuse if needed.
module.exports = { app, store, cache, batchWriter };
