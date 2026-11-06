"""Daily targets for weight loss, from the person's own numbers.

Mifflin-St Jeor for the energy burnt at rest, times an activity factor for
the day; a deficit for the pace chosen (7,700 kcal is about 1 kg of fat),
never below 1,200 kcal (women) / 1,500 (men). Protein 1.4 g per kg - enough
to keep muscle while losing weight. A guide, not medical advice.
"""
from __future__ import annotations

ACTIVITY = {"sitting": 1.2, "light": 1.375, "moderate": 1.55, "active": 1.725}
PACE = {"maintain": 0, "slow": 0.25, "steady": 0.5, "fast": 0.75}     # kg a week


def targets(p: dict) -> dict | None:
    try:
        w, h, a = float(p["weight_kg"]), float(p["height_cm"]), float(p["age"])
    except (KeyError, TypeError, ValueError):
        return None
    if not (25 <= w <= 300 and 120 <= h <= 230 and 14 <= a <= 100):
        return None
    male = p.get("sex") == "male"
    bmr = 10 * w + 6.25 * h - 5 * a + (5 if male else -161)
    tdee = bmr * ACTIVITY.get(p.get("activity"), 1.375)
    pace = PACE.get(p.get("pace"), 0.5)
    floor = 1500 if male else 1200
    kcal = max(floor, tdee - pace * 7700 / 7)
    return {
        "bmr": round(bmr), "tdee": round(tdee), "kcal": round(kcal / 10) * 10,
        "protein_g": round(1.4 * w), "pace_kg_week": pace,
        "bmi": round(w / (h / 100) ** 2, 1),
        "floored": kcal == floor and tdee - pace * 7700 / 7 < floor,
    }
