"""Lessons: the interactive learning pages (betting models from scratch, the
six models on my teams), behind the app's login. The pages live in
backend/lessons/ as self-contained HTML.

The app shows a lesson in a frame that loads it as an ordinary page (iPhone
Safari left a frame filled from a string blank): /lessons/{slug}/link (logged
in) hands out a signed address good for a few hours, and /lessons/view/{slug}
serves the page for it - re-dressed in the app's look (light canvas, white
cards with the 0.375rem radius, orange accents, numbers in Plex Mono) and in
the font picked in Account.

They're built on one person's bets and teams, so only LESSON_USERS see them.
"""
from __future__ import annotations

import hmac
import time
from hashlib import sha256
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import HTMLResponse

from auth import _secret, current_user
from models import User

router = APIRouter(prefix="/lessons", tags=["lessons"])

DIR = Path(__file__).resolve().parent.parent / "lessons"
LESSON_USERS = {"anukul"}
LINK_HOURS = 6
LESSONS = [
    {"slug": "betting-models", "file": "betting-models.html", "title": "Betting models from scratch",
     "about": "The arithmetic, six models from first principles, then the live model worked by hand on a real pick - with interview questions."},
    {"slug": "six-models", "file": "six-models.html", "title": "Six models, on my teams",
     "about": "Logistic, GAM, LightGBM, random forest, neural net and Bayesian on this weekend's matches, and how each scored on six unseen seasons."},
]
# the app's six fonts (frontend utils/appFont.js): id -> (CSS family, Google Fonts spec)
FONTS = {"plex": ('"IBM Plex Sans"', None), "inter": ('"Inter"', "Inter:wght@400;500;600;700"),
         "dmsans": ('"DM Sans"', "DM+Sans:wght@400;500;600;700"), "poppins": ('"Poppins"', "Poppins:wght@400;500;600;700"),
         "nunito": ('"Nunito"', "Nunito:wght@400;500;600;700"), "lora": ('"Lora"', "Lora:wght@400;500;600;700")}
# reading sizes (the A A A buttons in the app): text scale
SIZES = {"s": 0.9, "m": 1.0, "l": 1.15}


def reader(caller: User = Depends(current_user)) -> User:
    if (caller.name or "").lower() not in LESSON_USERS:
        raise HTTPException(404, "Not found")
    return caller


def _lesson(slug: str) -> dict:
    x = next((x for x in LESSONS if x["slug"] == slug), None)
    if not x:
        raise HTTPException(404, "No such lesson")
    return x


def _sign(slug: str, uid: int, exp: int) -> str:
    return hmac.new(_secret(), f"lesson|{slug}|{uid}|{exp}".encode(), sha256).hexdigest()[:40]


def _dress(html: str, font: str, size: str = "m") -> str:
    css_family, google = FONTS.get(font, FONTS["plex"])
    fams = ["IBM+Plex+Sans:wght@400;500;600;700", "IBM+Plex+Mono:wght@400;600"] + ([google] if google else [])
    body = f'{css_family}, "IBM Plex Sans", system-ui, sans-serif'
    head = (f'<link rel="stylesheet" href="https://fonts.googleapis.com/css2?{"&".join("family=" + f for f in fams)}&display=swap">'
            "<style id=\"app-theme\">"
            ":root[data-theme=\"light\"]{--bg:#f8fafc;--surface:#fff;--ink:#111827;--muted:#64748b;--line:#e2e8f0;"
            "--pitch:#ea580c;--pitch-soft:#fff7ed;--market:#b45309;--market-soft:#fefce8;--loss:#dc2626;--loss-soft:#fef2f2;"
            f"--slate:#475569;--code:#f1f5f9;--f-display:{body};--f-body:{body};--f-math:{body};"
            "--f-mono:\"IBM Plex Mono\",ui-monospace,monospace}"
            "[hidden]{display:none!important}"
            f":root{{--ls:{SIZES.get(size, 1.0)}}}html{{font-size:calc(16px * var(--ls))}}body{{font-size:calc(15.5px * var(--ls))!important}}"
            "body{letter-spacing:-.01em;-webkit-font-smoothing:antialiased}"
            "h1,h2,h3{font-weight:700;letter-spacing:-.02em}h1{font-size:1.75rem}h2{font-size:1.3rem}h3{font-size:1.05rem}"
            ".panel,.card,.callout,.formula,.stat,details.qa,.calc,.btn,.chip,.tnode,input[type=text],#tocSheet .sheet,table{border-radius:.375rem}"
            ".panel,.card,.stat,details.qa{box-shadow:0 1px 2px rgba(15,23,42,.05)}"
            ".pos{color:#15803d!important}.res.W{background:#16a34a}.res.L{background:#dc2626}"
            ".verdict.bet{color:#15803d;border-color:#15803d}td.bet{background:#f0fdf4!important;color:#15803d}"
            ".stat b,.out{font-weight:700}.part{border-radius:.375rem;background:#0f172a;color:#f8fafc}"
            ".part .eyebrow,.part p{color:#f8fafc}.eyebrow{color:#ea580c}"
            ".chip[aria-pressed=\"true\"]{background:#0f172a;color:#fff;border-color:#0f172a}header.top{background:#f8fafc}"
            "</style>"
            # the app changes the reading size in place (postMessage), so the lesson keeps your place
            "<script>addEventListener('message',function(e){var v=e.data&&e.data.lessonScale;"
            "if(typeof v==='number'&&v>0.5&&v<2)document.documentElement.style.setProperty('--ls',v)})</script>")
    low = html.lower()
    at = low.find("</head>")
    html = html[:at] + head + html[at:] if at >= 0 else head + html
    i = html.lower().find("<html")
    if i >= 0 and "data-theme" not in html[i:html.find(">", i)]:
        html = html[:i + 5] + ' data-theme="light"' + html[i + 5:]
    return html


@router.get("", response_model=list[dict])
def list_lessons(_: User = Depends(reader)):
    return [{k: x[k] for k in ("slug", "title", "about")} for x in LESSONS]


@router.get("/{slug}/link", response_model=dict)
def lesson_link(slug: str, font: str = "plex", size: str = "m", caller: User = Depends(reader)):
    """A signed address for the lesson page, good for LINK_HOURS - a frame can't send the login header."""
    _lesson(slug)
    exp = int(time.time()) + LINK_HOURS * 3600
    f = font if font in FONTS else "plex"
    z = size if size in SIZES else "m"
    return {"path": f"/lessons/view/{slug}?u={caller.id}&exp={exp}&f={f}&z={z}&s={_sign(slug, caller.id, exp)}",
            "scales": SIZES}


@router.get("/view/{slug}", response_class=HTMLResponse)
def lesson_view(slug: str, u: int, exp: int, s: str, f: str = "plex", z: str = "m"):
    x = _lesson(slug)
    if exp < time.time() or not hmac.compare_digest(s, _sign(slug, u, exp)):
        return HTMLResponse("<p style='font-family:system-ui;padding:1rem'>This lesson link has expired - go back and open it again.</p>", status_code=403)
    html = _dress((DIR / x["file"]).read_text(encoding="utf-8"), f, z)
    return HTMLResponse(html, headers={"Cache-Control": "private, max-age=300", "X-Robots-Tag": "noindex"})
