# CerbyFi — Product Requirements Document

**Version**: 1.0
**Date**: March 2026
**Status**: Live

---

## 1. Overview

### 1.1 Product Summary

CerbyFi is a web application that scores any US stock or ETF/fund on a 100-point framework. Users can look up any ticker, see a structured breakdown of its financial health across multiple categories, save items to a watchlist, and build portfolios with weighted aggregate scores and optimizer suggestions.

### 1.2 Problem Statement

Retail investors face information overload when evaluating stocks and ETFs. Financial data is either too raw (raw fundamentals from data APIs) or too opinionated (analyst ratings). There is no simple, transparent, reproducible score that tells a user how a stock or fund compares across key dimensions on a single normalized scale.

### 1.3 Goals

- Provide a single 0–100 score for any US stock or ETF that is transparent, reproducible, and broken down by category.
- Allow users to track stocks they care about via a persistent watchlist.
- Allow users to build hypothetical portfolios and see how individual holdings contribute to a weighted aggregate score.
- Suggest the mathematically optimal allocation across a portfolio to maximize the aggregate score.

### 1.4 Non-Goals

- Real-time price data or trading functionality.
- Buy/sell recommendations or financial advice.
- Non-US markets (out of scope for v1).
- Mobile native app (separate project).

---

## 2. Users

### 2.1 Target Users

| Persona | Description |
|---|---|
| **Retail investor** | Self-directed investor who wants a quick, structured way to evaluate stocks before researching further. |
| **Portfolio builder** | User who holds or is considering a basket of stocks and wants to understand how the mix affects overall quality. |
| **Curious browser** | User who wants to quickly look up a ticker and see how it scores without creating an account. |

### 2.2 Authentication Model

- **Anonymous user**: can search and view scores. Clicking "+ Watchlist" opens the sign-in prompt.
- **Registered user**: persistent server-side watchlist; can create and manage portfolios; watchlist survives across devices and sessions.

---

## 3. Features

### 3.1 Stock & ETF Scoring

**Description**: User enters a ticker symbol. The system auto-detects whether it is a stock or ETF and returns a scored result.

**Requirements**:
- Single text input; no mode selector required.
- System first attempts stock scoring via Finnhub. If no data is returned, falls back to ETF/fund scoring via FMP.
- Score is on a 0–100 scale, broken down into weighted categories.
- Each category shows: score, max score, percentage, and a color-coded progress bar.
- Each category is expandable to show individual metrics with their display value, score, and max.
- Result header shows: company/fund name, ticker, type badge (Stock / ETF / Fund), total score, star rating (1–5), rating label, and progress bar.
- If result is served from cache, display cache timestamp.
- After a result loads, a "+ Watchlist" button allows saving the item.
- Every successful analysis increments the global analysis counter.

**Scoring categories (stocks)**:

| Category | Max Points | Key Metrics |
|---|---|---|
| Valuation | 20 | P/E ratio, P/B ratio, P/S ratio, EV/EBITDA |
| Profitability | 20 | Net margin, ROE, ROA, FCF margin |
| Growth | 20 | Revenue growth, EPS growth |
| Financial Health | 20 | Debt/equity, current ratio, interest coverage |
| Momentum & Technicals | 20 | 52-week price performance, beta |

**Scoring categories (ETFs/funds)**:

| Category | Max Points | Key Metrics |
|---|---|---|
| Valuation | 25 | P/E ratio (Yahoo Finance), P/B ratio |
| Performance | 25 | 1Y / 3Y returns |
| Risk | 25 | Beta, standard deviation |
| Cost | 25 | Expense ratio |

**Data sources**:
- Stocks: Finnhub `/stock/profile2` + `/stock/metric?metric=all`
- ETFs: FMP `/stable/profile`
- ETF P/E: Yahoo Finance `quoteSummary` with crumb + cookie authentication (cached 1 hour)

**Caching**: Scores are cached in SQLite for 24 hours (configurable). Cache key is `stock:{ticker}` or `fund:{ticker}`.

---

### 3.2 Watchlist

**Description**: Users can save tickers to a watchlist for quick re-access from the sidebar.

**Requirements**:
- Watchlist appears in the left sidebar above Most Searched.
- Maximum 10 items displayed.
- Each card shows: name, ticker, type badge, score/max, color-coded progress bar, star rating.
- Clicking a card triggers a new analysis for that ticker.
- Each card has a remove (✕) button.
- "Clear all" button removes all items.
- Requires a registered account. Clicking "+ Watchlist" while not signed in opens the sign-in modal automatically.
- Stored server-side; synced on login and page load; survives across devices.
- Watchlist is hidden when not signed in.

---

### 3.3 Most Searched

**Description**: Shows the top 10 most-analyzed stocks and ETFs across all users.

**Requirements**:
- Appears in the left sidebar below Watchlist (or Portfolios if logged in).
- Two columns: Stocks | ETFs / Funds, each showing top 10.
- Each item shows: rank, ticker, name, score/max, lookup count.
- Clicking an item triggers analysis.
- Only shown when at least one item exists.
- Updates after every analysis.

---

### 3.4 User Accounts

**Description**: Users can create an account to get persistent, server-side data.

**Requirements**:
- Registration requires: name, email, password (min 6 characters).
- Login requires: email, password.
- Passwords are bcrypt-hashed; never stored in plain text.
- Authentication token is a JWT with 30-day expiry, stored in `localStorage`.
- Token is validated on page load via `GET /api/auth/me`; stale tokens are cleared automatically.
- Header shows "Hi, [Name]" and a Sign out button when logged in.
- Header shows Sign in and Register buttons when logged out.
- Auth UI is a modal with tab-switching between Sign in and Register forms.
- Inline error messages for failed login/registration.

