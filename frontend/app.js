const API_BASE = "";
const API_KEY  = window.CERBYFI_API_KEY || "";

const state = { lastData: null };

// ── Live price polling ─────────────────────────────────────
let _priceInterval = null;
const PRICE_POLL_MS = 60_000; // refresh every 60 seconds

function isMarketOpen() {
  // US market hours: Monday–Friday, 9:00am–5:00pm Eastern Time
  const now  = new Date();
  const et   = new Date(now.toLocaleString("en-US", { timeZone: "America/New_York" }));
  const day  = et.getDay();   // 0=Sun, 1=Mon … 6=Sat
  const hour = et.getHours();
  const min  = et.getMinutes();
  const mins = hour * 60 + min;
  return day >= 1 && day <= 5 && mins >= 9 * 60 && mins < 17 * 60;
}

async function refreshLivePrice() {
  if (!state.lastData) return;
  const { ticker, type } = state.lastData;
  try {
    const res = await fetch(
      `${API_BASE}/api/price/${ticker}?mode=${type === "fund" ? "fund" : "stock"}`,
      { headers: apiHeaders() }
    );
    if (!res.ok) return;
    const q = await res.json();
    applyPriceDisplay(q);
    // Keep state in sync so cached score still shows correct price
    state.lastData.price           = q.price;
    state.lastData.price_change    = q.price_change;
    state.lastData.price_change_pct = q.price_change_pct;
  } catch { /* silent — stale price is fine */ }
}

function applyPriceDisplay(q) {
  const priceRow = document.getElementById("price-row");
  if (!q || q.price == null) { priceRow.style.display = "none"; return; }
  const sign = (q.price_change ?? 0) >= 0 ? "+" : "";
  const chg  = q.price_change != null ? `${sign}$${Math.abs(q.price_change).toFixed(2)}` : "";
  const pct  = q.price_change_pct != null ? ` (${sign}${q.price_change_pct.toFixed(2)}%)` : "";
  const cls  = (q.price_change ?? 0) >= 0 ? "price-up" : "price-down";
  document.getElementById("price-value").textContent  = `$${q.price.toFixed(2)}`;
  document.getElementById("price-change").textContent = chg + pct;
  document.getElementById("price-change").className   = `price-change ${cls}`;
  priceRow.style.display = "";
}

function startPricePolling() {
  stopPricePolling();
  if (!isMarketOpen()) return;
  refreshLivePrice();  // fetch immediately, don't wait for first interval
  _priceInterval = setInterval(refreshLivePrice, PRICE_POLL_MS);
}

