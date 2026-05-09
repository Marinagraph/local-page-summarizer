const LM_STUDIO_ENDPOINT = "http://127.0.0.1:2000/v1/chat/completions";
const DEFAULT_OCR_ENDPOINT = "http://127.0.0.1:2010/ocr";

const collectButton = document.querySelector("#collectButton");
const exportButton = document.querySelector("#exportButton");
const modelInput = document.querySelector("#modelInput");
const maxCharsInput = document.querySelector("#maxCharsInput");
const ocrEnabledInput = document.querySelector("#ocrEnabledInput");
const ocrEndpointInput = document.querySelector("#ocrEndpointInput");
const statusElement = document.querySelector("#status");
const summaryElement = document.querySelector("#summary");
const pageMetaElement = document.querySelector("#pageMeta");

let lastSaved = null;

function setStatus(message) {
  statusElement.textContent = message;
}

function setBusy(isBusy) {
  collectButton.disabled = isBusy;
  exportButton.disabled = isBusy;
}

function storageKeyFor(url) {
  return `page:${url}`;
}

function compactForPrompt(page, maxChars) {
  const comments = page.comments && page.comments.length
    ? `\n\n[댓글 후보]\n${page.comments.map((comment, index) => `${index + 1}. ${comment}`).join("\n\n")}`
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
    comments,
    ocrText
  ].filter(Boolean).join("\n");

  return body.slice(0, maxChars);
}

async function collectCurrentPage() {
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.id) {
    throw new Error("수집할 원본 탭을 찾을 수 없습니다.");
  }

  try {
    return await browser.tabs.sendMessage(tab.id, { type: "COLLECT_PAGE" });
  } catch (error) {
    await browser.scripting.executeScript({
      target: { tabId: tab.id },
      files: ["contentScript.js"]
    });
    return browser.tabs.sendMessage(tab.id, { type: "COLLECT_PAGE" });
  }
}

async function summarizeWithLMStudio(page) {
  const model = modelInput.value.trim() || "gemma-4-26b-a4b-it";
  const maxChars = Math.max(1000, Number(maxCharsInput.value) || 24000);
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
            "이미지 OCR 텍스트가 있으면 캡처 기사나 이미지 본문일 수 있으므로 함께 분석하되, OCR 오류 가능성이 있는 내용은 단정하지 않는다."
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
            "7. 구매 또는 판단 시 주의점",
            "8. 출처에서 확인해야 할 부분",
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

async function enrichPageWithOcr(page) {
  if (!ocrEnabledInput.checked) {
    return { ...page, ocrResults: [] };
  }

  const images = Array.isArray(page.images) ? page.images.slice(0, 5) : [];
  if (!images.length) {
    return { ...page, ocrResults: [] };
  }

  const endpoint = ocrEndpointInput.value.trim() || DEFAULT_OCR_ENDPOINT;
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      pageUrl: page.url,
      images
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

function renderPageMeta(page, saved) {
  pageMetaElement.hidden = false;
  pageMetaElement.textContent = [
    page.title,
    page.url,
    `본문 ${page.text.length.toLocaleString()}자`,
    `댓글 후보 ${page.comments.length.toLocaleString()}개`,
    `이미지 후보 ${(page.images || []).length.toLocaleString()}개`,
    `OCR 결과 ${(page.ocrResults || []).filter((result) => result.text).length.toLocaleString()}개`,
    `저장 ${new Date(saved.collectedAt).toLocaleString()}`
  ].join("\n");
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

  lastSaved = saved;
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
    ...ocrSection,
    "## Source Text",
    "",
    "```text",
    saved.text,
    "```"
  ].join("\n");
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
}

async function autoSaveMarkdown(saved) {
  const blob = new Blob([toMarkdown(saved)], { type: "text/markdown;charset=utf-8" });
  const url = URL.createObjectURL(blob);

  await browser.downloads.download({
    url,
    filename: `Local Page Summarizer/${safeFileName(saved.title)}.md`,
    saveAs: false,
    conflictAction: "uniquify"
  });

  setTimeout(() => URL.revokeObjectURL(url), 30000);
}

async function restoreSettings() {
  const settings = await browser.storage.local.get(["model", "maxChars", "ocrEnabled", "ocrEndpoint", "lastSavedUrl"]);
  if (settings.model) {
    modelInput.value = settings.model;
  }
  if (settings.maxChars) {
    maxCharsInput.value = settings.maxChars;
  }
  if (typeof settings.ocrEnabled === "boolean") {
    ocrEnabledInput.checked = settings.ocrEnabled;
  }
  if (settings.ocrEndpoint) {
    ocrEndpointInput.value = settings.ocrEndpoint;
  }
  if (settings.lastSavedUrl) {
    const stored = await browser.storage.local.get(storageKeyFor(settings.lastSavedUrl));
    lastSaved = stored[storageKeyFor(settings.lastSavedUrl)] || null;
  }
}

async function persistSettings() {
  await browser.storage.local.set({
    model: modelInput.value.trim() || "gemma-4-26b-a4b-it",
    maxChars: Math.max(1000, Number(maxCharsInput.value) || 24000),
    ocrEnabled: ocrEnabledInput.checked,
    ocrEndpoint: ocrEndpointInput.value.trim() || DEFAULT_OCR_ENDPOINT
  });
}

collectButton.addEventListener("click", async () => {
  setBusy(true);
  setStatus("페이지 수집 중...");
  summaryElement.textContent = "현재 페이지 텍스트를 수집하고 있습니다.";

  try {
    await persistSettings();
    let page = await collectCurrentPage();

    if (!page.text || page.text.length < 20) {
      throw new Error("수집된 텍스트가 너무 짧습니다. 페이지가 완전히 로드된 뒤 다시 시도하세요.");
    }

    if (ocrEnabledInput.checked) {
      setStatus("이미지 OCR 중...");
      summaryElement.textContent = "이미지 후보를 OCR 서버로 보내고 있습니다.";
      page = await enrichPageWithOcr(page);
    } else {
      page = { ...page, ocrResults: [] };
    }

    setStatus("LM Studio 요약 중...");
    summaryElement.textContent = "LM Studio가 요약을 생성하고 있습니다.";
    const summary = await summarizeWithLMStudio(page);
    const saved = await saveResult(page, summary);
    await autoSaveMarkdown(saved);

    summaryElement.textContent = summary;
    renderPageMeta(page, saved);
    setStatus("저장 완료: Markdown 자동 저장됨");
  } catch (error) {
    summaryElement.textContent = error && error.message ? error.message : String(error);
    setStatus("오류");
  } finally {
    setBusy(false);
  }
});

exportButton.addEventListener("click", async () => {
  setBusy(true);
  setStatus("Markdown 내보내는 중...");

  try {
    await exportMarkdown();
    setStatus("내보내기 완료");
  } catch (error) {
    summaryElement.textContent = error && error.message ? error.message : String(error);
    setStatus("오류");
  } finally {
    setBusy(false);
  }
});

restoreSettings().catch((error) => {
  summaryElement.textContent = error && error.message ? error.message : String(error);
  setStatus("설정 복원 오류");
});
