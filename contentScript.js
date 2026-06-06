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

function collectDcinsideComments() {
  const comments = [];
  const seen = new Set();
  const items = document.querySelectorAll(
    ".comment_box .cmt_list > li.ub-content, " +
    ".comment_box li[id^='comment_li_'], " +
    ".comment_box li[id^='reply_li_']"
  );

  for (const item of items) {
    const textElement = item.querySelector(".usertxt.ub-word, .usertxt");
    const text = cleanText(textElement ? textElement.innerText || textElement.textContent || "" : "");
    if (!text) {
      continue;
    }

    const nick = cleanText(item.querySelector(".nickname em, .nickname")?.innerText || "");
    const ip = cleanText(item.querySelector(".ip")?.innerText || "");
    const date = cleanText(item.querySelector(".date_time, .gall_date")?.innerText || "");
    const prefix = [nick, ip, date].filter(Boolean).join(" ");
    const comment = prefix ? `${prefix}\n${text}` : text;

    if (seen.has(comment)) {
      continue;
    }

    seen.add(comment);
    comments.push(comment);
  }

  return comments;
}

function collectCommentsFromVisibleText(text) {
  const source = String(text || "");
  const startMatch = source.match(/전체\s*댓글\s*[\d,]+\s*개/);
  if (!startMatch || typeof startMatch.index !== "number") {
    return [];
  }

  const start = startMatch.index + startMatch[0].length;
  const afterStart = source.slice(start);
  const endMarkers = [
    "본문 보기댓글닫기새로고침",
    "타인의 권리를 침해하거나",
    "Shift+Enter 키를 동시에 누르면"
  ];
  const endCandidates = endMarkers
    .map((marker) => afterStart.indexOf(marker))
    .filter((index) => index >= 0);
  const end = endCandidates.length ? Math.min(...endCandidates) : afterStart.length;
  const segment = afterStart
    .slice(0, end)
    .replace(/^(등록순|최신순|답글순|댓글 등록본문 보기 댓글닫기 새로고침)\s*/gm, "")
    .trim();

  const comments = [];
  const seen = new Set();
  const datePattern = /\n?(\d{2}\.\d{2}\s+\d{2}:\d{2}:\d{2})\s*\n삭제/g;
  let lastIndex = 0;
  let match;

  while ((match = datePattern.exec(segment)) !== null) {
    const raw = segment.slice(lastIndex, match.index);
    lastIndex = datePattern.lastIndex;
    const lines = raw.split("\n").map((line) => cleanText(line)).filter(Boolean);
    if (!lines.length) {
      continue;
    }

    while (lines.length && /^(등록순|최신순|답글순|댓글 등록|본문 보기|댓글닫기|새로고침)$/.test(lines[0])) {
      lines.shift();
    }

    if (lines.length >= 2 && /^\([^)]+\)$/.test(lines[1])) {
      lines.splice(0, 2, `${lines[0]} ${lines[1]} ${match[1]}`);
    } else if (lines.length >= 1) {
      lines[0] = `${lines[0]} ${match[1]}`;
    }

    const comment = cleanText(lines.join("\n"));
    if (comment && !seen.has(comment)) {
      seen.add(comment);
      comments.push(comment);
    }
  }

  return comments;
}

function collectLikelyComments(pageText) {
  const dcinsideComments = collectDcinsideComments();
  if (dcinsideComments.length) {
    return dcinsideComments;
  }

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
    }
  }

  if (!comments.length) {
    return collectCommentsFromVisibleText(pageText);
  }

  return comments;
}

const CONTENT_CONTAINER_SELECTORS = [
  ".view_content",
  ".article_content",
  ".board_main_view",
  ".read_body",
  ".body_area",
  ".writing_view_box",
  ".gallview_contents",
  ".view_content_wrap",
  ".con_substance",
  ".write_div",
  ".view_body",
  "#board_read",
  ".post-content",
  ".post_content",
  ".xe_content",
  ".rd_body",
  ".read_content",
  ".article_view",
  ".post_view",
  ".content_view",
  "article",
  "main",
  "[role='main']"
];

const NON_CONTENT_CONTAINER_SELECTOR = [
  "header",
  "nav",
  "footer",
  "aside",
  "[class*='sidebar' i]",
  "[id*='sidebar' i]",
  "[class*='banner' i]",
  "[id*='banner' i]",
  "[class*='advert' i]",
  "[id*='advert' i]",
  "[class*='profile' i]",
  "[id*='profile' i]",
  "[class*='avatar' i]",
  "[id*='avatar' i]",
  "[class*='comment' i]",
  "[id*='comment' i]",
  "[class*='reply' i]",
  "[id*='reply' i]"
].join(",");

