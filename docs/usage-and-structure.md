# Local Page Summarizer 사용 및 파일 구조

이 문서는 개인용 Firefox 확장 프로그램 `Local Page Summarizer`의 파일 구조, 실행 방법, 설정 의미, OCR 서버 사용법, XPI 빌드 절차를 정리합니다.

## 개요

`Local Page Summarizer`는 현재 Firefox 탭의 본문, 댓글 후보, 이미지 OCR, YouTube transcript를 수집한 뒤 LM Studio의 OpenAI 호환 로컬 API로 요약합니다.

긴 페이지는 한 번에 잘라 보내지 않고 다음 순서로 나누어 분석합니다.

1. 본문 분석
2. 댓글 후보 분석
3. 이미지 OCR 분석
4. YouTube transcript 분석
5. 섹션별 분석 결과 최종 종합

없는 섹션은 건너뜁니다. 예를 들어 YouTube가 아니면 transcript 분석을 하지 않고, OCR을 꺼두거나 이미지가 없으면 OCR 분석을 하지 않습니다.

## 파일 구조

```text
C:\Users\objectives\local-page-summarizer
├── manifest.json
├── README.md
├── popup.html
├── popup.css
├── popup.js
├── contentScript.js
├── background.js
├── docs
│   └── usage-and-structure.md
├── scripts
│   └── start-ocr-server.ps1
└── ocr-server
    ├── server.py
    └── requirements.txt
```

생성되지만 Git에는 올리지 않는 파일과 폴더:

```text
dist\
.venv-ocr\
```

`dist\`에는 빌드한 `.xpi` 파일이 들어갑니다. `.venv-ocr\`는 OCR 서버용 Python 가상환경입니다.

## 주요 파일 역할

`manifest.json`
: Firefox 확장 설정 파일입니다. 현재 Manifest V2를 사용하며, 긴 작업이 끊기지 않도록 persistent background script를 사용합니다. 확장 ID는 `local-page-summarizer@example.local`입니다.

`popup.html`, `popup.css`, `popup.js`
: Firefox 툴바 버튼을 눌렀을 때 열리는 팝업 UI입니다. 모델명, 최대 청크 크기, OCR 사용 여부, OCR endpoint를 설정하고 작업 시작/상태 표시/Markdown 내보내기를 담당합니다. 긴 요약 작업 자체는 popup에서 돌리지 않습니다.

`contentScript.js`
: 실제 웹페이지 안에서 실행되는 수집기입니다. 본문, 댓글 후보, 이미지 후보, YouTube transcript를 수집합니다. 디시인사이드에서는 렌더링된 댓글 행을 우선 수집하고, 실패하면 보이는 `전체 댓글 ...개` 텍스트 구간을 파싱합니다. 이미지 후보는 감지된 본문 컨테이너 안에서만 수집하고, 로고/아바타/배너/사이드바/댓글 영역 이미지는 제외합니다.

`background.js`
: 핵심 작업자입니다. popup에서 요청을 받으면 현재 탭에서 수집한 데이터를 받아 OCR 서버와 LM Studio를 호출하고, 결과를 `browser.storage.local`에 저장한 뒤 Markdown 파일을 다운로드합니다.

`scripts\start-ocr-server.ps1`
: OCR 서버 실행용 PowerShell 스크립트입니다. Python 3.11을 우선 사용하고, 가상환경 생성과 dependency 설치를 처리합니다.

`ocr-server\server.py`
: FastAPI 기반 OCR 서버입니다. EasyOCR로 한국어/영어 OCR을 수행합니다. Firefox 확장에서 이미지 URL 또는 data URL을 받아 텍스트를 추출합니다.

`ocr-server\requirements.txt`
: OCR 서버 Python dependency 목록입니다.

## 실행 전 준비

필수:

- Firefox
- LM Studio
- LM Studio local server: `http://127.0.0.1:2000`
- LM Studio에 로드된 chat model

OCR을 쓸 때만 필요:

- Python 3.11
- CUDA-capable GPU
- CUDA-enabled PyTorch build
- OCR 서버 실행 터미널

LM Studio 서버 endpoint는 다음과 같아야 합니다.

```text
http://127.0.0.1:2000/v1/chat/completions
```

모델 목록 endpoint는 확장이 자동으로 사용합니다.

```text
http://127.0.0.1:2000/v1/models
```

## Firefox에 설치

임시 로드 방식:

1. Firefox 주소창에 `about:debugging#/runtime/this-firefox` 입력
2. `Load Temporary Add-on` 클릭
3. `C:\Users\objectives\local-page-summarizer\manifest.json` 선택
4. 요약할 웹페이지 열기
5. 툴바의 확장 버튼 클릭
6. `Save & Summarize` 클릭

서명된 XPI를 사용할 때:

1. `dist\local-page-summarizer-버전.xpi` 파일을 Firefox에 설치
2. 새 버전을 만들면 AMO 개발자 페이지에서 같은 확장 ID로 업데이트 업로드

