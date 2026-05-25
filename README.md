# Local Page Summarizer

Personal Firefox extension for saving the current page and summarizing it with LM Studio's local OpenAI-compatible API.

## Requirements

- Firefox
- LM Studio local server running at `http://127.0.0.1:2000`
- A loaded model in LM Studio
- Python 3.11 for the optional OCR server

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

If LM Studio requires an exact model name, enter that model name in the popup's `Model` field.
The default model name is `gemma-4-26b-a4b-it`.

## OCR server

The extension can send large page images to a local OCR server at:

```text
http://127.0.0.1:2010/ocr
```

Start it with:

```powershell
.\scripts\start-ocr-server.ps1
```

The first run creates `.venv-ocr`, installs Python dependencies, and downloads EasyOCR's Korean and English models. The script prefers Python 3.11 because some EasyOCR dependencies are unreliable on Python 3.13. Keep this terminal open while using OCR.

## Notes

- If text is selected on the page, the extension summarizes the selected text.
- If nothing is selected, it summarizes the visible page body.
- If likely comments are found, the summary asks the model to quote short notable comments for reference.
- If OCR is enabled, the extension sends up to five large image URLs to the local OCR server and adds extracted text to the summary prompt.
- On YouTube, open the transcript panel before collecting. Visible transcript segments are added to the summary prompt and Markdown export.
- Long summaries run in an inactive extension runner tab, so the popup can close and you can keep using the browser or other apps while the job continues.
- Saved entries are stored in `browser.storage.local`.
- After each summary, a Markdown file is automatically downloaded under `Local Page Summarizer`.
- `Export Markdown` exports the most recently saved page.
