"""Reading a photo or PDF someone attaches in a discussion (a quotation, a
menu, a brochure) into a short summary - the file itself is never kept:
it's read in memory here and dropped, only what the AI wrote is saved.

Everything the app has is used, side by side, whatever suits the file:
  - a PDF with text: its text (pdfplumber) to the text LLMs (both Groq keys,
    OpenRouter as fallback - ai_text)
  - a photo, or a scanned PDF (pages rendered with pdfium): Gemini vision
    reads the image, while at the same time OCR (OCR.space / Azure / Google
    Vision, the first that's set up) pulls the text for the text LLMs; the
    vision answer wins, the OCR one stands in when Gemini can't answer
Amounts come back wrapped in **...** so the app can show them bold.
"""
from __future__ import annotations

import base64
import io
import json
import re
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor

MAX_BYTES = 12 * 1024 * 1024
MAX_PAGES = 4               # of a PDF - quotations are short; brochures' first pages say enough

GEMINI_URL = "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions"
# Newest first; a busy (503) or slow model hands over to the next
GEMINI_MODELS = ["gemini-3.8-flash", "gemini-3.7-flash", "gemini-3.6-flash", "gemini-3.5-flash",
                 "gemini-flash-latest", "gemini-3.1-flash-lite"]


def _prompt(topic: str, details: str, params: list[dict]) -> str:
    fields = "\n".join(f'  "{p["key"]}": {p["label"]}' + (f' ({p["unit"]})' if p.get("unit") else "") for p in params)
    return f"""A member of a group planning "{topic}" ({details or 'no details'}) shared this document - usually a
quotation, price list, menu, package or brochure from a vendor in India.

Write a BRIEF summary for the group (3-6 short lines, plain text, "- " bullets fine): who it's from, what is
offered, the prices and what they include, key terms (validity, advance, taxes, extras). Wrap every amount of money
in double asterisks, e.g. **Rs 1,450 per plate**, **Rs 2.5 lakh**. Use only what the document says - never invent.

Also pull out, when the document states them:
- "vendor": the business it's from ("" if not shown)
- "price": the headline price as written, with its unit (e.g. "Rs 1,350 per plate", "Rs 4.5 lakh package"),
  or "" if none
- "values": these fields, as short text exactly as written (leave a field out when it isn't given):
{fields or '  (no fields set)'}
- "kind": one of quote, menu, package, brochure, invoice, other

Respond with ONLY a JSON object: {{"summary": "...", "vendor": "...", "price": "...", "values": {{}}, "kind": "..."}}
If the document is unreadable or blank, return {{"summary": "", "vendor": "", "values": {{}}, "kind": "other"}}."""


# ── getting at the content ─────────────────────────────────────────────────

def _jpeg_b64(img) -> str:
    img = img.convert("RGB")
    img.thumbnail((2000, 2000))
    buf = io.BytesIO()
    img.save(buf, "JPEG", quality=82)
    return base64.b64encode(buf.getvalue()).decode()


def _image_from_bytes(raw: bytes):
    from PIL import Image, ImageOps
    return ImageOps.exif_transpose(Image.open(io.BytesIO(raw)))


def _pdf(raw: bytes) -> tuple[str, list, int]:
    """(text of the first pages, rendered images of them for vision, page count)."""
    import pdfplumber
    text_parts, pages = [], 0
    try:
        with pdfplumber.open(io.BytesIO(raw)) as pdf:
            pages = len(pdf.pages)
            for p in pdf.pages[:MAX_PAGES]:
                text_parts.append(p.extract_text() or "")
    except Exception as e:
        if "password" in str(e).lower() or "encrypt" in str(e).lower():
            raise ValueError("That PDF is password-protected - share an unlocked copy or a screenshot.")
        raise ValueError("That PDF couldn't be opened.")
    images = []
    try:
        import pypdfium2 as pdfium
        doc = pdfium.PdfDocument(raw)
        for i in range(min(len(doc), MAX_PAGES)):
            images.append(doc[i].render(scale=1.6).to_pil())
        doc.close()
    except Exception as e:
        print(f"[attachment] pdf render failed: {e!r}")
    return "\n\n".join(text_parts).strip(), images, pages


# ── the readers ────────────────────────────────────────────────────────────

