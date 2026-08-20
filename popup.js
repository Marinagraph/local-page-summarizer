const DEFAULT_OCR_ENDPOINT = "http://127.0.0.1:2010/ocr";
const DEFAULT_MAX_CHARS = 8000;
const MIN_MAX_CHARS = 1000;
const DEFAULT_LM_STUDIO_CONCURRENCY = 2;
const MAX_LM_STUDIO_CONCURRENCY = 4;
const LEGACY_DEFAULT_MAX_CHARS = 24000;
const LEGACY_DEFAULT_MODELS = new Set([
  "local-model",
  "gemma-4-26b-a4b-it"
]);

const collectButton = document.querySelector("#collectButton");
const exportButton = document.querySelector("#exportButton");
const resetButton = document.querySelector("#resetButton");
const modelInput = document.querySelector("#modelInput");
const maxCharsInput = document.querySelector("#maxCharsInput");
const lmConcurrencyInput = document.querySelector("#lmConcurrencyInput");
const ocrEnabledInput = document.querySelector("#ocrEnabledInput");
const ocrEndpointInput = document.querySelector("#ocrEndpointInput");
const statusElement = document.querySelector("#status");
const summaryElement = document.querySelector("#summary");
const pageMetaElement = document.querySelector("#pageMeta");

let lastSaved = null;
let pollTimer = null;
const LIVE_JOB_TTL_MS = 60 * 60 * 1000;

function isLiveJobState(state) {
  if (!state || (state.status !== "queued" && state.status !== "running")) {
    return false;
  }

  const updatedAt = state.updatedAt ? new Date(state.updatedAt).getTime() : 0;
  return updatedAt > 0 && Date.now() - updatedAt < LIVE_JOB_TTL_MS;
}

function setStatus(message) {
  statusElement.textContent = message;
}

function storageKeyFor(url) {
  return `page:${url}`;
}