function stopPricePolling() {
  if (_priceInterval) { clearInterval(_priceInterval); _priceInterval = null; }
}

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
    const adminBtn   = auth.user.is_admin   ? `<button class="admin-badge" id="btn-admin">Admin</button>` : "";
    const premiumBadge = auth.user.is_premium ? `<span class="premium-header-badge">✦ Premium</span>` : "";
    el.innerHTML = `
      <span class="auth-name">Hi, ${escHtml(auth.user.name)}</span>
      ${premiumBadge}
      ${adminBtn}
      <a href="/help.html" class="auth-link" style="text-decoration:none;">Help</a>
      <button class="auth-link" id="btn-signout">Sign out</button>
    `;
    if (auth.user.is_admin) {
      document.getElementById("btn-admin").addEventListener("click", openAdminModal);
    }
    document.getElementById("btn-signout").addEventListener("click", signOut);
  } else {
    el.innerHTML = `
      <a href="/help.html" class="auth-link" style="text-decoration:none;">Help</a>
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
  cachedWatchlist = [];
  renderWatchlist();
  if (state.lastData) updateWatchlistBtn(state.lastData.ticker);
  // Hide portfolio section
  portfolioState.list = [];
  portfolioState.activeId = null;
  document.getElementById("portfolio-section").style.display = "none";
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

// ── Admin modal ───────────────────────────────────────────
const adminModal = document.getElementById("admin-modal");
document.getElementById("admin-modal-close").addEventListener("click", () => {
  adminModal.style.display = "none";
});
adminModal.addEventListener("click", e => { if (e.target === adminModal) adminModal.style.display = "none"; });

async function openAdminModal() {
  document.getElementById("admin-user-count").textContent = "…";
  document.getElementById("admin-analyses-count").textContent = "…";
  document.getElementById("admin-user-list").innerHTML = `<div style="color:var(--muted);font-size:0.85rem;padding:8px 0;">Loading…</div>`;
  adminModal.style.display = "flex";
  await refreshAdminModal();
}

async function refreshAdminModal() {
  try {
    const [statsRes, usersRes] = await Promise.all([
      fetch(`${API_BASE}/api/admin/stats`, { headers: apiHeaders() }),
      fetch(`${API_BASE}/api/admin/users`, { headers: apiHeaders() }),
    ]);
    if (statsRes.ok) {
      const data = await statsRes.json();
      document.getElementById("admin-user-count").textContent = data.user_count.toLocaleString();
      document.getElementById("admin-analyses-count").textContent = data.total_analyses.toLocaleString();
      document.getElementById("admin-ai-cache-count").textContent = (data.ai_reports_cached ?? "—").toLocaleString();
    }
    if (usersRes.ok) {
      const users = await usersRes.json();
      renderAdminUserList(users);
    }
  } catch { /* silent */ }
}

function renderAdminUserList(users) {
  const el = document.getElementById("admin-user-list");
  el.innerHTML = "";
  users.forEach(u => {
    const row = document.createElement("div");
    row.className = "admin-user-row";

    const isSelf      = u.id === auth.user?.id;
    const canToggleAdmin   = !u.is_protected && !isSelf;
    const adminBadge   = u.is_admin        ? `<span class="admin-role-badge is-admin">Admin</span>`   : "";
    const premiumBadge = u.is_premium      ? `<span class="admin-role-badge is-premium">Premium</span>` : "";
    const refreshBadge = u.can_refresh_ai  ? `<span class="admin-role-badge is-refresh">Refresh</span>` : "";

    const adminBtn = canToggleAdmin
      ? (u.is_admin
          ? `<button class="admin-toggle-btn demote"  data-id="${u.id}" data-field="is_admin"   data-val="false">Remove admin</button>`
          : `<button class="admin-toggle-btn promote" data-id="${u.id}" data-field="is_admin"   data-val="true">Make admin</button>`)
      : "";

    const premiumBtn = u.is_premium
      ? `<button class="admin-toggle-btn demote"  data-id="${u.id}" data-field="is_premium" data-val="false">Remove premium</button>`
      : `<button class="admin-toggle-btn promote" data-id="${u.id}" data-field="is_premium" data-val="true">Make premium</button>`;

    const refreshBtn = u.can_refresh_ai
      ? `<button class="admin-toggle-btn demote"  data-id="${u.id}" data-field="can_refresh_ai" data-val="false">Disable refresh</button>`
      : `<button class="admin-toggle-btn promote" data-id="${u.id}" data-field="can_refresh_ai" data-val="true">Enable refresh</button>`;

    row.innerHTML = `
      <div class="admin-user-info">
        <div class="admin-user-name">${escHtml(u.name)}</div>
        <div class="admin-user-email">${escHtml(u.email)}</div>
      </div>
      <div style="display:flex;gap:4px;flex-shrink:0;flex-wrap:wrap;">${adminBadge}${premiumBadge}${refreshBadge}</div>
      <div style="display:flex;gap:4px;flex-shrink:0;flex-wrap:wrap;">${adminBtn}${premiumBtn}${refreshBtn}</div>
    `;

    row.querySelectorAll(".admin-toggle-btn").forEach(btn => {
      btn.addEventListener("click", async () => {
        btn.disabled = true;
        const field = btn.dataset.field;
        const val   = btn.dataset.val === "true";
        try {
          const res = await fetch(`${API_BASE}/api/admin/users/${u.id}`, {
            method: "PATCH",
            headers: apiHeaders(true),
            body: JSON.stringify({ [field]: val }),
          });
          if (!res.ok) { alert((await res.json()).detail || "Failed to update."); }
          await refreshAdminModal();
        } catch { btn.disabled = false; }
      });
    });

    el.appendChild(row);
  });
}

// ── Watchlist (requires account) ──────────────────────────
let cachedWatchlist = [];

async function syncWatchlist() {
  if (auth.token) {
    try {
      const res = await fetch(`${API_BASE}/api/me/watchlist`, { headers: apiHeaders() });
      if (res.ok) cachedWatchlist = await res.json();
    } catch { cachedWatchlist = []; }
    await loadPortfolios();
  } else {
    cachedWatchlist = [];
  }
  renderWatchlist();
}

function isInWatchlist(ticker) {
  return cachedWatchlist.some(i => i.ticker === ticker);
}

async function addToWatchlist(ticker, data) {
  if (!auth.token) { openModal("login"); return; }
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
  await fetch(`${API_BASE}/api/me/watchlist`, {
    method: "POST",
    headers: apiHeaders(true),
    body: JSON.stringify(item),
  });
  await syncWatchlist();
  updateWatchlistBtn(ticker);
}

async function removeFromWatchlist(ticker) {
  if (!auth.token) return;
  await fetch(`${API_BASE}/api/me/watchlist/${ticker}`, {
    method: "DELETE",
    headers: apiHeaders(),
  });
  await syncWatchlist();
  updateWatchlistBtn(ticker);
}

function updateWatchlistBtn(ticker) {
  if (!auth.token) {
    watchlistBtn.textContent = "+ Watchlist";
    watchlistBtn.className   = "wl-toggle-btn";
    return;
  }
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
  if (!auth.token) return;
  for (const item of [...cachedWatchlist]) {
    await fetch(`${API_BASE}/api/me/watchlist/${item.ticker}`, {
      method: "DELETE", headers: apiHeaders(),
    });
  }
  cachedWatchlist = [];
  renderWatchlist();
  if (state.lastData) updateWatchlistBtn(state.lastData.ticker);
});

// ── Analyze ───────────────────────────────────────────────
async function analyze(ticker) {
  stopPricePolling();
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

  // Price display — show cached price immediately; fetch live price regardless
  applyPriceDisplay(data);
  startPricePolling();
  // If price missing from cached score (old cache entry), fetch it now even outside market hours
  if (data.price == null) refreshLivePrice();

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

  // AI Analysis section — visible to premium users only
  const aiSection = document.getElementById("ai-analysis-section");
  if (auth.user?.is_premium) {
    aiSection.style.display = "";
    resetAiAnalysis();
  } else {
    aiSection.style.display = "none";
  }

  // Refresh portfolio "add" button if a portfolio is open
  if (auth.user && portfolioState.activeId) {
    renderPortfolioDetail();
  }
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

// ── AI Analysis (premium) ─────────────────────────────────
document.getElementById("ai-analyze-btn").addEventListener("click", runAiAnalysis);

async function resetAiAnalysis() {
  const body = document.getElementById("ai-analysis-body");
  if (!state.lastData) return;

  body.innerHTML = `<div style="color:var(--muted);font-size:0.85rem;">Checking for report…</div>`;

  try {
    const ticker = state.lastData.ticker;
    const res = await fetch(`${API_BASE}/api/premium/ai-cache/${ticker}`, { headers: apiHeaders() });
    const result = await res.json();
    if (res.ok && !result.no_cache) {
      renderAiResult(result, body);
      return;
    }
  } catch { /* silent */ }

  body.innerHTML = `<button id="ai-analyze-btn" class="ai-analyze-btn">Get AI Analysis</button>`;
  document.getElementById("ai-analyze-btn").addEventListener("click", () => runAiAnalysis());
}

async function runAiAnalysis(forceRefresh = false) {
  const body = document.getElementById("ai-analysis-body");
  if (!state.lastData) return;

  body.innerHTML = `
    <div style="color:var(--muted);font-size:0.88rem;line-height:1.7;">
      <span class="ai-spinner"></span>${forceRefresh ? "Refreshing" : "Researching"} ${escHtml(state.lastData.ticker)} with Claude…
      <div style="font-size:0.78rem;margin-top:6px;color:var(--muted);opacity:0.7;">
        Searching news, analyst opinions, and sentiment. This takes 30–90 seconds.
      </div>
    </div>`;

  try {
    const res = await fetch(`${API_BASE}/api/premium/ai-analyze`, {
      method: "POST",
      headers: apiHeaders(true),
      body: JSON.stringify({ data: state.lastData, force_refresh: forceRefresh }),
    });

    const result = await res.json();

    if (!res.ok) {
      body.innerHTML = `<div style="color:var(--red);font-size:0.85rem;">${escHtml(result.detail || "AI analysis failed.")}</div>`;
      return;
    }

    renderAiResult(result, body);
  } catch(err) {
    body.innerHTML = `<div style="color:var(--red);font-size:0.85rem;">Error: ${escHtml(err.message || String(err))}</div>`;
  }
}

function renderAiResult(result, body) {
  const html = escHtml(result.text)
    .replace(/^#{2,4} (.+)$/gm, "<h3>$1</h3>")
    .replace(/^\d+\. (.+)$/gm, "<li>$1</li>")
    .replace(/^[•\-\*] (.+)$/gm, "<li>$1</li>")
    .replace(/(<li>.*<\/li>\n?)+/g, m => `<ul>${m}</ul>`)
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/\n{2,}/g, "\x00")
    .replace(/\n/g, " ")
    .replace(/\x00/g, "</p><p>")
    .replace(/^(?!<[hup])/, "<p>")
    .replace(/$(?!<\/[hup])/, "</p>")
    .replace(/<p>\s*<\/p>/g, "")
    .replace(/<p>(<[hup])/g, "$1")
    .replace(/(<\/[hup][^>]*>)<\/p>/g, "$1");

  const generatedDate = result.generated_at
    ? new Date(result.generated_at * 1000).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })
    : "";
  const cacheNote = result.cached
    ? `<span class="ai-cache-badge">Cached · Generated ${generatedDate}</span>`
    : `<span class="ai-cache-badge fresh">Generated now · Cached for 10 days</span>`;

  body.innerHTML = `
    <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px;margin-bottom:16px;">
      ${cacheNote}
      <div style="display:flex;gap:8px;flex-wrap:wrap;">
        <button id="ai-pdf-btn" class="ai-pdf-btn" style="font-size:0.78rem;padding:6px 14px;">↓ Download PDF</button>
        ${auth.user?.can_refresh_ai ? `<button id="ai-analyze-btn" class="ai-analyze-btn" style="font-size:0.78rem;padding:6px 14px;">↺ Refresh</button>` : ""}
      </div>
    </div>
    <div class="ai-analysis-text" id="ai-report-content">${html}</div>
    <div class="ai-disclaimer">
      AI research by Claude · Based on publicly available information · Not financial advice · Verify before acting
    </div>`;
  if (auth.user?.can_refresh_ai) {
    document.getElementById("ai-analyze-btn").addEventListener("click", () => runAiAnalysis(true));
  }
  document.getElementById("ai-pdf-btn").addEventListener("click", downloadAiPdf);
}

function downloadAiPdf() {
  const data = state.lastData;
  if (!data) return;

  const reportContent = document.getElementById("ai-report-content");
  if (!reportContent) return;

  const categoryRows = Object.values(data.categories).map(c => {
    const pct = c.pct.toFixed(0);
    const color = c.pct >= 70 ? "#16a34a" : c.pct >= 45 ? "#d97706" : "#dc2626";
    const barWidth = Math.round(c.pct);
    return `<tr>
      <td class="td-label">${escHtml(c.label)}</td>
      <td class="td-score" style="color:${color}">${c.score}/${c.max}</td>
      <td class="td-bar">
        <div class="bar-bg"><div class="bar-fg" style="background:${color};width:${barWidth}%"></div></div>
      </td>
      <td class="td-pct">${pct}%</td>
    </tr>`;
  }).join("");

  const starsHtml = "★".repeat(data.stars) + "☆".repeat(5 - data.stars);
  const scoreColor = data.pct >= 70 ? "#16a34a" : data.pct >= 45 ? "#d97706" : "#dc2626";
  const generatedDate = new Date().toLocaleDateString(undefined, { month: "long", day: "numeric", year: "numeric" });

  const aiHtml = reportContent.innerHTML
    .replace(/<h3>/g, '<h3 class="ai-h3">')
    .replace(/<ul>/g, '<ul class="ai-ul">');

  const fullHtml = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>CerbyFi · ${escHtml(data.ticker)} · AI Report</title>
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif;
    color: #1e293b;
    background: #fff;
    -webkit-print-color-adjust: exact;
    print-color-adjust: exact;
  }
  @page { size: A4; margin: 14mm 16mm; }

  /* ── Screen wrapper ── */
  .page { max-width: 740px; margin: 0 auto; padding: 24px; }


  /* ── Header band ── */
  .hdr {
    background: #0f172a;
    color: #fff;
    padding: 22px 28px;
    border-radius: 8px 8px 0 0;
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    page-break-inside: avoid;
  }
  .hdr-brand { font-size: 24px; font-weight: 800; letter-spacing: -0.4px; }
  .hdr-brand span { color: #4f8ef7; }
  .hdr-sub { font-size: 12px; color: #94a3b8; margin-top: 4px; text-transform: uppercase; letter-spacing: 0.08em; }
  .hdr-date { font-size: 13px; color: #94a3b8; text-align: right; }

  /* ── Company band ── */
  .co {
    background: #1e293b;
    color: #f1f5f9;
    padding: 18px 28px 22px;
    border-radius: 0 0 8px 8px;
    margin-bottom: 22px;
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 12px;
    page-break-inside: avoid;
  }
  .co-name { font-size: 22px; font-weight: 700; }
  .co-badges { display: flex; gap: 7px; margin-top: 5px; }
  .badge { background: #334155; color: #94a3b8; font-size: 12px; font-weight: 700; padding: 2px 8px; border-radius: 4px; }
  .score-num { font-size: 38px; font-weight: 800; line-height: 1; text-align: right; }
  .score-denom { font-size: 18px; color: #64748b; }
  .stars { color: #fbbf24; font-size: 17px; margin-top: 2px; text-align: right; }
  .rating { font-size: 13px; color: #94a3b8; text-align: right; margin-top: 2px; }

  /* ── Score table ── */
  .section { margin-bottom: 22px; page-break-inside: avoid; }
  .section-label {
    font-size: 12px; font-weight: 700; text-transform: uppercase;
    letter-spacing: 0.1em; color: #64748b; margin-bottom: 10px;
  }
  table { width: 100%; border-collapse: collapse; }
  .td-label { padding: 6px 10px 6px 0; font-size: 15px; color: #334155; }
  .td-score { padding: 6px 10px; font-size: 15px; font-weight: 600; white-space: nowrap; }
  .td-bar { padding: 6px 0; width: 130px; }
  .td-pct { padding: 6px 0 6px 8px; font-size: 13px; color: #64748b; }
  .bar-bg { background: #e2e8f0; border-radius: 3px; height: 7px; width: 100%; }
  .bar-fg { border-radius: 3px; height: 7px; }

  /* ── Divider ── */
  hr { border: none; border-top: 1px solid #e2e8f0; margin: 4px 0 20px; }

  /* ── AI text ── */
  .ai-body { font-size: 15px; line-height: 1.8; color: #334155; }
  .ai-body .ai-h3 {
    font-size: 12px; font-weight: 700; text-transform: uppercase;
    letter-spacing: 0.1em; color: #4f46e5;
    margin: 20px 0 8px; padding-bottom: 5px;
    border-bottom: 1px solid #e0e7ff;
    page-break-after: avoid;
  }
  .ai-body p { margin: 0 0 10px; color: #475569; }
  .ai-body .ai-ul { list-style: none; padding: 0; margin: 0 0 10px; }
  .ai-body .ai-ul li { padding: 4px 0 4px 16px; color: #475569; }
  .ai-body .ai-ul li::before { content: "• "; }
  .ai-body strong { color: #1e293b; }

  /* ── Footer ── */
  .footer {
    margin-top: 26px; padding-top: 12px;
    border-top: 1px solid #e2e8f0;
    font-size: 11px; color: #94a3b8; line-height: 1.6;
  }
</style>
</head>
<body>
<div class="page">

  <div class="hdr">
    <div>
      <div class="hdr-brand">Cerby<span>Fi</span></div>
      <div class="hdr-sub">AI Research Report &middot; Premium</div>
    </div>
    <div class="hdr-date">Generated ${escHtml(generatedDate)}</div>
  </div>

  <div class="co">
    <div>
      <div class="co-name">${escHtml(data.name)}</div>
      <div class="co-badges">
        <span class="badge">${escHtml(data.ticker)}</span>
        <span class="badge">${data.type === "fund" ? "ETF / Fund" : "Stock"}</span>
      </div>
    </div>
    <div>
      <div class="score-num" style="color:${scoreColor}">${data.total}<span class="score-denom">/${data.max_total}</span></div>
      <div class="stars">${starsHtml}</div>
      <div class="rating">${escHtml(data.rating_label)}</div>
    </div>
  </div>

  <div class="section">
    <div class="section-label">Score Breakdown</div>
    <table><tbody>${categoryRows}</tbody></table>
  </div>

  <hr>

  <div class="section">
    <div class="section-label">AI Analysis &middot; Claude Sonnet</div>
    <div class="ai-body">${aiHtml}</div>
  </div>

  <div class="footer">
    AI research by Claude &middot; Based on publicly available information as of ${escHtml(generatedDate)} &middot;
    For informational purposes only &middot; Not financial advice &middot;
    Always verify information independently before making investment decisions.
    Data sources: Finnhub, Financial Modeling Prep, Yahoo Finance.
  </div>

</div>
</body>
</html>`;

  // Use a Blob URL — far more reliable than window.open("","_blank") + document.write,
  // which can replace the current tab in some browsers.
  const blob = new Blob([fullHtml], { type: "text/html; charset=utf-8" });
  const url  = URL.createObjectURL(blob);
  const tab  = window.open(url, "_blank");
  if (!tab) {
    alert("Please allow popups for this site to open the PDF report.");
  }
  // Revoke the blob URL after 2 minutes to free memory
  setTimeout(() => URL.revokeObjectURL(url), 120_000);
}