def _gemini(prompt: str, images: list) -> dict:
    from database import get_settings
    key = get_settings().gemini_api_key
    if not key:
        raise RuntimeError("no Gemini key")
    content = [{"type": "text", "text": prompt}] + [
        {"type": "image_url", "image_url": {"url": f"data:image/jpeg;base64,{_jpeg_b64(im)}"}} for im in images[:MAX_PAGES]]
    last = None
    for model in GEMINI_MODELS:
        body = json.dumps({"model": model, "temperature": 0.2, "max_tokens": 4000,
                           "response_format": {"type": "json_object"},
                           "messages": [{"role": "user", "content": content}]}).encode()
        req = urllib.request.Request(GEMINI_URL, data=body, method="POST", headers={
            "Authorization": f"Bearer {key}", "Content-Type": "application/json", "Accept": "application/json"})
        try:
            with urllib.request.urlopen(req, timeout=30) as resp:
                text = json.loads(resp.read().decode())["choices"][0]["message"]["content"]
            m = re.search(r"\{.*\}", text, re.S)
            return json.loads(m.group(0) if m else text)
        except urllib.error.HTTPError as e:
            last = e
            if e.code in (401, 403):
                break                         # the key itself was refused
        except Exception as e:                # busy, timed out, odd reply: the next model
            last = e
    raise last or RuntimeError("Gemini didn't answer")


def _ocr_text(images: list) -> str:
    """The first OCR service that's set up, over each image."""
    import ocr_providers as op
    providers = [p() for p in (op.OCRSpaceProvider, op.AzureVisionProvider, op.GoogleVisionProvider)]
    providers = [p for p in providers if p.available()]
    if not providers:
        raise RuntimeError("no OCR service set up")
    out = []
    for im in images[:MAX_PAGES]:
        buf = io.BytesIO()
        im.convert("RGB").save(buf, "JPEG", quality=85)
        raw = buf.getvalue()
        for p in providers:
            try:
                t = p.extract_text(raw)
                if t and t.strip():
                    out.append(t)
                    break
            except Exception as e:
                print(f"[attachment] {p.name} OCR failed: {e!r}")
    text = "\n\n".join(out).strip()
    if not text:
        raise RuntimeError("OCR found no text")
    return text


def _text_llm(prompt: str, text: str, prefer: int = 0) -> dict:
    import ai_text
    return ai_text.chat_json(prompt, "Document text:\n" + text[:20000], temperature=0.2, prefer=prefer)


def _clean(out: dict, params: list[dict]) -> dict:
    keys = {p["key"] for p in params}
    values = out.get("values") if isinstance(out.get("values"), dict) else {}
    return {
        "summary": str(out.get("summary") or "").strip()[:3000],
        "vendor": str(out.get("vendor") or "").strip()[:200],
        "price": str(out.get("price") or "").strip()[:100],
        "values": {k: str(v).strip()[:200] for k, v in values.items() if k in keys and str(v or "").strip()},
        "kind": str(out.get("kind") or "other")[:20],
    }


def read(raw: bytes, filename: str, content_type: str, topic: str, details: str, params: list[dict]) -> dict:
    """{summary, vendor, values, kind, read_by, pages} - raises ValueError for
    a file that can't be read at all."""
    if len(raw) > MAX_BYTES:
        raise ValueError("That file is over 12 MB - share a smaller one or a screenshot.")
    prompt = _prompt(topic, details, params)
    is_pdf = raw[:5] == b"%PDF-" or (content_type or "").endswith("pdf") or filename.lower().endswith(".pdf")
    pages = 1
    if is_pdf:
        text, images, pages = _pdf(raw)
    else:
        try:
            images, text = [_image_from_bytes(raw)], ""
        except Exception:
            raise ValueError("Only photos (JPG, PNG…) and PDFs can be read.")
    del raw                                  # nothing of the file outlives this call

    results: dict[str, dict | Exception] = {}
    with ThreadPoolExecutor(max_workers=3) as pool:
        futs = {}
        if len(text) >= 200:
            # A real text PDF: both Groq keys read it at once (whichever answers well first is used)
            futs["pdf text (Groq)"] = pool.submit(_text_llm, prompt, text, 0)
            futs["pdf text (Groq 2)"] = pool.submit(_text_llm, prompt, text, 1)
        if images and (len(text) < 200 or not futs):
            futs["Gemini vision"] = pool.submit(_gemini, prompt, images)
            futs["OCR + Groq"] = pool.submit(lambda: _text_llm(prompt, _ocr_text(images), 0))
        for name, f in futs.items():
            try:
                results[name] = f.result(timeout=90)
            except Exception as e:
                results[name] = e
    order = ["Gemini vision", "pdf text (Groq)", "pdf text (Groq 2)", "OCR + Groq"]
    for name in order:
        r = results.get(name)
        if isinstance(r, dict):
            c = _clean(r, params)
            if c["summary"]:
                return {**c, "read_by": name, "pages": pages}
    errs = "; ".join(f"{k}: {v!r}"[:200] for k, v in results.items() if isinstance(v, Exception))
    print(f"[attachment] nothing could read {filename}: {errs}")
    raise ValueError("The AI couldn't read that file just now - try again, or a clearer photo.")