function safeFileName(title) {
  const normalized = String(title || "").normalize("NFKC");
  let fileName = normalized
    .replace(/[\u0000-\u001F\u007F-\u009F]/g, " ")
    .replace(/[\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFEFF]/g, " ")
    .replace(/[\uD800-\uDFFF]/g, " ")
    .replace(/[\\/:*?"<>|]+/g, " ")
    .replace(/[^0-9A-Za-z\u00C0-\u024F\u1100-\u11FF\u3130-\u318F\u3040-\u30FF\u3400-\u9FFF\uAC00-\uD7A3 ._()\[\]-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^[. ]+|[. ]+$/g, "")
    .slice(0, 80)
    .replace(/[. ]+$/g, "");

  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(fileName)) {
    fileName = `page-${fileName}`;
  }

  return fileName || "page-summary";
}

function normalizeLmStudioConcurrency(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return DEFAULT_LM_STUDIO_CONCURRENCY;
  }

  return Math.max(1, Math.min(MAX_LM_STUDIO_CONCURRENCY, Math.floor(numeric)));
}

function lmModelSourceLabel(source) {
  if (source === "loaded") {
    return "이미 로드됨";
  }
  if (source === "default-loaded") {
    return "기본 모델 자동 로드";
  }
  if (source === "legacy-jit") {
    return "LM Studio JIT 로드";
  }
  return "";
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
        result.sourceUrl && result.sourceUrl !== result.url ? `- OCR source URL: ${result.sourceUrl}` : "",
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
  const lmTimingSection = saved.lmTimings && saved.lmTimings.length
    ? [
      "## LM Studio Timing",
      "",
      "| Step | Section | Chunk | Elapsed | Prompt | Completion | Reasoning | Total |",
      "| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |",
      ...saved.lmTimings.map((timing) => {
        return `| ${timing.type || ""} | ${timing.section || ""} | ${timing.chunk ? `${timing.chunk}/${timing.chunks || "?"}` : ""} | ${timing.elapsedMs ? `${(timing.elapsedMs / 1000).toFixed(1)}s` : ""} | ${timing.promptTokens || ""} | ${timing.completionTokens || ""} | ${Number(timing.reasoningTokens) || 0} | ${timing.totalTokens || ""} |`;
      }),
      ""
    ]
    : [];

  return [
    `# ${saved.title}`,
    "",
    `- URL: ${saved.url}`,
    `- Summarizer version: ${saved.summarizerVersion || "unknown"}`,
    saved.lmModel ? `- LM Studio model: ${saved.lmModel}` : "",
    saved.lmModelSource ? `- LM Studio model source: ${saved.lmModelSource}` : "",
    saved.lmModelContextLength ? `- LM Studio model context: ${saved.lmModelContextLength}` : "",
    saved.lmEffectiveMaxChars ? `- LM Studio chunk chars: ${saved.lmConfiguredMaxChars || saved.lmEffectiveMaxChars} configured, ${saved.lmEffectiveMaxChars} effective` : "",
    typeof saved.lmThinkingDisabled === "boolean" ? `- LM Studio thinking disabled: ${saved.lmThinkingDisabled ? "yes" : "no"}` : "",
    `- Collected: ${saved.collectedAt}`,
    `- Saved: ${saved.savedAt}`,
    `- Selected only: ${saved.selectedOnly ? "yes" : "no"}`,
    ...(saved.danawaCollection ? [
      `- Danawa product opinions: ${saved.danawaCollection.productOpinionCount} across ${saved.danawaCollection.productOpinionPages} pages`,
      `- Danawa company reviews: ${saved.danawaCollection.companyReviewCount} across ${saved.danawaCollection.companyReviewPages} pages`
    ] : []),
    ...(saved.kakakuCollection ? [
      `- Kakaku reviews: ${saved.kakakuCollection.reviewCount} across ${saved.kakakuCollection.pagesFetched} pages`,
      `- Kakaku reported reviews: ${saved.kakakuCollection.totalReported || saved.kakakuCollection.reviewCount}`
    ] : []),
    ...(saved.kakakuBbsCollection ? [
      `- Kakaku BBS threads: ${saved.kakakuBbsCollection.threadCount} across ${saved.kakakuBbsCollection.pagesFetched} pages`,
      `- Kakaku BBS posts: ${saved.kakakuBbsCollection.postCount}`
    ] : []),
    ...(saved.ocrTiming ? [
      `- OCR timing: ${saved.ocrTiming.totalSeconds}s, workers ${saved.ocrTiming.downloadWorkers}, batch ${saved.ocrTiming.easyocrBatchSize}`
    ] : []),
    "",
    "## Summary",
    "",
    saved.summary,
    "",
    ...transcriptSection,
    ...ocrSection,
    ...lmTimingSection,
    "## Source Text",
    "",
    "```text",
    saved.text,
    "```"
  ].join("\n");
}

function renderMetaFromSaved(saved) {
  const modelSource = lmModelSourceLabel(saved.lmModelSource);
  pageMetaElement.hidden = false;
  pageMetaElement.textContent = [
    saved.title,
    saved.url,
    `Transcript ${(saved.transcript?.segments || []).length.toLocaleString()} segments`,
    `Text extractor ${saved.textSource || "selectors"}`,
    `본문 ${(saved.text || "").length.toLocaleString()}자`,
    `댓글 후보 ${(saved.comments || []).length.toLocaleString()}개`,
    saved.lmModel
      ? `모델 ${saved.lmModel}${modelSource ? ` (${modelSource})` : ""}`
      : "",
    saved.lmEffectiveMaxChars
      ? `청크 ${(saved.lmConfiguredMaxChars || saved.lmEffectiveMaxChars).toLocaleString()} → ${saved.lmEffectiveMaxChars.toLocaleString()}자`
      : "",
    saved.lmThinkingDisabled ? "Thinking off" : "",
    saved.danawaCollection
      ? `다나와 상품의견 ${saved.danawaCollection.productOpinionCount.toLocaleString()}개 / 쇼핑몰 후기 ${saved.danawaCollection.companyReviewCount.toLocaleString()}개`
      : "",
    saved.kakakuCollection
      ? `가격닷컴 리뷰 ${saved.kakakuCollection.reviewCount.toLocaleString()}개 / ${saved.kakakuCollection.pagesFetched}페이지`
      : "",
    saved.kakakuBbsCollection
      ? `가격닷컴 BBS 스레드 ${saved.kakakuBbsCollection.threadCount.toLocaleString()}개 / 원글·답글 ${saved.kakakuBbsCollection.postCount.toLocaleString()}개 / ${saved.kakakuBbsCollection.pagesFetched}페이지`
      : "",
    `이미지 후보 ${(saved.images || []).length.toLocaleString()}개`,
    `OCR 결과 ${(saved.ocrResults || []).filter((result) => result.text).length.toLocaleString()}개`,
    saved.summarizerVersion ? `버전 ${saved.summarizerVersion}` : "",
    `저장 ${new Date(saved.savedAt || saved.collectedAt).toLocaleString()}`
  ].filter(Boolean).join("\n");
}

function renderJobState(state) {
  if (!state) {
    collectButton.disabled = false;
    return;
  }

  if (isLiveJobState(state)) {
    collectButton.disabled = true;
    setStatus(state.message || "요약 작업 진행 중...");
    summaryElement.textContent = [
      "요약 작업이 원본 페이지 탭에서 진행 중입니다.",
      "원본 탭만 닫지 않으면 다른 브라우저, VSCode, 터미널을 사용해도 됩니다.",
      "",
      state.title || state.url || "",
      state.message || ""
    ].filter(Boolean).join("\n");
    return;
  }

  collectButton.disabled = false;

  if (state.status === "done") {
    setStatus("저장 완료: Markdown 자동 저장됨");
    summaryElement.textContent = state.summary || "요약 완료";
    if (lastSaved) {
      renderMetaFromSaved(lastSaved);
    }
    return;
  }

  if (state.status === "error") {
    setStatus("오류");
    summaryElement.textContent = state.error || "요약 중 오류가 발생했습니다.";
    return;
  }

  if (state.status === "idle") {
    setStatus("작업 상태 초기화됨");
    summaryElement.textContent = state.message || "다시 Save & Summarize를 누를 수 있습니다.";
  }
}

async function restoreSettings() {
  const settings = await browser.storage.local.get([
    "model",
    "maxChars",
    "lmStudioConcurrency",
    "ocrEnabled",
    "ocrEndpoint",
    "lastSavedUrl",
    "summaryJobState"
  ]);

  if (settings.model) {
    modelInput.value = LEGACY_DEFAULT_MODELS.has(settings.model) ? "auto:gemma" : settings.model;
  }
  if (settings.maxChars) {
    const savedMaxChars = Math.max(MIN_MAX_CHARS, Number(settings.maxChars) || DEFAULT_MAX_CHARS);
    maxCharsInput.value = savedMaxChars === LEGACY_DEFAULT_MAX_CHARS
      ? DEFAULT_MAX_CHARS
      : savedMaxChars;
  }
  lmConcurrencyInput.value = normalizeLmStudioConcurrency(settings.lmStudioConcurrency);
  if (typeof settings.ocrEnabled === "boolean") {
    ocrEnabledInput.checked = settings.ocrEnabled;
  }
  if (settings.ocrEndpoint) {
    ocrEndpointInput.value = settings.ocrEndpoint;
  }
  if (settings.lastSavedUrl) {
    const stored = await browser.storage.local.get(storageKeyFor(settings.lastSavedUrl));
    lastSaved = stored[storageKeyFor(settings.lastSavedUrl)] || null;
    if (lastSaved) {
      renderMetaFromSaved(lastSaved);
    }
  }
  if (settings.summaryJobState) {
    renderJobState(settings.summaryJobState);
  }
}

async function persistSettings() {
  const settings = {
    model: modelInput.value.trim() || "auto:gemma",
    maxChars: Math.max(MIN_MAX_CHARS, Number(maxCharsInput.value) || DEFAULT_MAX_CHARS),
    lmStudioConcurrency: normalizeLmStudioConcurrency(lmConcurrencyInput.value),
    ocrEnabled: ocrEnabledInput.checked,
    ocrEndpoint: ocrEndpointInput.value.trim() || DEFAULT_OCR_ENDPOINT
  };
  await browser.storage.local.set(settings);
  return settings;
}

async function markStaleJob(currentState) {
  if (!currentState || (currentState.status !== "queued" && currentState.status !== "running")) {
    return;
  }

  await browser.storage.local.set({
    summaryJobState: {
      ...currentState,
      status: "error",
      message: "오류",
      error: "이전 작업이 응답하지 않아 초기화되었습니다.",
      updatedAt: new Date().toISOString()
    }
  });
}

async function startSummaryJob() {
  const currentState = (await browser.storage.local.get("summaryJobState")).summaryJobState;
  if (isLiveJobState(currentState)) {
    renderJobState(currentState);
    return;
  }
  await markStaleJob(currentState);

  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.id) {
    throw new Error("수집할 원본 탭을 찾을 수 없습니다.");
  }

  const settings = await persistSettings();
  const jobId = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const request = {
    jobId,
    tabId: tab.id,
    settings,
    title: tab.title || "",
    url: tab.url || "",
    createdAt: new Date().toISOString()
  };
  const state = {
    jobId,
    status: "queued",
    message: "작업 준비 중...",
    title: tab.title || "",
    url: tab.url || "",
    createdAt: request.createdAt,
    updatedAt: request.createdAt
  };

  renderJobState(state);
  const response = await browser.runtime.sendMessage({
    type: "START_SUMMARY_JOB",
    request
  });

  if (response && response.state) {
    renderJobState(response.state);
    return;
  }

  renderJobState(response && response.state ? response.state : state);
}