// ── Init ──────────────────────────────────────────────────
initAuth();
loadTopTickers();
loadStats();

// ── Portfolios ────────────────────────────────────────────
const portfolioState = { list: [], activeId: null, optimizeData: null, editing: false };

async function loadPortfolios() {
  if (!auth.token) {
    document.getElementById("portfolio-section").style.display = "none";
    return;
  }
  try {
    const res = await fetch(`${API_BASE}/api/me/portfolios`, { headers: apiHeaders() });
    if (res.ok) {
      portfolioState.list = await res.json();
      renderPortfolioSection();
    }
  } catch { /* silent */ }
}

function renderPortfolioSection() {
  const section = document.getElementById("portfolio-section");
  section.style.display = "block";
  if (portfolioState.activeId) {
    renderPortfolioDetail();
  } else {
    renderPortfolioList();
  }
}

function renderPortfolioList() {
  document.getElementById("portfolio-list").style.display = "";
  document.getElementById("portfolio-detail").style.display = "none";
  const list = document.getElementById("portfolio-list");
  list.innerHTML = "";
  if (!portfolioState.list.length) {
    list.innerHTML = `<div style="font-size:0.8rem;color:var(--muted);padding:8px 0;">No portfolios yet. Click + New to create one.</div>`;
    return;
  }
  portfolioState.list.forEach(p => {
    const agg = p.aggregate_score;
    const pct = agg !== null ? agg : null;
    const card = document.createElement("div");
    card.className = "portfolio-card";
    card.innerHTML = `
      <div class="portfolio-card-header">
        <span class="portfolio-card-name">${escHtml(p.name)}</span>
        <button class="ph-remove" data-id="${p.id}" title="Delete">✕</button>
      </div>
      <div class="portfolio-card-meta">${p.holdings.length} holding${p.holdings.length !== 1 ? "s" : ""}</div>
      ${pct !== null ? `
        <div class="portfolio-card-score" style="color:${scoreColor(pct)}">Score: ${pct.toFixed(1)}</div>
        <div class="wl-bar-track" style="margin-top:4px;">
          <div class="wl-bar-fill ${barColor(pct)}" style="width:${pct}%"></div>
        </div>` : '<div class="portfolio-card-meta">Add stocks to see score</div>'}
    `;
    card.querySelector(".ph-remove").addEventListener("click", async e => {
      e.stopPropagation();
      if (!confirm(`Delete "${p.name}"?`)) return;
      await fetch(`${API_BASE}/api/me/portfolios/${p.id}`, { method: "DELETE", headers: apiHeaders() });
      await loadPortfolios();
    });
    card.addEventListener("click", () => openPortfolioDetail(p.id));
    list.appendChild(card);
  });
}

