/*
 * Generates the search-query dataset (data/queries.csv).
 *
 * The assignment lets us use any dataset with a `query,count` shape, with a
 * minimum of 100k rows. Rather than ship a huge file in git, this script builds
 * a realistic e-commerce / tech flavoured dataset by combining brands, product
 * categories and modifiers. Counts follow a skewed (Zipf-ish) distribution so
 * that short, common queries are far more popular than the long tail -- which
 * is what makes a typeahead demo feel real.
 *
 * If you'd rather use a real open-source dataset (AOL query logs, Wikipedia
 * page titles, Amazon product titles, etc.), just drop a CSV with the same
 * `query,count` header at data/queries.csv and skip this script.
 *
 * Run:  npm run generate-data
 */

const fs = require('fs');
const path = require('path');

const TARGET_ROWS = 120000; // comfortably above the 100k minimum

// Small seeded RNG (mulberry32) so the dataset is reproducible across runs.
function makeRng(seed) {
  return function () {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rng = makeRng(42);

const brands = [
  'apple', 'samsung', 'sony', 'nike', 'adidas', 'dell', 'hp', 'lenovo', 'asus',
  'acer', 'lg', 'bosch', 'canon', 'nikon', 'jbl', 'boat', 'oneplus', 'xiaomi',
  'realme', 'oppo', 'vivo', 'google', 'microsoft', 'intel', 'amd', 'nvidia',
  'logitech', 'razer', 'puma', 'reebok', 'philips', 'panasonic', 'whirlpool',
  'godrej', 'havells', 'titan', 'fossil', 'casio', 'levis', 'zara',
];

const products = [
  'phone', 'laptop', 'headphones', 'earbuds', 'smartwatch', 'tablet', 'tv',
  'camera', 'monitor', 'keyboard', 'mouse', 'speaker', 'charger', 'cable',
  'power bank', 'router', 'printer', 'fridge', 'washing machine', 'microwave',
  'air conditioner', 'fan', 'shoes', 'running shoes', 'backpack', 'watch',
  'sunglasses', 't shirt', 'jeans', 'jacket', 'sneakers', 'trimmer', 'mixer',
  'vacuum cleaner', 'water purifier', 'gaming chair', 'graphics card',
  'ssd', 'hard disk', 'pen drive', 'memory card', 'mic', 'webcam', 'projector',
  'soundbar', 'home theatre', 'kettle', 'toaster', 'iron', 'geyser',
  'smart tv', 'led tv', 'dslr camera', 'action camera', 'gaming laptop',
  'gaming mouse', 'mechanical keyboard', 'desk', 'office chair', 'standing desk',
  'air fryer', 'induction cooktop', 'blender', 'juicer', 'coffee maker',
  'hair dryer', 'electric toothbrush', 'fitness band', 'treadmill', 'dumbbells',
  'yoga mat', 'cricket bat', 'football', 'cycle', 'helmet', 'car charger',
  'phone case', 'screen protector', 'tripod', 'gimbal', 'drone', 'smart bulb',
];

const modifiers = [
  '', 'pro', 'max', 'plus', 'mini', 'ultra', 'lite', '2024', '2025', 'price',
  'review', 'under 10000', 'under 20000', 'under 50000', 'wireless', 'bluetooth',
  'for gaming', 'for students', 'best', 'offer', 'deals', 'black', 'white',
  'blue', 'red', 'with warranty', 'refurbished', 'new', 'latest', 'cheap',
  '5g', '4k', 'hd', 'usb c', 'fast charging', 'noise cancelling', 'waterproof',
  'under 5000', 'under 30000', 'under 100000', 'amazon', 'flipkart', 'online',
  'near me', 'second hand', 'original', 'combo', 'sale', 'discount', 'gold',
  'silver', 'rose gold', 'green', 'pink', 'large', 'small', 'portable',
  'rechargeable', 'foldable', 'premium', 'budget', 'top rated', 'in india',
];

// A few standalone "head" queries that should clearly dominate the rankings.
const headQueries = [
  ['iphone', 1000000], ['iphone 15', 850000], ['iphone charger', 600000],
  ['java tutorial', 400000], ['python tutorial', 380000], ['airpods', 720000],
  ['laptop', 500000], ['samsung galaxy', 450000], ['nike shoes', 300000],
  ['ps5', 280000], ['macbook air', 260000], ['wireless earbuds', 240000],
];

function popularityWeight(index, listLength) {
  // Earlier items in each list are treated as more popular.
  return (listLength - index) / listLength;
}

function buildRows() {
  const seen = new Set();
  const rows = [];

  function add(query, count) {
    query = query.trim().replace(/\s+/g, ' ').toLowerCase();
    if (!query || seen.has(query)) return;
    seen.add(query);
    rows.push([query, Math.max(1, Math.round(count))]);
  }

  for (const [q, c] of headQueries) add(q, c);

  // 1. Standalone products ("laptop", "headphones", ...). These are the generic,
  //    high-traffic queries, so they get the biggest counts. We add these FIRST
  //    so short prefixes like "lap" always surface useful results -- otherwise
  //    the brand combos below would eat the whole budget.
  for (let p = 0; p < products.length; p++) {
    const weight = popularityWeight(p, products.length);
    add(products[p], 450000 * weight * (0.5 + rng() * 0.5));
  }

  // 2. product + modifier ("laptop pro", "headphones wireless", ...). Still
  //    fairly generic, generally popular.
  for (let p = 0; p < products.length; p++) {
    for (let m = 0; m < modifiers.length; m++) {
      const query = [products[p], modifiers[m]].filter(Boolean).join(' ');
      const weight =
        popularityWeight(p, products.length) * popularityWeight(m, modifiers.length);
      add(query, 300000 * weight * (0.3 + rng() * 0.7));
    }
  }

  // 3. brand + product + optional modifier ("apple laptop pro", ...). This is the
  //    long tail; it fills the rest of the dataset up to the target size.
  outer: for (let b = 0; b < brands.length; b++) {
    for (let p = 0; p < products.length; p++) {
      for (let m = 0; m < modifiers.length; m++) {
        const query = [brands[b], products[p], modifiers[m]].filter(Boolean).join(' ');
        const weight =
          popularityWeight(b, brands.length) *
          popularityWeight(p, products.length) *
          popularityWeight(m, modifiers.length);

        // weight^2 widens the gap between popular and long-tail queries.
        add(query, 200000 * Math.pow(weight, 2) * (0.3 + rng() * 0.7));

        if (rows.length >= TARGET_ROWS) break outer;
      }
    }
  }

  return rows;
}

function main() {
  console.log('Building dataset...');
  const rows = buildRows();

  const dataDir = path.join(__dirname, '..', 'data');
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

  const outFile = path.join(dataDir, 'queries.csv');
  const stream = fs.createWriteStream(outFile);
  stream.write('query,count\n');
  for (const [query, count] of rows) {
    // queries can contain spaces but never commas here, so plain CSV is fine.
    stream.write(`${query},${count}\n`);
  }
  stream.end();

  stream.on('finish', () => {
    console.log(`Wrote ${rows.length.toLocaleString()} unique queries to ${outFile}`);
  });
}

main();