async function refreshJobState() {
  const { summaryJobState, lastSavedUrl } = await browser.storage.local.get(["summaryJobState", "lastSavedUrl"]);
  if (lastSavedUrl) {
    const stored = await browser.storage.local.get(storageKeyFor(lastSavedUrl));
    lastSaved = stored[storageKeyFor(lastSavedUrl)] || lastSaved;
  }
  renderJobState(summaryJobState);
}

async function exportMarkdown() {
  if (!lastSaved) {
    const { lastSavedUrl } = await browser.storage.local.get("lastSavedUrl");
    if (lastSavedUrl) {
      const stored = await browser.storage.local.get(storageKeyFor(lastSavedUrl));
      lastSaved = stored[storageKeyFor(lastSavedUrl)];
    }
  }

  if (!lastSaved) {
    throw new Error("내보낼 저장 항목이 없습니다.");
  }

  const blob = new Blob([toMarkdown(lastSaved)], { type: "text/markdown;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  await browser.downloads.download({
    url,
    filename: `${safeFileName(lastSaved.title)}.md`,
    saveAs: true
  });
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}

collectButton.addEventListener("click", async () => {
  collectButton.disabled = true;
  setStatus("작업 시작 중...");
  summaryElement.textContent = "요약 작업을 원본 페이지 탭으로 넘기고 있습니다.";

  try {
    await startSummaryJob();
  } catch (error) {
    collectButton.disabled = false;
    summaryElement.textContent = error && error.message ? error.message : String(error);
    setStatus("오류");
  }
});

