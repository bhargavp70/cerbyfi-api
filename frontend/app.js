const API_BASE = "";
const API_KEY  = window.CERBYFI_API_KEY || "";

const state = { lastData: null };

// ── DOM refs ──────────────────────────────────────────────
const form           = document.getElementById("search-form");
const tickerInput    = document.getElementById("ticker-input");
const analyzeBtn     = document.getElementById("analyze-btn");
const errorSection   = document.getElementById("error-section");
const errorMsg       = document.getElementById("error-msg");
const resultsSection = document.getElementById("results-section");
const watchlistBtn   = document.getElementById("watchlist-btn");

// ── Auth state ────────────────────────────────────────────
const auth = { token: null, user: null };
const TOKEN_KEY = "cerbyfi_token";

function apiHeaders(includeJson = false) {
  const h = {};
  if (API_KEY)    h["X-API-Key"]     = API_KEY;
  if (auth.token) h["Authorization"] = `Bearer ${auth.token}`;
  if (includeJson) h["Content-Type"] = "application/json";
  return h;
}

async function initAuth() {
  const token = localStorage.getItem(TOKEN_KEY);
  if (!token) return;
  auth.token = token;
  try {
    const res = await fetch(`${API_BASE}/api/auth/me`, { headers: apiHeaders() });
    if (res.ok) {
      auth.user = await res.json();
      renderAuthState();
      await syncWatchlist();
    } else {
      auth.token = null;
      localStorage.removeItem(TOKEN_KEY);
    }
  } catch { auth.token = null; }
}

function renderAuthState() {
  const el = document.getElementById("header-auth");
  if (auth.user) {
    el.innerHTML = `
      <span class="auth-name">Hi, ${escHtml(auth.user.name)}</span>
      <button class="auth-link" id="btn-signout">Sign out</button>
    `;
    document.getElementById("btn-signout").addEventListener("click", signOut);
  } else {
    el.innerHTML = `
      <button class="auth-link" id="btn-open-login">Sign in</button>
      <button class="auth-link primary" id="btn-open-register">Register</button>
    `;
    document.getElementById("btn-open-login").addEventListener("click", () => openModal("login"));
    document.getElementById("btn-open-register").addEventListener("click", () => openModal("register"));
  }
}

function signOut() {
  auth.token = null;
  auth.user  = null;
  localStorage.removeItem(TOKEN_KEY);
  renderAuthState();
  // Fall back to localStorage watchlist
  cachedWatchlist = loadLocalWatchlist();
  renderWatchlist();
  if (state.lastData) updateWatchlistBtn(state.lastData.ticker);
}

// ── Auth modal ────────────────────────────────────────────
const modal = document.getElementById("auth-modal");

function openModal(tab = "login") {
  modal.style.display = "flex";
  switchModalTab(tab);
}
function closeModal() {
  modal.style.display = "none";
  document.getElementById("login-error").textContent = "";
  document.getElementById("reg-error").textContent   = "";
}

document.getElementById("modal-close").addEventListener("click", closeModal);
modal.addEventListener("click", e => { if (e.target === modal) closeModal(); });
document.getElementById("btn-open-login").addEventListener("click", () => openModal("login"));
document.getElementById("btn-open-register").addEventListener("click", () => openModal("register"));

document.getElementById("tab-login").addEventListener("click", () => switchModalTab("login"));
document.getElementById("tab-register").addEventListener("click", () => switchModalTab("register"));

function switchModalTab(tab) {
  const isLogin = tab === "login";
  document.getElementById("login-form").style.display    = isLogin ? "" : "none";
  document.getElementById("register-form").style.display = isLogin ? "none" : "";
  document.getElementById("tab-login").classList.toggle("active", isLogin);
  document.getElementById("tab-register").classList.toggle("active", !isLogin);
}

