/*
 * Quick performance harness. Start the server first (npm start), then in another
 * terminal run: npm run benchmark
 *
 * It measures:
 *   1. /suggest latency (p50/p95/p99) for cache-miss vs cache-hit traffic
 *   2. cache hit rate + per-node key spread (from /stats)
 *   3. batch write reduction: how many /search submissions collapse into how
 *      many actual store writes
 *
 * Numbers go straight into docs/PERFORMANCE.md.
 */

const BASE = process.env.BASE || 'http://localhost:3000';

const PREFIXES = [
  'i', 'ip', 'iph', 'ipho', 'a', 'ap', 'app', 'sam', 'lap', 'lapt', 'nik',
  'sho', 'head', 'ear', 'tv', 'cam', 'mon', 'key', 'mou', 'wat', 'pho', 'so',
  'be', 'ch', 'pri', 'rev', 'ble', 'wir', 'gam', 'ssd',
];

function percentile(sorted, p) {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx];
}

async function timeRequest(url) {
  const start = process.hrtime.bigint();
  const res = await fetch(url);
  await res.json();
  const end = process.hrtime.bigint();
  return Number(end - start) / 1e6; // ms
}

async function measureSuggest(label, urls) {
  const timings = [];
  for (const url of urls) {
    timings.push(await timeRequest(url));
  }
  timings.sort((a, b) => a - b);
  console.log(`\n${label} (${urls.length} requests)`);
  console.log(`  p50: ${percentile(timings, 50).toFixed(3)} ms`);
  console.log(`  p95: ${percentile(timings, 95).toFixed(3)} ms`);
  console.log(`  p99: ${percentile(timings, 99).toFixed(3)} ms`);
  console.log(`  max: ${timings[timings.length - 1].toFixed(3)} ms`);
}

async function getStats() {
  const res = await fetch(`${BASE}/stats`);
  return res.json();
}

async function main() {
  // Sanity check the server is up.
  try {
    await fetch(`${BASE}/stats`);
  } catch {
    console.error(`Could not reach ${BASE}. Start the server with "npm start" first.`);
    process.exit(1);
  }

  // --- 1. Cache-MISS heavy: lots of distinct prefixes (first time seen) ---
  // We tack on a throwaway suffix-ish variation by cycling rank to vary keys.
  const missUrls = [];
  for (const p of PREFIXES) {
    missUrls.push(`${BASE}/suggest?q=${encodeURIComponent(p)}&rank=popular`);
    missUrls.push(`${BASE}/suggest?q=${encodeURIComponent(p)}&rank=recent`);
  }
  await measureSuggest('Cache-miss (cold prefixes)', missUrls);

  // --- 2. Cache-HIT heavy: hammer the same prefixes we just warmed ---
  const hitUrls = [];
  for (let i = 0; i < 50; i++) {
    for (const p of PREFIXES) {
      hitUrls.push(`${BASE}/suggest?q=${encodeURIComponent(p)}&rank=popular`);
    }
  }
  await measureSuggest('Cache-hit (warm prefixes)', hitUrls);

  // --- 3. Batch write reduction ---
  // Fire a stream of searches with lots of repeats and see how many writes the
  // store actually does.
  const SEARCHES = 1000;
  const sample = ['iphone', 'iphone 15', 'laptop', 'nike shoes', 'airpods', 'ps5'];
  for (let i = 0; i < SEARCHES; i++) {
    const query = sample[i % sample.length];
    await fetch(`${BASE}/search`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query }),
    });
  }
  // Force a flush so the numbers settle, then read stats.
  await fetch(`${BASE}/admin/flush`, { method: 'POST' });

  const stats = await getStats();
  console.log('\n--- Cache stats ---');
  console.log(`  hit rate: ${(stats.cache.hitRate * 100).toFixed(1)}%`);
  console.log(`  total keys cached: ${stats.cache.totalKeys}`);
  console.log('  per-node key spread:');
  for (const n of stats.cache.perNode) {
    console.log(`    ${n.node}: ${n.keys} keys, ${(n.hitRate * 100).toFixed(1)}% hit rate`);
  }

  console.log('\n--- Store / DB counters ---');
  console.log(`  total queries: ${stats.store.totalQueries.toLocaleString()}`);
  console.log(`  db reads (suggest fell through to store): ${stats.store.dbReads}`);
  console.log(`  db writes (rows touched): ${stats.store.dbWrites}`);

  console.log('\n--- Batch write reduction ---');
  console.log(`  search submissions: ${stats.batch.submissionsReceived}`);
  console.log(`  rows actually written: ${stats.batch.rowsWritten}`);
  console.log(`  flushes: ${stats.batch.flushCount}`);
  console.log(`  write reduction factor: ${stats.batch.writeReductionFactor}x`);

  console.log('\nDone.');
}

main();
