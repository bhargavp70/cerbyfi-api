"""Premium-only endpoints."""
import time
import requests
from fastapi import APIRouter, Depends, HTTPException
from app.config import settings
from app.db import score_db
from app.user_auth import require_premium

router = APIRouter(prefix="/api/premium", tags=["premium"])

_ANTHROPIC_URL = "https://api.anthropic.com/v1/messages"
_ANTHROPIC_HEADERS = {
    "anthropic-version": "2023-06-01",
    "content-type": "application/json",
}
_WEB_SEARCH_TOOL = {"type": "web_search_20250305", "name": "web_search", "max_uses": 8}


def _call_claude(messages: list, max_turns: int = 12) -> str:
    """
    Agentic loop: keep calling Claude until stop_reason is end_turn.
    Handles the web_search tool, which Anthropic executes server-side —
    we just need to re-submit the conversation with the tool results included.
    """
    for _ in range(max_turns):
        try:
            res = requests.post(
                _ANTHROPIC_URL,
                headers={**_ANTHROPIC_HEADERS, "x-api-key": settings.claude_api_key},
                json={
                    "model": "claude-sonnet-4-6",
                    "max_tokens": 2500,
                    "tools": [_WEB_SEARCH_TOOL],
                    "messages": messages,
                },
                timeout=90,
            )
        except requests.RequestException as e:
            raise HTTPException(status_code=502, detail=f"Could not reach AI service: {e}")

        if not res.ok:
            detail = res.json().get("error", {}).get("message", res.text)
            raise HTTPException(status_code=res.status_code, detail=detail)

        data = res.json()
        content = data.get("content", [])
        stop_reason = data.get("stop_reason")

        if stop_reason == "end_turn":
            texts = [b["text"] for b in content if b.get("type") == "text"]
            result = "\n\n".join(texts).strip()
            # Strip any "thinking aloud" preamble before the first section heading
            if "## " in result:
                result = result[result.index("## "):]
            return result

        if stop_reason == "tool_use":
            # Append assistant turn, then send tool results back
            messages.append({"role": "assistant", "content": content})
            tool_results = [
                {"type": "tool_result", "tool_use_id": b["id"], "content": b.get("content", "")}
                for b in content if b.get("type") == "tool_use"
            ]
            messages.append({"role": "user", "content": tool_results})
        else:
            # Unexpected stop reason — return whatever text we have
            texts = [b["text"] for b in content if b.get("type") == "text"]
            return "\n\n".join(texts).strip()

    raise HTTPException(status_code=504, detail="AI analysis timed out (too many search rounds).")


@router.post("/ai-analyze")
def ai_analyze(body: dict, user_id: str = Depends(require_premium)):
    if not settings.claude_api_key:
        raise HTTPException(status_code=503, detail="AI analysis is not configured.")

    data = body.get("data")
    if not data:
        raise HTTPException(status_code=422, detail="data field required.")

    ticker = data.get("ticker", "").upper()

    # Return cached report if still fresh (10-day TTL)
    cached_text = score_db.get_ai_analysis(ticker)
    if cached_text:
        generated_at = score_db.ai_analysis_cache_info(ticker)
        return {"text": cached_text, "cached": True, "generated_at": generated_at}

    name   = data.get("name", ticker)
    score  = data.get("total", "?")
    max_s  = data.get("max_total", 100)
    pct    = data.get("pct", 0)
    rating = data.get("rating_label", "")
    asset_type = "ETF/fund" if data.get("type") == "fund" else "company"

    category_lines = "\n".join(
        f"  • {cat['label']}: {cat['score']}/{cat['max']} ({cat['pct']:.0f}%)"
        for cat in data.get("categories", {}).values()
    )

    prompt = f"""You are a senior equity research analyst writing a comprehensive briefing for a retail investor about {name} ({ticker}).

CerbyFi has scored this {asset_type} {score}/{max_s} ({pct:.0f}%) — rated "{rating}".

Score breakdown:
{category_lines}

Your job is to go far beyond these numbers. Use web search to research:
- Recent news and developments (last 3–6 months)
- What Wall Street and independent analysts are currently saying
- Public and retail investor sentiment
- Key business developments, earnings surprises, product launches, executive changes
- Competitive landscape and market position
- Any risks or controversies investors should know about

Write a compelling, narrative-driven research briefing with these exact sections:

## The Company & Its Story
2–3 sentences on what this {asset_type} actually does, its core business model, and why it matters in its industry. Write for someone who has never heard of it.

## What the Score Reveals
Explain what the CerbyFi score tells us about this {asset_type}'s financial health. Connect the category scores to real business realities — not just "valuation is low" but why that matters in this context.

## Recent News & Developments
3–4 key recent developments (news, earnings, products, partnerships, regulatory events). Be specific — include approximate dates if known. Source from web search.

## What Analysts Are Saying
Summarize current Wall Street sentiment and notable analyst opinions. Include any recent rating changes, price target revisions, or consensus views. Source from web search.

## Public & Retail Sentiment
What are everyday investors and the financial community saying? Are there any notable trends on forums, social media, or retail platforms? Any unusual options activity or institutional moves? Source from web search.

## Opportunities & Risks
2 concrete opportunities this {asset_type} has right now. 2 concrete risks that could hurt it. Be specific — not generic.

## 5 Questions to Guide Your Research
List exactly 5 sharp, specific questions a retail investor should answer before making any decision about {ticker}. These should be questions that require the investor to do their own digging — not things already answered above. Number them 1–5.

## Where to Research Further
List 5–6 specific, named sources where the investor can learn more: e.g. specific SEC filings, earnings call transcripts, industry reports, news sources, or financial databases. Be specific about what to look for at each source.

---
Important:
- Be factual and specific. No vague platitudes.
- Do not give buy/sell recommendations.
- If you cannot find current information for a section, say so clearly rather than speculating.
- Write in plain English for a retail investor, not jargon."""

    text = _call_claude([{"role": "user", "content": prompt}])
    score_db.set_ai_analysis(ticker, text)
    return {"text": text, "cached": False, "generated_at": time.time()}
