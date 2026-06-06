from __future__ import annotations

import base64
import io
import os
from typing import Any, NamedTuple

import easyocr
import numpy as np
import requests
import torch
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from PIL import Image
from pydantic import BaseModel


MAX_IMAGES = 5
MAX_IMAGE_BYTES = 10 * 1024 * 1024
IMAGE_SNIFF_BYTES = 16
OCR_SERVER_VERSION = "0.3.14"

app = FastAPI(title="Local Page Summarizer OCR")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

reader: easyocr.Reader | None = None


class LoadedImage(NamedTuple):
    raw: bytes
    content_type: str
    source_url: str


class ImageCandidate(BaseModel):
    url: str
    originalUrl: str | None = ""
    linkedUrl: str | None = ""
    fetchError: str | None = ""
    alt: str | None = ""
    width: int | None = 0
    height: int | None = 0


class OcrRequest(BaseModel):
    pageUrl: str
    images: list[ImageCandidate]


def get_reader() -> easyocr.Reader:
    global reader
    if reader is None:
        require_gpu()
        reader = easyocr.Reader(["ko", "en"], gpu=True)
    return reader


def gpu_name() -> str:
    if torch.cuda.is_available():
        return f"cuda:{torch.cuda.get_device_name(0)}"

    return ""


def require_gpu() -> None:
    if not gpu_name():
        raise RuntimeError(
            "OCR GPU is required, but no CUDA GPU is available to PyTorch. "
            "Install a CUDA-enabled PyTorch build or run on a machine with CUDA."
        )


@app.on_event("startup")
def validate_gpu_on_startup() -> None:
    get_reader()


def describe_bytes(raw: bytes) -> str:
    return f"bytes={len(raw)}, head={raw[:IMAGE_SNIFF_BYTES].hex()}"


def looks_like_html_or_json(raw: bytes) -> bool:
    prefix = raw[:256].lstrip().lower()
    return prefix.startswith((b"<!doctype", b"<html", b"<head", b"<body", b"{", b"["))


def candidate_urls(candidate: ImageCandidate) -> list[str]:
    urls = [
        candidate.url,
        candidate.originalUrl or "",
        candidate.linkedUrl or "",
    ]
    unique = []
    seen = set()
    for url in urls:
        normalized = str(url or "").strip()
        if normalized and normalized not in seen:
            seen.add(normalized)
            unique.append(normalized)
    return unique


def load_image_url(url: str, page_url: str) -> LoadedImage:
    content_type = "data:image"
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
                "User-Agent": (
                    "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:126.0) "
                    "Gecko/20100101 Firefox/126.0"
                ),
                "Referer": page_url,
                "Accept": "image/avif,image/webp,image/png,image/jpeg,image/*,*/*;q=0.8",
                "Accept-Language": "ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7",
            },
            timeout=20,
        )
        response.raise_for_status()
        raw = response.content
        content_type = response.headers.get("content-type", "")

    if len(raw) > MAX_IMAGE_BYTES:
        raise ValueError(f"image is too large ({describe_bytes(raw)})")

    if looks_like_html_or_json(raw):
        raise ValueError(f"non-image response ({content_type or 'unknown'}, {describe_bytes(raw)})")

    return LoadedImage(raw=raw, content_type=content_type, source_url=url)


def load_image(candidate: ImageCandidate, page_url: str) -> LoadedImage:
    errors = []
    for url in candidate_urls(candidate):
        try:
            return load_image_url(url, page_url)
        except Exception as exc:
            errors.append(f"{url}: {exc}")

    raise ValueError("all image URL attempts failed; " + " | ".join(errors))


def ocr_image(loaded: LoadedImage) -> str:
    try:
        image = Image.open(io.BytesIO(loaded.raw)).convert("RGB")
    except Exception as exc:
        raise ValueError(
            f"cannot identify image file ({loaded.content_type or 'unknown'}, {describe_bytes(loaded.raw)})"
        ) from exc

    result: list[Any] = get_reader().readtext(np.array(image))
    lines = [str(item[1]).strip() for item in result if len(item) >= 2 and str(item[1]).strip()]
    return "\n".join(lines)


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok", "gpu": gpu_name(), "version": OCR_SERVER_VERSION}


@app.post("/ocr")
def run_ocr(payload: OcrRequest) -> dict[str, Any]:
    if not payload.images:
        return {"results": []}

    results = []
    for index, candidate in enumerate(payload.images[:MAX_IMAGES], start=1):
        display_url = candidate.originalUrl or candidate.linkedUrl or candidate.url
        try:
            loaded = load_image(candidate, payload.pageUrl)
            text = ocr_image(loaded)
            results.append(
                {
                    "index": index,
                    "url": display_url,
                    "sourceUrl": loaded.source_url,
                    "alt": candidate.alt or "",
                    "width": candidate.width or 0,
                    "height": candidate.height or 0,
                    "text": text,
                    "error": candidate.fetchError or "",
                }
            )
        except Exception as exc:
            error = str(exc)
            if candidate.fetchError:
                error = f"{candidate.fetchError}; OCR fallback failed: {error}"

            results.append(
                {
                    "index": index,
                    "url": display_url,
                    "sourceUrl": candidate.url,
                    "alt": candidate.alt or "",
                    "width": candidate.width or 0,
                    "height": candidate.height or 0,
                    "text": "",
                    "error": error,
                }
            )

    return {"results": results}
