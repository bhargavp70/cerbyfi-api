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

document.querySelector(".topbar-brand").addEventListener("click", () => {
  state.lastData = null;
  stopPricePolling();
  showHome();
});

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
  // Revoke token server-side so it can't be reused even if intercepted
  if (auth.token) {
    fetch(`${API_BASE}/api/auth/logout`, {
      method: "POST",
      headers: { "Authorization": `Bearer ${auth.token}` },
    }).catch(() => {});
  }
  auth.token = null;
  auth.user  = null;
  localStorage.removeItem(TOKEN_KEY);
  renderAuthState();
  updateNavGuestCta();
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
    updateNavGuestCta();
    loadHome();
    await syncWatchlist();
    if (state.lastData) updateWatchlistBtn(state.lastData.ticker);
  } catch { errEl.textContent = "Could not reach server."; }
  finally  { submit.disabled = false; }
});

document.getElementById("register-form").addEventListener("submit", async e => {
  e.preventDefault();
  const errEl  = document.getElementById("reg-error");
  const submit = document.getElementById("reg-submit");
  errEl.textContent = "";

  const pw = document.getElementById("reg-password").value;
  if (pw.length < 8)                          { errEl.textContent = "Password must be at least 8 characters."; return; }
  if (!/\d/.test(pw))                         { errEl.textContent = "Password must contain at least one number."; return; }
  if (!/[A-Z]/.test(pw))                      { errEl.textContent = "Password must contain at least one capital letter."; return; }
  if (!/[!@#$%^&*()_+\-=\[\]{};':"\\|,.<>\/?`~]/.test(pw)) { errEl.textContent = "Password must contain at least one special character."; return; }

  submit.disabled = true;
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
    updateNavGuestCta();
    if (data.email_sent) {
      setTimeout(() => alert(`Welcome to CerbyFi, ${data.user.name}!\n\nA verification email has been sent to ${data.user.email}. Please check your inbox and click the link to verify your account.`), 200);
    }
    loadHome();
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
    const [statsRes, usersRes, settingsRes] = await Promise.all([
      fetch(`${API_BASE}/api/admin/stats`, { headers: apiHeaders() }),
      fetch(`${API_BASE}/api/admin/users`, { headers: apiHeaders() }),
      fetch(`${API_BASE}/api/admin/settings`, { headers: apiHeaders() }),
    ]);
    if (statsRes.ok) {
      const data = await statsRes.json();
      document.getElementById("admin-user-count").textContent = data.user_count.toLocaleString();
      document.getElementById("admin-analyses-count").textContent = data.total_analyses.toLocaleString();
      document.getElementById("admin-ai-cache-count").textContent = (data.ai_reports_cached ?? "—").toLocaleString();
    }
    if (settingsRes.ok) {
      const s = await settingsRes.json();
      document.getElementById("admin-ai-limit-input").value = s.ai_monthly_limit;
    }
    if (usersRes.ok) {
      const users = await usersRes.json();
      renderAdminUserList(users);
    }
  } catch { /* silent */ }
}

document.getElementById("admin-ai-limit-save").addEventListener("click", async () => {
  const input = document.getElementById("admin-ai-limit-input");
  const val = parseInt(input.value, 10);
  if (isNaN(val) || val < 0) { alert("Enter a valid non-negative number."); return; }
  const btn = document.getElementById("admin-ai-limit-save");
  btn.disabled = true;
  try {
    const res = await fetch(`${API_BASE}/api/admin/settings`, {
      method: "PATCH",
      headers: apiHeaders(true),
      body: JSON.stringify({ ai_monthly_limit: val }),
    });
    if (!res.ok) { alert((await res.json()).detail || "Failed to save."); }
    else { btn.textContent = "Saved!"; setTimeout(() => { btn.textContent = "Save"; btn.disabled = false; }, 1500); return; }
  } catch { /* silent */ }
  btn.disabled = false;
});

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

    const ejectBtn = (!u.is_protected && !isSelf)
      ? `<button class="admin-toggle-btn eject" data-id="${u.id}" data-name="${escHtml(u.name)}">Eject</button>`
      : "";

    row.innerHTML = `
      <div class="admin-user-top">
        <div class="admin-user-info">
          <div class="admin-user-name">${escHtml(u.name)}</div>
          <div class="admin-user-email">${escHtml(u.email)}</div>
        </div>
        <div style="display:flex;gap:4px;flex-wrap:wrap;">${adminBadge}${premiumBadge}${refreshBadge}</div>
      </div>
      <div style="display:flex;gap:6px;flex-wrap:wrap;">${adminBtn}${premiumBtn}${refreshBtn}${ejectBtn}</div>
    `;

    row.querySelectorAll(".admin-toggle-btn:not(.eject)").forEach(btn => {
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

    const ejectEl = row.querySelector(".eject");
    if (ejectEl) {
      ejectEl.addEventListener("click", async () => {
        if (!confirm(`Eject "${u.name}" (${u.email})?\n\nThis will permanently delete their account, watchlist, and portfolios.`)) return;
        ejectEl.disabled = true;
        try {
          const res = await fetch(`${API_BASE}/api/admin/users/${u.id}`, {
            method: "DELETE",
            headers: apiHeaders(),
          });
          if (!res.ok) { alert((await res.json()).detail || "Failed to eject user."); ejectEl.disabled = false; return; }
          await refreshAdminModal();
        } catch { ejectEl.disabled = false; }
      });
    }

    el.appendChild(row);
  });
}

// ── Admin tab switcher ────────────────────────────────────
function adminShowTab(tab) {
  document.getElementById("admin-panel-users").style.display    = tab === "users"    ? "flex" : "none";
  document.getElementById("admin-panel-feedback").style.display = tab === "feedback" ? "flex" : "none";
  document.getElementById("admin-tab-users").classList.toggle("active",    tab === "users");
  document.getElementById("admin-tab-feedback").classList.toggle("active", tab === "feedback");
  if (tab === "feedback") loadAdminFeedback();
}

async function loadAdminFeedback() {
  const el = document.getElementById("admin-feedback-list");
  el.innerHTML = `<div style="color:var(--muted);font-size:0.85rem;padding:8px 0;">Loading…</div>`;
  try {
    const res = await fetch(`${API_BASE}/api/admin/feedback`, { headers: apiHeaders() });
    if (!res.ok) { el.innerHTML = `<div style="color:var(--red);">Failed to load.</div>`; return; }
    const items = await res.json();
    if (!items.length) { el.innerHTML = `<div style="color:var(--muted);font-size:0.85rem;padding:8px 0;">No feedback yet.</div>`; return; }
    el.innerHTML = "";
    items.forEach(f => {
      const d = new Date(f.created_at * 1000);
      const row = document.createElement("div");
      row.style.cssText = "padding:12px 0;border-bottom:1px solid var(--border);";
      row.innerHTML = `
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;">
          <span style="font-size:0.82rem;font-weight:600;color:var(--text);">${escHtml(f.user_name)}</span>
          <span style="display:flex;align-items:center;gap:8px;">
            <span style="font-size:0.72rem;color:var(--muted);">${d.toLocaleDateString()}</span>
            <button class="admin-toggle-btn eject" data-id="${f.id}" style="font-size:0.72rem;padding:2px 8px;">Delete</button>
          </span>
        </div>
        <div style="font-size:0.85rem;color:var(--muted);line-height:1.5;">${escHtml(f.text)}</div>`;
      row.querySelector(".eject").addEventListener("click", async (e) => {
        const btn = e.target;
        btn.disabled = true;
        await fetch(`${API_BASE}/api/admin/feedback/${f.id}`, { method: "DELETE", headers: apiHeaders() });
        row.remove();
      });
      el.appendChild(row);
    });
  } catch { el.innerHTML = `<div style="color:var(--red);">Error loading feedback.</div>`; }
}

// ── Feedback modal ────────────────────────────────────────
const feedbackModal = document.getElementById("feedback-modal");
document.getElementById("feedback-modal-close").addEventListener("click", () => { feedbackModal.style.display = "none"; });
feedbackModal.addEventListener("click", e => { if (e.target === feedbackModal) feedbackModal.style.display = "none"; });

document.getElementById("btn-open-feedback").addEventListener("click", () => {
  document.getElementById("feedback-text").value = "";
  document.getElementById("feedback-word-count").textContent = "0 / 200 words";
  document.getElementById("feedback-error").textContent = "";
  feedbackModal.style.display = "flex";
});

document.getElementById("feedback-text").addEventListener("input", () => {
  const words = document.getElementById("feedback-text").value.trim().split(/\s+/).filter(Boolean).length;
  const wc = document.getElementById("feedback-word-count");
  wc.textContent = `${words} / 200 words`;
  wc.style.color = words > 200 ? "var(--red)" : "var(--muted)";
});

document.getElementById("feedback-submit").addEventListener("click", async () => {
  const text = document.getElementById("feedback-text").value.trim();
  const words = text.split(/\s+/).filter(Boolean).length;
  const errEl = document.getElementById("feedback-error");
  errEl.textContent = "";
  if (!text) { errEl.textContent = "Please write something."; return; }
  if (words > 200) { errEl.textContent = "Too long — keep it under 200 words."; return; }
  const btn = document.getElementById("feedback-submit");
  btn.disabled = true; btn.textContent = "Sending…";
  try {
    const res = await fetch(`${API_BASE}/api/admin/feedback`, {
      method: "POST",
      headers: apiHeaders(true),
      body: JSON.stringify({ text }),
    });
    if (res.ok) {
      btn.textContent = "Thank you!";
      setTimeout(() => { feedbackModal.style.display = "none"; btn.textContent = "Submit Feedback"; btn.disabled = false; }, 1500);
    } else {
      const d = await res.json();
      errEl.textContent = d.detail || "Failed to submit.";
      btn.disabled = false; btn.textContent = "Submit Feedback";
    }
  } catch { errEl.textContent = "Network error."; btn.disabled = false; btn.textContent = "Submit Feedback"; }
});

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

  // Update SVG score gauge
  const gaugeEl = document.getElementById("score-gauge-fill");
  if (gaugeEl) {
    const circumference = 339.3;
    const offset = circumference - (data.pct / 100) * circumference;
    gaugeEl.style.strokeDashoffset = offset;
    const gaugeColor = data.pct >= 70 ? "#00e599" : data.pct >= 45 ? "#ffb830" : "#ff4d6a";
    gaugeEl.setAttribute("stroke", gaugeColor);
  }
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
  homeSection.style.display = "none";
  resultsSection.style.display = "block";
  if (_lastIndices.length) {
    document.getElementById("right-indices").style.display = "";
  }

  // AI Analysis section — visible to all logged-in users
  const aiSection = document.getElementById("ai-analysis-section");
  if (auth.user) {
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
  const CAT_ICONS = {
    business_quality: "🏢", financial_strength: "💪", growth_potential: "📈",
    valuation: "💰", management: "🎯", fund_stability: "🏦",
    risk_profile: "🛡️", returns: "📈", income: "💸",
  };
  // Derive key from label (lowercase, replace spaces with _)
  const catKey = cat.label.toLowerCase().replace(/[^a-z]/g, "_").replace(/_+/g, "_");
  const icon = CAT_ICONS[catKey] || "📊";

  const card = document.createElement("div");
  card.className = "category-card";
  card.innerHTML = `
    <div class="cat-icon">${icon}</div>
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
    return `<div class="metric-row">
      <span class="metric-label">${m.label}</span>
      <span class="metric-right">
        <span class="metric-value">${m.display}</span>
        <span class="mini-score" style="color:${scoreColor(p)}">${m.score}/${m.max}</span>
      </span>
    </div>`;
  }).join("");
  return `<div class="metrics-list">${rows}</div>`;
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
  return pct >= 70 ? "var(--green)" : pct >= 45 ? "var(--gold)" : "var(--red)";
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
  errorSection.style.display   = "none";
  resultsSection.style.display = "none";
  homeSection.style.display    = "none";
  document.getElementById("right-indices").style.display = "none";
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

  // Try to load cached report (available to all logged-in users)
  try {
    const ticker = state.lastData.ticker;
    const res = await fetch(`${API_BASE}/api/premium/ai-cache/${ticker}`, { headers: apiHeaders() });
    const result = await res.json();
    if (res.ok && !result.no_cache) {
      renderAiResult(result, body);
      return;
    }
  } catch { /* silent */ }

  // No cached report — show generate button for premium, upgrade prompt for others
  if (auth.user?.is_premium) {
    let usageHtml = "";
    try {
      const ur = await fetch(`${API_BASE}/api/premium/ai-usage`, { headers: apiHeaders() });
      if (ur.ok) {
        const u = await ur.json();
        const limitLabel = u.limit === 0 ? "unlimited" : `${u.limit}/mo`;
        usageHtml = `<div style="font-size:0.78rem;color:var(--muted);margin-top:8px;">${u.used} of ${limitLabel} reports used this month</div>`;
      }
    } catch { /* silent */ }
    body.innerHTML = `
      <button id="ai-analyze-btn" class="ai-analyze-btn">Get AI Analysis</button>
      ${usageHtml}`;
    document.getElementById("ai-analyze-btn").addEventListener("click", () => runAiAnalysis());
  } else {
    body.innerHTML = `
      <div style="color:var(--muted);font-size:0.85rem;line-height:1.6;">
        No AI report available yet for this ticker.<br>
        <span style="color:var(--muted);opacity:0.7;font-size:0.8rem;">Premium members can generate AI reports. Upgrade to unlock.</span>
      </div>`;
  }
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
    // Update usage display if present in response
    if (result.usage) {
      const existingUsage = body.querySelector(".ai-usage-line");
      if (!existingUsage) {
        const u = result.usage;
        const limitLabel = u.limit === 0 ? "unlimited" : `${u.limit}/mo`;
        const usageEl = document.createElement("div");
        usageEl.className = "ai-usage-line";
        usageEl.style.cssText = "font-size:0.78rem;color:var(--muted);margin-top:6px;";
        usageEl.textContent = `${u.used} of ${limitLabel} reports used this month`;
        body.appendChild(usageEl);
      }
    }
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

// ── Home section ──────────────────────────────────────────
const homeSection = document.getElementById("home-section");

function showHome() {
  homeSection.style.display = "";
  resultsSection.style.display = "none";
  errorSection.style.display   = "none";
  document.getElementById("right-indices").style.display = "none";
}

function hideHome() {
  homeSection.style.display = "none";
  document.getElementById("right-indices").style.display = "";
}

function renderSparkline(canvas, values, changePct) {
  if (!values || values.length < 2) return;
  const w = canvas.clientWidth || 200, h = 40;
  const min = Math.min(...values), max = Math.max(...values);
  const range = max - min || 1;
  const pts = values.map((v, i) => {
    const x = (i / (values.length - 1)) * w;
    const y = h - ((v - min) / range) * (h - 4) - 2;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(" ");
  // Use the authoritative change_pct from Yahoo (prev close → current) for color;
  // fall back to first-vs-last comparison only if not provided
  const isUp = changePct != null ? changePct >= 0 : values[values.length - 1] >= values[0];
  const color = isUp ? "#00e599" : "#ff4d6a";
  canvas.innerHTML = `<svg width="100%" height="${h}" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none">
    <polyline points="${pts}" fill="none" stroke="${color}" stroke-width="1.5" stroke-linejoin="round"/>
    <line x1="0" y1="${h - 2}" x2="${w}" y2="${h - 2}" stroke="rgba(255,255,255,0.1)" stroke-width="1" stroke-dasharray="3,3"/>
  </svg>`;
}

async function loadHome() {
  try {
    const res = await fetch(`${API_BASE}/api/market`);
    if (!res.ok) return;
    const data = await res.json();
    renderIndices(data.indices || []);
    renderNews(data.news || []);
    renderResources(data.resources || []);
  } catch { /* silent */ }
  loadAbout();
}

// ── About Us ──────────────────────────────────────────────

let _aboutData = null;

async function loadAbout() {
  try {
    const res = await fetch(`${API_BASE}/api/admin/about`);
    if (!res.ok) return;
    _aboutData = await res.json();
    renderAbout(_aboutData);
  } catch { /* silent */ }
}

function renderAbout(data) {
  const block   = document.getElementById("about-block");
  const titleEl = document.getElementById("about-block-title");
  const content = document.getElementById("about-content");
  const editBtn = document.getElementById("about-edit-btn");

  titleEl.textContent = data.title || "About CerbyFi";
  if (auth.user && auth.user.is_admin) editBtn.style.display = "";

  const highlights = (data.highlights || []).map(h => `
    <div class="about-highlight">
      <div class="about-highlight-icon">${escHtml(h.icon || "")}</div>
      <div class="about-highlight-title">${escHtml(h.title)}</div>
      <div class="about-highlight-text">${escHtml(h.text)}</div>
    </div>`).join("");

  content.innerHTML = `
    ${data.tagline ? `<div class="about-tagline">${escHtml(data.tagline)}</div>` : ""}
    ${data.body    ? `<div class="about-body">${escHtml(data.body)}</div>` : ""}
    ${highlights   ? `<div class="about-highlights">${highlights}</div>` : ""}
  `;
  block.style.display = "";
}

function openAboutEdit() {
  const data = _aboutData || {};
  document.getElementById("about-input-title").value   = data.title   || "";
  document.getElementById("about-input-tagline").value = data.tagline || "";
  document.getElementById("about-input-body").value    = data.body    || "";

  const editor = document.getElementById("about-highlights-editor");
  editor.innerHTML = "";
  const highlights = data.highlights || [{icon:"",title:"",text:""},{icon:"",title:"",text:""},{icon:"",title:"",text:""}];
  highlights.slice(0, 3).forEach((h, i) => {
    const row = document.createElement("div");
    row.style.cssText = "display:grid;grid-template-columns:48px 1fr 2fr;gap:8px;align-items:center;";
    row.innerHTML = `
      <input data-hi="${i}" data-field="icon" type="text" maxlength="4" placeholder="🔥"
        value="${escHtml(h.icon||"")}"
        style="padding:7px 6px;background:var(--surface2);border:1.5px solid rgba(255,255,255,0.15);border-radius:6px;color:var(--text);font-size:1rem;outline:none;text-align:center;" />
      <input data-hi="${i}" data-field="title" type="text" maxlength="80" placeholder="Feature title"
        value="${escHtml(h.title||"")}"
        style="padding:7px 10px;background:var(--surface2);border:1.5px solid rgba(255,255,255,0.15);border-radius:6px;color:var(--text);font-size:0.85rem;outline:none;" />
      <input data-hi="${i}" data-field="text" type="text" maxlength="200" placeholder="Short description"
        value="${escHtml(h.text||"")}"
        style="padding:7px 10px;background:var(--surface2);border:1.5px solid rgba(255,255,255,0.15);border-radius:6px;color:var(--text);font-size:0.85rem;outline:none;" />
    `;
    editor.appendChild(row);
  });

  document.getElementById("about-save-error").textContent = "";
  document.getElementById("about-modal").style.display = "flex";
}

async function saveAbout() {
  const btn = document.getElementById("about-save-btn");
  btn.disabled = true;
  btn.textContent = "Saving…";

  const highlights = [];
  document.querySelectorAll("#about-highlights-editor [data-hi]").forEach(inp => {
    const i     = parseInt(inp.dataset.hi);
    const field = inp.dataset.field;
    if (!highlights[i]) highlights[i] = {icon:"",title:"",text:""};
    highlights[i][field] = inp.value.trim();
  });
  const filtered = highlights.filter(h => h.title || h.text);

  const body = {
    title:      document.getElementById("about-input-title").value.trim(),
    tagline:    document.getElementById("about-input-tagline").value.trim(),
    body:       document.getElementById("about-input-body").value.trim(),
    highlights: filtered,
  };

  try {
    const res = await fetch(`${API_BASE}/api/admin/about`, {
      method: "PATCH",
      headers: { ...apiHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (!res.ok) {
      document.getElementById("about-save-error").textContent = data.detail || "Save failed.";
      return;
    }
    _aboutData = data.about;
    renderAbout(_aboutData);
    document.getElementById("about-modal").style.display = "none";
  } catch (e) {
    document.getElementById("about-save-error").textContent = "Network error.";
  } finally {
    btn.disabled = false;
    btn.textContent = "Save";
  }
}

document.getElementById("about-edit-btn").addEventListener("click", openAboutEdit);
document.getElementById("about-modal-close").addEventListener("click", () => {
  document.getElementById("about-modal").style.display = "none";
});
document.getElementById("about-save-btn").addEventListener("click", saveAbout);

// Store indices data for right-panel reuse
let _lastIndices = [];

function renderIndices(indices) {
  _lastIndices = indices;
  const grid = document.getElementById("indices-grid");
  grid.innerHTML = "";
  indices.forEach(idx => {
    const up = idx.change_pct >= 0;
    const changeClass = idx.change_pct == null ? "flat" : up ? "up" : "dn";
    const changeText = idx.change_pct == null ? "—"
      : `${up ? "+" : ""}${idx.change_pct.toFixed(2)}%`;
    const priceText = idx.price != null
      ? idx.price.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })
      : "—";

    const card = document.createElement("div");
    card.className = "index-card";
    card.innerHTML = `
      <div class="index-name">${escHtml(idx.name)}</div>
      <div class="index-desc">${escHtml(idx.desc)}</div>
      <div class="index-sparkline" data-spark></div>
      <div class="index-bottom">
        <span class="index-price">${priceText}</span>
        <span class="index-change ${changeClass}">${changeText}</span>
      </div>`;
    grid.appendChild(card);

    requestAnimationFrame(() => {
      const spark = card.querySelector("[data-spark]");
      renderSparkline(spark, idx.sparkline, idx.change_pct);
    });
  });

  renderRightIndices(indices);
}

function renderRightIndices(indices) {
  const list = document.getElementById("right-indices-list");
  list.innerHTML = "";
  indices.forEach(idx => {
    const up = idx.change_pct >= 0;
    const changeClass = idx.change_pct == null ? "flat" : up ? "up" : "dn";
    const changeText = idx.change_pct == null ? "—"
      : `${up ? "+" : ""}${idx.change_pct.toFixed(2)}%`;
    const priceText = idx.price != null
      ? idx.price.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })
      : "—";

    const row = document.createElement("div");
    row.className = "right-index-row";
    row.title = "Back to Markets";
    row.innerHTML = `
      <span class="right-index-name">${escHtml(idx.name)}</span>
      <div class="right-index-right">
        <span class="right-index-price">${priceText}</span>
        <span class="right-index-chg ${changeClass}">${changeText}</span>
      </div>`;
    row.addEventListener("click", () => {
      state.lastData = null;
      stopPricePolling();
      showHome();
    });
    list.appendChild(row);
  });
}

function renderNews(items) {
  const list = document.getElementById("news-list");
  list.innerHTML = "";
  if (!items.length) {
    list.innerHTML = `<div style="color:var(--muted);font-size:0.85rem;">No news available.</div>`;
    return;
  }
  items.forEach(item => {
    const a = document.createElement("a");
    a.className = "news-item";
    a.href = item.url;
    a.target = "_blank";
    a.rel = "noopener noreferrer";
    const ts = item.datetime ? new Date(item.datetime * 1000).toLocaleDateString() : "";
    a.innerHTML = `
      ${item.image ? `<img class="news-thumb" src="${escHtml(item.image)}" alt="" loading="lazy" onerror="this.style.display='none'">` : ""}
      <div class="news-body">
        <div class="news-headline">${escHtml(item.headline)}</div>
        <div class="news-meta">${escHtml(item.source || "")}${ts ? " · " + ts : ""}</div>
      </div>`;
    list.appendChild(a);
  });
}

const KIND_ICONS = { article: "📰", video: "▶️", podcast: "🎙️", tool: "🛠️", book: "📚" };

function youtubeId(url) {
  try {
    const u = new URL(url);
    if (u.hostname === "youtu.be") return u.pathname.slice(1).split("?")[0];
    if (u.hostname.includes("youtube.com")) {
      if (u.pathname === "/watch") return u.searchParams.get("v");
      const m = u.pathname.match(/\/embed\/([^/?]+)/);
      if (m) return m[1];
    }
  } catch { /* invalid URL */ }
  return null;
}

function renderResources(items) {
  const block = document.getElementById("resources-block");
  const list  = document.getElementById("resources-list");
  const editBtn = document.getElementById("resources-edit-btn");

  if (auth.user && auth.user.is_admin) {
    editBtn.style.display = "";
  }

  if (!items.length && !(auth.user && auth.user.is_admin)) {
    block.style.display = "none";
    return;
  }
  block.style.display = "";
  list.innerHTML = "";

  items.forEach((item, idx) => {
    const div = document.createElement("div");
    div.className = "resource-item-wrap";
    const ytId = youtubeId(item.url);
    const icon = KIND_ICONS[item.kind] || "🔗";

    let domain = "";
    try { domain = new URL(item.url).hostname.replace("www.", ""); } catch {}
    const faviconUrl = domain ? `https://www.google.com/s2/favicons?domain=${domain}&sz=32` : "";

    const embedHtml = ytId ? `
      <div class="yt-embed-wrap">
        <iframe class="yt-embed"
          src="https://www.youtube.com/embed/${ytId}"
          title="${escHtml(item.title)}"
          frameborder="0"
          allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
          allowfullscreen loading="lazy"></iframe>
      </div>
      <div class="resource-body" style="padding:8px 4px 4px;">
        <div class="resource-title">${escHtml(item.title)}</div>
        ${item.description ? `<div class="resource-desc">${escHtml(item.description)}</div>` : ""}
        <div class="resource-source">${icon} ${escHtml(domain)}</div>
      </div>` : `
      <a class="resource-snippet" href="${escHtml(item.url)}" target="_blank" rel="noopener noreferrer">
        <div class="resource-snippet-header">
          ${faviconUrl ? `<img class="resource-favicon" src="${faviconUrl}" alt="" loading="lazy" onerror="this.style.display='none'">` : ""}
          <span class="resource-snippet-domain">${escHtml(domain)}</span>
          <span class="resource-snippet-kind">${icon}</span>
        </div>
        <div class="resource-snippet-title">${escHtml(item.title)}</div>
        ${item.description ? `<div class="resource-snippet-desc">${escHtml(item.description)}</div>` : ""}
      </a>`;

    div.innerHTML = `
      ${embedHtml}
      ${auth.user && auth.user.is_admin ? `
        <div class="resource-admin-row">
          <button class="wl-clear-btn res-up-btn"   data-id="${item.id}" ${idx === 0 ? "disabled" : ""}>↑</button>
          <button class="wl-clear-btn res-down-btn" data-id="${item.id}" ${idx === items.length - 1 ? "disabled" : ""}>↓</button>
          <button class="wl-clear-btn" onclick="editResource('${item.id}')">Edit</button>
          <button class="wl-clear-btn" style="color:var(--red);" onclick="deleteResource('${item.id}')">Delete</button>
        </div>` : ""}`;
    list.appendChild(div);
  });

  // Wire up reorder buttons
  if (auth.user && auth.user.is_admin) {
    list.querySelectorAll(".res-up-btn").forEach(btn => {
      btn.addEventListener("click", () => moveResource(btn.dataset.id, items, -1));
    });
    list.querySelectorAll(".res-down-btn").forEach(btn => {
      btn.addEventListener("click", () => moveResource(btn.dataset.id, items, 1));
    });
  }

  if (auth.user && auth.user.is_admin && !items.length) {
    list.innerHTML = `<div style="color:var(--muted);font-size:0.82rem;">No resources yet. Click "+ Add" to add one.</div>`;
  }
}

