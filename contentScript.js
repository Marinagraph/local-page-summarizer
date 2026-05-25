function cleanText(text) {
  return text
    .replace(/\r/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function getMetaDescription() {
  const meta = document.querySelector('meta[name="description"], meta[property="og:description"]');
  return meta ? cleanText(meta.getAttribute("content") || "") : "";
}

function collectLikelyComments() {
  const selectors = [
    "[data-testid*='comment' i]",
    "[class*='comment' i]",
    "[id*='comment' i]",
    "article"
  ];

  const seen = new Set();
  const comments = [];

  for (const selector of selectors) {
    for (const element of document.querySelectorAll(selector)) {
      const text = cleanText(element.innerText || "");
      if (text.length < 30 || text.length > 5000 || seen.has(text)) {
        continue;
      }

      seen.add(text);
      comments.push(text);

      if (comments.length >= 80) {
        return comments;
      }
    }
  }

  return comments;
}

function collectImageCandidates() {
  const seen = new Set();
  const images = [];

  function firstSrcFromSrcset(srcset) {
    return (srcset || "").split(",")[0].trim().split(/\s+/)[0] || "";
  }

  function resolveUrl(value) {
    if (!value) {
      return "";
    }

    try {
      return new URL(value, location.href).href;
    } catch {
      return value;
    }
  }

  function isLikelyImageUrl(value) {
    return /\.(png|jpe?g|webp|gif|bmp)(\?|#|$)/i.test(value);
  }

  for (const image of document.querySelectorAll("img")) {
    const src = resolveUrl(
      image.currentSrc ||
      image.src ||
      image.getAttribute("data-original") ||
      image.getAttribute("data-src") ||
      image.getAttribute("data-lazy-src") ||
      image.getAttribute("data-url") ||
      firstSrcFromSrcset(image.getAttribute("srcset"))
    );
    const width = image.naturalWidth || image.width || 0;
    const height = image.naturalHeight || image.height || 0;
    const lowerSrc = src.toLowerCase();
    const linkedImage = resolveUrl(image.closest("a")?.href || "");

    if (!src || seen.has(src)) {
      continue;
    }
    if ((width < 300 || height < 180) && !isLikelyImageUrl(src) && !isLikelyImageUrl(linkedImage)) {
      continue;
    }
    if (lowerSrc.includes("logo") || lowerSrc.includes("avatar") || lowerSrc.includes("profile") || lowerSrc.includes("emoji")) {
      continue;
    }
    if (lowerSrc.endsWith(".svg") || lowerSrc.startsWith("blob:")) {
      continue;
    }

    seen.add(src);
    images.push({
      url: src,
      linkedUrl: isLikelyImageUrl(linkedImage) ? linkedImage : "",
      alt: image.alt || "",
      width,
      height
    });

    if (images.length >= 8) {
      break;
    }
  }

  return images;
}

function getBestTextSource() {
  const selectors = [
    ".view_content",
    ".article_content",
    ".board_main_view",
    ".read_body",
    ".body_area",
    ".write_div",
    ".view_body",
    "#board_read",
    "article",
    "main",
    "[role='main']",
    "body"
  ];
  const candidates = [];

  for (const selector of selectors) {
    for (const element of document.querySelectorAll(selector)) {
      const text = cleanText(element.innerText || "");
      if (text && !candidates.some((candidate) => candidate.text === text)) {
        candidates.push({ element, text });
      }
    }
  }

  candidates.sort((a, b) => b.text.length - a.text.length);
  return candidates[0] || { element: document.body, text: cleanText(document.body.innerText || "") };
}

function collectYouTubeTranscript() {
  if (!location.hostname.includes("youtube.com")) {
    return { text: "", segments: [] };
  }

  const segmentSelectors = [
    "ytd-transcript-segment-renderer",
    "yt-transcript-segment-renderer",
    "[class*='transcript-segment']"
  ];
  const segments = [];
  const seen = new Set();

  for (const selector of segmentSelectors) {
    for (const element of document.querySelectorAll(selector)) {
      const timestampElement = element.querySelector("#timestamp, .segment-timestamp, [class*='timestamp']");
      const textElement = element.querySelector("#content-text, .segment-text, yt-formatted-string, [class*='segment-text']");
      const timestamp = cleanText(timestampElement ? timestampElement.innerText || "" : "");
      const text = cleanText(textElement ? textElement.innerText || "" : element.innerText || "");
      const normalizedText = cleanText(text.replace(timestamp, ""));

      if (!normalizedText || normalizedText.length < 2) {
        continue;
      }

      const key = `${timestamp}|${normalizedText}`;
      if (seen.has(key)) {
        continue;
      }

      seen.add(key);
      segments.push({ timestamp, text: normalizedText });
    }
  }

  const text = cleanText(segments.map((segment) => {
    return segment.timestamp ? `${segment.timestamp} ${segment.text}` : segment.text;
  }).join("\n"));

  return { text, segments };
}

function collectPage() {
  const selection = cleanText(String(window.getSelection ? window.getSelection() : ""));
  const bestSource = getBestTextSource();
  const text = cleanText(selection || bestSource.text || document.body.innerText || "");
  const transcript = collectYouTubeTranscript();

  return {
    title: document.title || location.href,
    url: location.href,
    description: getMetaDescription(),
    text,
    comments: collectLikelyComments(),
    images: collectImageCandidates(),
    transcript,
    selectedOnly: Boolean(selection),
    collectedAt: new Date().toISOString()
  };
}

const LM_STUDIO_ENDPOINT = "http://127.0.0.1:2000/v1/chat/completions";
const DEFAULT_OCR_ENDPOINT = "http://127.0.0.1:2010/ocr";

let activeSummaryJob = null;

function storageKeyFor(url) {
  return `page:${url}`;
}

async function updateJobState(partial) {
  const current = (await browser.storage.local.get("summaryJobState")).summaryJobState || {};
  const next = {
    ...current,
    ...partial,
    updatedAt: new Date().toISOString()
  };
  await browser.storage.local.set({ summaryJobState: next });
  return next;
}

function compactForPrompt(page, maxChars) {
  const comments = page.comments && page.comments.length
    ? `\n\n[댓글 후보]\n${page.comments.map((comment, index) => `${index + 1}. ${comment}`).join("\n\n")}`
    : "";
  const transcriptText = page.transcript && page.transcript.text
    ? `\n\n[YouTube transcript]\n${page.transcript.text}`
    : "";
  const ocrText = page.ocrResults && page.ocrResults.length
    ? `\n\n[이미지 OCR 텍스트]\n${page.ocrResults.map((result) => [
      `이미지 ${result.index}: ${result.width}x${result.height}`,
      result.alt ? `ALT: ${result.alt}` : "",
      `URL: ${result.url}`,
      result.text ? result.text : result.error ? `OCR 오류: ${result.error}` : "OCR 텍스트 없음"
    ].filter(Boolean).join("\n")).join("\n\n")}`
    : "";

  const body = [
    `제목: ${page.title}`,
    `URL: ${page.url}`,
    page.description ? `설명: ${page.description}` : "",
    page.selectedOnly ? "수집 범위: 사용자가 선택한 텍스트" : "수집 범위: 페이지 본문",
    "",
    page.text,
    transcriptText,
    comments,
    ocrText
  ].filter(Boolean).join("\n");

  return body.slice(0, maxChars);
}

async function summarizeWithLMStudio(page, settings) {
  const model = settings.model || "gemma-4-26b-a4b-it";
  const maxChars = Math.max(1000, Number(settings.maxChars) || 24000);
  const content = compactForPrompt(page, maxChars);

  const response = await fetch(LM_STUDIO_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model,
      messages: [
        {
          role: "system",
          content: [
            "너는 한국어 개인 리서치 보조자다.",
            "주어진 웹페이지 내용을 사실 중심으로 정리한다.",
            "광고, 메뉴, 중복 문구는 무시하고 페이지의 주장과 근거를 우선한다.",
            "댓글 후보가 있으면 사용자 반응으로 따로 정리한다.",
            "이미지 OCR 텍스트가 있으면 캡처 기사나 이미지 본문일 수 있으므로 함께 분석하되, OCR 오류 가능성이 있는 내용은 단정하지 않는다.",
            "YouTube transcript가 있으면 영상의 핵심 주장, 근거, 시간 흐름을 중심으로 정리한다."
          ].join(" ")
        },
        {
          role: "user",
          content: [
            "다음 페이지를 아래 형식으로 정리해줘.",
            "",
            "1. 핵심 요약",
            "2. 장점",
            "3. 단점",
            "4. 댓글/사용자 반응",
            "5. 눈여겨볼 댓글",
            "   - 참고할 만한 댓글이 있으면 원문에서 핵심 문장만 짧게 인용하고, 왜 중요한지 한 줄로 설명",
            "   - 댓글 후보가 없거나 의미 있는 댓글이 없으면 '특별히 인용할 댓글 없음'이라고 작성",
            "6. 이미지 OCR에서 확인된 내용",
            "   - 이미지 OCR 텍스트가 있으면 본문과 다른 핵심 내용만 정리",
            "   - OCR 텍스트가 없으면 '이미지 OCR 내용 없음'이라고 작성",
            "7. YouTube transcript에서 확인된 내용",
            "   - transcript가 있으면 영상의 핵심 흐름과 중요한 발언을 정리",
            "   - transcript가 없으면 'YouTube transcript 없음'이라고 작성",
            "8. 구매 또는 판단 시 주의점",
            "9. 출처에서 확인해야 할 부분",
            "",
            content
          ].join("\n")
        }
      ],
      temperature: 0.2,
      stream: false
    })
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`LM Studio 요청 실패: ${response.status} ${errorText}`);
  }

  const data = await response.json();
  const summary = data && data.choices && data.choices[0] && data.choices[0].message
    ? data.choices[0].message.content
    : "";

  if (!summary) {
    throw new Error("LM Studio 응답에서 요약을 찾지 못했습니다.");
  }

  return summary.trim();
}

