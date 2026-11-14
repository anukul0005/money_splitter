"""Which matches to consider betting on: one rule for every sport.

Expected return on a side = our chance of it winning x the price offered - 1.
At least the threshold the user sets (10 / 15 / 20 / 30%) -> "consider" that
side; otherwise "skip". With no price yet, the lowest price that would clear
the threshold for each side: (1 + threshold) / our chance.

Our chance is the sport's own model (tennis_model, badminton_model,
hockey_model). On the tennis prices kept so far, using our chance as it is
did better than blending it toward the bookmaker's - and very large apparent
edges did worse (the model missing an injury, say), so the dashboard tracks
each threshold's record rather than promising any.
"""
from __future__ import annotations

EDGES = (0.10, 0.15, 0.20, 0.30)
DEFAULT = 0.20
MAX_PRICE = 6.0          # long shots: too noisy to trust a model's edge on


def clamp_edge(e: float | None) -> float:
    try:
        e = float(e)
    except (TypeError, ValueError):
        return DEFAULT
    return min(max(e, 0.02), 1.0)


def verdict(probs: list[float], prices: list[float] | None, edge: float = DEFAULT) -> dict:
    """`probs` / `prices` per outcome (side 1, side 2[, draw])."""
    edge = clamp_edge(edge)
    mins = [round((1 + edge) / p, 2) if p > 0.01 else None for p in probs]
    out = {"edge_needed": edge, "min_price": mins, "probs": [round(p, 3) for p in probs]}
    if not prices or any(not x for x in prices[:2]):
        return {**out, "verdict": "need_price"}
    evs = [p * o - 1 if o and o <= MAX_PRICE else -1.0 for p, o in zip(probs, prices)]
    i = max(range(len(evs)), key=lambda k: evs[k])
    out["ev"] = [round(x, 3) for x in evs]
    if evs[i] >= edge:
        return {**out, "verdict": "consider", "side": i + 1, "price": prices[i], "expected": round(evs[i], 3)}
    return {**out, "verdict": "skip", "best_side": i + 1, "best_expected": round(evs[i], 3)}
