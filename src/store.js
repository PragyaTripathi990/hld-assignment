// The "primary data store". A real system would back this with a database
// (Postgres, DynamoDB, ...); for this assignment it is an in-process structure:
//
//   - a Map  query -> { count, recencyScore, decayedAt }   for O(1) updates
//   - a Trie                                                for prefix lookup
//
// The Map is the source of truth for counts. The Trie is only an index of which
// queries exist, letting us answer "what starts with this prefix" without
// scanning everything. Reads here are what caching tries to AVOID, and writes
// here are what the batch layer tries to COALESCE.

const fs = require('fs');
const readline = require('readline');
const { Trie } = require('./trie');
const config = require('./config');

class Store {
  constructor() {
    this.queryTable = new Map(); // query -> { count, recencyScore, decayedAt }
    this.trie = new Trie();

    // Counters surfaced in /stats so batching/caching can be demonstrated.
    this.dbReads = 0;  // times a suggestion request actually hit this store
    this.dbWrites = 0; // individual query rows written (bumped by batch flush)
  }

  // Decay a query's recency score forward to `now`. There is no background
  // timer; instead the score is decayed lazily whenever it is read or updated.
  // It halves every `halfLifeMs`, which prevents a brief popularity spike from
  // ranking forever.
  currentRecency(entry, now) {
    if (entry.recencyScore === 0) return 0;
    const age = now - entry.decayedAt;
    if (age <= 0) return entry.recencyScore;
    const decayFactor = Math.pow(0.5, age / config.trending.halfLifeMs);
    return entry.recencyScore * decayFactor;
  }

  async load(filePath) {
    if (!fs.existsSync(filePath)) {
      throw new Error(
        `Dataset not found at ${filePath}. Run "npm run generate-data" first.`
      );
    }

    const now = Date.now();
    const reader = readline.createInterface({
      input: fs.createReadStream(filePath),
      crlfDelay: Infinity,
    });

    let headerSeen = false;
    for await (const line of reader) {
      if (!headerSeen) { headerSeen = true; continue; } // skip "query,count"
      if (!line) continue;

      // Split on the LAST comma so queries containing commas still parse.
      const splitAt = line.lastIndexOf(',');
      if (splitAt === -1) continue;
      const query = line.slice(0, splitAt).trim().toLowerCase();
      const count = parseInt(line.slice(splitAt + 1), 10);
      if (!query || Number.isNaN(count)) continue;

      this.queryTable.set(query, { count, recencyScore: 0, decayedAt: now });
      this.trie.insert(query);
    }

    return this.size();
  }

  size() {
    return this.queryTable.size;
  }

  // Apply `delta` searches of `query`. Invoked by the batch writer on flush, not
  // per request. Previously-unseen queries are inserted into the trie.
  applySearch(query, delta, now = Date.now()) {
    query = query.trim().toLowerCase();
    if (!query) return;

    let entry = this.queryTable.get(query);
    if (!entry) {
      // New query: it starts at 0 and the delta below lifts it. Because a
      // submission always contributes at least 1, a fresh query effectively
      // arrives with the initial count.
      entry = { count: 0, recencyScore: 0, decayedAt: now };
      this.queryTable.set(query, entry);
      this.trie.insert(query);
    }

    entry.count += delta;

    // Roll recency forward: decay whatever was there, then add this batch.
    entry.recencyScore = this.currentRecency(entry, now) + delta;
    entry.decayedAt = now;

    this.dbWrites++; // one row touched per distinct query in the batch
  }

  // Core read path. Returns up to `limit` suggestions for `prefix`, ranked by
  // all-time popularity ("popular") or a recency-aware blend ("recent").
  suggest(prefix, { rank = 'popular', limit = config.suggestionLimit, now = Date.now() } = {}) {
    this.dbReads++;

    prefix = prefix.trim().toLowerCase();
    if (!prefix) return [];

    const matches = this.trie.collect(prefix);

    const ranked = matches.map((query) => {
      const entry = this.queryTable.get(query);
      const baseCount = entry.count;
      const recency = this.currentRecency(entry, now);

      let score;
      if (rank === 'recent') {
        // Enhanced ranking: log-dampened popularity + a weighted, decayed
        // recency term.
        //
        // Why log the count? Raw counts span several orders of magnitude
        // (1 .. 1,000,000). Adding recency to the raw count would pin an
        // all-time giant at the top forever, so recency could never move it --
        // exactly the "permanently over-ranked" problem we're told to avoid.
        // log10 squeezes popularity into a narrow range (~0..6) so a burst of
        // recent searches can compete and reorder results. And since the
        // recency term decays, that boost fades on its own.
        score = Math.log10(baseCount + 1) + config.trending.recencyWeight * recency;
      } else {
        score = baseCount; // basic ranking: pure all-time popularity
      }
      // `recent` is included in both modes so the UI can flag freshly-searched
      // items -- in popular mode they hold position, in recent mode they climb.
      return { query, count: baseCount, recent: +recency.toFixed(2), score };
    });

    ranked.sort((a, b) => b.score - a.score);
    return ranked.slice(0, limit);
  }

  // Trending = what's hot *right now*, ranked purely by decayed recency. Queries
  // with no recent activity are skipped so the list isn't padded with stale
  // all-time-popular entries.
  trending(limit = config.suggestionLimit, now = Date.now()) {
    const active = [];
    for (const [query, entry] of this.queryTable) {
      const recency = this.currentRecency(entry, now);
      if (recency > 0.01) active.push({ query, recentScore: recency, count: entry.count });
    }
    active.sort((a, b) => b.recentScore - a.recentScore);
    return active.slice(0, limit);
  }
}

module.exports = { Store };