document.getElementById("resources-edit-btn").addEventListener("click", () => addResource());

async function addResource() {
  const title = prompt("Title:");
  if (!title) return;
  const url = prompt("URL:");
  if (!url) return;
  const description = prompt("Short description (optional):") || "";
  const kind = prompt("Kind: article / video / podcast / tool / book", "article") || "article";

  // Place new item at top: position = current minimum - 1
  let topPosition = 0;
  try {
    const existing = await (await fetch(`${API_BASE}/api/market/resources`, { headers: apiHeaders() })).json();
    if (existing.length) topPosition = Math.min(...existing.map(r => r.position)) - 1;
  } catch { /* use 0 */ }

  const res = await fetch(`${API_BASE}/api/market/resources`, {
    method: "POST",
    headers: apiHeaders(true),
    body: JSON.stringify({ title, url, description, kind, position: topPosition }),
  });
  if (res.ok) loadHome();
}

async function moveResource(id, items, direction) {
  const idx = items.findIndex(r => r.id === id);
  const swapIdx = idx + direction;
  if (swapIdx < 0 || swapIdx >= items.length) return;

  // Swap in a copy, then save all with clean sequential positions 0,1,2…
  const newOrder = [...items];
  [newOrder[idx], newOrder[swapIdx]] = [newOrder[swapIdx], newOrder[idx]];

  await Promise.all(newOrder.map((item, i) =>
    fetch(`${API_BASE}/api/market/resources/${item.id}`, {
      method: "PUT", headers: apiHeaders(true),
      body: JSON.stringify({ title: item.title, url: item.url, description: item.description || "", kind: item.kind || "article", position: i }),
    })
  ));
  loadHome();
}