function openPortfolioDetail(id) {
  portfolioState.activeId = id;
  portfolioState.optimizeData = null;
  portfolioState.editing = false;
  renderPortfolioDetail();
}

function renderPortfolioDetail() {
  document.getElementById("portfolio-list").style.display = "none";
  document.getElementById("portfolio-detail").style.display = "";
  document.getElementById("optimize-panel").style.display = "none";

  const p = portfolioState.list.find(x => x.id === portfolioState.activeId);
  if (!p) return;

  document.getElementById("portfolio-detail-name").textContent = p.name;

  const agg = p.aggregate_score;
  document.getElementById("portfolio-agg-score").textContent = agg !== null ? agg.toFixed(1) : "—";
  const bar = document.getElementById("portfolio-agg-bar");
  bar.style.width = agg !== null ? `${agg}%` : "0%";
  bar.className = `wl-bar-fill ${agg !== null ? barColor(agg) : ""}`;

  // Holdings list
  const holdingsEl = document.getElementById("portfolio-holdings-list");
  holdingsEl.innerHTML = "";
  if (!p.holdings.length) {
    holdingsEl.innerHTML = `<div style="font-size:0.8rem;color:var(--muted);padding:8px 0;">No holdings. Analyze a stock/ETF then click "+ Add to Portfolio".</div>`;
  }

  if (portfolioState.editing) {
    renderAllocationEditor(p);
  } else {
    p.holdings.forEach(h => {
      const row = document.createElement("div");
      row.className = "portfolio-holding-row";
      const hPct = h.pct_score;
      row.innerHTML = `
        <span class="ph-ticker">${h.ticker}</span>
        <span class="ph-name">${escHtml(h.name || "")}</span>
        <span class="ph-alloc">${h.allocation.toFixed(0)}%</span>
        <span class="ph-score" style="color:${hPct !== null ? scoreColor(hPct) : 'var(--muted)'}">
          ${hPct !== null ? hPct.toFixed(0) : "N/A"}
        </span>
        <button class="ph-remove" data-ticker="${h.ticker}">✕</button>
      `;
      row.querySelector(".ph-remove").addEventListener("click", async () => {
        await fetch(`${API_BASE}/api/me/portfolios/${p.id}/holdings/${h.ticker}`, {
          method: "DELETE", headers: apiHeaders(),
        });
        await loadPortfolios();
        openPortfolioDetail(p.id);
      });
      holdingsEl.appendChild(row);
    });

    if (p.holdings.length > 1) {
      // Edit allocations button row
      const editRow = document.createElement("div");
      editRow.style.cssText = "margin-top:8px;";
      editRow.innerHTML = `<button class="wl-toggle-btn" id="edit-alloc-btn" style="width:100%;font-size:0.8rem;">Edit allocations</button>`;
      editRow.querySelector("#edit-alloc-btn").addEventListener("click", () => {
        portfolioState.editing = true;
        renderPortfolioDetail();
      });
      holdingsEl.appendChild(editRow);
    }
  }

  // "Add current to portfolio" button
  const addBtn = document.getElementById("portfolio-add-current-btn");
  if (state.lastData && !p.holdings.find(h => h.ticker === state.lastData.ticker)) {
    addBtn.style.display = "";
    addBtn.textContent = `+ Add ${state.lastData.ticker} to this portfolio`;
    addBtn.onclick = () => addCurrentToPortfolio(p.id);
  } else {
    addBtn.style.display = "none";
  }
}

