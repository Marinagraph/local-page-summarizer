from __future__ import annotations

import argparse
import io
import json
import sys
import time
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any

import requests
from PIL import Image


DEFAULT_LIGHTON_MODEL = "lightonai/LightOnOCR-2-1B"
DEFAULT_PROMPT = (
    "Extract all visible text from this image. Preserve Korean text exactly. "
    "Return only the OCR text, without commentary."
)


@dataclass
class ImageInput:
    source: str
    width: int
    height: int
    mode: str
    load_seconds: float


@dataclass
class EngineResult:
    engine: str
    model: str
    load_seconds: float
    inference_seconds: float
    text: str
    error: str = ""


def now() -> float:
    return time.perf_counter()


def is_url(value: str) -> bool:
    return value.startswith("http://") or value.startswith("https://")


def load_image(source: str, page_url: str = "") -> tuple[Image.Image, ImageInput]:
    started = now()
    if is_url(source):
        headers = {
            "Accept": "image/avif,image/webp,image/png,image/jpeg,image/*,*/*;q=0.8",
            "Accept-Language": "ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7",
            "User-Agent": (
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:126.0) "
                "Gecko/20100101 Firefox/126.0"
            ),
        }
        if page_url:
            headers["Referer"] = page_url
        response = requests.get(source, headers=headers, timeout=30)
        response.raise_for_status()
        raw = response.content
    else:
        raw = Path(source).read_bytes()

    image = Image.open(io.BytesIO(raw)).convert("RGB")
    loaded = ImageInput(
        source=source,
        width=image.width,
        height=image.height,
        mode=image.mode,
        load_seconds=now() - started,
    )
    return image, loaded


def run_easyocr(image: Image.Image, languages: list[str]) -> EngineResult:
    import easyocr
    import numpy as np

    started = now()
    reader = easyocr.Reader(languages, gpu=True)
    load_seconds = now() - started

    started = now()
    rows: list[Any] = reader.readtext(np.array(image))
    inference_seconds = now() - started

    lines = []
    for row in rows:
        if len(row) >= 2 and str(row[1]).strip():
            lines.append(str(row[1]).strip())

    return EngineResult(
        engine="easyocr",
        model=f"easyocr:{','.join(languages)}",
        load_seconds=load_seconds,
        inference_seconds=inference_seconds,
        text="\n".join(lines).strip(),
    )


def build_lighton_inputs(processor: Any, image: Image.Image, prompt: str) -> Any:
    import torch

    messages_with_pil = [
        {
            "role": "user",
            "content": [
                {"type": "image", "image": image},
                {"type": "text", "text": prompt},
            ],
        }
    ]

    try:
        return processor.apply_chat_template(
            messages_with_pil,
            add_generation_prompt=True,
            tokenize=True,
            return_dict=True,
            return_tensors="pt",
        )
    except Exception:
        messages_without_image = [
            {
                "role": "user",
                "content": [
                    {"type": "image"},
                    {"type": "text", "text": prompt},
                ],
            }
        ]
        text = processor.apply_chat_template(
            messages_without_image,
            add_generation_prompt=True,
            tokenize=False,
        )
        return processor(images=image, text=text, return_tensors="pt")


def load_lighton_model(model_id: str) -> tuple[Any, Any, str, float]:
    import torch

    started = now()
    device = "cuda" if torch.cuda.is_available() else "cpu"
    dtype = torch.bfloat16 if device == "cuda" else torch.float32

    try:
        from transformers import LightOnOcrForConditionalGeneration, LightOnOcrProcessor

        processor = LightOnOcrProcessor.from_pretrained(model_id)
        model = LightOnOcrForConditionalGeneration.from_pretrained(
            model_id,
            torch_dtype=dtype,
        ).to(device)
    except ImportError:
        from transformers import AutoModelForSeq2SeqLM, AutoProcessor

        processor = AutoProcessor.from_pretrained(model_id)
        model = AutoModelForSeq2SeqLM.from_pretrained(
            model_id,
            torch_dtype=dtype,
            trust_remote_code=True,
        ).to(device)

    model.eval()
    return processor, model, device, now() - started