## 기본 사용법

1. LM Studio에서 모델을 로드합니다.
2. LM Studio local server를 `127.0.0.1:2000`으로 켭니다.
3. OCR이 필요하면 OCR 서버도 켭니다.
4. Firefox에서 요약할 페이지를 엽니다.
5. 필요한 경우 페이지가 완전히 로드될 때까지 기다립니다.
6. YouTube 영상이면 transcript 패널을 먼저 열어둡니다.
7. 확장 버튼을 누릅니다.
8. 설정을 확인하고 `Save & Summarize`를 누릅니다.
9. 작업이 끝나면 `Downloads\Local Page Summarizer\` 아래에 Markdown 파일이 자동 저장됩니다.

텍스트를 선택한 상태로 실행하면 페이지 전체가 아니라 선택한 텍스트를 중심으로 수집합니다.

## Popup 설정

`Model`
: LM Studio에 보낼 모델명입니다. 기본값은 `auto:gemma`입니다. 이 값은 LM Studio의 `/v1/models` 목록에서 embedding 모델을 제외한 Gemma 계열 모델 중 가장 큰 모델을 자동 선택합니다. 정확한 모델 ID나 일부 문자열도 직접 입력할 수 있습니다.

예:

```text
auto:gemma
google/gemma-4-31b-qat
gemma
qwen
```

`Max chars`
: 전체 페이지 제한이 아니라 한 번의 LM Studio 호출에 넣을 청크 크기입니다. 기본값은 `8000`입니다. LM Studio에서 context를 100k 정도로 크게 잡았다면 `80000` 또는 `100000`처럼 올려 청크 수를 줄일 수 있습니다. context 오류가 발생하면 확장은 더 작은 크기로 자동 재시도합니다.

`Parallel`
: 동시에 실행할 LM Studio 분석 호출 수입니다. 기본값은 `2`입니다. LM Studio 슬롯과 GPU 여유가 충분하면 `3` 또는 `4`를 시도할 수 있고, PC가 버거우면 `1`로 낮춥니다. 최종 종합 요약은 모든 섹션 분석이 끝난 뒤 한 번만 실행됩니다.

`OCR images`
: 켜면 감지된 본문 컨테이너 안의 이미지 후보를 OCR 서버로 보냅니다. 꺼두면 OCR 서버를 호출하지 않습니다.

`OCR endpoint`
: 기본값은 다음과 같습니다.

```text
http://127.0.0.1:2010/ocr
```

## OCR 서버 사용법

PowerShell에서 프로젝트 폴더로 이동한 뒤 실행합니다.

```powershell
cd C:\Users\objectives\local-page-summarizer
.\scripts\start-ocr-server.ps1
```

처음 실행하면 `.venv-ocr` 가상환경을 만들고 PyTorch `cu128` wheel index에서 CUDA PyTorch를 명시적으로 설치한 뒤 EasyOCR dependency를 설치합니다. 그 다음 PyTorch가 CUDA GPU를 인식하는지 확인하고 EasyOCR 모델을 설치합니다. OCR 서버는 GPU 전용이며 CUDA가 보이지 않으면 시작하지 않습니다. EasyOCR reader는 서버 시작 시 미리 로드되므로 서버 시작은 조금 길어질 수 있지만 첫 요약 작업의 OCR 대기 시간이 줄어듭니다.

정상 실행 확인:

```powershell
curl http://127.0.0.1:2010/health
```

예상 응답:

```json
{"status":"ok","gpu":"cuda:..."}
```

이미 2010 포트를 쓰는 서버가 있고 `/health` 응답에 CUDA GPU 정보가 없으면 `scripts\start-ocr-server.ps1`가 오래된 OCR 서버 프로세스를 종료하고 최신 GPU OCR 서버를 다시 시작합니다. 정상 GPU OCR 서버가 이미 실행 중이면 그대로 재사용합니다.

OCR 서버는 CPU fallback을 허용하지 않습니다. CUDA GPU가 보이지 않으면 시작 단계에서 실패합니다.

## DCInside 이미지 처리

디시인사이드 이미지는 웹페이지에서는 보이지만 직접 URL을 열거나 background script에서 fetch하면 `403 Forbidden`이 날 수 있습니다.

확장은 다음 URL 패턴을 이미지 후보로 인정합니다.

```text
https://dcimg6.dcinside.co.kr/viewimage.php?...
https://image.dcinside.com/viewimagePop.php?...
```

또한 `onclick="imgPop('...')"` 안에 들어있는 원본 팝업 이미지 URL도 추출합니다.

디시 이미지는 background script가 억지로 fetch하지 않고 OCR 서버에 URL을 넘깁니다. OCR 서버는 원래 페이지 URL을 `Referer`로 붙여 이미지를 가져옵니다.

## 저장 위치

요약 결과는 두 군데에 저장됩니다.

1. Firefox 내부 저장소: `browser.storage.local`
2. Markdown 파일: Firefox 다운로드 폴더 아래 `Local Page Summarizer`

예:

```text
C:\Users\objectives\Downloads\Local Page Summarizer\페이지 제목.md
```

Popup의 `Export Markdown`은 가장 최근 저장 결과를 다시 Markdown으로 내보냅니다.

## XPI 빌드

현재 수동 빌드 명령:

```powershell
$src='C:\Users\objectives\local-page-summarizer'
$outDir=Join-Path $src 'dist'
$version=(Get-Content -Raw (Join-Path $src 'manifest.json') | ConvertFrom-Json).version
$tmpZip=Join-Path $outDir "local-page-summarizer-$version.zip"
$xpi=Join-Path $outDir "local-page-summarizer-$version.xpi"
New-Item -ItemType Directory -Force -Path $outDir | Out-Null
Remove-Item -LiteralPath $tmpZip,$xpi -Force -ErrorAction SilentlyContinue
$files=@('manifest.json','popup.html','popup.css','popup.js','contentScript.js','background.js','README.md')
Compress-Archive -Path ($files | ForEach-Object { Join-Path $src $_ }) -DestinationPath $tmpZip -Force
Move-Item -LiteralPath $tmpZip -Destination $xpi -Force
tar -tf $xpi
```

현재 빌드 산출물 예:

```text
dist\local-page-summarizer-0.3.17.xpi
```

## 개발 검증

JavaScript 문법 검사:

```powershell
node --check .\background.js
node --check .\popup.js
node --check .\contentScript.js
```

Manifest 확인:

```powershell
Get-Content -Raw .\manifest.json | ConvertFrom-Json | Select-Object manifest_version,version
```

Git diff 공백 검사:

```powershell
git diff --check
```

## 자주 생기는 문제

`LM Studio 요청 실패: context length`
: `Max chars`를 낮추거나 LM Studio에서 모델 context length를 키웁니다. 확장은 자동 재시도를 하지만, 모델 context가 너무 작고 페이지가 매우 길면 실패할 수 있습니다.

`OCR 서버가 CUDA GPU 오류로 시작되지 않음`
: OCR은 GPU 전용입니다. `.venv-ocr` 안의 PyTorch가 CUDA GPU를 인식해야 합니다. CUDA 지원 PyTorch를 설치하거나 CUDA GPU가 있는 환경에서 실행합니다.

`OCR 결과가 엉뚱한 이미지로 나옴`
: 최신 버전에서는 감지된 본문 컨테이너 안의 이미지만 OCR 후보로 수집합니다. 사이트 구조가 특이해서 본문 이미지를 못 찾으면 해당 사이트의 본문 컨테이너 selector를 `contentScript.js`의 `CONTENT_CONTAINER_SELECTORS`에 추가합니다.

`DCInside 이미지 fetch failed: 403`
: 디시 이미지는 직접 접근이 막히는 경우가 많습니다. 최신 버전은 OCR 서버가 `Referer`를 붙여 가져오게 처리합니다. OCR 서버가 실행 중인지 먼저 확인합니다.

`DCInside 댓글이 요약에 약하게 반영됨`
: 최신 버전은 `.comment_box` 안의 렌더링된 댓글 행을 직접 수집합니다. 그래도 댓글 후보가 0개로 보이면 페이지가 댓글을 아직 렌더링하지 않은 상태일 수 있으므로 댓글이 화면에 보인 뒤 다시 실행합니다.

`popup을 닫으면 작업이 끊기는 문제`
: 현재 구조에서는 긴 작업을 popup이 아니라 persistent background script가 수행합니다. popup을 닫거나 다른 창을 사용해도 작업은 계속됩니다.

`이전 작업 진행 중으로 계속 보임`
: Popup에서 `Reset Job`을 누릅니다. 실행 중인 작업이 있으면 abort하고 상태를 초기화합니다.

## 설계 원칙

- popup은 리모컨과 상태 표시만 담당합니다.
- content script는 페이지 수집만 담당합니다.
- background script는 긴 작업, LM Studio 호출, OCR 호출, 저장을 담당합니다.
- OCR 서버는 로컬 PC에서만 동작하며 이미지를 EasyOCR로 처리합니다.
- OCR 서버는 GPU 전용으로 동작하며 CPU fallback을 허용하지 않습니다.
- 댓글 후보는 현재 페이지 DOM에 보이는 범위 안에서 전부 분석합니다. 페이지네이션 뒤쪽 댓글을 자동으로 가져오지는 않습니다.
- 성능 최적화는 보이는 댓글을 줄이는 방식으로 하지 않습니다. 대신 작은 중간 분석 결과의 추가 병합 호출을 생략해 LM Studio 호출 수를 줄입니다.
- LLM은 자기 학습 시점이나 사전 지식을 기준으로 원문을 가짜로 판정하지 않도록 프롬프트에서 제한합니다.