function renderAllocationEditor(p) {
  const holdingsEl = document.getElementById("portfolio-holdings-list");
  holdingsEl.innerHTML = "";

  const inputs = {};
  p.holdings.forEach(h => {
    const row = document.createElement("div");
    row.className = "portfolio-holding-row";
    row.innerHTML = `
      <span class="ph-ticker">${h.ticker}</span>
      <span class="ph-name">${escHtml(h.name || "")}</span>
      <input type="number" class="alloc-input" min="1" max="99" step="1" value="${h.allocation.toFixed(0)}" data-ticker="${h.ticker}" />
      <span style="font-size:0.78rem;color:var(--muted);">%</span>
    `;
    holdingsEl.appendChild(row);
    inputs[h.ticker] = row.querySelector("input");
  });

  // Sum hint
  const hint = document.createElement("div");
  hint.id = "alloc-sum-hint";
  hint.className = "alloc-sum-hint";
  holdingsEl.appendChild(hint);

  const updateHint = () => {
    const sum = Object.values(inputs).reduce((a, el) => a + (parseFloat(el.value) || 0), 0);
    hint.textContent = `Total: ${sum.toFixed(0)}% ${sum === 100 ? "✓" : "(must equal 100)"}`;
    hint.className = `alloc-sum-hint ${Math.abs(sum - 100) < 0.5 ? "alloc-sum-ok" : "alloc-sum-err"}`;
  };
  Object.values(inputs).forEach(el => el.addEventListener("input", updateHint));
  updateHint();

  // Save / Cancel
  const actions = document.createElement("div");
  actions.style.cssText = "display:flex;gap:6px;margin-top:8px;";
  actions.innerHTML = `
    <button id="save-alloc-btn" class="auth-submit" style="flex:1;padding:8px;font-size:0.82rem;">Save</button>
    <button id="cancel-alloc-btn" class="wl-clear-btn">Cancel</button>
  `;
  holdingsEl.appendChild(actions);

  actions.querySelector("#cancel-alloc-btn").addEventListener("click", () => {
    portfolioState.editing = false;
    renderPortfolioDetail();
  });
  actions.querySelector("#save-alloc-btn").addEventListener("click", async () => {
    const sum = Object.values(inputs).reduce((a, el) => a + (parseFloat(el.value) || 0), 0);
    if (Math.abs(sum - 100) > 0.5) {
      hint.textContent = `Total must be 100. Currently ${sum.toFixed(1)}%.`;
      hint.className = "alloc-sum-hint alloc-sum-err";
      return;
    }
    const updated = p.holdings.map(h => ({
      ...h,
      allocation: parseFloat(inputs[h.ticker].value) || h.allocation,
    }));
    await saveAllocations(p.id, updated);
  });
}