async function enrichPageWithOcr(page, settings) {
  if (!settings.ocrEnabled) {
    return { ...page, ocrResults: [] };
  }

  const images = Array.isArray(page.images) ? page.images.slice(0, 5) : [];
  if (!images.length) {
    return { ...page, ocrResults: [] };
  }

  const preparedImages = await Promise.all(images.map(prepareImageForOcr));
  const endpoint = settings.ocrEndpoint || DEFAULT_OCR_ENDPOINT;
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      pageUrl: page.url,
      images: preparedImages
    })
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`OCR 요청 실패: ${response.status} ${errorText}`);
  }

  const data = await response.json();
  return {
    ...page,
    ocrResults: Array.isArray(data.results) ? data.results : []
  };
}

async function prepareImageForOcr(image) {
  const url = image.linkedUrl || image.url;

  try {
    const response = await fetch(url, {
      credentials: "include",
      cache: "force-cache"
    });

    if (!response.ok) {
      throw new Error(`image fetch failed: ${response.status}`);
    }

    const blob = await response.blob();
    if (!blob.type.startsWith("image/")) {
      throw new Error(`not an image response: ${blob.type || "unknown"}`);
    }

    const dataUrl = await blobToDataUrl(blob);
    return {
      ...image,
      originalUrl: image.url,
      url: dataUrl
    };
  } catch (error) {
    return {
      ...image,
      url,
      fetchError: error && error.message ? error.message : String(error)
    };
  }
}

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(reader.error || new Error("failed to read image blob"));
    reader.readAsDataURL(blob);
  });
}

