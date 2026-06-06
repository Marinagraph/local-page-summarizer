const LM_STUDIO_ENDPOINT = "http://127.0.0.1:2000/v1/chat/completions";
const LM_STUDIO_MODELS_ENDPOINT = "http://127.0.0.1:2000/v1/models";
const DEFAULT_OCR_ENDPOINT = "http://127.0.0.1:2010/ocr";
const DEFAULT_MAX_CHARS = 8000;
const MIN_MAX_CHARS = 1000;
const SUMMARY_MAX_TOKENS = 1400;

let activeJob = null;
let activeAbortController = null;
const LIVE_JOB_TTL_MS = 60 * 60 * 1000;

function storageKeyFor(url) {
  return `page:${url}`;
}

function isLiveJobState(state) {
  if (!state || (state.status !== "queued" && state.status !== "running")) {
    return false;
  }

  const updatedAt = state.updatedAt ? new Date(state.updatedAt).getTime() : 0;
  return updatedAt > 0 && Date.now() - updatedAt < LIVE_JOB_TTL_MS;
}

async function setJobState(partial) {
  const current = (await browser.storage.local.get("summaryJobState")).summaryJobState || {};
  const next = {
    ...current,
    ...partial,
    updatedAt: new Date().toISOString()
  };
  await browser.storage.local.set({ summaryJobState: next });
  return next;
}

async function collectPageFromTab(tabId) {
  try {
    return await browser.tabs.sendMessage(tabId, { type: "COLLECT_PAGE" });
  } catch (error) {
    await browser.tabs.executeScript(tabId, { file: "contentScript.js" });
    return browser.tabs.sendMessage(tabId, { type: "COLLECT_PAGE" });
  }
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

function normalizeMaxChars(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return DEFAULT_MAX_CHARS;
  }

  return Math.max(MIN_MAX_CHARS, Math.floor(numeric));
}

function clampText(value, maxChars) {
  const text = String(value || "").replace(/\r\n/g, "\n").trim();
  if (!text || maxChars <= 0) {
    return "";
  }

  if (text.length <= maxChars) {
    return text;
  }

  const omitted = text.length - maxChars;
  return `${text.slice(0, maxChars).trim()}\n[truncated: ${omitted.toLocaleString()} chars omitted]`;
}

function compactForContext(page, maxChars) {
  const budget = normalizeMaxChars(maxChars);
  const hasComments = Array.isArray(page.comments) && page.comments.length > 0;
  const hasOcr = Array.isArray(page.ocrResults) && page.ocrResults.length > 0;
  const hasTranscript = Boolean(page.transcript && page.transcript.text);

  let sourceBudget = Math.floor(budget * 0.45);
  if (!hasComments) sourceBudget += Math.floor(budget * 0.18);
  if (!hasOcr) sourceBudget += Math.floor(budget * 0.17);
  if (!hasTranscript) sourceBudget += Math.floor(budget * 0.10);

  const commentsBudget = hasComments ? Math.floor(budget * 0.20) : 0;
  const ocrBudget = hasOcr ? Math.floor(budget * 0.20) : 0;
  const transcriptBudget = hasTranscript ? Math.floor(budget * 0.15) : 0;

  const commentsText = hasComments
    ? page.comments
      .slice(0, 24)
      .map((comment, index) => `${index + 1}. ${clampText(comment, 280)}`)
      .join("\n")
    : "";

  const ocrText = hasOcr
    ? page.ocrResults
      .slice(0, 5)
      .map((result) => [
        `Image ${result.index}: ${result.width || "?"}x${result.height || "?"}`,
        result.alt ? `ALT: ${clampText(result.alt, 160)}` : "",
        result.url ? `URL: ${result.url}` : "",
        result.text ? clampText(result.text, 900) : result.error ? `OCR error: ${result.error}` : "No OCR text"
      ].filter(Boolean).join("\n"))
      .join("\n\n")
    : "";

  const transcriptText = hasTranscript
    ? clampText(page.transcript.text, transcriptBudget)
    : "";

  const sections = [
    [
      `Title: ${page.title || ""}`,
      `URL: ${page.url || ""}`,
      page.description ? `Description: ${page.description}` : "",
      page.selectedOnly ? "Collected range: selected text" : "Collected range: page body"
    ].filter(Boolean).join("\n"),
    `[SOURCE TEXT]\n${clampText(page.text, sourceBudget)}`,
    transcriptText ? `[YOUTUBE TRANSCRIPT]\n${transcriptText}` : "",
    commentsText ? `[COMMENT CANDIDATES]\n${clampText(commentsText, commentsBudget)}` : "",
    ocrText ? `[IMAGE OCR]\n${clampText(ocrText, ocrBudget)}` : ""
  ].filter(Boolean).join("\n\n");

  return clampText(sections, budget);
}