async function editResource(id) {
  const existing = (await (await fetch(`${API_BASE}/api/market/resources`, { headers: apiHeaders() })).json())
    .find(r => r.id === id);
  if (!existing) return;
  const title = prompt("Title:", existing.title);
  if (title == null) return;
  const url = prompt("URL:", existing.url);
  if (url == null) return;
  const description = prompt("Description:", existing.description || "") || "";
  const kind = prompt("Kind:", existing.kind || "article") || "article";
  await fetch(`${API_BASE}/api/market/resources/${id}`, {
    method: "PUT",
    headers: apiHeaders(true),
    body: JSON.stringify({ title, url, description, kind, position: existing.position }),
  });
  loadHome();
}

async function deleteResource(id) {
  if (!confirm("Delete this resource?")) return;
  await fetch(`${API_BASE}/api/market/resources/${id}`, { method: "DELETE", headers: apiHeaders() });
  loadHome();
}

// Show/hide guest CTA in left nav
function updateNavGuestCta() {
  const cta = document.getElementById("nav-guest-cta");
  if (!cta) return;
  cta.style.display = auth.user ? "none" : "block";
}

document.getElementById("nav-signin-btn").addEventListener("click", () => openModal("login"));
document.getElementById("nav-register-btn").addEventListener("click", () => openModal("register"));

