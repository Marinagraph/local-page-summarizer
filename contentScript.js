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

function isDcinsidePage() {
  return /(^|\.)dcinside\.com$/i.test(location.hostname);
}

function isInstagramPage() {
  return /(^|\.)instagram\.com$/i.test(location.hostname);
}

function isDanawaPage() {
  return /(^|\.)danawa\.com$/i.test(location.hostname);
}

function getElementText(element) {
  return cleanText(element ? element.innerText || element.textContent || "" : "");
}

function isRenderedElement(element) {
  if (!element || !element.isConnected) {
    return false;
  }

  const style = window.getComputedStyle ? window.getComputedStyle(element) : null;
  if (style && (style.display === "none" || style.visibility === "hidden")) {
    return false;
  }

  return Boolean(element.getClientRects().length || element.offsetWidth || element.offsetHeight);
}

function pushUniqueComment(comments, seen, value) {
  const comment = cleanText(value);
  if (!comment || seen.has(comment)) {
    return;
  }

  seen.add(comment);
  comments.push(comment);
}

function ownRenderedItemText(element) {
  const clone = element.cloneNode(true);
  for (const nested of clone.querySelectorAll("li li, [role='listitem'] [role='listitem']")) {
    nested.remove();
  }
  for (const ignored of clone.querySelectorAll("script, style, svg")) {
    ignored.remove();
  }
  return cleanText(clone.innerText || clone.textContent || "");
}

function getDcinsideCommentRoots() {
  const roots = [];
  const seen = new Set();

  function addRoots(selector) {
    for (const root of document.querySelectorAll(selector)) {
      if (seen.has(root)) {
        continue;
      }
      if (!root.querySelector("li[id^='comment_li_'].ub-content, li[id^='reply_li_'].ub-content")) {
        continue;
      }
      seen.add(root);
      roots.push(root);
    }
  }

  addRoots("ul.cmt_list.add");

  if (!roots.length) {
    addRoots("#comment_wrap ul.cmt_list");
    addRoots(".comment_wrap ul.cmt_list");
    addRoots(".comment_box ul.cmt_list");
  }

  return roots.filter((root) => {
    if (root.classList.contains("add")) {
      return true;
    }

    const container = root.closest("#comment_wrap, .comment_wrap, .comment_box") || root.parentElement;
    return Boolean(container && container.querySelector(
      ".bottom_paging_box, .cmt_paging, .btn_cmt_refresh, .btn_cmt_close"
    ));
  });
}

function isExcludedDcinsideCommentItem(item) {
  const id = item.id || "";
  const isComment = /^comment_li_\d+$/.test(id);
  const isReply = /^reply_li_\d+$/.test(id);

  if (!isComment && !isReply) {
    return true;
  }
  if (id === "comment_li_0" || item.classList.contains("dory")) {
    return true;
  }
  if (item.querySelector(".comment_dory, .dory_txt, .cmtboy, .cmt_write_box")) {
    return true;
  }

  return false;
}

function getDcinsideCommentInfoRoot(item) {
  for (const child of item.children) {
    if (child.classList.contains("cmt_info") || child.classList.contains("reply_info")) {
      return child;
    }
  }

  return item;
}

function getDefuddleConstructor() {
  return (
    (typeof globalThis !== "undefined" && globalThis.Defuddle) ||
    (typeof window !== "undefined" && window.Defuddle) ||
    (typeof self !== "undefined" && self.Defuddle) ||
    null
  );
}

function createDetachedDocumentClone() {
  const cloned = document.implementation.createHTMLDocument(document.title || "");

  function importChildren(source, target) {
    target.replaceChildren();
    for (const child of source.childNodes) {
      target.appendChild(cloned.importNode(child, true));
    }
  }

  if (document.head) importChildren(document.head, cloned.head);
  if (document.body) importChildren(document.body, cloned.body);

  const base = cloned.createElement("base");
  base.href = location.href;
  cloned.head.prepend(base);

  return cloned;
}

function htmlToReadableText(html) {
  const parsed = new DOMParser().parseFromString(String(html || ""), "text/html");
  const content = parsed.body;

  for (const element of content.querySelectorAll("br")) {
    element.replaceWith("\n");
  }

  const blockSelector = [
    "address",
    "article",
    "blockquote",
    "dd",
    "details",
    "div",
    "dl",
    "dt",
    "figcaption",
    "figure",
    "h1",
    "h2",
    "h3",
    "h4",
    "h5",
    "h6",
    "hr",
    "li",
    "main",
    "ol",
    "p",
    "pre",
    "section",
    "summary",
    "table",
    "td",
    "th",
    "tr",
    "ul"
  ].join(",");

  for (const element of content.querySelectorAll(blockSelector)) {
    element.append("\n");
  }

  return cleanText(content.textContent || "");
}

