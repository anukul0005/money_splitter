"""Receipt OCR, one class per provider, all behind the same interface.

Three independent providers - OCR.space, Azure AI Vision, Google Cloud
Vision - each free up to its own monthly quota (25k / 5k / 1k requests a
month respectively, at time of writing). None of them see this app's
database; each is handed a single receipt photo and asked for raw text
back. Callers never call a specific provider directly - see routers/
receipts.py's scan_receipt, which tries them in quota-cheapest-first order
and only spends a second call when the first one's result looks
unreliable (see receipt_parser.py's confidence score).

Each provider is silently skipped (`available()` returns False) rather
than raising when its API key isn't configured - the whole point is that
this app runs fine with zero, one, two or three of these wired up, and
adding a provider later is pasting in an API key, not touching this file.
"""
from __future__ import annotations

import base64
import json
import time
import urllib.error
import urllib.request

from database import get_settings


class OCRProvider:
    """One OCR backend. `name` is what shows up in a scan's `provider`
    field, so a bad read can be traced to which service produced it."""
    name = "base"

    def available(self) -> bool:
        """Whether this provider has the config it needs to be tried at
        all - never crashes on a missing key, just gets skipped."""
        raise NotImplementedError

    def extract_text(self, image_bytes: bytes) -> str:
        """Raw OCR text, newline-separated, roughly top to bottom - callers
        parse structure out of this; providers don't."""
        raise NotImplementedError


class OCRSpaceProvider(OCRProvider):
    """https://ocr.space - 25,000 free requests/month, no cloud account
    needed, just an API key. Tried first because it's the cheapest quota
    to spend and needs the least setup."""
    name = "ocrspace"

    def available(self) -> bool:
        return bool(get_settings().ocrspace_api_key)

    def extract_text(self, image_bytes: bytes) -> str:
        boundary = "----SplitEasyReceiptBoundary"

        def field(name: str, value: str) -> str:
            return f'--{boundary}\r\nContent-Disposition: form-data; name="{name}"\r\n\r\n{value}\r\n'

        parts = (
            field("apikey", get_settings().ocrspace_api_key)
            + field("OCREngine", "2")   # engine 2: better with mixed fonts/receipts
            + field("scale", "true")
            + f'--{boundary}\r\nContent-Disposition: form-data; name="file"; filename="receipt.jpg"\r\n'
              f"Content-Type: image/jpeg\r\n\r\n"
        )
        payload = parts.encode() + image_bytes + f"\r\n--{boundary}--\r\n".encode()

        req = urllib.request.Request(
            "https://api.ocr.space/parse/image",
            data=payload,
            headers={"Content-Type": f"multipart/form-data; boundary={boundary}"},
            method="POST",
        )

        # 30s was too tight - OCR.space's free tier shares infrastructure
        # across every free account, and a genuinely successful request
        # regularly takes 30-45s under load, not just on a bad image. Tried
        # twice at 45s each (not longer - Render's own request timeout is
        # the ceiling here) before giving up: a cold/busy backend on the
        # first attempt is common, and worth one retry before spending the
        # next provider's quota on what timing out again would rule out
        # anyway.
        last_error: Exception | None = None
        for attempt in range(2):
            try:
                with urllib.request.urlopen(req, timeout=45) as resp:
                    data = json.loads(resp.read().decode())
                if data.get("IsErroredOnProcessing"):
                    raise RuntimeError(f"OCR.space error: {data.get('ErrorMessage')}")
                results = data.get("ParsedResults") or []
                return results[0]["ParsedText"] if results else ""
            except (TimeoutError, urllib.error.URLError) as e:
                last_error = e
        raise RuntimeError(f"OCR.space timed out twice: {last_error}")


class AzureVisionProvider(OCRProvider):
    """Azure AI Vision's Read operation - 5,000 free transactions/month on
    the F0 tier. Async by design (submit, then poll): the right shape for
    a Read call, which queues the image rather than answering inline."""
    name = "azure"

    def available(self) -> bool:
        s = get_settings()
        return bool(s.azure_vision_key and s.azure_vision_endpoint)

    def extract_text(self, image_bytes: bytes) -> str:
        s = get_settings()
        endpoint = s.azure_vision_endpoint.rstrip("/")
        submit_req = urllib.request.Request(
            f"{endpoint}/vision/v3.2/read/analyze",
            data=image_bytes,
            method="POST",
            headers={
                "Ocp-Apim-Subscription-Key": s.azure_vision_key,
                "Content-Type": "application/octet-stream",
            },
        )
        with urllib.request.urlopen(submit_req, timeout=30) as resp:
            operation_url = resp.headers.get("Operation-Location")
        if not operation_url:
            raise RuntimeError("Azure did not return an operation URL")

        # Read is queued, not synchronous - a receipt-sized image is
        # usually done within a second or two, so ten 1s polls is generous
        # rather than tight.
        for _ in range(10):
            time.sleep(1)
            poll_req = urllib.request.Request(
                operation_url, headers={"Ocp-Apim-Subscription-Key": s.azure_vision_key},
            )
            with urllib.request.urlopen(poll_req, timeout=15) as resp:
                result = json.loads(resp.read().decode())
            status = result.get("status")
            if status == "succeeded":
                lines = []
                for page in result.get("analyzeResult", {}).get("readResults", []):
                    for line in page.get("lines", []):
                        lines.append(line.get("text", ""))
                return "\n".join(lines)
            if status == "failed":
                raise RuntimeError("Azure OCR failed")
        raise RuntimeError("Azure OCR timed out waiting for a result")


class GoogleVisionProvider(OCRProvider):
    """Google Cloud Vision's TEXT_DETECTION - 1,000 free units/month, the
    smallest of the three quotas, so tried last."""
    name = "google"

    def available(self) -> bool:
        return bool(get_settings().google_vision_api_key)

    def extract_text(self, image_bytes: bytes) -> str:
        api_key = get_settings().google_vision_api_key
        payload = json.dumps({
            "requests": [{
                "image": {"content": base64.b64encode(image_bytes).decode()},
                "features": [{"type": "TEXT_DETECTION"}],
            }]
        }).encode()
        req = urllib.request.Request(
            f"https://vision.googleapis.com/v1/images:annotate?key={api_key}",
            data=payload,
            method="POST",
            headers={"Content-Type": "application/json"},
        )
        with urllib.request.urlopen(req, timeout=30) as resp:
            data = json.loads(resp.read().decode())
        responses = data.get("responses") or [{}]
        annotations = responses[0].get("textAnnotations") or []
        return annotations[0].get("description", "") if annotations else ""
