// Relative URL — frontend is served by the same FastAPI server
const API_BASE = "";
// Injected at build time by the server or set here for the web client
const API_KEY  = window.CERBYFI_API_KEY || "";

const state = { mode: "stock" };

// ── DOM refs ──────────────────────────────────────────────
const form          = document.getElementById("search-form");
const tickerInput   = document.getElementById("ticker-input");
const analyzeBtn    = document.getElementById("analyze-btn");
const errorSection  = document.getElementById("error-section");
const errorMsg      = document.getElementById("error-msg");
const resultsSection = document.getElementById("results-section");

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
      renderResults(data);
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
