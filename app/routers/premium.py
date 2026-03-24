"""Premium-only endpoints."""
import requests
from fastapi import APIRouter, Depends, HTTPException
from app.config import settings
from app.user_auth import require_premium

router = APIRouter(prefix="/api/premium", tags=["premium"])

_ANTHROPIC_URL = "https://api.anthropic.com/v1/messages"


@router.post("/ai-analyze")
def ai_analyze(body: dict, user_id: str = Depends(require_premium)):
    if not settings.claude_api_key:
        raise HTTPException(status_code=503, detail="AI analysis is not configured.")

    data = body.get("data")
    if not data:
        raise HTTPException(status_code=422, detail="data field required.")

    category_text = "\n".join(
        f"- {cat['label']}: {cat['score']}/{cat['max']} ({cat['pct']:.0f}%)"
        for cat in data.get("categories", {}).values()
    )

    prompt = f"""You are a concise financial analyst assistant. Here is the CerbyFi score report for {data.get('name')} ({data.get('ticker')}):

Overall score: {data.get('total')}/{data.get('max_total')} ({data.get('pct', 0):.0f}%) — {data.get('rating_label')}

Category breakdown:
{category_text}

Respond with exactly these four sections using these headings:
**Summary**
2 sentences on the company's overall financial health.

**Strengths**
The 2 strongest scoring areas and why they matter to investors.

**Concerns**
The 2 weakest areas an investor should investigate further.

**Question to ask**
One specific question a retail investor should research before buying.

Keep responses factual, grounded in the scores above. Do not make buy or sell recommendations."""

    try:
        res = requests.post(
            _ANTHROPIC_URL,
            headers={
                "x-api-key": settings.claude_api_key,
                "anthropic-version": "2023-06-01",
                "content-type": "application/json",
            },
            json={
                "model": "claude-haiku-4-5-20251001",
                "max_tokens": 600,
                "messages": [{"role": "user", "content": prompt}],
            },
            timeout=30,
        )
    except requests.RequestException as e:
        raise HTTPException(status_code=502, detail=f"Could not reach AI service: {e}")

    if not res.ok:
        detail = res.json().get("error", {}).get("message", res.text)
        raise HTTPException(status_code=res.status_code, detail=detail)

    return {"text": res.json()["content"][0]["text"]}