// ── Init ──────────────────────────────────────────────────
initAuth().then(() => { updateNavGuestCta(); loadHome(); });
loadTopTickers();
loadStats();
loadHome();
showHome();

// ── Portfolios ────────────────────────────────────────────
const portfolioState = { list: [], activeId: null, optimizeData: null, editing: false, activeTab: "holdings", perfLoaded: false, lastOptimizeRisk: false };

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
  document.getElementById("portfolio-add-manual").style.display = "none";
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
  portfolioState.activeTab = "holdings";
  portfolioState.perfLoaded = false;
  renderPortfolioDetail();
}

function renderPortfolioDetail() {
  document.getElementById("portfolio-list").style.display = "none";
  document.getElementById("portfolio-detail").style.display = "";
  document.getElementById("portfolio-add-manual").style.display = "flex";
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

  // Tab bar
  const tabBar = document.createElement("div");
  tabBar.style.cssText = "display:flex;gap:0;border-bottom:1px solid var(--border);margin-bottom:10px;";
  tabBar.innerHTML = `
    <button class="modal-tab ${portfolioState.activeTab === 'holdings' ? 'active' : ''}" id="ptab-holdings">Holdings</button>
    <button class="modal-tab ${portfolioState.activeTab === 'perf' ? 'active' : ''}" id="ptab-perf">Performance</button>
    <button class="modal-tab ${portfolioState.activeTab === 'risk' ? 'active' : ''}" id="ptab-risk">Risk</button>
  `;
  holdingsEl.appendChild(tabBar);
  tabBar.querySelector("#ptab-holdings").addEventListener("click", () => {
    portfolioState.activeTab = "holdings"; portfolioState.editing = false; renderPortfolioDetail();
  });
  tabBar.querySelector("#ptab-perf").addEventListener("click", () => {
    portfolioState.activeTab = "perf"; portfolioState.editing = false; portfolioState.perfLoaded = false; renderPortfolioDetail();
  });
  tabBar.querySelector("#ptab-risk").addEventListener("click", () => {
    portfolioState.activeTab = "risk"; portfolioState.editing = false; renderPortfolioDetail();
  });

  if (portfolioState.activeTab === "risk") {
    renderRiskTab(p, holdingsEl);
  } else if (portfolioState.activeTab === "perf") {
    renderPerformanceTab(p, holdingsEl);
  } else if (portfolioState.editing) {
    renderAllocationEditor(p);
  } else {
    p.holdings.forEach(h => {
      const row = document.createElement("div");
      row.className = "portfolio-holding-row";
      const hPct = h.pct_score;
      row.innerHTML = `
        <span class="ph-ticker" style="cursor:pointer;text-decoration:underline dotted;" title="Analyze ${h.ticker}">${h.ticker}</span>
        <span class="ph-name">${escHtml(h.name || "")}</span>
        <span class="ph-alloc">${h.allocation.toFixed(0)}%</span>
        <span class="ph-score" style="color:${hPct !== null ? scoreColor(hPct) : 'var(--muted)'}">
          ${hPct !== null ? hPct.toFixed(0) : "N/A"}
        </span>
        <button class="ph-remove" data-ticker="${h.ticker}">✕</button>
      `;
      row.querySelector(".ph-ticker").addEventListener("click", () => {
        tickerInput.value = h.ticker;
        analyze(h.ticker);
      });
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
    row.style.cssText = "flex-wrap:wrap;gap:4px;";
    row.innerHTML = `
      <span class="ph-ticker">${h.ticker}</span>
      <span class="ph-name" style="flex:1;">${escHtml(h.name || "")}</span>
      <label style="display:flex;align-items:center;gap:3px;font-size:0.72rem;color:var(--muted);">
        Alloc <input type="number" class="alloc-input" min="1" max="99" step="1" value="${h.allocation.toFixed(0)}" data-ticker="${h.ticker}" style="width:44px;" /> %
      </label>
      <label style="display:flex;align-items:center;gap:3px;font-size:0.72rem;color:var(--muted);" title="Max cap for optimizer">
        Max <input type="number" class="alloc-input cap-input" min="1" max="99" step="1" placeholder="—" value="${h.max_alloc ? h.max_alloc.toFixed(0) : ''}" data-ticker="${h.ticker}" style="width:40px;" /> %
      </label>
    `;
    holdingsEl.appendChild(row);
    inputs[h.ticker] = { alloc: row.querySelector('[data-ticker].alloc-input:not(.cap-input)'), cap: row.querySelector('.cap-input') };
  });

  // Sum hint
  const hint = document.createElement("div");
  hint.id = "alloc-sum-hint";
  hint.className = "alloc-sum-hint";
  holdingsEl.appendChild(hint);

  const updateHint = () => {
    const sum = Object.values(inputs).reduce((a, obj) => a + (parseFloat(obj.alloc.value) || 0), 0);
    hint.textContent = `Total: ${sum.toFixed(0)}% ${sum === 100 ? "✓" : "(must equal 100)"}`;
    hint.className = `alloc-sum-hint ${Math.abs(sum - 100) < 0.5 ? "alloc-sum-ok" : "alloc-sum-err"}`;
  };
  Object.values(inputs).forEach(obj => obj.alloc.addEventListener("input", updateHint));
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
    const sum = Object.values(inputs).reduce((a, obj) => a + (parseFloat(obj.alloc.value) || 0), 0);
    if (Math.abs(sum - 100) > 0.5) {
      hint.textContent = `Total must be 100. Currently ${sum.toFixed(1)}%.`;
      hint.className = "alloc-sum-hint alloc-sum-err";
      return;
    }
    const updated = p.holdings.map(h => ({
      ...h,
      allocation: parseFloat(inputs[h.ticker].alloc.value) || h.allocation,
      max_alloc: parseFloat(inputs[h.ticker].cap.value) || null,
    }));
    await saveAllocations(p.id, updated);
  });
}