function collectDefuddleTextSource(fallbackElement) {
  if (isDcinsidePage() || isYouTubePage()) {
    return null;
  }

  const DefuddleConstructor = getDefuddleConstructor();
  if (!DefuddleConstructor || !document.body) {
    return null;
  }

  try {
    const cloned = createDetachedDocumentClone();
    const result = new DefuddleConstructor(cloned, {
      url: location.href,
      includeReplies: false,
      removeImages: false,
      removeSmallImages: false,
      useAsync: false
    }).parse();
    const text = htmlToReadableText(result && result.content);

    if (text.length < 80) {
      return null;
    }

    return {
      text,
      element: fallbackElement || null,
      priority: 4,
      extractor: "defuddle",
      wordCount: result && result.wordCount,
      title: result && result.title,
      description: result && result.description
    };
  } catch (error) {
    console.warn("Local Page Summarizer: Defuddle extraction failed", error);
    return null;
  }
}

function shouldUseDefuddleSource(defuddleSource, fallbackSource) {
  if (!defuddleSource || !defuddleSource.text) {
    return false;
  }
  if (!fallbackSource || !fallbackSource.text) {
    return true;
  }

  const defuddleLength = defuddleSource.text.length;
  const fallbackLength = fallbackSource.text.length;

  if (defuddleLength < 200 && fallbackLength > defuddleLength * 2) {
    return false;
  }
  if (fallbackLength >= 1000 && defuddleLength > fallbackLength * 3) {
    return false;
  }

  return true;
}

function collectDcinsideComments() {
  if (!isDcinsidePage()) {
    return [];
  }

  const comments = [];
  const seen = new Set();

  for (const root of getDcinsideCommentRoots()) {
    const items = root.querySelectorAll("li[id^='comment_li_'].ub-content, li[id^='reply_li_'].ub-content");

    for (const item of items) {
      if (isExcludedDcinsideCommentItem(item)) {
        continue;
      }

      const infoRoot = getDcinsideCommentInfoRoot(item);
      const textElement = infoRoot.querySelector(".cmt_txtbox .usertxt.ub-word, .cmt_txtbox .usertxt");
      const text = getElementText(textElement);
      if (!text) {
        continue;
      }

      const writer = infoRoot.querySelector(".cmt_nickbox .gall_writer.ub-writer, .gall_writer.ub-writer");
      const nick = getElementText(infoRoot.querySelector(".nickname em, .nickname")) ||
        cleanText(writer ? writer.getAttribute("data-nick") || "" : "");
      const ip = getElementText(infoRoot.querySelector(".ip"));
      const date = getElementText(infoRoot.querySelector(".date_time, .gall_date"));
      const prefixParts = [];

      if ((item.id || "").startsWith("reply_li_")) {
        prefixParts.push("답글");
      }
      prefixParts.push(...[nick, ip, date].filter(Boolean));

      const prefix = prefixParts.join(" ");
      const comment = prefix ? `${prefix}\n${text}` : text;

      if (seen.has(comment)) {
        continue;
      }

      seen.add(comment);
      comments.push(comment);
    }
  }

  return comments;
}

function getInstagramProfileName(element) {
  for (const anchor of element.querySelectorAll("a[href]")) {
    let pathname = "";
    try {
      pathname = new URL(anchor.getAttribute("href"), location.href).pathname;
    } catch {
      continue;
    }

    if (!/^\/[A-Za-z0-9._]+\/$/.test(pathname)) {
      continue;
    }

    const name = getElementText(anchor);
    if (name) {
      return name;
    }
  }

  return "";
}

function isInstagramUiLine(line) {
  return (
    /^(reply|view replies|hide replies|see translation|liked?|likes?|more|report|follow|following)$/i.test(line) ||
    /^(\d+\s+)?(likes?|replies)$/i.test(line) ||
    /^\d+\s*(s|m|h|d|w|mo|y)$/i.test(line) ||
    /^\d+\s*(\uCD08|\uBD84|\uC2DC\uAC04|\uC77C|\uC8FC|\uAC1C\uC6D4|\uB144)(\s*\uC804)?$/.test(line) ||
    /^(\uB2F5\uAE00(\s*\uB2EC\uAE30|\s*\uBCF4\uAE30)?|\uB2F5\uAE00\s*\d+\uAC1C\s*\uBCF4\uAE30|\uBC88\uC5ED\s*\uBCF4\uAE30|\uC88B\uC544\uC694|\uB354\s*\uBCF4\uAE30|\uC2E0\uACE0|\uD314\uB85C\uC6B0|\uD314\uB85C\uC789)$/.test(line) ||
    /^\uC88B\uC544\uC694\s*\d+\uAC1C$/.test(line)
  );
}

