from __future__ import annotations

import base64
import io
import os
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
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
MAX_DOWNLOAD_WORKERS = int(os.getenv("OCR_DOWNLOAD_WORKERS", "5"))
REQUEST_TIMEOUT_SECONDS = float(os.getenv("OCR_REQUEST_TIMEOUT_SECONDS", "8"))
EASYOCR_BATCH_SIZE = int(os.getenv("OCR_EASYOCR_BATCH_SIZE", "8"))
EASYOCR_CANVAS_SIZE = int(os.getenv("OCR_EASYOCR_CANVAS_SIZE", "2560"))
OCR_SERVER_VERSION = "0.3.27"

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
    load_seconds: float


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
    started = time.perf_counter()
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
            timeout=REQUEST_TIMEOUT_SECONDS,
        )
        response.raise_for_status()
        raw = response.content
        content_type = response.headers.get("content-type", "")

    if len(raw) > MAX_IMAGE_BYTES:
        raise ValueError(f"image is too large ({describe_bytes(raw)})")

    if looks_like_html_or_json(raw):
        raise ValueError(f"non-image response ({content_type or 'unknown'}, {describe_bytes(raw)})")

    return LoadedImage(raw=raw, content_type=content_type, source_url=url, load_seconds=time.perf_counter() - started)


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

    result: list[Any] = get_reader().readtext(
        np.array(image),
        batch_size=EASYOCR_BATCH_SIZE,
        canvas_size=EASYOCR_CANVAS_SIZE,
        detail=0,
        paragraph=False,
    )
    lines = []
    for item in result:
        if isinstance(item, str):
            text = item.strip()
        elif len(item) >= 2:
            text = str(item[1]).strip()
        else:
            text = ""
        if text:
            lines.append(text)
    return "\n".join(lines)


@app.get("/health")
def health() -> dict[str, str]:
    return {
        "status": "ok",
        "gpu": gpu_name(),
        "version": OCR_SERVER_VERSION,
        "downloadWorkers": str(MAX_DOWNLOAD_WORKERS),
        "requestTimeoutSeconds": str(REQUEST_TIMEOUT_SECONDS),
        "easyocrBatchSize": str(EASYOCR_BATCH_SIZE),
        "easyocrCanvasSize": str(EASYOCR_CANVAS_SIZE),
    }


def empty_result(index: int, candidate: ImageCandidate, error: str = "") -> dict[str, Any]:
    display_url = candidate.originalUrl or candidate.linkedUrl or candidate.url
    if candidate.fetchError and error:
        error = f"{candidate.fetchError}; OCR fallback failed: {error}"
    elif candidate.fetchError:
        error = candidate.fetchError

    return {
        "index": index,
        "url": display_url,
        "sourceUrl": candidate.url,
        "alt": candidate.alt or "",
        "width": candidate.width or 0,
        "height": candidate.height or 0,
        "text": "",
        "error": error,
    }


def load_candidate(index: int, candidate: ImageCandidate, page_url: str) -> tuple[int, ImageCandidate, LoadedImage | None, str]:
    try:
        return index, candidate, load_image(candidate, page_url), ""
    except Exception as exc:
        return index, candidate, None, str(exc)


@app.post("/ocr")
def run_ocr(payload: OcrRequest) -> dict[str, Any]:
    if not payload.images:
        return {"results": []}

    started = time.perf_counter()
    candidates = list(payload.images[:MAX_IMAGES])
    results_by_index: dict[int, dict[str, Any]] = {}
    worker_count = max(1, min(MAX_DOWNLOAD_WORKERS, len(candidates)))

    with ThreadPoolExecutor(max_workers=worker_count) as executor:
        futures = [
            executor.submit(load_candidate, index, candidate, payload.pageUrl)
            for index, candidate in enumerate(candidates, start=1)
        ]

        for future in as_completed(futures):
            index, candidate, loaded, error = future.result()
            if loaded is None:
                results_by_index[index] = empty_result(index, candidate, error)
                continue

            ocr_started = time.perf_counter()
            display_url = candidate.originalUrl or candidate.linkedUrl or candidate.url
            try:
                text = ocr_image(loaded)
                results_by_index[index] = {
                    "index": index,
                    "url": display_url,
                    "sourceUrl": loaded.source_url,
                    "alt": candidate.alt or "",
                    "width": candidate.width or 0,
                    "height": candidate.height or 0,
                    "text": text,
                    "error": candidate.fetchError or "",
                    "loadSeconds": round(loaded.load_seconds, 3),
                    "ocrSeconds": round(time.perf_counter() - ocr_started, 3),
                }
            except Exception as exc:
                results_by_index[index] = empty_result(index, candidate, str(exc))

    results = [results_by_index[index] for index in sorted(results_by_index)]
    return {
        "results": results,
        "timing": {
            "totalSeconds": round(time.perf_counter() - started, 3),
            "downloadWorkers": worker_count,
            "easyocrBatchSize": EASYOCR_BATCH_SIZE,
            "easyocrCanvasSize": EASYOCR_CANVAS_SIZE,
        },
    }