async function saveResult(page, summary) {
  const saved = {
    ...page,
    summary,
    savedAt: new Date().toISOString()
  };

  await browser.storage.local.set({
    [storageKeyFor(page.url)]: saved,
    lastSavedUrl: page.url
  });

  return saved;
}

function safeFileName(title) {
  return title
    .replace(/[\\/:*?"<>|]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80) || "page-summary";
}

function toMarkdown(saved) {
  const transcriptSection = saved.transcript && saved.transcript.text
    ? [
      "## YouTube Transcript",
      "",
      "```text",
      saved.transcript.text,
      "```",
      ""
    ]
    : [];
  const ocrSection = saved.ocrResults && saved.ocrResults.length
    ? [
      "## Image OCR",
      "",
      ...saved.ocrResults.flatMap((result) => [
        `### Image ${result.index}`,
        "",
        `- URL: ${result.url}`,
        `- Size: ${result.width}x${result.height}`,
        result.alt ? `- Alt: ${result.alt}` : "",
        result.error ? `- Error: ${result.error}` : "",
        "",
        "```text",
        result.text || "",
        "```",
        ""
      ].filter(Boolean))
    ]
    : [];

  return [
    `# ${saved.title}`,
    "",
    `- URL: ${saved.url}`,
    `- Collected: ${saved.collectedAt}`,
    `- Saved: ${saved.savedAt}`,
    `- Selected only: ${saved.selectedOnly ? "yes" : "no"}`,
    "",
    "## Summary",
    "",
    saved.summary,
    "",
    ...transcriptSection,
    ...ocrSection,
    "## Source Text",
    "",
    "```text",
    saved.text,
    "```"
  ].join("\n");
}

async function autoSaveMarkdown(saved) {
  const markdown = toMarkdown(saved);
  const filename = `Local Page Summarizer/${safeFileName(saved.title)}.md`;

  try {
    await browser.runtime.sendMessage({
      type: "DOWNLOAD_MARKDOWN",
      filename,
      markdown
    });
  } catch {
    const blob = new Blob([markdown], { type: "text/markdown;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `${safeFileName(saved.title)}.md`;
    link.style.display = "none";
    document.documentElement.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
  }
}

async function runSummaryJob(request) {
  if (activeSummaryJob) {
    return activeSummaryJob;
  }

  activeSummaryJob = (async () => {
    await updateJobState({
      jobId: request.jobId,
      status: "running",
      message: "페이지 수집 중...",
      title: document.title || request.title || "",
      url: location.href,
      createdAt: request.createdAt
    });

    try {
      let page = collectPage();
      await updateJobState({
        message: "페이지 수집 완료",
        title: page.title,
        url: page.url
      });

      const hasImagesForOcr = request.settings.ocrEnabled && Array.isArray(page.images) && page.images.length > 0;
      const hasTranscript = Boolean(page.transcript && page.transcript.text);
      if ((!page.text || page.text.length < 20) && !hasImagesForOcr && !hasTranscript) {
        throw new Error("수집된 텍스트가 너무 짧습니다. 페이지가 완전히 로드된 뒤 다시 시도하세요.");
      }

      if (request.settings.ocrEnabled) {
        await updateJobState({ message: "이미지 OCR 중..." });
        page = await enrichPageWithOcr(page, request.settings);
      } else {
        page = { ...page, ocrResults: [] };
      }

      await updateJobState({ message: "LM Studio 요약 중..." });
      const summary = await summarizeWithLMStudio(page, request.settings);

      await updateJobState({ message: "결과 저장 중..." });
      const saved = await saveResult(page, summary);
      await autoSaveMarkdown(saved);

      await updateJobState({
        status: "done",
        message: "저장 완료: Markdown 자동 저장됨",
        summary,
        title: saved.title,
        url: saved.url,
        savedAt: saved.savedAt
      });
    } catch (error) {
      await updateJobState({
        status: "error",
        message: "오류",
        error: error && error.message ? error.message : String(error)
      });
    } finally {
      activeSummaryJob = null;
    }
  })();

  return activeSummaryJob;
}

browser.runtime.onMessage.addListener((message) => {
  if (message && message.type === "COLLECT_PAGE") {
    return Promise.resolve(collectPage());
  }

  if (message && message.type === "RUN_SUMMARY_JOB") {
    runSummaryJob(message.request);
    return Promise.resolve({ started: true });
  }

  return false;
});
