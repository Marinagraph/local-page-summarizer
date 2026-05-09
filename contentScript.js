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

  for (const image of document.querySelectorAll("img")) {
    const src = image.currentSrc || image.src || image.getAttribute("data-src") || "";
    const width = image.naturalWidth || image.width || 0;
    const height = image.naturalHeight || image.height || 0;
    const lowerSrc = src.toLowerCase();

    if (!src || seen.has(src)) {
      continue;
    }
    if (width < 300 || height < 180) {
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

function collectPage() {
  const selection = cleanText(String(window.getSelection ? window.getSelection() : ""));
  const main = document.querySelector("main, article, [role='main']");
  const sourceElement = main || document.body;
  const text = cleanText(selection || sourceElement.innerText || document.body.innerText || "");

  return {
    title: document.title || location.href,
    url: location.href,
    description: getMetaDescription(),
    text,
    comments: collectLikelyComments(),
    images: collectImageCandidates(),
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
