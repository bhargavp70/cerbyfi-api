import json
from pathlib import Path
from app.scorer.core import apply_thresholds, format_value
from app.scorer.fetchers import fetch_stock_data

_CONFIG_PATH = Path(__file__).parent.parent / "configs" / "scoring_config.json"


def _load_config() -> dict:
    with open(_CONFIG_PATH) as f:
        return json.load(f)


def score_stock(ticker: str) -> dict:
    config = _load_config()
    data   = fetch_stock_data(ticker.upper())

    results = {
        "ticker":     ticker.upper(),
        "name":       data.get("longName", ticker.upper()),
        "categories": {},
        "total":      0,
    }

    for cat_key, category in config["categories"].items():
        cat_score = 0
        metrics_results = {}
        for metric_key, metric in category["metrics"].items():
            max_score = metric["max_score"]
            value     = data.get(metric["field"])
            score     = apply_thresholds(value, metric["thresholds"], metric["direction"])
            if score is None:
                score   = max_score // 2
                display = "N/A"
            else:
                display = format_value(value, metric.get("format", "number"))
            cat_score += score
            metrics_results[metric_key] = {
                "label":   metric["label"],
                "score":   score,
                "max":     max_score,
                "display": display,
            }
        results["categories"][cat_key] = {
            "label":   category["label"],
            "score":   cat_score,
            "max":     category["max_score"],
            "metrics": metrics_results,
        }
        results["total"] += cat_score

    return results