def run_lighton(
    image: Image.Image,
    model_id: str,
    prompt: str,
    max_new_tokens: int,
) -> EngineResult:
    import torch

    processor, model, device, load_seconds = load_lighton_model(model_id)
    inputs = build_lighton_inputs(processor, image, prompt)
    inputs = inputs.to(device)

    started = now()
    with torch.inference_mode():
        outputs = model.generate(
            **inputs,
            max_new_tokens=max_new_tokens,
            do_sample=False,
        )
    inference_seconds = now() - started

    input_length = inputs["input_ids"].shape[-1] if "input_ids" in inputs else 0
    generated = outputs[0][input_length:] if input_length else outputs[0]
    text = processor.decode(generated, skip_special_tokens=True).strip()

    return EngineResult(
        engine="lighton",
        model=model_id,
        load_seconds=load_seconds,
        inference_seconds=inference_seconds,
        text=text,
    )


def result_or_error(engine: str, model: str, callback: Any) -> EngineResult:
    try:
        return callback()
    except Exception as exc:
        return EngineResult(
            engine=engine,
            model=model,
            load_seconds=0.0,
            inference_seconds=0.0,
            text="",
            error=f"{type(exc).__name__}: {exc}",
        )


def print_markdown(image_info: ImageInput, results: list[EngineResult]) -> None:
    print(f"# OCR benchmark\n")
    print(f"- Source: {image_info.source}")
    print(f"- Size: {image_info.width}x{image_info.height}")
    print(f"- Image load: {image_info.load_seconds:.3f}s")
    for result in results:
        print(f"\n## {result.engine} ({result.model})\n")
        if result.error:
            print(f"- Error: {result.error}")
            continue
        print(f"- Model load: {result.load_seconds:.3f}s")
        print(f"- Inference: {result.inference_seconds:.3f}s")
        print(f"- Total engine time: {(result.load_seconds + result.inference_seconds):.3f}s")
        print("\n```text")
        print(result.text or "(no text)")
        print("```")


def main() -> int:
    parser = argparse.ArgumentParser(description="Compare EasyOCR and LightOnOCR on one image.")
    parser.add_argument("--image", required=True, help="Image file path or URL.")
    parser.add_argument("--page-url", default="", help="Referer URL for protected image URLs.")
    parser.add_argument("--engine", choices=["easyocr", "lighton", "both"], default="both")
    parser.add_argument("--model", default=DEFAULT_LIGHTON_MODEL)
    parser.add_argument("--prompt", default=DEFAULT_PROMPT)
    parser.add_argument("--max-new-tokens", type=int, default=1024)
    parser.add_argument("--languages", default="ko,en", help="EasyOCR languages, comma-separated.")
    parser.add_argument("--json", action="store_true", help="Emit JSON instead of Markdown.")
    args = parser.parse_args()

    image, image_info = load_image(args.image, args.page_url)
    languages = [part.strip() for part in args.languages.split(",") if part.strip()]
    results: list[EngineResult] = []

    if args.engine in {"easyocr", "both"}:
        results.append(
            result_or_error(
                "easyocr",
                f"easyocr:{','.join(languages)}",
                lambda: run_easyocr(image, languages),
            )
        )

    if args.engine in {"lighton", "both"}:
        results.append(
            result_or_error(
                "lighton",
                args.model,
                lambda: run_lighton(image, args.model, args.prompt, args.max_new_tokens),
            )
        )

    if args.json:
        print(json.dumps({"image": asdict(image_info), "results": [asdict(r) for r in results]}, ensure_ascii=False, indent=2))
    else:
        print_markdown(image_info, results)

    return 1 if any(result.error for result in results) else 0


if __name__ == "__main__":
    sys.exit(main())