document.getElementById("login-form").addEventListener("submit", async e => {
  e.preventDefault();
  const errEl  = document.getElementById("login-error");
  const submit = document.getElementById("login-submit");
  submit.disabled = true;
  errEl.textContent = "";
  try {
    const res = await fetch(`${API_BASE}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email:    document.getElementById("login-email").value,
        password: document.getElementById("login-password").value,
      }),
    });
    const data = await res.json();
    if (!res.ok) { errEl.textContent = data.detail || "Login failed."; return; }
    auth.token = data.token;
    auth.user  = data.user;
    localStorage.setItem(TOKEN_KEY, data.token);
    closeModal();
    renderAuthState();
    await syncWatchlist();
    if (state.lastData) updateWatchlistBtn(state.lastData.ticker);
  } catch { errEl.textContent = "Could not reach server."; }
  finally  { submit.disabled = false; }
});

document.getElementById("register-form").addEventListener("submit", async e => {
  e.preventDefault();
  const errEl  = document.getElementById("reg-error");
  const submit = document.getElementById("reg-submit");
  submit.disabled = true;
  errEl.textContent = "";
  try {
    const res = await fetch(`${API_BASE}/api/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name:     document.getElementById("reg-name").value,
        email:    document.getElementById("reg-email").value,
        password: document.getElementById("reg-password").value,
      }),
    });
    const data = await res.json();
    if (!res.ok) { errEl.textContent = data.detail || "Registration failed."; return; }
    auth.token = data.token;
    auth.user  = data.user;
    localStorage.setItem(TOKEN_KEY, data.token);
    closeModal();
    renderAuthState();
    await syncWatchlist();
    if (state.lastData) updateWatchlistBtn(state.lastData.ticker);
  } catch { errEl.textContent = "Could not reach server."; }
  finally  { submit.disabled = false; }
});

// ── Watchlist (server when logged in, localStorage otherwise) ──
const WL_KEY = "cerbyfi_watchlist";
let cachedWatchlist = [];

function loadLocalWatchlist() {
  try { return JSON.parse(localStorage.getItem(WL_KEY) || "[]"); }
  catch { return []; }
}
function saveLocalWatchlist(list) {
  localStorage.setItem(WL_KEY, JSON.stringify(list.slice(0, 10)));
}

async function syncWatchlist() {
  if (auth.token) {
    try {
      const res = await fetch(`${API_BASE}/api/me/watchlist`, { headers: apiHeaders() });
      if (res.ok) cachedWatchlist = await res.json();
    } catch { cachedWatchlist = []; }
  } else {
    cachedWatchlist = loadLocalWatchlist();
  }
  renderWatchlist();
}

function isInWatchlist(ticker) {
  return cachedWatchlist.some(i => i.ticker === ticker);
}

async function addToWatchlist(ticker, data) {
  const item = {
    ticker,
    mode:      data.type,
    name:      data.name,
    score:     data.total,
    max_score: data.max_total,
    pct:       data.pct,
    stars:     data.stars,
    rating:    data.rating_label,
  };
  if (auth.token) {
    await fetch(`${API_BASE}/api/me/watchlist`, {
      method: "POST",
      headers: apiHeaders(true),
      body: JSON.stringify(item),
    });
    await syncWatchlist();
  } else {
    const list = loadLocalWatchlist().filter(i => i.ticker !== ticker);
    list.unshift({ ...item, saved_at: new Date().toISOString() });
    saveLocalWatchlist(list);
    cachedWatchlist = loadLocalWatchlist();
    renderWatchlist();
  }
  updateWatchlistBtn(ticker);
}

async function removeFromWatchlist(ticker) {
  if (auth.token) {
    await fetch(`${API_BASE}/api/me/watchlist/${ticker}`, {
      method: "DELETE",
      headers: apiHeaders(),
    });
    await syncWatchlist();
  } else {
    saveLocalWatchlist(loadLocalWatchlist().filter(i => i.ticker !== ticker));
    cachedWatchlist = loadLocalWatchlist();
    renderWatchlist();
  }
  updateWatchlistBtn(ticker);
}

function updateWatchlistBtn(ticker) {
  const inList = isInWatchlist(ticker);
  watchlistBtn.textContent = inList ? "✓ In Watchlist" : "+ Watchlist";
  watchlistBtn.className   = "wl-toggle-btn" + (inList ? " in-list" : "");
}

