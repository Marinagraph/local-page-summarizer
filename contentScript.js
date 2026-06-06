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
    }
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
    comments: collectLikelyComments(),
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