function renderPerformanceTab(p, container) {
  // Money input form
  const formWrap = document.createElement("div");
  formWrap.style.cssText = "margin-bottom:10px;";

  const hasMoneyData = p.holdings.some(h => h.shares && h.avg_cost);

  if (!hasMoneyData) {
    formWrap.innerHTML = `<div style="font-size:0.8rem;color:var(--muted);margin-bottom:10px;">Enter your purchase details below to see total return including dividends.</div>`;
  }

  // Per-holding money inputs
  const inputs = {};
  p.holdings.forEach(h => {
    const row = document.createElement("div");
    row.style.cssText = "display:flex;flex-direction:column;gap:4px;padding:8px 0;border-bottom:1px solid var(--border);";
    row.innerHTML = `
      <div style="font-size:0.82rem;font-weight:700;color:var(--text);">${h.ticker} <span style="font-weight:400;color:var(--muted);">${escHtml(h.name || "")}</span></div>
      <div style="display:flex;gap:6px;flex-wrap:wrap;">
        <label style="display:flex;flex-direction:column;gap:2px;font-size:0.72rem;color:var(--muted);flex:1;min-width:60px;">
          Shares
          <input type="number" class="alloc-input" style="width:100%;" placeholder="e.g. 10" step="any" value="${h.shares || ''}" data-field="shares" data-ticker="${h.ticker}" />
        </label>
        <label style="display:flex;flex-direction:column;gap:2px;font-size:0.72rem;color:var(--muted);flex:1;min-width:70px;">
          Avg Cost ($)
          <input type="number" class="alloc-input" style="width:100%;" placeholder="e.g. 150.00" step="any" value="${h.avg_cost || ''}" data-field="avg_cost" data-ticker="${h.ticker}" />
        </label>
        <label style="display:flex;flex-direction:column;gap:2px;font-size:0.72rem;color:var(--muted);flex:1;min-width:100px;">
          Purchase Date
          <input type="date" class="alloc-input" style="width:100%;color:var(--text);background:var(--surface);" value="${h.purchase_date || ''}" data-field="purchase_date" data-ticker="${h.ticker}" />
        </label>
      </div>
    `;
    formWrap.appendChild(row);
    inputs[h.ticker] = {
      shares: row.querySelector('[data-field="shares"]'),
      avg_cost: row.querySelector('[data-field="avg_cost"]'),
      purchase_date: row.querySelector('[data-field="purchase_date"]'),
    };
  });

  const saveBtn = document.createElement("button");
  saveBtn.className = "auth-submit";
  saveBtn.style.cssText = "margin-top:10px;padding:8px;font-size:0.82rem;width:100%;";
  saveBtn.textContent = "Save & Calculate Return";
  formWrap.appendChild(saveBtn);

  container.appendChild(formWrap);

  // Results area
  const resultsEl = document.createElement("div");
  resultsEl.id = "perf-results";
  container.appendChild(resultsEl);

  saveBtn.addEventListener("click", async () => {
    saveBtn.disabled = true;
    saveBtn.textContent = "Saving…";

    // Save each holding's money data
    const updated = p.holdings.map(h => ({
      ...h,
      shares: parseFloat(inputs[h.ticker].shares.value) || null,
      avg_cost: parseFloat(inputs[h.ticker].avg_cost.value) || null,
      purchase_date: inputs[h.ticker].purchase_date.value || null,
    }));

    await fetch(`${API_BASE}/api/me/portfolios/${p.id}/holdings`, {
      method: "PUT",
      headers: apiHeaders(true),
      body: JSON.stringify({ holdings: updated }),
    });

    saveBtn.textContent = "Loading performance…";

    // Fetch performance
    try {
      const res = await fetch(`${API_BASE}/api/me/portfolios/${p.id}/performance`, {
        headers: apiHeaders(),
      });
      if (res.ok) {
        const data = await res.json();
        renderPerfResults(data, resultsEl);
        // Sync allocations in background — don't block showing results
        syncAllocationsFromPerf(p, updated, data).then(() => loadPortfolios()).catch(() => {});
      } else {
        const err = await res.json().catch(() => ({}));
        resultsEl.innerHTML = `<div style="color:var(--red);font-size:0.82rem;margin-top:8px;">Error: ${err.detail || res.status}</div>`;
      }
    } catch (e) {
      resultsEl.innerHTML = `<div style="color:var(--red);font-size:0.82rem;margin-top:8px;">Network error: ${e.message}</div>`;
    }

    saveBtn.disabled = false;
    saveBtn.textContent = "Save & Calculate Return";
  });

  // Auto-load if money data already exists (only once per open, not on re-render)
  if (hasMoneyData && !portfolioState.perfLoaded) {
    portfolioState.perfLoaded = true;
    (async () => {
      resultsEl.innerHTML = `<div style="color:var(--muted);font-size:0.82rem;margin-top:8px;">Loading performance…</div>`;
      try {
        const res = await fetch(`${API_BASE}/api/me/portfolios/${p.id}/performance`, { headers: apiHeaders() });
        if (res.ok) {
          const data = await res.json();
          renderPerfResults(data, resultsEl);
          // Sync allocations silently — no loadPortfolios() to avoid re-render loop
          syncAllocationsFromPerf(p, p.holdings, data).catch(() => {});
        } else {
          const err = await res.json().catch(() => ({}));
          resultsEl.innerHTML = `<div style="color:var(--red);font-size:0.82rem;margin-top:8px;">Error: ${err.detail || res.status}</div>`;
        }
      } catch (e) {
        resultsEl.innerHTML = `<div style="color:var(--red);font-size:0.82rem;margin-top:8px;">Network error: ${e.message}</div>`;
      }
    })();
  }
}

