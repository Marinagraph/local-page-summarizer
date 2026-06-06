const LM_STUDIO_ENDPOINT = "http://127.0.0.1:2000/v1/chat/completions";
const LM_STUDIO_MODELS_ENDPOINT = "http://127.0.0.1:2000/v1/models";
const DEFAULT_OCR_ENDPOINT = "http://127.0.0.1:2010/ocr";
const DEFAULT_MAX_CHARS = 8000;
const MIN_MAX_CHARS = 1000;
const SECTION_SUMMARY_MAX_TOKENS = 900;
const SECTION_MERGE_MAX_TOKENS = 1200;
const SUMMARY_MAX_TOKENS = 1800;
const SECTION_MERGE_SKIP_RATIO = 0.45;

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

function normalizeMaxChars(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return DEFAULT_MAX_CHARS;
  }

  return Math.max(MIN_MAX_CHARS, Math.floor(numeric));
}

function chunkMaxChars(maxChars) {
  return Math.max(MIN_MAX_CHARS, Math.floor(normalizeMaxChars(maxChars) * 0.82));
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

function splitLongText(text, maxChars) {
  const chunks = [];
  let remaining = String(text || "").trim();

  while (remaining.length > maxChars) {
    let cutAt = remaining.lastIndexOf("\n", maxChars);
    if (cutAt < Math.floor(maxChars * 0.5)) {
      cutAt = remaining.lastIndexOf(". ", maxChars);
    }
    if (cutAt < Math.floor(maxChars * 0.5)) {
      cutAt = maxChars;
    }

    chunks.push(remaining.slice(0, cutAt).trim());
    remaining = remaining.slice(cutAt).trim();
  }

  if (remaining) {
    chunks.push(remaining);
  }

  return chunks.filter(Boolean);
}

function splitTextIntoChunks(value, maxChars) {
  const limit = chunkMaxChars(maxChars);
  const text = String(value || "").replace(/\r\n/g, "\n").trim();
  if (!text) {
    return [];
  }

  const blocks = text.split(/\n{2,}/).map((block) => block.trim()).filter(Boolean);
  if (!blocks.length) {
    return splitLongText(text, limit);
  }

  const chunks = [];
  let current = "";

  for (const block of blocks) {
    if (block.length > limit) {
      if (current) {
        chunks.push(current);
        current = "";
      }
      chunks.push(...splitLongText(block, limit));
      continue;
    }

    const next = current ? `${current}\n\n${block}` : block;
    if (next.length > limit) {
      chunks.push(current);
      current = block;
    } else {
      current = next;
    }
  }

  if (current) {
    chunks.push(current);
  }

  return chunks.filter(Boolean);
}

function splitEntriesIntoChunks(entries, maxChars) {
  return splitTextIntoChunks(entries.filter(Boolean).join("\n\n"), maxChars);
}

function pageContext(page) {
  const now = new Date();
  return [
    `현재 날짜(사용자 PC 기준): ${now.toLocaleDateString("ko-KR")} (${now.toISOString().slice(0, 10)})`,
    `수집 시각: ${page.collectedAt || now.toISOString()}`,
    `제목: ${page.title || ""}`,
    `URL: ${page.url || ""}`,
    page.description ? `설명: ${page.description}` : "",
    page.selectedOnly ? "수집 범위: 사용자가 선택한 텍스트" : "수집 범위: 페이지 본문",
    `본문 길이: ${(page.text || "").length.toLocaleString()}자`,
    `댓글 후보: ${(page.comments || []).length.toLocaleString()}개`,
    `이미지 후보: ${(page.images || []).length.toLocaleString()}개`,
    `OCR 결과: ${(page.ocrResults || []).filter((result) => result.text).length.toLocaleString()}개`,
    `YouTube transcript: ${page.transcript && page.transcript.text ? "있음" : "없음"}`
  ].filter(Boolean).join("\n");
}

function buildAnalysisSections(page, maxChars) {
  const sections = [];
  const sourceChunks = splitTextIntoChunks(page.text, maxChars);

  if (sourceChunks.length) {
    sections.push({
      key: "source",
      title: "본문",
      instruction: [
        "본문에서 핵심 주장, 근거, 수치, 맥락, 장점, 단점, 판단 시 주의점을 추출한다.",
        "광고, 메뉴, 중복 문구, 사이트 공통 문구는 버린다.",
        "커뮤니티 게시글이면 페이지 안에 적힌 주장과 글쓴이의 해석을 구분한다.",
        "모델의 학습 시점, 기억, 사전 지식과 다르다는 이유로 가짜나 조작이라고 판정하지 않는다."
      ].join(" "),
      chunks: sourceChunks
    });
  }

  if (Array.isArray(page.comments) && page.comments.length) {
    const commentEntries = page.comments.map((comment, index) => (
      `${index + 1}. ${clampText(comment, 1200)}`
    ));
    const commentChunks = splitEntriesIntoChunks(commentEntries, maxChars);
    if (commentChunks.length) {
      sections.push({
        key: "comments",
        title: "댓글",
        instruction: [
          "댓글 후보에서 반복되는 반응, 논쟁점, 신뢰할 만한 지적, 감정적 반응을 구분한다.",
          "대표적인 댓글 흐름과 반대 의견을 모두 포함한다.",
          "눈여겨볼 댓글은 원문 핵심 문장만 짧게 인용한다.",
          "의미 있는 댓글이 있으면 최소 3개 이상 짧게 인용한다.",
          "의미 없는 짧은 반응, 중복, 광고성 문구는 제외한다."
        ].join(" "),
        chunks: commentChunks
      });
    }
  }

  if (Array.isArray(page.ocrResults) && page.ocrResults.length) {
    const ocrEntries = page.ocrResults.map((result) => [
      `이미지 ${result.index}: ${result.width || "?"}x${result.height || "?"}`,
      result.alt ? `ALT: ${clampText(result.alt, 300)}` : "",
      result.url ? `URL: ${result.url}` : "",
      result.text ? result.text : result.error ? `OCR 오류: ${result.error}` : "OCR 텍스트 없음"
    ].filter(Boolean).join("\n"));
    const ocrChunks = splitEntriesIntoChunks(ocrEntries, maxChars);
    if (ocrChunks.length) {
      sections.push({
        key: "ocr",
        title: "이미지 OCR",
        instruction: [
          "이미지 OCR 텍스트에서 기사 캡처, 표, 수치, 본문과 다른 근거를 추출한다.",
          "OCR은 오독 가능성이 있으므로 불확실한 내용은 단정하지 않는다.",
          "본문과 중복되는 내용은 압축하고, 새로 확인되는 내용만 강조한다."
        ].join(" "),
        chunks: ocrChunks
      });
    }
  }

  if (page.transcript && page.transcript.text) {
    const transcriptChunks = splitTextIntoChunks(page.transcript.text, maxChars);
    if (transcriptChunks.length) {
      sections.push({
        key: "transcript",
        title: "YouTube transcript",
        instruction: [
          "YouTube transcript에서 영상의 흐름, 주요 주장, 근거, 중요한 발언을 정리한다.",
          "시간 순서가 의미 있으면 흐름을 유지하고, 반복 발언은 묶어서 압축한다."
        ].join(" "),
        chunks: transcriptChunks
      });
    }
  }

  return sections;
}

function buildSectionMessages(context, section, chunk, chunkIndex, totalChunks) {
  return [
    {
      role: "system",
      content: [
        "너는 한국어 개인 리서치 보조자다.",
        "지금은 최종 요약 전 단계로, 페이지의 한 섹션만 분석한다.",
        "원문에 없는 내용을 추정하지 말고, 사실/주장/근거/불확실성을 구분한다.",
        "모델의 학습 시점, 기억, 사전 지식과 다르다는 이유로 원문을 가짜나 조작이라고 판정하지 않는다.",
        "날짜가 미래인지 판단할 때는 [페이지 정보]의 현재 날짜만 기준으로 삼는다.",
        "최종 답변에 바로 재사용할 수 있게 간결하지만 정보 손실을 줄여 정리한다."
      ].join(" ")
    },
    {
      role: "user",
      content: [
        "[페이지 정보]",
        context,
        "",
        `[분석 섹션: ${section.title}]`,
        `청크: ${chunkIndex + 1}/${totalChunks}`,
        section.instruction,
        "",
        "출력 형식:",
        "- 핵심 내용",
        "- 근거/수치/인용",
        "- 장점 또는 긍정 신호",
        "- 단점 또는 위험 신호",
        "- 확인 필요 사항",
        "",
        "[원문]",
        chunk
      ].join("\n")
    }
  ];
}

function buildSectionMergeMessages(context, section, summaryText) {
  return [
    {
      role: "system",
      content: [
        "너는 한국어 개인 리서치 보조자다.",
        "같은 섹션을 여러 청크로 분석한 결과를 하나로 병합한다.",
        "중복을 제거하되, 서로 다른 근거와 중요한 반응은 잃지 않는다."
      ].join(" ")
    },
    {
      role: "user",
      content: [
        "[페이지 정보]",
        context,
        "",
        `[병합 섹션: ${section.title}]`,
        section.instruction,
        "",
        "아래 청크별 분석을 하나의 섹션 분석으로 병합해줘.",
        "짧은 인용은 유지하되 너무 긴 원문 복사는 하지 마.",
        "",
        summaryText
      ].join("\n")
    }
  ];
}

function buildFinalMessages(context, sectionSummaryText) {
  return [
    {
      role: "system",
      content: [
        "너는 한국어 개인 리서치 보조자다.",
        "섹션별 사전 분석을 종합해 최종 요약을 작성한다.",
        "원문에 없는 사실을 만들지 말고, 페이지 안의 본문과 댓글 분위기를 근거로 정리한다.",
        "모델의 학습 시점, 기억, 사전 지식과 다르다는 이유로 원문을 가짜나 조작이라고 판정하지 않는다.",
        "날짜가 미래인지 판단할 때는 [페이지 정보]의 현재 날짜만 기준으로 삼는다.",
        "사이트 전체의 정치 성향이나 평판을 일반화해서 경고하지 않는다.",
        "확인 필요 사항은 원문 안의 구체적 주장, 수치, OCR 오독 가능성, 출처 부재에 한정한다.",
        "본문, 댓글, OCR, transcript 중 없는 섹션은 없다고 적고 억지로 채우지 않는다."
      ].join(" ")
    },
    {
      role: "user",
      content: [
        "[페이지 정보]",
        context,
        "",
        "다음 섹션별 분석을 바탕으로 최종 결과를 아래 형식으로 정리해줘.",
        "",
        "1. 핵심 요약",
        "2. 장점",
        "3. 단점",
        "4. 댓글/사용자 반응",
        "5. 눈여겨볼 댓글",
        "   - 참고할 만한 댓글이 있으면 원문에서 핵심 문장만 짧게 인용하고, 왜 중요한지 한 줄로 설명",
        "   - 댓글 후보가 없거나 의미 있는 댓글이 없으면 '특별히 인용할 댓글 없음'이라고 작성",
        "   - 댓글 섹션 분석이 제공된 경우에는 가능한 한 대표 댓글을 인용하고, 쉽게 '없음'으로 처리하지 말 것",
        "6. 이미지 OCR에서 확인한 내용",
        "7. YouTube transcript에서 확인한 내용",
        "8. 구매 또는 판단 시 주의점",
        "   - 특정 사이트의 성향을 이유로 한 일반적 경고는 쓰지 말고, 이 페이지 내용 자체에서 확인해야 할 점만 작성",
        "   - 모델이 모르는 사건이거나 학습 시점 이후 사건이라는 이유만으로 가짜/조작이라고 쓰지 말 것",
        "9. 출처에서 확인해야 할 부분",
        "",
        "[섹션별 분석]",
        sectionSummaryText
      ].join("\n")
    }
  ];
}

async function requestChatCompletion(model, messages, signal, maxTokens) {
  const response = await fetch(LM_STUDIO_ENDPOINT, {
    method: "POST",
    signal,
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model,
      messages,
      temperature: 0.2,
      max_tokens: maxTokens,
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
  const summary = extractCompletionText(data);

  if (!summary) {
    return {
      ok: false,
      status: response.status,
      errorText: `LM Studio response did not contain a summary. ${describeCompletionResponse(data)}`
    };
  }

  return {
    ok: true,
    summary
  };
}

function extractCompletionText(data) {
  const directText = extractTextValue(data && (data.output_text || data.text || data.content));
  if (directText) {
    return directText;
  }

  const outputs = Array.isArray(data && data.output) ? data.output : [];
  for (const output of outputs) {
    const text = extractTextValue(output && (output.content || output.text));
    if (text) {
      return text;
    }
  }

  const choices = Array.isArray(data && data.choices) ? data.choices : [];
  for (const choice of choices) {
    const message = choice && choice.message ? choice.message : {};
    const candidates = [
      message.content,
      message.reasoning_content,
      message.reasoning,
      message.response,
      choice.text,
      choice.content,
      choice.delta && choice.delta.content
    ];

    for (const candidate of candidates) {
      const text = extractTextValue(candidate);
      if (text) {
        return text;
      }
    }
  }

  return "";
}

function extractTextValue(value) {
  if (typeof value === "string") {
    return value.trim();
  }

  if (Array.isArray(value)) {
    return value.map((item) => extractTextValue(item)).filter(Boolean).join("\n").trim();
  }

  if (value && typeof value === "object") {
    return [
      value.text,
      value.content,
      value.value,
      value.output_text
    ].map((item) => extractTextValue(item)).filter(Boolean).join("\n").trim();
  }

  return "";
}

function describeCompletionResponse(data) {
  try {
    const choices = Array.isArray(data && data.choices) ? data.choices : [];
    const description = {
      object: data && data.object,
      model: data && data.model,
      usage: data && data.usage,
      choices: choices.slice(0, 2).map((choice) => {
        const message = choice && choice.message ? choice.message : {};
        return {
          index: choice && choice.index,
          finish_reason: choice && choice.finish_reason,
          choice_keys: choice ? Object.keys(choice) : [],
          message_keys: Object.keys(message),
          content_type: typeof message.content,
          content_preview: previewText(extractTextValue(message.content)),
          reasoning_preview: previewText(extractTextValue(message.reasoning_content || message.reasoning)),
          text_preview: previewText(extractTextValue(choice && choice.text))
        };
      })
    };

    return JSON.stringify(description).slice(0, 1200);
  } catch (error) {
    return `Unable to describe response: ${error && error.message ? error.message : String(error)}`;
  }
}

function previewText(value) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  return text.slice(0, 160);
}

function isContextLengthError(errorText) {
  return /context length|n_keep|tokens to keep|too many tokens|maximum context/i.test(String(errorText || ""));
}

function retryCharBudgets(maxChars) {
  const normalized = normalizeMaxChars(maxChars);
  const attempts = [...new Set([
    normalized,
    Math.floor(normalized * 0.65),
    Math.floor(normalized * 0.4),
    4000,
    2000,
    1000
  ].map((value) => Math.min(normalized, value))
    .filter((value) => value >= MIN_MAX_CHARS))]
    .sort((a, b) => b - a);
  return attempts;
}

async function requestContentWithRetry(model, content, signal, maxChars, maxTokens, buildMessages) {
  let lastResult = null;
  let promptChars = normalizeMaxChars(maxChars);

  for (const attemptChars of retryCharBudgets(maxChars)) {
    promptChars = attemptChars;
    lastResult = await requestChatCompletion(
      model,
      buildMessages(clampText(content, promptChars)),
      signal,
      maxTokens
    );

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

  return {
    summary: lastResult.summary,
    promptChars
  };
}

async function summarizeSection(model, context, section, maxChars, signal, report, sectionIndex, sectionCount) {
  const chunkSummaries = [];

  for (let index = 0; index < section.chunks.length; index += 1) {
    if (report) {
      await report(`LM Studio 분석 중... ${section.title} ${sectionIndex + 1}/${sectionCount}, 조각 ${index + 1}/${section.chunks.length}`);
    }

    const result = await requestContentWithRetry(
      model,
      section.chunks[index],
      signal,
      maxChars,
      SECTION_SUMMARY_MAX_TOKENS,
      (content) => buildSectionMessages(context, section, content, index, section.chunks.length)
    );
    chunkSummaries.push(result.summary);
  }

  if (chunkSummaries.length === 1) {
    return chunkSummaries[0];
  }

  const combinedSummary = chunkSummaries.map((summary, index) => `## 조각 ${index + 1}\n${summary}`).join("\n\n");
  const skipMergeLimit = Math.floor(normalizeMaxChars(maxChars) * SECTION_MERGE_SKIP_RATIO);
  if (combinedSummary.length <= skipMergeLimit) {
    return combinedSummary;
  }

  if (report) {
    await report(`LM Studio 분석 병합 중... ${section.title}`);
  }

  const merged = await requestContentWithRetry(
    model,
    combinedSummary,
    signal,
    maxChars,
    SECTION_MERGE_MAX_TOKENS,
    (content) => buildSectionMergeMessages(context, section, content)
  );

  return merged.summary;
}

async function summarizeWithLMStudio(page, settings, signal, report) {
  const model = await resolveModelName(settings.model, signal);
  const maxChars = normalizeMaxChars(settings.maxChars);
  const context = pageContext(page);
  const sections = buildAnalysisSections(page, maxChars);

  if (!sections.length) {
    throw new Error("요약할 본문, 댓글, OCR, transcript 내용을 찾지 못했습니다.");
  }

  const sectionSummaries = [];
  for (let index = 0; index < sections.length; index += 1) {
    const section = sections[index];
    const summary = await summarizeSection(model, context, section, maxChars, signal, report, index, sections.length);
    sectionSummaries.push({
      title: section.title,
      summary
    });
  }

  if (report) {
    await report("LM Studio 최종 종합 중...");
  }

  const finalContent = sectionSummaries.map((item) => `## ${item.title}\n${item.summary}`).join("\n\n");
  const finalResult = await requestContentWithRetry(
    model,
    finalContent,
    signal,
    maxChars,
    SUMMARY_MAX_TOKENS,
    (content) => buildFinalMessages(context, content)
  );

  return finalResult.summary;
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

  if (shouldLetOcrServerFetch(url)) {
    return {
      ...image,
      originalUrl: image.url,
      url
    };
  }

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

function shouldLetOcrServerFetch(url) {
  return /\/\/(?:(?:dcimg|image|dccdn)\d*\.dcinside\.co\.kr|image\.dcinside\.com)\/viewimage(?:pop)?\.php/i.test(String(url || ""));
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
    `- Comment candidates: ${(saved.comments || []).length}`,
    `- Image candidates: ${(saved.images || []).length}`,
    `- OCR results: ${(saved.ocrResults || []).filter((result) => result.text).length}`,
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

    await setJobState({ message: "LM Studio 분석 준비 중..." });
    const summary = await summarizeWithLMStudio(page, request.settings, signal, (message) => setJobState({ message }));

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
