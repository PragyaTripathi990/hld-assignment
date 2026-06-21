// Frontend logic. No framework -- just enough vanilla JS to drive the typeahead,
// submit searches, switch ranking modes, and keep the trending list fresh.

const input = document.getElementById('search-input');
const suggestionsEl = document.getElementById('suggestions');
const searchBtn = document.getElementById('search-btn');
const statusEl = document.getElementById('status');
const resultEl = document.getElementById('result');
const trendingEl = document.getElementById('trending-list');
const modeButtons = document.querySelectorAll('.mode-btn');
const modeHint = document.getElementById('mode-hint');

let suggestions = [];   // current suggestion objects
let activeIndex = -1;   // which suggestion is highlighted for keyboard nav
let debounceTimer = null;

const MODE_HINTS = {
  popular: 'Ranked by all-time popularity (overall search count).',
  recent: 'Recency-aware: recently searched queries are boosted to the top, then decay back down.',
};

function currentRank() {
  return document.querySelector('.mode-btn.active').dataset.rank;
}

function setStatus(message, isError = false) {
  statusEl.textContent = message;
  statusEl.classList.toggle('error', isError);
}

function formatCount(n) {
  return n.toLocaleString();
}

// ---- Suggestions ----

// Debounce so we don't fire a request on every keystroke -- we wait until the
// user pauses briefly. This is the "avoid unnecessary backend calls" bit.
function onInput() {
  clearTimeout(debounceTimer);
  const value = input.value.trim();
  if (!value) {
    hideSuggestions();
    setStatus('');
    return;
  }
  debounceTimer = setTimeout(() => fetchSuggestions(value), 150);
}

async function fetchSuggestions(prefix) {
  setStatus('Searching...');
  try {
    const res = await fetch(
      `/suggest?q=${encodeURIComponent(prefix)}&rank=${currentRank()}`
    );
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();

    // Ignore stale responses if the user has typed more since we asked.
    if (input.value.trim().toLowerCase() !== prefix.toLowerCase()) return;

    suggestions = data.suggestions || [];
    renderSuggestions();
    setStatus(
      suggestions.length
        ? `${suggestions.length} result(s) · ${data.cached ? 'served from cache' : 'computed fresh'}`
        : 'No matches found.'
    );
  } catch (err) {
    hideSuggestions();
    setStatus('Could not load suggestions. Is the server running?', true);
  }
}

function renderSuggestions() {
  if (!suggestions.length) {
    hideSuggestions();
    return;
  }
  activeIndex = -1;
  suggestionsEl.innerHTML = suggestions
    .map((s, i) => {
      // Flag queries that have recent activity. In "popular" mode they stay in
      // place; in "recent" mode they're the ones that climbed -- which makes the
      // difference between the two rankings easy to see.
      const badge = s.recent && s.recent > 0.5 ? '<span class="badge">recent</span>' : '';
      return `
      <li role="option" data-index="${i}">
        <span class="text">${escapeHtml(s.query)}</span>
        ${badge}
        <span class="count">${formatCount(s.count)}</span>
      </li>`;
    })
    .join('');
  suggestionsEl.classList.remove('hidden');

  suggestionsEl.querySelectorAll('li').forEach((li) => {
    li.addEventListener('mousedown', (e) => {
      e.preventDefault(); // keep focus in the input
      selectSuggestion(Number(li.dataset.index));
    });
  });
}

function hideSuggestions() {
  suggestionsEl.classList.add('hidden');
  suggestionsEl.innerHTML = '';
  activeIndex = -1;
}

function highlight(index) {
  const items = suggestionsEl.querySelectorAll('li');
  items.forEach((li) => li.classList.remove('active'));
  if (index >= 0 && index < items.length) {
    items[index].classList.add('active');
    items[index].scrollIntoView({ block: 'nearest' });
  }
}

function selectSuggestion(index) {
  const chosen = suggestions[index];
  if (!chosen) return;
  input.value = chosen.query;
  hideSuggestions();
  submitSearch(chosen.query);
}

// ---- Keyboard navigation ----

function onKeyDown(e) {
  const visible = !suggestionsEl.classList.contains('hidden');

  if (e.key === 'ArrowDown' && visible) {
    e.preventDefault();
    activeIndex = Math.min(activeIndex + 1, suggestions.length - 1);
    highlight(activeIndex);
  } else if (e.key === 'ArrowUp' && visible) {
    e.preventDefault();
    activeIndex = Math.max(activeIndex - 1, 0);
    highlight(activeIndex);
  } else if (e.key === 'Enter') {
    e.preventDefault();
    if (visible && activeIndex >= 0) {
      selectSuggestion(activeIndex);
    } else {
      submitSearch(input.value.trim());
      hideSuggestions();
    }
  } else if (e.key === 'Escape') {
    hideSuggestions();
  }
}

// ---- Search submission ----

async function submitSearch(query) {
  if (!query) return;
  setStatus('Submitting search...');
  resultEl.classList.add('hidden');

  try {
    const res = await fetch('/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();

    resultEl.innerHTML = `
      <div class="label">Server response</div>
      <div>Message: <code>"${escapeHtml(data.message)}"</code></div>
      <div>Recorded query: <code>${escapeHtml(data.query)}</code></div>`;
    resultEl.classList.remove('hidden');
    setStatus('');

    // Give the batch writer a moment to flush, then refresh trending.
    setTimeout(loadTrending, 2200);
  } catch (err) {
    setStatus('Search failed. Is the server running?', true);
  }
}

// ---- Trending ----

async function loadTrending() {
  try {
    const res = await fetch('/trending');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    renderTrending(data.trending || []);
  } catch (err) {
    // Trending is non-critical; stay quiet on failure.
  }
}

function renderTrending(items) {
  if (!items.length) {
    trendingEl.innerHTML =
      '<li class="empty">No trending searches yet — submit a few searches to see them appear.</li>';
    return;
  }
  trendingEl.innerHTML = items
    .map(
      (t) => `
      <li>
        <span class="t-query">${escapeHtml(t.query)}</span>
        <span class="t-score">recent score ${t.recentScore.toFixed(1)}</span>
      </li>`
    )
    .join('');
}

// ---- Helpers ----

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ---- Wire up events ----

input.addEventListener('input', onInput);
input.addEventListener('keydown', onKeyDown);
searchBtn.addEventListener('click', () => {
  submitSearch(input.value.trim());
  hideSuggestions();
});

// Switching ranking mode re-runs the current search so the two orderings can be
// compared side by side.
modeButtons.forEach((btn) =>
  btn.addEventListener('click', () => {
    modeButtons.forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    modeHint.textContent = MODE_HINTS[currentRank()];
    const value = input.value.trim();
    if (value) fetchSuggestions(value);
  })
);

// Close the dropdown when clicking elsewhere.
document.addEventListener('click', (e) => {
  if (!e.target.closest('.search-box')) hideSuggestions();
});

// Initial load + periodic refresh of trending.
loadTrending();
setInterval(loadTrending, 5000);