function hasInstagramReplyControl(element) {
  return Array.from(element.querySelectorAll("button, [role='button']")).some((control) => {
    const label = getElementText(control);
    return /^(reply|\uB2F5\uAE00\s*\uB2EC\uAE30)$/i.test(label);
  });
}

function collectInstagramComments() {
  if (!isInstagramPage()) {
    return [];
  }

  const comments = [];
  const seen = new Set();
  const roots = [];
  const rootSet = new Set();

  for (const root of document.querySelectorAll("article, [role='dialog']")) {
    if (!rootSet.has(root) && isRenderedElement(root)) {
      rootSet.add(root);
      roots.push(root);
    }
  }

  for (const root of roots) {
    const header = root.querySelector("header") || root.querySelector("[role='banner']");
    const postAuthor = header ? getInstagramProfileName(header) : "";
    const candidateSet = new Set();

    for (const item of root.querySelectorAll(
      "ul > li, ul > div > li, [role='list'] > [role='listitem']"
    )) {
      candidateSet.add(item);
    }

    for (const item of candidateSet) {
      if (!isRenderedElement(item) || item.closest("header")) {
        continue;
      }

      const author = getInstagramProfileName(item);
      if (!author) {
        continue;
      }

      const rawLines = ownRenderedItemText(item)
        .split("\n")
        .map((line) => cleanText(line))
        .filter(Boolean);
      const lines = rawLines.filter((line) => line !== author && !isInstagramUiLine(line));

      if (lines.length && lines[0].startsWith(`${author} `)) {
        lines[0] = cleanText(lines[0].slice(author.length));
      }

      const body = cleanText(lines.filter(Boolean).join("\n"));
      if (!body || body.length > 4000) {
        continue;
      }

      if (postAuthor && author === postAuthor && !hasInstagramReplyControl(item)) {
        continue;
      }

      pushUniqueComment(comments, seen, `${author}\n${body}`);
    }
  }

  return comments;
}

function isDanawaUiLine(line) {
  return (
    /^(report|reply|delete|edit|more|collapse|recommend|not recommend)$/i.test(line) ||
    /^(\uC2E0\uACE0|\uB2F5\uAE00|\uC0AD\uC81C|\uC218\uC815|\uB354\uBCF4\uAE30|\uC811\uAE30|\uCD94\uCC9C|\uBE44\uCD94\uCC9C|\uB4F1\uB85D)$/.test(line) ||
    /^\d[\d,]*\s*\uC6D0$/.test(line) ||
    /^(\uC0C1\uD488\uC758\uACAC|\uC0C1\uD488\uD3C9|\uB9AC\uBDF0|\uC0AC\uC6A9\uAE30)$/.test(line)
  );
}

