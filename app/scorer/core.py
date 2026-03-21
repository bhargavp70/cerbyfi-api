from typing import Optional


def apply_thresholds(value: float, thresholds: list, direction: str) -> Optional[int]:
    if value is None:
        return None
    if direction == "min":
        for t in sorted(thresholds, key=lambda x: x["value"], reverse=True):
            if value >= t["value"]:
                return t["score"]
    else:
        for t in sorted(thresholds, key=lambda x: x["value"]):
            if value <= t["value"]:
                return t["score"]
    return thresholds[-1]["score"]


def format_value(value: float, fmt: str) -> str:
    if fmt == "percent":
        return f"{value:.1%}"
    elif fmt == "number":
        return f"{value:.2f}"
    elif fmt == "raw_pct":
        return f"{value:.1f}%"
    elif fmt == "aum":
        if value >= 1:
            return f"${value:.1f}B"
        return f"${value * 1000:.0f}M"
    return str(value)


def rating_label(total: int) -> tuple[int, str]:
    """Returns (stars, label) for a given total score out of 100."""
    if total >= 80:
        return 5, "Excellent — Strong buy candidate"
    elif total >= 65:
        return 4, "Good — Worth considering"
    elif total >= 50:
        return 3, "Fair — Proceed with caution"
    elif total >= 35:
        return 2, "Weak — Significant concerns"
    return 1, "Poor — Avoid"