exportButton.addEventListener("click", async () => {
  exportButton.disabled = true;
  setStatus("Markdown 내보내는 중...");

  try {
    await exportMarkdown();
    setStatus("내보내기 완료");
  } catch (error) {
    summaryElement.textContent = error && error.message ? error.message : String(error);
    setStatus("오류");
  } finally {
    exportButton.disabled = false;
  }
});

resetButton.addEventListener("click", async () => {
  try {
    await browser.runtime.sendMessage({ type: "RESET_SUMMARY_JOB" });
  } catch {
    await browser.storage.local.set({
      summaryJobState: {
        status: "idle",
        message: "작업 상태가 초기화되었습니다.",
        updatedAt: new Date().toISOString()
      }
    });
  }

  collectButton.disabled = false;
  setStatus("작업 상태 초기화됨");
  summaryElement.textContent = "이전 작업 상태를 초기화했습니다. 다시 Save & Summarize를 누를 수 있습니다.";
});

restoreSettings().catch((error) => {
  summaryElement.textContent = error && error.message ? error.message : String(error);
  setStatus("설정 복원 오류");
});

pollTimer = setInterval(() => {
  refreshJobState().catch(() => {});
}, 1000);

window.addEventListener("unload", () => {
  if (pollTimer) {
    clearInterval(pollTimer);
  }
});