async function saveAllocations(portfolioId, holdings) {
  const res = await fetch(`${API_BASE}/api/me/portfolios/${portfolioId}/holdings`, {
    method: "PUT",
    headers: apiHeaders(true),
    body: JSON.stringify({ holdings }),
  });
  if (!res.ok) {
    const err = await res.json();
    alert(err.detail || "Failed to save.");
    return;
  }
  portfolioState.editing = false;
  document.getElementById("optimize-panel").style.display = "none";
  await loadPortfolios();
  openPortfolioDetail(portfolioId);
}

async function addCurrentToPortfolio(portfolioId) {
  if (!state.lastData) return;
  const p = portfolioState.list.find(x => x.id === portfolioId);
  if (!p) return;

  const d = state.lastData;
  const newHolding = {
    ticker:    d.ticker,
    mode:      d.type,
    name:      d.name,
    score:     d.total,
    max_score: d.max_total,
    pct_score: d.pct,
    stars:     d.stars,
    allocation: 0,
  };

  // Add with 0% allocation, then immediately open allocation editor
  const existingAllocSum = p.holdings.reduce((s, h) => s + h.allocation, 0);
  const suggestedAlloc = Math.max(0, 100 - existingAllocSum);
  newHolding.allocation = suggestedAlloc;

  const updatedHoldings = [...p.holdings, newHolding];
  // Normalize so total = 100 (reduce existing proportionally if needed)
  const total = updatedHoldings.reduce((s, h) => s + h.allocation, 0);
  if (total !== 100 && total > 0) {
    updatedHoldings.forEach(h => { h.allocation = parseFloat((h.allocation / total * 100).toFixed(1)); });
    // fix rounding
    const diff = parseFloat((100 - updatedHoldings.reduce((s,h) => s + h.allocation, 0)).toFixed(1));
    updatedHoldings[0].allocation += diff;
  }

  await saveAllocations(portfolioId, updatedHoldings);
  portfolioState.editing = true;
  renderPortfolioDetail();
}