function buildSummaryMessages(content) {
  return [
    {
      role: "system",
      content: [
        "You are a Korean personal research assistant.",
        "Summarize the provided web page in Korean.",
        "Ignore ads, menus, repeated boilerplate, and navigation text.",
        "Separate claims from evidence, and be careful with community posts or unverified screenshots.",
        "If comment candidates are present, quote only short notable comments that help interpret user reaction.",
        "If OCR text is present, treat it as potentially noisy and mention only useful evidence from it.",
        "If a YouTube transcript is present, summarize the main claims and flow."
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
        "6. 이미지 OCR에서 확인한 내용",
        "7. YouTube transcript에서 확인한 내용",
        "8. 구매 또는 판단 시 주의점",
        "9. 출처에서 확인해야 할 부분",
        "",
        content
      ].join("\n")
    }
  ];
}

async function requestSummaryCompletion(model, content, signal) {
  const response = await fetch(LM_STUDIO_ENDPOINT, {
    method: "POST",
    signal,
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model,
      messages: buildSummaryMessages(content),
      temperature: 0.2,
      max_tokens: SUMMARY_MAX_TOKENS,
      stream: false
    })
  });

  if (!response.ok) {
    return {
      ok: false,
      status: response.status,
      errorText: await response.text()
    };
  }

  const data = await response.json();
  const summary = data && data.choices && data.choices[0] && data.choices[0].message
    ? data.choices[0].message.content
    : "";

  if (!summary) {
    return {
      ok: false,
      status: response.status,
      errorText: "LM Studio response did not contain a summary."
    };
  }

  return {
    ok: true,
    summary: summary.trim()
  };
}

function isContextLengthError(errorText) {
  return /context length|n_keep|tokens to keep|too many tokens|maximum context/i.test(String(errorText || ""));
}

async function summarizeWithLMStudioSafe(page, settings, signal) {
  const model = await resolveModelName(settings.model, signal);
  const maxChars = normalizeMaxChars(settings.maxChars);
  const attempts = [...new Set([
    maxChars,
    Math.min(8000, Math.floor(maxChars / 2)),
    4000,
    2000
  ].map((value) => Math.min(maxChars, value))
    .filter((value) => value >= MIN_MAX_CHARS))]
    .sort((a, b) => b - a);

  let lastResult = null;
  let promptChars = attempts[0];

  for (const attemptChars of attempts) {
    promptChars = attemptChars;
    const content = compactForContext(page, promptChars);
    lastResult = await requestSummaryCompletion(model, content, signal);

    if (lastResult.ok) {
      break;
    }

    if (!isContextLengthError(lastResult.errorText)) {
      break;
    }
  }

  if (!lastResult || !lastResult.ok) {
    throw new Error(`LM Studio 요청 실패: ${lastResult ? lastResult.status : "unknown"} ${lastResult ? lastResult.errorText : ""}`);
  }

  if (promptChars < maxChars) {
    return [
      lastResult.summary,
      "",
      "---",
      `참고: 원문이 모델 컨텍스트보다 길어서 입력을 ${promptChars.toLocaleString()}자로 줄여 다시 요약했습니다.`
    ].join("\n");
  }

  return lastResult.summary;
}

async function summarizeWithLMStudio(page, settings, signal) {
  return summarizeWithLMStudioSafe(page, settings, signal);
}

