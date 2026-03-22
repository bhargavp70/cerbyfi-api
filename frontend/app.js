// Relative URL — frontend is served by the same FastAPI server
const API_BASE = "";
// Injected at build time by the server or set here for the web client
const API_KEY  = window.CERBYFI_API_KEY || "";

const state = { mode: "stock", lastData: null };

// ── DOM refs ──────────────────────────────────────────────
const form           = document.getElementById("search-form");
const tickerInput    = document.getElementById("ticker-input");
const analyzeBtn     = document.getElementById("analyze-btn");
const errorSection   = document.getElementById("error-section");
const errorMsg       = document.getElementById("error-msg");
const resultsSection = document.getElementById("results-section");
const watchlistBtn   = document.getElementById("watchlist-btn");

// ── Watchlist persistence ──────────────────────────────────
const WL_KEY = "cerbyfi_watchlist";

function loadWatchlist() {
  try { return JSON.parse(localStorage.getItem(WL_KEY) || "[]"); }
  catch { return []; }
}

function saveWatchlist(list) {
  localStorage.setItem(WL_KEY, JSON.stringify(list));
}

function isInWatchlist(ticker) {
  return loadWatchlist().some(i => i.ticker === ticker);
}

function addToWatchlist(ticker, mode, data) {
  const list = loadWatchlist().filter(i => i.ticker !== ticker);
  list.unshift({
    ticker,
    mode,
    name:   data.name,
    score:  data.total,
    max:    data.max_total,
    pct:    data.pct,
    stars:  data.stars,
    rating: data.rating_label,
    saved_at: new Date().toISOString(),
  });
  saveWatchlist(list);
  renderWatchlist();
  updateWatchlistBtn(ticker);
}

function removeFromWatchlist(ticker) {
  saveWatchlist(loadWatchlist().filter(i => i.ticker !== ticker));
  renderWatchlist();
  updateWatchlistBtn(ticker);
}

function updateWatchlistBtn(ticker) {
  const inList = isInWatchlist(ticker);
  watchlistBtn.textContent = inList ? "✓ In Watchlist" : "+ Watchlist";
  watchlistBtn.className = "wl-toggle-btn" + (inList ? " in-list" : "");
}

function renderWatchlist() {
  const list = loadWatchlist();
  const section = document.getElementById("watchlist-section");
  const grid    = document.getElementById("watchlist-grid");

  if (!list.length) { section.style.display = "none"; return; }

  section.style.display = "block";
  grid.className = "watchlist-grid";
  grid.innerHTML = "";

  list.forEach(item => {
    const card = document.createElement("div");
    card.className = "wl-card";
    card.innerHTML = `
      <div class="wl-card-top">
        <span class="wl-card-name" title="${item.name}">${item.name}</span>
        <button class="wl-remove-btn" data-ticker="${item.ticker}" title="Remove">✕</button>
      </div>
      <div class="wl-card-meta">
        <span class="wl-ticker-badge">${item.ticker}</span>
        <span class="wl-type-badge">${item.mode === "fund" ? "ETF" : "Stock"}</span>
        <span class="wl-score-text" style="color:${scoreColor(item.pct)}">${item.score}/${item.max}</span>
      </div>
      <div class="wl-bar-track">
        <div class="wl-bar-fill ${barColor(item.pct)}" style="width:${item.pct}%"></div>
      </div>
      <div class="wl-stars">${"★".repeat(item.stars)}${"☆".repeat(5 - item.stars)}</div>
    `;

    card.querySelector(".wl-remove-btn").addEventListener("click", (e) => {
      e.stopPropagation();
      removeFromWatchlist(item.ticker);
    });

    card.addEventListener("click", () => {
      state.mode = item.mode;
      document.querySelectorAll(".tab-btn").forEach(b => {
        b.classList.toggle("active", b.dataset.mode === item.mode);
      });
      tickerInput.placeholder = item.mode === "stock"
        ? "e.g. AAPL, NVDA, TSLA" : "e.g. SPY, QQQ, VTI";
      tickerInput.value = item.ticker;
      analyze(item.ticker, item.mode);
    });

    grid.appendChild(card);
  });
}

// ── Tab switching ─────────────────────────────────────────
document.querySelectorAll(".tab-btn").forEach(btn => {
  btn.addEventListener("click", () => {
    state.mode = btn.dataset.mode;
    document.querySelectorAll(".tab-btn").forEach(b => b.classList.remove("active"));
    btn.classList.add("active");
    tickerInput.placeholder = state.mode === "stock"
      ? "e.g. AAPL, NVDA, TSLA"
      : "e.g. SPY, QQQ, VTI";
  });
});

// ── Form submit ───────────────────────────────────────────
form.addEventListener("submit", async (e) => {
  e.preventDefault();
  const ticker = tickerInput.value.trim().toUpperCase();
  if (!ticker) return;
  await analyze(ticker, state.mode);
});