document.getElementById("new-portfolio-btn").addEventListener("click", async () => {
  const name = prompt("Portfolio name:");
  if (!name || !name.trim()) return;
  const res = await fetch(`${API_BASE}/api/me/portfolios`, {
    method: "POST",
    headers: apiHeaders(true),
    body: JSON.stringify({ name: name.trim() }),
  });
  if (res.ok) {
    const p = await res.json();
    await loadPortfolios();
    openPortfolioDetail(p.id);
  }
});

document.getElementById("portfolio-back-btn").addEventListener("click", () => {
  portfolioState.activeId = null;
  portfolioState.optimizeData = null;
  portfolioState.editing = false;
  renderPortfolioSection();
});

document.getElementById("delete-portfolio-btn").addEventListener("click", async () => {
  const p = portfolioState.list.find(x => x.id === portfolioState.activeId);
  if (!p || !confirm(`Delete "${p.name}"?`)) return;
  await fetch(`${API_BASE}/api/me/portfolios/${p.id}`, { method: "DELETE", headers: apiHeaders() });
  portfolioState.activeId = null;
  await loadPortfolios();
});

document.getElementById("optimize-btn").addEventListener("click", async () => {
  const panel = document.getElementById("optimize-panel");
  if (panel.style.display !== "none") { panel.style.display = "none"; return; }

  const res = await fetch(`${API_BASE}/api/me/portfolios/${portfolioState.activeId}/optimize`, {
    headers: apiHeaders(),
  });
  if (!res.ok) { alert((await res.json()).detail || "Could not optimize."); return; }
  const data = await res.json();
  portfolioState.optimizeData = data;

  document.getElementById("opt-current-score").textContent = data.current_score.toFixed(1);
  document.getElementById("opt-new-score").textContent     = data.optimized_score.toFixed(1);

  const rows = document.getElementById("optimize-rows");
  rows.innerHTML = "";
  data.holdings.forEach(h => {
    const row = document.createElement("div");
    row.className = "optimize-row";
    row.innerHTML = `
      <span class="opt-ticker">${h.ticker}</span>
      <span class="ph-name" style="flex:1;">${escHtml(h.name || "")}</span>
      <span class="opt-current">${h.current_allocation.toFixed(0)}%</span>
      <span class="opt-arrow-sm">→</span>
      <span class="opt-new">${h.optimized_allocation.toFixed(0)}%</span>
    `;
    rows.appendChild(row);
  });
  panel.style.display = "";
});

document.getElementById("apply-optimize-btn").addEventListener("click", async () => {
  const data = portfolioState.optimizeData;
  if (!data) return;
  const p = portfolioState.list.find(x => x.id === portfolioState.activeId);
  if (!p) return;
  const updated = p.holdings.map(h => {
    const opt = data.holdings.find(o => o.ticker === h.ticker);
    return { ...h, allocation: opt ? opt.optimized_allocation : h.allocation };
  });
  await saveAllocations(portfolioState.activeId, updated);
});