function renderRiskTab(p, container) {
  const wrap = document.createElement("div");
  wrap.innerHTML = `<div style="color:var(--muted);font-size:0.82rem;padding:8px 0;">Fetching risk metrics…</div>`;
  container.appendChild(wrap);

  (async () => {
    try {
      const res = await fetch(`${API_BASE}/api/me/portfolios/${p.id}/risk`, { headers: apiHeaders() });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        wrap.innerHTML = `<div style="color:var(--red);font-size:0.82rem;">Failed to load risk data: ${err.detail || res.status}</div>`;
        return;
      }
      const data = await res.json();

      const riskColor = (beta) => {
        if (beta == null) return "var(--muted)";
        if (beta < 0.8)  return "var(--green)";
        if (beta < 1.2)  return "var(--text)";
        if (beta < 1.8)  return "var(--amber)";
        return "var(--red)";
      };
      const volColor = (v) => {
        if (v == null) return "var(--muted)";
        if (v < 20)  return "var(--green)";
        if (v < 35)  return "var(--text)";
        if (v < 50)  return "var(--amber)";
        return "var(--red)";
      };
      const ddColor = (d) => {
        if (d == null) return "var(--muted)";
        if (d < 10)  return "var(--green)";
        if (d < 20)  return "var(--text)";
        if (d < 35)  return "var(--amber)";
        return "var(--red)";
      };

      let html = "";

      // Portfolio summary
      if (data.portfolio_beta != null || data.portfolio_volatility != null) {
        html += `
          <div style="background:var(--surface2);border:1px solid var(--border);border-radius:10px;padding:12px;margin-bottom:12px;">
            <div style="font-size:0.68rem;font-weight:700;text-transform:uppercase;letter-spacing:0.1em;color:var(--muted);margin-bottom:8px;">Portfolio (Weighted)</div>
            <div style="display:flex;gap:16px;flex-wrap:wrap;">
              ${data.portfolio_beta != null ? `<div><div style="font-size:0.68rem;color:var(--muted);">Weighted Beta</div><div style="font-size:1.1rem;font-weight:700;color:${riskColor(data.portfolio_beta)};">${data.portfolio_beta}</div></div>` : ""}
              ${data.portfolio_volatility != null ? `<div><div style="font-size:0.68rem;color:var(--muted);">Avg Volatility</div><div style="font-size:1.1rem;font-weight:700;color:${volColor(data.portfolio_volatility)};">${data.portfolio_volatility}%</div></div>` : ""}
            </div>
          </div>`;
      }

      // Per-holding table
      html += `<div style="font-size:0.68rem;font-weight:700;text-transform:uppercase;letter-spacing:0.08em;color:var(--muted);margin-bottom:6px;">Per Holding (1-Year Data)</div>`;

      data.holdings.forEach(h => {
        if (h.error) {
          html += `<div style="padding:6px 0;border-bottom:1px solid var(--border);font-size:0.78rem;color:var(--muted);">${h.ticker} — data unavailable${h.error_msg ? ': ' + h.error_msg : ''}</div>`;
          return;
        }
        const returnColor = h.return_1y == null ? "var(--muted)" : h.return_1y >= 0 ? "var(--green)" : "var(--red)";
        html += `
          <div style="padding:10px 0;border-bottom:1px solid var(--border);">
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;">
              <span style="font-weight:700;color:var(--accent);cursor:pointer;text-decoration:underline dotted;" onclick="tickerInput.value='${h.ticker}';analyze('${h.ticker}')">${h.ticker}</span>
              <span style="font-size:0.78rem;font-weight:700;color:${returnColor};">${h.return_1y != null ? (h.return_1y >= 0 ? "+" : "") + h.return_1y + "% 1Y" : "—"}</span>
            </div>
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:6px;font-size:0.75rem;">
              <div>
                <span style="color:var(--muted);">Beta </span>
                <span style="font-weight:600;color:${riskColor(h.beta)};">${h.beta != null ? h.beta : "—"}</span>
                <span style="font-size:0.65rem;color:var(--muted);margin-left:3px;">${h.beta == null ? "" : h.beta < 0.8 ? "(low)" : h.beta < 1.2 ? "(market)" : h.beta < 1.8 ? "(high)" : "(very high)"}</span>
              </div>
              <div>
                <span style="color:var(--muted);">Volatility </span>
                <span style="font-weight:600;color:${volColor(h.volatility_1y)};">${h.volatility_1y != null ? h.volatility_1y + "%" : "—"}</span>
              </div>
              <div>
                <span style="color:var(--muted);">Max Drawdown </span>
                <span style="font-weight:600;color:${ddColor(h.max_drawdown_1y)}">${h.max_drawdown_1y != null ? "-" + h.max_drawdown_1y + "%" : "—"}</span>
              </div>
              <div>
                <span style="color:var(--muted);">52W Range </span>
                <span style="font-weight:600;color:var(--text);">${h.week52_low != null ? "$" + h.week52_low : "—"} – ${h.week52_high != null ? "$" + h.week52_high : "—"}</span>
              </div>
              ${h.pct_from_52w_high != null ? `<div style="grid-column:span 2;"><span style="color:var(--muted);">From 52W High </span><span style="font-weight:600;color:${h.pct_from_52w_high >= -5 ? "var(--amber)" : "var(--muted)"};">${h.pct_from_52w_high}%</span></div>` : ""}
            </div>
          </div>`;
      });

      // Legend
      html += `
        <div style="margin-top:10px;font-size:0.68rem;color:var(--muted);line-height:1.6;">
          <div style="font-weight:700;margin-bottom:2px;">Beta guide:</div>
          <span style="color:var(--green);">< 0.8 low risk</span> ·
          <span>0.8–1.2 market</span> ·
          <span style="color:var(--amber);">1.2–1.8 elevated</span> ·
          <span style="color:var(--red);">> 1.8 high risk</span>
        </div>`;

      wrap.innerHTML = html;
    } catch (e) {
      wrap.innerHTML = `<div style="color:var(--red);font-size:0.82rem;">Error: ${e.message}</div>`;
    }
  })();
}

