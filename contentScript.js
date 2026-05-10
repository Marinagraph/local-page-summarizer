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

browser.runtime.onMessage.addListener((message) => {
  if (message && message.type === "COLLECT_PAGE") {
    return Promise.resolve(collectPage());
  }

  return false;
});