async function summarizeWithLMStudioLegacy(page, settings, signal) {
  const model = await resolveModelName(settings.model, signal);
  const maxChars = Math.max(1000, Number(settings.maxChars) || 24000);
  const content = compactForPrompt(page, maxChars);

  const response = await fetch(LM_STUDIO_ENDPOINT, {
    method: "POST",
    signal,
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

async function resolveModelName(configuredModel, signal) {
  const requested = (configuredModel || "").trim();
  const response = await fetch(LM_STUDIO_MODELS_ENDPOINT, { signal });
  if (!response.ok) {
    throw new Error(`LM Studio 모델 목록 요청 실패: ${response.status}`);
  }

  const data = await response.json();
  const models = (Array.isArray(data.data) ? data.data : []).filter((item) => {
    const id = String(item.id || "");
    return id && !id.toLowerCase().includes("embedding") && !id.toLowerCase().includes("embed");
  });

  if (requested && !requested.toLowerCase().startsWith("auto")) {
    const exact = models.find((item) => item.id === requested);
    if (exact) {
      return exact.id;
    }

    const partialMatches = models.filter((item) => item.id.toLowerCase().includes(requested.toLowerCase()));
    if (partialMatches.length) {
      return pickBestModel(partialMatches).id;
    }

    return requested;
  }

  const query = requested.includes(":")
    ? requested.slice(requested.indexOf(":") + 1).trim().toLowerCase()
    : "";
  const candidates = query
    ? models.filter((item) => item.id.toLowerCase().includes(query))
    : models;
  const model = pickBestModel(candidates);

  if (!model || !model.id) {
    throw new Error("LM Studio에서 사용할 chat 모델을 찾지 못했습니다.");
  }

  return model.id;
}

function pickBestModel(models) {
  return [...models].sort((a, b) => {
    const bSize = extractModelSizeB(b.id);
    const aSize = extractModelSizeB(a.id);
    if (bSize !== aSize) {
      return bSize - aSize;
    }
    return 0;
  })[0];
}

function extractModelSizeB(modelId) {
  const matches = [...String(modelId || "").matchAll(/(\d+(?:\.\d+)?)\s*b/gi)];
  if (!matches.length) {
    return 0;
  }
  return Math.max(...matches.map((match) => Number(match[1]) || 0));
}

async function enrichPageWithOcr(page, settings, signal) {
  if (!settings.ocrEnabled) {
    return { ...page, ocrResults: [] };
  }

  const images = Array.isArray(page.images) ? page.images.slice(0, 5) : [];
  if (!images.length) {
    return { ...page, ocrResults: [] };
  }

  const preparedImages = await Promise.all(images.map((image) => prepareImageForOcr(image, signal)));
  const endpoint = settings.ocrEndpoint || DEFAULT_OCR_ENDPOINT;
  const response = await fetch(endpoint, {
    method: "POST",
    signal,
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

async function prepareImageForOcr(image, signal) {
  const url = image.linkedUrl || image.url;

  try {
    const response = await fetch(url, {
      signal,
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

async function downloadMarkdown(saved) {
  const blob = new Blob([toMarkdown(saved)], { type: "text/markdown;charset=utf-8" });
  const url = URL.createObjectURL(blob);

  await browser.downloads.download({
    url,
    filename: `Local Page Summarizer/${safeFileName(saved.title)}.md`,
    saveAs: false,
    conflictAction: "uniquify"
  });

  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

async function runSummaryJob(request) {
  activeAbortController = new AbortController();
  const signal = activeAbortController.signal;

  await setJobState({
    jobId: request.jobId,
    status: "running",
    message: "페이지 수집 중...",
    title: request.title || "",
    url: request.url || "",
    createdAt: request.createdAt
  });

  try {
    let page = await collectPageFromTab(request.tabId);
    await setJobState({
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
      await setJobState({ message: "이미지 OCR 중..." });
      page = await enrichPageWithOcr(page, request.settings, signal);
    } else {
      page = { ...page, ocrResults: [] };
    }

    await setJobState({ message: "LM Studio 요약 중..." });
    const summary = await summarizeWithLMStudio(page, request.settings, signal);

    await setJobState({ message: "결과 저장 중..." });
    const saved = await saveResult(page, summary);
    await downloadMarkdown(saved);

    await setJobState({
      status: "done",
      message: "저장 완료: Markdown 자동 저장됨",
      summary,
      title: saved.title,
      url: saved.url,
      savedAt: saved.savedAt
    });
  } catch (error) {
    await setJobState({
      status: "error",
      message: "오류",
      error: error && error.message ? error.message : String(error)
    });
  } finally {
    activeJob = null;
    activeAbortController = null;
  }
}

browser.runtime.onMessage.addListener((message) => {
  if (!message || message.type !== "START_SUMMARY_JOB") {
    if (message && message.type === "RESET_SUMMARY_JOB") {
      if (activeAbortController) {
        activeAbortController.abort();
      }
      activeJob = null;
      return browser.storage.local.set({
        summaryJobState: {
          status: "idle",
          message: "작업 상태가 초기화되었습니다.",
          updatedAt: new Date().toISOString()
        }
      }).then(() => ({ ok: true }));
    }
    return false;
  }

  return (async () => {
    const currentState = (await browser.storage.local.get("summaryJobState")).summaryJobState;
    const sameRequest = currentState && message.request && currentState.jobId === message.request.jobId;

    if (activeJob) {
      return { started: false, state: currentState };
    }

    if (isLiveJobState(currentState) && !sameRequest) {
      return { started: false, state: currentState };
    }

    await setJobState({
      ...message.request,
      status: "queued",
      message: "작업 준비 중..."
    });

    activeJob = runSummaryJob(message.request);
    activeJob.catch(() => {});

    return {
      started: true,
      state: (await browser.storage.local.get("summaryJobState")).summaryJobState
    };
  })();
});