// ── Watchlist button ──────────────────────────────────────
watchlistBtn.addEventListener("click", () => {
  if (!state.lastData) return;
  const { ticker, mode } = state.lastData;
  if (isInWatchlist(ticker)) {
    removeFromWatchlist(ticker);
  } else {
    addToWatchlist(ticker, mode, state.lastData);
  }
});

// ── Clear watchlist ───────────────────────────────────────
document.getElementById("clear-watchlist-btn").addEventListener("click", () => {
  saveWatchlist([]);
  renderWatchlist();
  if (state.lastData) updateWatchlistBtn(state.lastData.ticker);
});

async function analyze(ticker, mode) {
  setLoading(true);
  hideAll();

  try {
    const res = await fetch(`${API_BASE}/api/${mode}/${ticker}`, {
      headers: API_KEY ? { "X-API-Key": API_KEY } : {},
    });
    const data = await res.json();
    if (!res.ok) {
      showError(ticker, data.detail || "Unknown error");
    } else {
      state.lastData = { ...data, mode };
      renderResults(data);
      updateWatchlistBtn(ticker);
    }
  } catch (err) {
    showError(ticker, "Could not reach the server. Is it running?");
  } finally {
    setLoading(false);
  }
}

// ── Render results ────────────────────────────────────────
function renderResults(data) {
  // Header
  document.getElementById("result-name").textContent = data.name;
  document.getElementById("result-ticker").textContent = data.ticker;
  document.getElementById("result-type-badge").textContent =
    data.type === "fund" ? "ETF / Fund" : "Stock";

  if (data.cached) {
    const d = new Date(data.fetched_at);
    document.getElementById("cached-badge").textContent =
      `Cached · ${d.toLocaleTimeString()}`;
    document.getElementById("cached-badge").style.display = "inline";
  } else {
    document.getElementById("cached-badge").style.display = "none";
  }

  document.getElementById("score-big").textContent = data.total;
  document.getElementById("score-denom").textContent = `/ ${data.max_total}`;
  document.getElementById("stars-row").textContent = starsString(data.stars);
  document.getElementById("rating-text").textContent = data.rating_label;

  const fill = document.getElementById("total-bar-fill");
  fill.style.width = `${data.pct}%`;
  fill.className = `bar-fill ${barColor(data.pct)}`;

  // Categories
  const grid = document.getElementById("categories-grid");
  grid.innerHTML = "";
  for (const [key, cat] of Object.entries(data.categories)) {
    grid.appendChild(buildCategoryCard(cat));
  }

  resultsSection.style.display = "block";
}

function buildCategoryCard(cat) {
  const pct = cat.pct;
  const card = document.createElement("div");
  card.className = "category-card";

  card.innerHTML = `
    <div class="category-header">
      <span class="category-label">${cat.label}</span>
      <span class="category-score">${cat.score} / ${cat.max}</span>
    </div>
    <div class="cat-bar-wrap">
      <div class="bar-track">
        <div class="bar-fill ${barColor(pct)}" style="width:${pct}%"></div>
      </div>
    </div>
    <details class="metrics-detail">
      <summary>Show metrics</summary>
      ${buildMetricsTable(cat.metrics)}
    </details>
  `;
  return card;
}

function buildMetricsTable(metrics) {
  const rows = Object.values(metrics).map(m => {
    const metricPct = m.max > 0 ? Math.round(m.score / m.max * 100) : 0;
    return `<tr>
      <td>${m.label}</td>
      <td>${m.display}</td>
      <td><span class="mini-score" style="color:${scoreColor(metricPct)}">${m.score}/${m.max}</span></td>
    </tr>`;
  }).join("");
  return `<table class="metrics-table"><tbody>${rows}</tbody></table>`;
}

// ── Helpers ───────────────────────────────────────────────
function starsString(n) {
  return "★".repeat(n) + "☆".repeat(5 - n);
}

function barColor(pct) {
  if (pct >= 70) return "green";
  if (pct >= 45) return "amber";
  return "red";
}

function scoreColor(pct) {
  if (pct >= 70) return "var(--green)";
  if (pct >= 45) return "var(--amber)";
  return "var(--red)";
}

function showError(ticker, msg) {
  errorMsg.textContent = `${ticker}: ${msg}`;
  errorSection.style.display = "block";
}

function hideAll() {
  errorSection.style.display = "none";
  resultsSection.style.display = "none";
}

function setLoading(bool) {
  analyzeBtn.disabled = bool;
  analyzeBtn.classList.toggle("loading", bool);
  if (bool) analyzeBtn.textContent = "Analyzing";
  else analyzeBtn.textContent = "Analyze";
}

// ── Init ──────────────────────────────────────────────────
renderWatchlist();