function renderWatchlist() {
  const list    = cachedWatchlist.slice(0, 10);
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
        <span class="wl-card-name" title="${escHtml(item.name || item.ticker)}">${escHtml(item.name || item.ticker)}</span>
        <button class="wl-remove-btn" data-ticker="${item.ticker}" title="Remove">✕</button>
      </div>
      <div class="wl-card-meta">
        <span class="wl-ticker-badge">${item.ticker}</span>
        <span class="wl-type-badge">${item.mode === "fund" ? "ETF" : "Stock"}</span>
        <span class="wl-score-text" style="color:${scoreColor(item.pct)}">${item.score}/${item.max_score}</span>
      </div>
      <div class="wl-bar-track">
        <div class="wl-bar-fill ${barColor(item.pct)}" style="width:${item.pct}%"></div>
      </div>
      <div class="wl-stars">${"★".repeat(item.stars || 0)}${"☆".repeat(5 - (item.stars || 0))}</div>
    `;
    card.querySelector(".wl-remove-btn").addEventListener("click", e => {
      e.stopPropagation();
      removeFromWatchlist(item.ticker);
    });
    card.addEventListener("click", () => {
      tickerInput.value = item.ticker;
      analyze(item.ticker);
    });
    grid.appendChild(card);
  });
}

// ── Form submit ───────────────────────────────────────────
form.addEventListener("submit", async e => {
  e.preventDefault();
  const ticker = tickerInput.value.trim().toUpperCase();
  if (!ticker) return;
  await analyze(ticker);
});

// ── Watchlist button ──────────────────────────────────────
watchlistBtn.addEventListener("click", async () => {
  if (!state.lastData) return;
  const { ticker } = state.lastData;
  if (isInWatchlist(ticker)) {
    await removeFromWatchlist(ticker);
  } else {
    await addToWatchlist(ticker, state.lastData);
  }
});

// ── Clear watchlist ───────────────────────────────────────
document.getElementById("clear-watchlist-btn").addEventListener("click", async () => {
  if (auth.token) {
    // Remove each item individually
    for (const item of [...cachedWatchlist]) {
      await fetch(`${API_BASE}/api/me/watchlist/${item.ticker}`, {
        method: "DELETE", headers: apiHeaders(),
      });
    }
    cachedWatchlist = [];
  } else {
    saveLocalWatchlist([]);
    cachedWatchlist = [];
  }
  renderWatchlist();
  if (state.lastData) updateWatchlistBtn(state.lastData.ticker);
});

// ── Analyze ───────────────────────────────────────────────
async function analyze(ticker) {
  setLoading(true);
  hideAll();
  try {
    const res = await fetch(`${API_BASE}/api/analyze/${ticker}`, { headers: apiHeaders() });
    const data = await res.json();
    if (!res.ok) {
      showError(ticker, data.detail || "Unknown error");
    } else {
      state.lastData = data;
      renderResults(data);
      updateWatchlistBtn(ticker);
      loadTopTickers();
      loadStats();
    }
  } catch {
    showError(ticker, "Could not reach the server. Is it running?");
  } finally {
    setLoading(false);
  }
}

// ── Render results ────────────────────────────────────────
function renderResults(data) {
  document.getElementById("result-name").textContent = data.name;
  document.getElementById("result-ticker").textContent = data.ticker;
  document.getElementById("result-type-badge").textContent =
    data.type === "fund" ? "ETF / Fund" : "Stock";

  if (data.cached) {
    const d = new Date(data.fetched_at);
    document.getElementById("cached-badge").textContent = `Cached · ${d.toLocaleTimeString()}`;
    document.getElementById("cached-badge").style.display = "inline";
  } else {
    document.getElementById("cached-badge").style.display = "none";
  }

  document.getElementById("score-big").textContent  = data.total;
  document.getElementById("score-denom").textContent = `/ ${data.max_total}`;
  document.getElementById("stars-row").textContent   = starsString(data.stars);
  document.getElementById("rating-text").textContent  = data.rating_label;

  const fill = document.getElementById("total-bar-fill");
  fill.style.width = `${data.pct}%`;
  fill.className   = `bar-fill ${barColor(data.pct)}`;

  const grid = document.getElementById("categories-grid");
  grid.innerHTML = "";
  for (const cat of Object.values(data.categories)) {
    grid.appendChild(buildCategoryCard(cat));
  }
  resultsSection.style.display = "block";
}

function buildCategoryCard(cat) {
  const card = document.createElement("div");
  card.className = "category-card";
  card.innerHTML = `
    <div class="category-header">
      <span class="category-label">${cat.label}</span>
      <span class="category-score">${cat.score} / ${cat.max}</span>
    </div>
    <div class="cat-bar-wrap">
      <div class="bar-track">
        <div class="bar-fill ${barColor(cat.pct)}" style="width:${cat.pct}%"></div>
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
    const p = m.max > 0 ? Math.round(m.score / m.max * 100) : 0;
    return `<tr>
      <td>${m.label}</td>
      <td>${m.display}</td>
      <td><span class="mini-score" style="color:${scoreColor(p)}">${m.score}/${m.max}</span></td>
    </tr>`;
  }).join("");
  return `<table class="metrics-table"><tbody>${rows}</tbody></table>`;
}

