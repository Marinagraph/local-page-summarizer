# OCR engine benchmark

This note records the first local comparison between the current EasyOCR path and `lightonai/LightOnOCR-2-1B`.

## How to run

Prepare the separate benchmark environment:

```powershell
.\scripts\benchmark-ocr-engines.ps1 -InstallOnly
```

Run EasyOCR only:

```powershell
.\scripts\benchmark-ocr-engines.ps1 -Image "IMAGE_URL_OR_PATH" -PageUrl "SOURCE_PAGE_URL" -Engine easyocr
```

Run LightOnOCR only:

```powershell
.\scripts\benchmark-ocr-engines.ps1 -Image "IMAGE_URL_OR_PATH" -PageUrl "SOURCE_PAGE_URL" -Engine lighton
```

Run both engines:

```powershell
.\scripts\benchmark-ocr-engines.ps1 -Image "IMAGE_URL_OR_PATH" -PageUrl "SOURCE_PAGE_URL" -Engine both
```

The benchmark environment lives in `.venv-ocr-bench` and is intentionally separate from the production OCR server venv.

## Initial result

Test image:

```text
https://dcimg6.dcinside.co.kr/viewimage.php?id=29b8dd29e6c039b267bcc6ba1ad83034897e&no=24b0d769e1d32ca73fe784fa11d028316e90785a65405c690dfe6a8236464a1c51f70f0ec619cf0e45e91126c86b4c28068ebc1c638b8f572fd806a09a0b1e5613bd9ba4622665d253e751e9b216b8ea4b79797d657fa504781c8545a6a353e0e6287c2448e36dd93c726013615547
```

Source page:

```text
https://gall.dcinside.com/board/view/?id=dcbest&no=435175
```

Image size: `850x326`.

| Engine | Model load | Inference | Notes |
| --- | ---: | ---: | --- |
| EasyOCR `ko,en` | `1.423s` | `0.303s` | Produced plain OCR text with acceptable Korean extraction. |
| LightOnOCR-2-1B | `30.707s` | `5.849s` | Produced HTML-like reconstructed output and one visible Korean typo. |

## Current decision

Do not replace EasyOCR with LightOnOCR yet. On the first Korean community screenshot test, LightOnOCR was slower per image and less direct than EasyOCR. It may still be useful for document layout reconstruction, but it is not a clear speed upgrade for the current extension workload.