---

### 3.5 Portfolios

**Description**: Logged-in users can create named portfolios of stocks/ETFs with percentage allocations and view a weighted aggregate score.

**Requirements**:

**Portfolio management**:
- Users can create multiple named portfolios (prompted by name on creation).
- Each portfolio is listed in the left sidebar (below Watchlist, above Most Searched) when logged in.
- Clicking a portfolio opens its detail view within the sidebar.
- Portfolios can be renamed (PATCH) or deleted.
- Deleting a portfolio also deletes all its holdings.

**Holdings**:
- A holding consists of: ticker, asset type, name, score data (copied from last analysis), and allocation %.
- Holdings are added from the current analysis result ("+ Add [TICKER] to this portfolio" button).
- When a new holding is added, existing allocations are automatically normalized to sum to 100%.
- Holdings can be removed individually (✕ button per row).
- Holdings display: ticker, name, allocation %, score percentage (color-coded).

**Allocation editing**:
- When a portfolio has ≥ 2 holdings, an "Edit allocations" button appears.
- Editor shows number inputs per holding; a live sum hint updates as values change.
- Sum hint turns red if total ≠ 100%; turns green if total = 100%.
- Save is blocked if total is not within 0.5% of 100%.
- Changes are persisted via `PUT /api/me/portfolios/{id}/holdings`.

**Aggregate score**:
- Displayed at the top of the portfolio detail view.
- Formula: `Σ (allocation_i / 100) × pct_score_i`
- Shown as a number (0–100) with a color-coded progress bar.
- Recalculated on any change to holdings or allocations.

**Portfolio optimizer**:
- "Optimize" button fetches the optimal allocation for the current holdings.
- Optimizer uses a greedy algorithm:
  - Every holding receives a minimum floor of **5%**.
  - No single holding may exceed a cap of **60%**.
  - Remaining budget (after floors) is allocated to the highest-scoring holdings first, each up to the cap.
  - Result always produces an aggregate score ≥ the current allocation.
- UI shows a "Current → Optimized" score comparison panel.
- Each holding shows its current allocation and suggested new allocation.
- "Apply Allocation" saves the optimized allocation immediately.
- Optimizer panel can be toggled open/closed without losing state.

---

### 3.6 Analysis Counter

**Description**: A running total of all analyses ever performed, shown in the header.

**Requirements**:
- Displayed in the header subtitle: e.g., `Stock & fund scoring — 100-point framework · 143 analyses run`.
- Updates after every successful analysis.
- Hidden when count is 0.
- Fetched from `GET /api/stats` (public endpoint, no API key required).

---

## 4. Non-Functional Requirements

### 4.1 Performance
- Cached results must return in < 200ms.
- Uncached results may take 1–5 seconds depending on external API latency.
- Yahoo Finance crumb is cached for 1 hour to avoid repeated auth round-trips.

### 4.2 Security
- All `/api/*` routes require `X-API-Key` header (except auth endpoints).
- JWT-protected routes require `Authorization: Bearer <token>`.
- Passwords are bcrypt-hashed with a generated salt.
- `JWT_SECRET` must be set to a strong random value in production.
- HTTPS enforced via `X-Forwarded-Proto` redirect middleware (Railway).
- CORS locked to known origins via `ALLOWED_ORIGINS` env var.

### 4.3 Persistence
- SQLite with WAL journal mode for thread-safe concurrent reads.
- Production database at `/data/cerbyfi.db` (Railway volume mount).
- Development/fallback database at `/tmp/cerbyfi_cache.db`.
- Score cache TTL is configurable (default 24 hours).

### 4.4 Reliability
- External API failures are caught and surfaced as user-facing error messages.
- Cache serves stale data gracefully when external APIs are unavailable (within TTL).
- Individual cache entries can be invalidated via `DELETE /api/cache/{key}`.

### 4.5 Responsiveness
- Two-column layout: sidebar (left, 300px) + main content (right, flexible).
- On screens ≤ 780px wide, layout stacks: main content on top, sidebar below.

---

## 5. Data Model

### 5.1 Tables

| Table | Purpose |
|---|---|
| `score_cache` | Cached scoring results (key, JSON value, timestamp) |
| `lookups` | Per-ticker analysis counts and last-seen score data |
| `users` | Registered user accounts (id, email, name, bcrypt hash) |
| `watchlist` | Per-user watchlist items with saved score snapshot |
| `portfolios` | Named portfolios (id, user_id, name, timestamps) |
| `portfolio_holdings` | Holdings per portfolio (ticker, allocation, score snapshot) |

---

## 6. API Summary

See [README.md](../README.md) for the full endpoint reference.

---

## 7. Deployment

- **Platform**: Railway
- **Service**: Single FastAPI service serving both API and static frontend
- **Volume**: Railway volume mounted at `/data` for persistent SQLite
- **Required env vars**: `FINNHUB_API_KEY`, `FMP_API_KEY`, `CERBYFI_API_KEY`, `ALLOWED_ORIGINS`, `JWT_SECRET`
- **CI/CD**: Auto-deploy on push to `main`

---

## 8. Future Considerations

The following are not in scope for v1 but may be considered later:

- **Price alerts**: notify users when a watched ticker's score changes significantly.
- **Score history**: track how a ticker's score changes over time.
- **Comparison view**: side-by-side score breakdown for two tickers.
- **International markets**: expand beyond US stocks/ETFs.
- **Portfolio benchmarking**: compare portfolio aggregate score against SPY/QQQ.
- **Email notifications**: weekly portfolio digest.
- **CSV export**: download watchlist or portfolio as CSV.