function collectImageCandidates(contentRoot) {
  const seen = new Set();
  const candidates = [];

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
    const url = String(value || "");
    return (
      /\.(png|jpe?g|webp|gif|bmp)(\?|#|$)/i.test(url) ||
      /\/viewimage(?:pop)?\.php(?:\?|$)/i.test(url) ||
      /\/\/(?:dcimg|image)\d*\.dcinside\.co\.kr\//i.test(url) ||
      /\/\/image\.dcinside\.com\//i.test(url) ||
      /\/\/dccdn\d*\.dcinside\.co\.kr\//i.test(url) ||
      /\/\/ncache\.ilbe\.com\/files\/attach\//i.test(url)
    );
  }

  function imageUrlFromOnclick(value) {
    const match = String(value || "").match(/imgPop\(['"]([^'"]+)['"]/i);
    return match ? match[1] : "";
  }

  function elementTokenText(element) {
    return [
      element.id || "",
      element.className || "",
      element.getAttribute("role") || "",
      element.closest("a")?.className || "",
      element.closest("a")?.id || ""
    ].join(" ").toLowerCase();
  }

  function isDecorativeImage(src, image) {
    const lowerSrc = String(src || "").toLowerCase();
    const tokenText = elementTokenText(image);
    return (
      lowerSrc.includes("logo") ||
      lowerSrc.includes("avatar") ||
      lowerSrc.includes("profile") ||
      lowerSrc.includes("emoji") ||
      lowerSrc.includes("sprite") ||
      lowerSrc.includes("icon") ||
      lowerSrc.includes("loading") ||
      lowerSrc.includes("blank") ||
      lowerSrc.includes("spacer") ||
      tokenText.includes("logo") ||
      tokenText.includes("avatar") ||
      tokenText.includes("profile") ||
      tokenText.includes("emoji") ||
      tokenText.includes("icon")
    );
  }

  function scoreImage(image, src, linkedImage, width, height) {
    const inBestContentRoot = Boolean(contentRoot && contentRoot !== document.body && contentRoot.contains(image));
    const inKnownContentRoot = Boolean(image.closest(CONTENT_CONTAINER_SELECTORS.join(",")));
    const inNonContentRoot = Boolean(image.closest(NON_CONTENT_CONTAINER_SELECTOR));
    const lowerOcrUrl = String(linkedImage || src || "").toLowerCase();
    const area = width * height;
    let score = 0;

    if (inBestContentRoot) score += 120;
    if (inKnownContentRoot) score += 80;
    if (isLikelyImageUrl(linkedImage)) score += 30;
    if (isLikelyImageUrl(src)) score += 20;
    if (width >= 500) score += 15;
    if (height >= 300) score += 15;
    if (area >= 200000) score += 25;
    if (image.alt && image.alt.length > 4) score += 5;
    if (lowerOcrUrl.includes("/attach/") || lowerOcrUrl.includes("/files/attach/") || lowerOcrUrl.includes("/upload/")) {
      score += 35;
    }
    if (/\/viewimage(?:pop)?\.php(?:\?|$)/i.test(lowerOcrUrl)) {
      score += 35;
    }

    if (inNonContentRoot && !inBestContentRoot) score -= 120;
    if (width > 0 && height > 0 && (width < 180 || height < 120)) score -= 80;
    if (isDecorativeImage(src, image)) score -= 120;

    return score;
  }

  for (const image of document.querySelectorAll("img")) {
    const src = resolveUrl(
      image.getAttribute("data-original") ||
      image.getAttribute("data-src") ||
      image.getAttribute("data-lazy-src") ||
      image.getAttribute("data-url") ||
      firstSrcFromSrcset(image.getAttribute("srcset")) ||
      image.currentSrc ||
      image.src
    );
    const width = image.naturalWidth || image.width || 0;
    const height = image.naturalHeight || image.height || 0;
    const lowerSrc = src.toLowerCase();
    const onclickImage = resolveUrl(
      imageUrlFromOnclick(image.getAttribute("onclick")) ||
      imageUrlFromOnclick(image.closest("a")?.getAttribute("onclick")) ||
      ""
    );
    const linkedImage = onclickImage || resolveUrl(image.closest("a")?.href || "");
    const ocrUrl = isLikelyImageUrl(linkedImage) ? linkedImage : src;

    if (!src || !ocrUrl || seen.has(ocrUrl)) {
      continue;
    }
    if ((width < 300 || height < 180) && !isLikelyImageUrl(src) && !isLikelyImageUrl(linkedImage)) {
      continue;
    }
    if (isDecorativeImage(src, image)) {
      continue;
    }
    if (lowerSrc.endsWith(".svg") || lowerSrc.startsWith("blob:")) {
      continue;
    }

    seen.add(ocrUrl);
    candidates.push({
      url: src,
      linkedUrl: isLikelyImageUrl(linkedImage) ? linkedImage : "",
      pageVisibleUrl: src,
      alt: image.alt || "",
      width,
      height,
      score: scoreImage(image, src, linkedImage, width, height)
    });
  }

  return candidates
    .filter((image) => image.score > -50)
    .sort((a, b) => b.score - a.score)
    .slice(0, 8)
    .map(({ score, ...image }) => image);
}

function getBestTextSource() {
  const selectors = [
    ...CONTENT_CONTAINER_SELECTORS,
    "body"
  ];
  const candidates = [];

  for (const selector of selectors) {
    for (const element of document.querySelectorAll(selector)) {
      const text = cleanText(element.innerText || "");
      if (text && !candidates.some((candidate) => candidate.text === text)) {
        candidates.push({
          text,
          element,
          priority: selector === "body" ? 0 : 1
        });
      }
    }
  }

  candidates.sort((a, b) => (b.priority - a.priority) || (b.text.length - a.text.length));
  return candidates[0] || { text: cleanText(document.body.innerText || "") };
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

  return {
    title: document.title || location.href,
    url: location.href,
    description: getMetaDescription(),
    text,
    comments: collectLikelyComments(text),
    images: collectImageCandidates(bestSource.element),
    transcript: collectYouTubeTranscript(),
    selectedOnly: Boolean(selection),
    collectedAt: new Date().toISOString()
  };
}

browser.runtime.onMessage.addListener((message) => {
  if (message && message.type === "COLLECT_PAGE") {
    return Promise.resolve(collectPage());
  }

  return false;
});