function collectDanawaComments() {
  if (!isDanawaPage()) {
    return [];
  }

  const selectors = [
    "[id^='danawa-prodBlog-productOpinion-list-self-']",
    "[id^='danawa-prodBlog-companyReview-content-wrap-']",
    "#danawa-prodBlog-companyReview-content-list li",
    "#danawa-prodBlog-productOpinion-content-list li",
    "[class*='review_list' i] > li",
    "[class*='review-list' i] > li",
    "[class*='reviewList' i] > li",
    "[class*='opinion_list' i] > li",
    "[class*='opinion-list' i] > li",
    "[class*='comment_list' i] > li",
    "[class*='comment-list' i] > li",
    "[class*='mall_review' i] li",
    "[class*='prod_review' i] li",
    "[class*='user_review' i] li",
    "[class*='review_item' i]",
    "[class*='review-item' i]",
    "[class*='opinion_item' i]",
    "[class*='opinion-item' i]",
    "[class*='comment_item' i]",
    "[class*='comment-item' i]"
  ];
  const candidateSet = new Set();
  const comments = [];
  const seen = new Set();

  for (const selector of selectors) {
    for (const element of document.querySelectorAll(selector)) {
      candidateSet.add(element);
    }
  }

  for (const item of candidateSet) {
    if (!isRenderedElement(item)) {
      continue;
    }

    const lines = ownRenderedItemText(item)
      .split("\n")
      .map((line) => cleanText(line))
      .filter((line) => line && !isDanawaUiLine(line));
    const comment = cleanText(lines.join("\n"));

    if (comment.length < 2 || comment.length > 5000) {
      continue;
    }
    if (/^(\uB4F1\uB85D\uB41C|\uC791\uC131\uB41C).*(\uC5C6\uC2B5\uB2C8\uB2E4|\uC5C6\uC74C)$/.test(comment)) {
      continue;
    }

    pushUniqueComment(comments, seen, comment);
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
  if (isDcinsidePage()) {
    return dcinsideComments;
  }

  if (isInstagramPage()) {
    return collectInstagramComments();
  }

  if (isDanawaPage()) {
    return collectDanawaComments();
  }

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

const DCINSIDE_CONTENT_SELECTORS = [
  ".write_div",
  ".view_content .write_div",
  ".gallview_contents .write_div",
  ".view_content",
  ".gallview_contents",
  ".writing_view_box",
  "#board_read .write_div"
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

  function isUsableImageRoot(element) {
    return Boolean(
      element &&
      element !== document.body &&
      !element.closest(NON_CONTENT_CONTAINER_SELECTOR) &&
      element.querySelector("img")
    );
  }

  function collectImageRoots() {
    if (isUsableImageRoot(contentRoot)) {
      return [contentRoot];
    }

    const roots = [];
    for (const selector of CONTENT_CONTAINER_SELECTORS) {
      for (const element of document.querySelectorAll(selector)) {
        if (!isUsableImageRoot(element)) {
          continue;
        }
        if (roots.some((root) => root === element || root.contains(element) || element.contains(root))) {
          continue;
        }

        roots.push(element);
      }
    }

    return roots;
  }

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

  function isYouTubeThumbnailUrl(value) {
    try {
      return new URL(value, location.href).hostname === "i.ytimg.com";
    } catch {
      return /\/\/i\.ytimg\.com\//i.test(String(value || ""));
    }
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

  for (const root of collectImageRoots()) {
    for (const image of root.querySelectorAll("img")) {
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

      if (image.closest(NON_CONTENT_CONTAINER_SELECTOR)) {
        continue;
      }
      if (!src || !ocrUrl || seen.has(ocrUrl)) {
        continue;
      }
      if (isYouTubeThumbnailUrl(src) || isYouTubeThumbnailUrl(linkedImage) || isYouTubeThumbnailUrl(ocrUrl)) {
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
  }

  return candidates
    .filter((image) => image.score > -50)
    .sort((a, b) => b.score - a.score)
    .slice(0, 8)
    .map(({ score, ...image }) => image);
}

function getBestTextSource() {
  if (isDcinsidePage()) {
    const dcinsideSource = getDcinsideTextSource();
    if (dcinsideSource.text) {
      return dcinsideSource;
    }
  }

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
  const selectorSource = candidates[0] || { text: cleanText(document.body.innerText || ""), element: document.body };
  const defuddleSource = collectDefuddleTextSource(selectorSource.element);

  if (shouldUseDefuddleSource(defuddleSource, selectorSource)) {
    return defuddleSource;
  }

  return selectorSource;
}

function getDcinsideTextSource() {
  const candidates = [];

  for (const selector of DCINSIDE_CONTENT_SELECTORS) {
    for (const element of document.querySelectorAll(selector)) {
      const text = cleanDcinsideBodyText(element.innerText || element.textContent || "");
      if (!text || candidates.some((candidate) => candidate.text === text)) {
        continue;
      }

      candidates.push({
        text,
        element,
        priority: selector.includes("write_div") ? 3 : 2
      });
    }
  }

  candidates.sort((a, b) => (b.priority - a.priority) || (b.text.length - a.text.length));
  return candidates[0] || { text: "", element: null };
}

function cleanDcinsideBodyText(value) {
  const lines = String(value || "")
    .replace(/\r/g, "")
    .split("\n")
    .map((line) => cleanText(line))
    .filter(Boolean);
  const kept = [];
  const stopPatterns = [
    /^전체\s*댓글\s*[\d,]+\s*개/,
    /^댓글\s*[\d,]+\s*개/,
    /^등록순$/,
    /^최신순$/,
    /^본문 보기$/,
    /^댓글닫기$/,
    /^로그인$/,
    /^갤러리 리스트$/,
    /^실시간 베스트/,
    /^개념글/,
    /^뉴스$/,
    /^만두몰/
  ];
  const dropPatterns = [
    /^추천\s*\d+/,
    /^비추천\s*\d+/,
    /^댓글\s*\d+/,
    /^조회\s*\d+/,
    /^작성일/,
    /^디시콘/,
    /^공유$/,
    /^신고$/,
    /^삭제$/,
    /^수정$/,
    /^답글$/,
    /^본문영역$/,
    /^이미지\s*\d+$/,
    /^이미지 순서/,
    /^이미지를 클릭/
  ];

  for (const line of lines) {
    if (stopPatterns.some((pattern) => pattern.test(line))) {
      break;
    }
    if (dropPatterns.some((pattern) => pattern.test(line))) {
      continue;
    }
    kept.push(line);
  }

  return cleanText(kept.join("\n"));
}

function isYouTubePage() {
  return /(^|\.)youtube\.com$/i.test(location.hostname) || /(^|\.)youtu\.be$/i.test(location.hostname);
}

function collectYouTubeTranscript() {
  if (!isYouTubePage()) {
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
    textSource: bestSource.extractor || "selectors",
    comments: collectLikelyComments(text),
    images: isYouTubePage() ? [] : collectImageCandidates(bestSource.element),
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
