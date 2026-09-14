"""POST /receipts/scan - a receipt photo in, a structured guess back.

Tries providers cheapest-quota-first (OCR.space, then Azure, then Google -
see ocr_providers.py), stopping the first time a result's confidence (see
receipt_parser.parse_receipt) clears CONFIDENCE_THRESHOLD. A receipt that
never clears it still returns its best attempt rather than an error - a
mostly-right pre-fill beats none at all, and the frontend's add-expense
form is where a person actually confirms it before it becomes a real
expense. Nothing here ever writes to the database.
"""
from __future__ import annotations

from fastapi import APIRouter, Depends, File, HTTPException, UploadFile

from auth import current_user
from models import User
from ocr_providers import AzureVisionProvider, GoogleVisionProvider, OCRProvider, OCRSpaceProvider
from receipt_parser import parse_receipt

router = APIRouter(prefix="/receipts", tags=["receipts"])

CONFIDENCE_THRESHOLD = 85

# Cheapest free quota first: OCR.space (25k/month) before Azure (5k/month)
# before Google (1k/month) - see the module docstring for why this order
# rather than "best OCR first".
PROVIDERS: list[OCRProvider] = [OCRSpaceProvider(), AzureVisionProvider(), GoogleVisionProvider()]


@router.post("/scan", response_model=dict)
async def scan_receipt(file: UploadFile = File(...), caller: User = Depends(current_user)):
    image_bytes = await file.read()
    if not image_bytes:
        raise HTTPException(400, "Empty file")

    attempts: list[str] = []
    best: dict | None = None

    for provider in PROVIDERS:
        if not provider.available():
            attempts.append(f"{provider.name}: not configured")
            continue
        try:
            text = provider.extract_text(image_bytes)
            parsed = parse_receipt(text)
            parsed["provider"] = provider.name
            attempts.append(f"{provider.name}: confidence {parsed['confidence']}")
            if best is None or parsed["confidence"] > best["confidence"]:
                best = parsed
            if parsed["confidence"] >= CONFIDENCE_THRESHOLD:
                return parsed
        except Exception as e:
            attempts.append(f"{provider.name}: {type(e).__name__}: {e}")

    if best is not None:
        return best

    raise HTTPException(502, "Could not read this receipt - " + "; ".join(attempts))