// ── Analysis counter ──────────────────────────────────────
async function loadStats() {
  try {
    const res = await fetch(`${API_BASE}/api/stats`);
    if (!res.ok) return;
    const data = await res.json();
    const el = document.getElementById("analysis-counter");
    if (data.total_analyses > 0) {
      el.textContent = `${data.total_analyses.toLocaleString()} analyses run`;
    }
  } catch { /* silent */ }
}

// ── Most Searched ─────────────────────────────────────────
async function loadTopTickers() {
  try {
    const res = await fetch(`${API_BASE}/api/top`, { headers: apiHeaders() });
    if (!res.ok) return;
    const data = await res.json();
    renderTopList("top-stocks-list", data.stocks);
    renderTopList("top-funds-list",  data.funds);
    const hasData = data.stocks.length > 0 || data.funds.length > 0;
    document.getElementById("top-section").style.display = hasData ? "block" : "none";
  } catch { /* silent */ }
}

function renderTopList(listId, items) {
  const ul = document.getElementById(listId);
  ul.innerHTML = "";
  if (!items.length) {
    ul.innerHTML = `<li class="top-item"><span class="top-name" style="color:var(--muted)">No data yet</span></li>`;
    return;
  }
  items.forEach((item, i) => {
    const li = document.createElement("li");
    li.className = "top-item";
    li.innerHTML = `
      <span class="top-rank">${i + 1}</span>
      <span class="top-ticker">${item.ticker}</span>
      <span class="top-name">${item.name}</span>
      <span class="top-score" style="color:${scoreColor(item.pct)}">${item.score}/${item.max_score}</span>
      <span class="top-count">${item.count}×</span>
    `;
    li.addEventListener("click", () => {
      tickerInput.value = item.ticker;
      analyze(item.ticker);
    });
    ul.appendChild(li);
  });
}

// ── Helpers ───────────────────────────────────────────────
function starsString(n) { return "★".repeat(n) + "☆".repeat(5 - n); }
function barColor(pct)   { return pct >= 70 ? "green" : pct >= 45 ? "amber" : "red"; }
function scoreColor(pct) {
  return pct >= 70 ? "var(--green)" : pct >= 45 ? "var(--amber)" : "var(--red)";
}
function escHtml(s) {
  return String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;")
                  .replace(/"/g,"&quot;").replace(/'/g,"&#39;");
}
function showError(ticker, msg) {
  errorMsg.textContent = `${ticker}: ${msg}`;
  errorSection.style.display = "block";
}
function hideAll() {
  errorSection.style.display  = "none";
  resultsSection.style.display = "none";
}
function setLoading(bool) {
  analyzeBtn.disabled = bool;
  analyzeBtn.classList.toggle("loading", bool);
  analyzeBtn.textContent = bool ? "Analyzing" : "Analyze";
}

// ── Init ──────────────────────────────────────────────────
initAuth().then(() => {
  if (!auth.user) {
    cachedWatchlist = loadLocalWatchlist();
    renderWatchlist();
  }
});
loadTopTickers();
loadStats();
