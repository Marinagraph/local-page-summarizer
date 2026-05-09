from __future__ import annotations

import base64
import io
import os
from typing import Any

import easyocr
import requests
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from PIL import Image
from pydantic import BaseModel


MAX_IMAGES = 5
MAX_IMAGE_BYTES = 10 * 1024 * 1024

app = FastAPI(title="Local Page Summarizer OCR")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

reader: easyocr.Reader | None = None


class ImageCandidate(BaseModel):
    url: str
    alt: str | None = ""
    width: int | None = 0
    height: int | None = 0


class OcrRequest(BaseModel):
    pageUrl: str
    images: list[ImageCandidate]


def get_reader() -> easyocr.Reader:
    global reader
    if reader is None:
      gpu = os.environ.get("OCR_GPU", "0") == "1"
      reader = easyocr.Reader(["ko", "en"], gpu=gpu)
    return reader


def load_image_bytes(candidate: ImageCandidate, page_url: str) -> bytes:
    url = candidate.url
    if url.startswith("data:image/"):
        try:
            _, encoded = url.split(",", 1)
            raw = base64.b64decode(encoded)
        except ValueError as exc:
            raise ValueError("invalid data URL") from exc
    else:
        response = requests.get(
            url,
            headers={
                "User-Agent": "Mozilla/5.0 Local Page Summarizer OCR",
                "Referer": page_url,
            },
            timeout=20,
        )
        response.raise_for_status()
        raw = response.content

    if len(raw) > MAX_IMAGE_BYTES:
        raise ValueError("image is too large")
    return raw


def ocr_image(raw: bytes) -> str:
    image = Image.open(io.BytesIO(raw)).convert("RGB")
    result: list[Any] = get_reader().readtext(image)
    lines = [str(item[1]).strip() for item in result if len(item) >= 2 and str(item[1]).strip()]
    return "\n".join(lines)


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.post("/ocr")
def run_ocr(payload: OcrRequest) -> dict[str, Any]:
    if not payload.images:
        return {"results": []}

    results = []
    for index, candidate in enumerate(payload.images[:MAX_IMAGES], start=1):
        try:
            raw = load_image_bytes(candidate, payload.pageUrl)
            text = ocr_image(raw)
            results.append(
                {
                    "index": index,
                    "url": candidate.url,
                    "alt": candidate.alt or "",
                    "width": candidate.width or 0,
                    "height": candidate.height or 0,
                    "text": text,
                    "error": "",
                }
            )
        except Exception as exc:
            results.append(
                {
                    "index": index,
                    "url": candidate.url,
                    "alt": candidate.alt or "",
                    "width": candidate.width or 0,
                    "height": candidate.height or 0,
                    "text": "",
                    "error": str(exc),
                }
            )

    return {"results": results}
