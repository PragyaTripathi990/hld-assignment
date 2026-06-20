// Prefix tree (trie) used as the lookup index. It turns a typed prefix into
// "every stored query that begins with it" without rescanning the full dataset
// on each keystroke.
//
// A node tracks only its child links and a flag marking the end of a complete
// query. Counts are not stored here -- they live in the store's Map. Keeping the
// trie about membership alone makes it compact and simple.

class TrieNode {
  constructor() {
    // Null-prototype object acts as a lightweight char -> node lookup.
    this.children = Object.create(null);
    this.isWord = false;
  }
}

class Trie {
  constructor() {
    this.root = new TrieNode();
    this.size = 0;
  }

  insert(term) {
    let cursor = this.root;
    for (const c of term) {
      if (!cursor.children[c]) cursor.children[c] = new TrieNode();
      cursor = cursor.children[c];
    }
    if (!cursor.isWord) {
      cursor.isWord = true;
      this.size++;
    }
  }

  // Descend to the node representing `prefix`, or null when nothing stored
  // starts with it.
  descend(prefix) {
    let cursor = this.root;
    for (const c of prefix) {
      cursor = cursor.children[c];
      if (!cursor) return null;
    }
    return cursor;
  }

  // Gather every complete query beneath `prefix`. The store ranks these by count
  // and trims to the top N, so we must return ALL candidates here -- handing back
  // only the first few encountered would produce a wrong "top by count".
  //
  // `scanCap` is a safety valve only: for an absurdly broad prefix we bail after
  // that many hits rather than traversing the entire tree. Any prefix of one or
  // more characters stays comfortably below it in practice.
  collect(prefix, scanCap = 50000) {
    const origin = this.descend(prefix);
    if (!origin) return [];

    const matches = [];
    const frontier = [[origin, prefix]];

    while (frontier.length && matches.length < scanCap) {
      const [cursor, term] = frontier.pop();
      if (cursor.isWord) matches.push(term);

      for (const c in cursor.children) {
        frontier.push([cursor.children[c], term + c]);
      }
    }
    return matches;
  }
}

module.exports = { Trie, TrieNode };
