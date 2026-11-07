"""Recipes: an Indian recipe recommender with nutrition, weight-loss
planning and ingredient costing.

Self-contained - nothing here imports the rest of the app except through
the two hooks set by the host (`configure`): how to ask the LLM for JSON,
and the settings it reads keys from. The FastAPI router (routers/recipes.py)
is one host; a Flask app could be another.

The rule this package is built on: the LLM suggests dishes, ingredients and
steps; every number - calories, protein, cost - is worked out here in
Python, from data with a source:
  - nutrition of whole dishes: the Indian Nutrient Databank (indb.py)
  - nutrition of single ingredients: USDA FoodData Central (foods.py)
  - ingredient prices: mandi prices from data.gov.in when a key is set,
    else a hand-entered reference list, shown as estimates (prices.py)
"""
from __future__ import annotations

from pathlib import Path
from typing import Callable

DATA_DIR = Path(__file__).resolve().parent.parent / ".cache" / "cookbook"

# Set by the host app: chat_json(system, user, **kw) -> dict, and get_key(name) -> str
_hooks: dict[str, Callable] = {}


def configure(chat_json: Callable, get_key: Callable[[str], str], abv_lookup: Callable | None = None) -> None:
    """`abv_lookup(brand, kind) -> {"abv": %, "source": str} | None`: a
    drink's strength from the host's own drinks catalogue."""
    _hooks["chat_json"] = chat_json
    _hooks["get_key"] = get_key
    if abv_lookup:
        _hooks["abv_lookup"] = abv_lookup


def abv_of(brand: str, kind: str) -> dict | None:
    f = _hooks.get("abv_lookup")
    try:
        return f(brand, kind) if f else None
    except Exception:
        return None


def chat_json(system: str, user: str, **kw) -> dict:
    return _hooks["chat_json"](system, user, **kw)


def key(name: str) -> str:
    f = _hooks.get("get_key")
    return (f(name) if f else "") or ""
