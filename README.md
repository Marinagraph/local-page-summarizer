# Local Page Summarizer

Personal Firefox extension for saving the current page and summarizing it with LM Studio's local OpenAI-compatible API.

Detailed file structure and usage notes are in [`docs/usage-and-structure.md`](docs/usage-and-structure.md).
OCR engine benchmark notes are in [`docs/ocr-benchmark.md`](docs/ocr-benchmark.md).

## Requirements

- Firefox
- LM Studio local server running at `http://127.0.0.1:2000`
- At least one downloaded chat model in LM Studio; loading it manually is optional
- Python 3.11 and a CUDA-capable GPU for the optional OCR server

## Load in Firefox

1. Open `about:debugging#/runtime/this-firefox`.
2. Click `Load Temporary Add-on`.
3. Select `C:\Users\objectives\local-page-summarizer\manifest.json`.
4. Open any normal web page.
5. Click the extension button and choose `Save & Summarize`.

## LM Studio

Start the local server in LM Studio and keep the endpoint at:

```text
http://127.0.0.1:2000/v1/chat/completions
```

The extension first checks LM Studio's native `/api/v1/models` endpoint. If one chat model is already loaded, that exact loaded instance is used regardless of the `Fallback model` value. If no chat model is loaded, the extension resolves the `Fallback model`, loads it through `/api/v1/models/load`, and then starts analysis. When several chat models are loaded, an exact or partial `Fallback model` match wins; otherwise the first loaded instance returned by LM Studio is used.

`Fallback model` defaults to `auto:gemma`, which selects the largest downloaded non-embedding Gemma model only when nothing is already loaded. You can enter an exact model key or a partial model key instead. The model actually used and whether it was already loaded or loaded as the fallback are included in the popup metadata and Markdown export.

When `Fallback model` starts with `auto`, the selected model advertises an `off` reasoning mode, and the request uses the default `Max chars` value, the extension enables its fast automatic mode. It sends both `reasoning_effort: none` and `enable_thinking: false`, raises the effective chunk size to `16000` for contexts of at least 32k or `24000` for contexts of at least 64k, and therefore reduces repeated section calls without dropping source text or comments. A manually changed `Max chars` value is never overridden.

The popup defaults `Max chars` to `8000` so models loaded with a small context remain safe. `Max chars` is the per-call chunk budget, not a hard cap on the collected page. If LM Studio reports a context-length error, the extension retries with smaller prompts automatically. Markdown metadata records configured and effective chunk sizes, and the timing table records reasoning tokens so thinking can be verified as zero.
Set `Parallel` to control how many independent LM Studio analysis calls can run at the same time. The default is `2`, which is usually faster than fully sequential analysis while avoiding heavy contention. If LM Studio has enough GPU memory and multiple slots, try `3` or `4`; if the machine becomes sluggish, lower it to `1`.

## OCR server

The extension can send large page images to a local OCR server at:

```text
http://127.0.0.1:2010/ocr
```

Start it with:

```powershell
.\scripts\start-ocr-server.ps1
```

The first run creates `.venv-ocr`, installs CUDA-enabled PyTorch from the PyTorch `cu128` wheel index, installs Python dependencies, checks that PyTorch can see a CUDA GPU, and downloads EasyOCR's Korean and English models. The OCR server is GPU-only and fails to start if CUDA is not available. The script prefers Python 3.11 because some EasyOCR dependencies are unreliable on Python 3.13. Keep this terminal open while using OCR.
If an older server is already responding on port 2010 but does not report a CUDA GPU from `/health`, the start script stops that stale process and starts the current GPU OCR server.
The OCR reader is loaded during server startup so the first page summary does not pay the EasyOCR model-loading cost.
OCR image downloads are performed in parallel, while EasyOCR recognition stays GPU-sequential for stability. The server uses `OCR_DOWNLOAD_WORKERS=5`, `OCR_REQUEST_TIMEOUT_SECONDS=8`, `OCR_EASYOCR_BATCH_SIZE=8`, and `OCR_EASYOCR_CANVAS_SIZE=2560` by default; set these environment variables before starting the OCR server if you need to tune speed versus memory/accuracy.

## Notes

- If text is selected on the page, the extension summarizes the selected text.
- If nothing is selected, it summarizes the visible page body.
- On general article/blog/review pages, the extension first tries the bundled Defuddle extractor for cleaner body text, then falls back to the existing selector-based extractor when Defuddle returns too little or suspiciously large content.
- Page HTML is copied with DOM node cloning and parsed in an inert document. Extracted HTML is never assigned to the active page with `innerHTML`.
- If likely comments are found, all currently visible comment candidates are analyzed. Sites are not paginated automatically except for supported Danawa product pages, Kakaku product-review pages, and Kakaku product BBS pages.
- On DCInside, rendered comment rows are collected only from the real visible `ul.cmt_list.add` comment list. Image-adjacent reaction text is not treated as comments.
- On Instagram and non-product Danawa pages, site-specific collectors read the currently rendered comment, review, and product-opinion rows.
- On `prod.danawa.com` product pages, the background job fetches every product-opinion and company-review page in 100-row batches, retries transient failures, removes duplicate row IDs, and sends the complete set to chunked comment analysis.
- On `review.kakaku.com/review/K.../` pages, the background job follows every `Page=N` review page, decodes the Shift_JIS response explicitly, and collects the author, date, review ID, overall and category ratings, title, full review body, usage details, and helpful count. It verifies the collected count against Kakaku's reported total before analysis.
- On `bbs.kakaku.com/bbs/K.../` product BBS pages, the background job follows every six-thread page and collects every thread opener and reply with its thread title, author, date, post number, and helpful score. The complete collected discussion is passed to comment analysis.
- Markdown filenames remove unsupported punctuation, emoji, control characters, trailing dots, and Windows reserved names before download.
- If OCR is enabled, the extension sends up to five large image URLs found inside detected content containers to the local OCR server and adds extracted text to the summary prompt. It does not fall back to scanning every image in the page body, and it skips logos, avatars, banners, sidebars, comments, and reply areas. Markdown exports include OCR timing so slow pages can be diagnosed later.
- For DCInside `viewimage.php` images, the extension keeps the original page image URL and lets the OCR server fetch it with the page URL as `Referer`, because direct background fetches can return 403 even when the image is visible in the page.
- For DCInside pages with both rendered image URLs and `imgPop` popup URLs, the rendered `dcimg`/`dccdn` URL is preferred for OCR. If the first URL returns an HTML block page, the OCR server retries the alternate original/linked URLs before reporting failure.
- On YouTube, open the transcript panel before collecting. Visible transcript segments are added to the summary prompt and Markdown export. YouTube image OCR is skipped so recommendation thumbnails are not mixed into the summary.
- Long collected pages are analyzed in stages. The extension summarizes body text, comment candidates, image OCR, and YouTube transcripts separately, skips sections that are not present, then asks LM Studio for a final combined summary.
- Independent LM Studio section and chunk analysis calls can run in parallel. The final combined summary still runs after all section analyses complete.
- If chunk-level analysis results are already small enough, the extension skips an extra intermediate merge call and sends them directly to the final combined summary.
- LM Studio output token limits are kept conservative for local 26B-class models, and Markdown exports include LM Studio timing by section so slow steps can be diagnosed.
- Long summaries run in a persistent Firefox background script. The popup can close, and you can keep using another browser, VSCode, terminal, or other apps while the job continues.
- Saved entries are stored in `browser.storage.local`.
- After each summary, a Markdown file is automatically downloaded under `Local Page Summarizer`.
- `Export Markdown` exports the most recently saved page.