async function syncAllocationsFromPerf(p, holdings, perfData) {
  // Build ticker → current_value map from performance results
  const valueMap = {};
  let totalValue = 0;
  perfData.holdings.forEach(h => {
    if (h.current_value != null) {
      valueMap[h.ticker] = h.current_value;
      totalValue += h.current_value;
    }
  });
  if (totalValue <= 0) return; // no prices available, skip

  // Compute real-weight allocations, rounded to 1 decimal
  const updated = holdings.map(h => ({
    ...h,
    allocation: valueMap[h.ticker] != null
      ? parseFloat(((valueMap[h.ticker] / totalValue) * 100).toFixed(1))
      : h.allocation,
  }));

  // Fix rounding drift so total = exactly 100
  const sum = updated.reduce((s, h) => s + h.allocation, 0);
  const drift = parseFloat((100 - sum).toFixed(1));
  if (drift !== 0 && updated.length > 0) updated[0].allocation = parseFloat((updated[0].allocation + drift).toFixed(1));

  await fetch(`${API_BASE}/api/me/portfolios/${p.id}/holdings`, {
    method: "PUT",
    headers: apiHeaders(true),
    body: JSON.stringify({ holdings: updated }),
  });
}

function renderPerfResults(data, el) {
  const fmt$ = v => v != null ? `$${v.toLocaleString("en-US", {minimumFractionDigits:2, maximumFractionDigits:2})}` : "—";
  const fmtPct = v => v != null ? `${v >= 0 ? "+" : ""}${v.toFixed(2)}%` : "—";
  const color = v => v == null ? "var(--muted)" : v >= 0 ? "var(--green)" : "var(--red)";

  let html = `
    <div style="background:var(--surface2);border:1px solid var(--border);border-radius:10px;padding:14px;margin:12px 0 8px;">
      <div style="font-size:0.68rem;font-weight:700;text-transform:uppercase;letter-spacing:0.1em;color:var(--muted);margin-bottom:10px;">Portfolio Total</div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;">
        <div><div style="font-size:0.72rem;color:var(--muted);">Invested</div><div style="font-size:1rem;font-weight:700;">${fmt$(data.total_invested)}</div></div>
        <div><div style="font-size:0.72rem;color:var(--muted);">Current Value</div><div style="font-size:1rem;font-weight:700;">${fmt$(data.total_current_value)}</div></div>
        <div><div style="font-size:0.72rem;color:var(--muted);">Dividends</div><div style="font-size:1rem;font-weight:700;color:var(--green);">${fmt$(data.total_dividends)}</div></div>
        <div><div style="font-size:0.72rem;color:var(--muted);">Total Return</div>
          <div style="font-size:1rem;font-weight:700;color:${color(data.total_return)};">${fmt$(data.total_return)} <span style="font-size:0.82rem;">(${fmtPct(data.total_return_pct)})</span></div>
        </div>
      </div>
    </div>
  `;

  data.holdings.forEach(h => {
    if (!h.invested) return;
    html += `
      <div style="padding:8px 0;border-bottom:1px solid var(--border);font-size:0.78rem;">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px;">
          <span style="font-weight:700;color:var(--accent);cursor:pointer;text-decoration:underline dotted;" onclick="tickerInput.value='${h.ticker}';analyze('${h.ticker}')">${h.ticker}</span>
          <span style="color:${color(h.total_return)};font-weight:700;">${fmt$(h.total_return)} <span style="font-size:0.72rem;">(${fmtPct(h.total_return_pct)})</span></span>
        </div>
        <div style="display:flex;gap:12px;color:var(--muted);flex-wrap:wrap;">
          <span>${h.shares} shares @ ${fmt$(h.avg_cost)}</span>
          <span>Invested: ${fmt$(h.invested)}</span>
          <span>Now: ${fmt$(h.current_value)}</span>
          ${h.dividends_received ? `<span style="color:var(--green);">Div: +${fmt$(h.dividends_received)}</span>` : ""}
          <span>Price gain: <span style="color:${color(h.price_gain)};">${fmtPct(h.price_gain_pct)}</span></span>
        </div>
      </div>
    `;
  });

  el.innerHTML = html;
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

// ── Manual add ticker to portfolio ───────────────────────
document.getElementById("portfolio-manual-ticker").addEventListener("keydown", e => {
  if (e.key === "Enter") document.getElementById("portfolio-manual-add-btn").click();
});
document.getElementById("portfolio-manual-ticker").addEventListener("input", e => {
  e.target.value = e.target.value.toUpperCase();
});

document.getElementById("portfolio-manual-add-btn").addEventListener("click", async () => {
  const input = document.getElementById("portfolio-manual-ticker");
  const ticker = input.value.trim().toUpperCase();
  if (!ticker) return;

  const p = portfolioState.list.find(x => x.id === portfolioState.activeId);
  if (!p) return;
  if (p.holdings.find(h => h.ticker === ticker)) {
    input.value = "";
    return; // already in portfolio
  }

  const btn = document.getElementById("portfolio-manual-add-btn");
  btn.disabled = true;
  btn.textContent = "…";

  // Try to get score data from cache (no-spin analyze call)
  let newHolding = { ticker, mode: "stock", name: null, score: null, max_score: null, pct_score: null, stars: null, allocation: 0 };
  try {
    const res = await fetch(`${API_BASE}/api/analyze/${ticker}`, { headers: apiHeaders() });
    if (res.ok) {
      const d = await res.json();
      newHolding = { ticker: d.ticker, mode: d.type, name: d.name, score: d.total, max_score: d.max_total, pct_score: d.pct, stars: d.stars, allocation: 0 };
    }
  } catch { /* use bare holding if offline */ }

  // Distribute allocation evenly
  const n = p.holdings.length + 1;
  const evenAlloc = parseFloat((100 / n).toFixed(1));
  const updatedHoldings = [...p.holdings, newHolding].map((h, i, arr) => ({
    ...h,
    allocation: i < arr.length - 1 ? evenAlloc : parseFloat((100 - evenAlloc * (arr.length - 1)).toFixed(1)),
  }));

  await saveAllocations(p.id, updatedHoldings);
  input.value = "";
  btn.disabled = false;
  btn.textContent = "+ Add";
});

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

async function runOptimize(riskWeighted) {
  const panel = document.getElementById("optimize-panel");
  const btn = document.getElementById(riskWeighted ? "optimize-risk-btn" : "optimize-btn");
  const otherBtn = document.getElementById(riskWeighted ? "optimize-btn" : "optimize-risk-btn");

  // Toggle off if already showing same mode
  if (panel.style.display !== "none" && portfolioState.lastOptimizeRisk === riskWeighted) {
    panel.style.display = "none"; return;
  }

  btn.disabled = true;
  btn.textContent = riskWeighted ? "Fetching betas…" : "Optimizing…";
  otherBtn.disabled = true;

  try {
    const res = await fetch(
      `${API_BASE}/api/me/portfolios/${portfolioState.activeId}/optimize?risk_weighted=${riskWeighted}`,
      { headers: apiHeaders() }
    );
    if (!res.ok) { alert((await res.json()).detail || "Could not optimize."); return; }
    const data = await res.json();
    portfolioState.optimizeData = data;
    portfolioState.lastOptimizeRisk = riskWeighted;

    document.getElementById("opt-current-score").textContent = data.current_score.toFixed(1);
    document.getElementById("opt-new-score").textContent     = data.optimized_score.toFixed(1);

    const rows = document.getElementById("optimize-rows");
    rows.innerHTML = "";

    // Header label
    const hdr = document.createElement("div");
    hdr.style.cssText = "font-size:0.68rem;color:var(--muted);padding:4px 0 6px;text-transform:uppercase;letter-spacing:0.06em;";
    hdr.textContent = riskWeighted ? "Risk-adjusted optimization (high-beta stocks penalised)" : "Category-complementarity optimization";
    rows.appendChild(hdr);

    data.holdings.forEach(h => {
      const row = document.createElement("div");
      row.className = "optimize-row";
      row.style.cssText = "flex-direction:column;align-items:flex-start;gap:2px;padding:6px 0;";

      const cappedTag = h.capped ? `<span style="font-size:0.65rem;color:var(--amber);margin-left:4px;" title="Max cap applied">⚠ capped</span>` : "";
      const riskTag = (riskWeighted && h.risk_penalty != null && h.risk_penalty < 0.95)
        ? `<span style="font-size:0.65rem;color:var(--red);margin-left:4px;" title="High beta — penalised">β↑</span>` : "";

      let driverText = "";
      if (h.top_category) {
        driverText = `<div style="font-size:0.68rem;color:var(--muted);padding-left:2px;">Driver: <span style="color:var(--blue);">${h.top_category}</span> (${h.top_category_pct != null ? h.top_category_pct.toFixed(0)+'%' : '—'})</div>`;
      }

      row.innerHTML = `
        <div style="display:flex;align-items:center;width:100%;gap:4px;">
          <span class="opt-ticker">${h.ticker}</span>
          <span class="ph-name" style="flex:1;font-size:0.72rem;">${escHtml(h.name || "")}</span>
          <span class="opt-current">${h.current_allocation.toFixed(0)}%</span>
          <span class="opt-arrow-sm">→</span>
          <span class="opt-new">${h.optimized_allocation.toFixed(0)}%</span>
          ${cappedTag}${riskTag}
        </div>
        ${driverText}
      `;
      rows.appendChild(row);
    });
    panel.style.display = "";
  } finally {
    btn.disabled = false;
    btn.textContent = riskWeighted ? "Optimize + Risk" : "Optimize";
    otherBtn.disabled = false;
  }
}

document.getElementById("optimize-btn").addEventListener("click", () => runOptimize(false));
document.getElementById("optimize-risk-btn").addEventListener("click", () => runOptimize(true));

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

