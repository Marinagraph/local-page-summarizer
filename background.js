const LM_STUDIO_ENDPOINT = "http://127.0.0.1:2000/v1/chat/completions";
const LM_STUDIO_MODELS_ENDPOINT = "http://127.0.0.1:2000/v1/models";
const LM_STUDIO_NATIVE_MODELS_ENDPOINT = "http://127.0.0.1:2000/api/v1/models";
const LM_STUDIO_LOAD_MODEL_ENDPOINT = "http://127.0.0.1:2000/api/v1/models/load";
const DEFAULT_OCR_ENDPOINT = "http://127.0.0.1:2010/ocr";
const DEFAULT_MAX_CHARS = 8000;
const MIN_MAX_CHARS = 1000;
const AUTO_MEDIUM_CONTEXT_MAX_CHARS = 16000;
const AUTO_LARGE_CONTEXT_MAX_CHARS = 24000;
const SECTION_SUMMARY_MAX_TOKENS = 900;
const SECTION_MERGE_MAX_TOKENS = 1100;
const SUMMARY_MAX_TOKENS = 1500;
const KOREAN_REWRITE_MAX_TOKENS = 1300;
const MAX_REASONING_RETRY_TOKENS = 2400;
const OUTPUT_START_MARKER = "<<<SUMMARY_OUTPUT_START>>>";
const OUTPUT_END_MARKER = "<<<SUMMARY_OUTPUT_END>>>";
const SECTION_MERGE_SKIP_RATIO = 0.45;
const DEFAULT_LM_STUDIO_CONCURRENCY = 2;
const MAX_LM_STUDIO_CONCURRENCY = 4;
const DANAWA_PAGE_SIZE = 100;
const DANAWA_MAX_PAGES = 100;
const DANAWA_FETCH_RETRIES = 3;
const KAKAKU_MAX_PAGES = 100;
const KAKAKU_FETCH_RETRIES = 3;

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
    await browser.tabs.executeScript(tabId, { file: "vendor/defuddle.js" }).catch(() => {});
    await browser.tabs.executeScript(tabId, { file: "contentScript.js" });
    return browser.tabs.sendMessage(tabId, { type: "COLLECT_PAGE" });
  }
}

function normalizeDanawaText(value) {
  return String(value || "")
    .replace(/\u00a0/g, " ")
    .replace(/\r/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function isDanawaProductCollection(page) {
  if (!page || !page.danawa || !/^\d+$/.test(String(page.danawa.productCode || ""))) {
    return false;
  }

  try {
    const url = new URL(page.url);
    return url.hostname === "prod.danawa.com" && url.pathname.startsWith("/info");
  } catch {
    return false;
  }
}

function parseDanawaProductOpinions(html) {
  const parsed = new DOMParser().parseFromString(String(html || ""), "text/html");
  const rows = [];

  for (const item of parsed.querySelectorAll("[id^='danawa-prodBlog-productOpinion-list-self-']")) {
    const itemId = item.id.replace("danawa-prodBlog-productOpinion-list-self-", "");
    const contentInput = item.querySelector("[id^='danawa-prodBlog-productOpinion-content-text-']");
    const contentElement = item.querySelector(".danawa-prodBlog-productOpinion-clazz-content");
    const content = normalizeDanawaText(
      (contentInput && contentInput.value) || (contentElement && contentElement.textContent) || ""
    );
    if (!content) {
      continue;
    }

    const nickname = normalizeDanawaText(item.querySelector("[id^='danawa-prodBlog-productOpinion-nickname-']")?.textContent);
    const date = normalizeDanawaText(item.querySelector(".cmt_head .date, .date")?.textContent);
    const headText = normalizeDanawaText(item.querySelector(".head_text_name")?.textContent);
    const depth = item.querySelector("[id^='danawa-prodBlog-productOpinion-list-depth-']")?.value;
    const label = String(depth) === "2"
      ? "다나와 상품의견 답글"
      : headText && headText !== "의견"
        ? `다나와 상품의견 (${headText})`
        : "다나와 상품의견";
    const metadata = [nickname, date].filter(Boolean).join(" | ");

    rows.push({
      key: `opinion:${itemId || rows.length}`,
      text: `[${label}]${metadata ? ` ${metadata}` : ""}\n${content}`
    });
  }

  return rows;
}

function parseDanawaCompanyReviews(html) {
  const parsed = new DOMParser().parseFromString(String(html || ""), "text/html");
  const rows = [];

  for (const contentWrap of parsed.querySelectorAll("[id^='danawa-prodBlog-companyReview-content-wrap-']")) {
    const item = contentWrap.closest("li") || contentWrap.parentElement;
    if (!item) {
      continue;
    }

    const body = normalizeDanawaText(
      contentWrap.querySelector(".atc")?.textContent || contentWrap.querySelector(".tit")?.textContent || ""
    );
    if (!body) {
      continue;
    }

    const uidElement = item.querySelector(
      "[id^='danawa-prodBlog-companyReview-button-block-'], [id^='danawa-prodBlog-companyReview-button-side-']"
    );
    const uid = uidElement ? uidElement.id.split("-").pop() : "";
    const score = normalizeDanawaText(item.querySelector(".star_mask")?.textContent);
    const mallImage = item.querySelector(".mall img[alt]");
    const mall = normalizeDanawaText(mallImage?.getAttribute("alt") || item.querySelector(".mall")?.textContent);
    const date = normalizeDanawaText(item.querySelector(".top_info .date, .date")?.textContent);
    const name = normalizeDanawaText(item.querySelector(".top_info .name, .name")?.textContent);
    const metadata = [score, mall, date, name].filter(Boolean).join(" | ");

    rows.push({
      key: `review:${uid || `${rows.length}:${body}`}`,
      text: `[다나와 쇼핑몰 후기]${metadata ? ` ${metadata}` : ""}\n${body}`
    });
  }

  return rows;
}

function danawaRequestUrl(page, kind, pageNumber) {
  const info = page.danawa;
  const endpoint = new URL(
    kind === "opinion"
      ? "/info/dpg/ajax/productOpinion.ajax.php"
      : "/info/dpg/ajax/companyProductReview.ajax.php",
    "https://prod.danawa.com"
  );
  const common = {
    prodCode: info.productCode,
    productCodes: info.productCodes || info.productCode,
    page: String(pageNumber),
    limit: String(DANAWA_PAGE_SIZE)
  };
  const params = kind === "opinion"
    ? {
      ...common,
      keyword: "",
      condition: "",
      past: "N",
      sort: "1",
      headTextSeq: "0",
      cate1Code: info.cate1Code || "",
      cate2Code: info.cate2Code || "",
      cate3Code: info.cate3Code || "",
      makeDate: info.makeDate || ""
    }
    : {
      ...common,
      score: "0",
      sortType: "",
      onlyPhotoReview: "",
      usefullScore: "Y",
      innerKeyword: "",
      subjectWord: "0",
      subjectWordString: "",
      subjectSimilarWordString: "",
      pageType: "list"
    };

  for (const [key, value] of Object.entries(params)) {
    endpoint.searchParams.set(key, value);
  }
  endpoint.searchParams.set("t", `${Date.now()}-${pageNumber}`);
  return endpoint.href;
}

function throwIfCollectionAborted(signal) {
  if (signal && signal.aborted) {
    throw new Error("Summary job was cancelled.");
  }
}

function waitForCollectionRetry(delayMs, signal) {
  return new Promise((resolve, reject) => {
    throwIfCollectionAborted(signal);
    let settled = false;
    const timer = setTimeout(() => {
      settled = true;
      if (signal) signal.removeEventListener("abort", onAbort);
      resolve();
    }, delayMs);
    const onAbort = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error("Summary job was cancelled."));
    };
    if (signal) {
      signal.addEventListener("abort", onAbort, { once: true });
      if (signal.aborted) onAbort();
    }
  });
}

async function fetchDanawaPage(url, signal) {
  let lastError = null;

  for (let attempt = 1; attempt <= DANAWA_FETCH_RETRIES; attempt += 1) {
    throwIfCollectionAborted(signal);
    try {
      const response = await fetch(url, {
        method: "GET",
        credentials: "include",
        cache: "no-store",
        headers: { Accept: "text/html,application/xhtml+xml" },
        signal
      });

      if (response.ok) {
        return response.text();
      }

      lastError = new Error(`Danawa request failed: ${response.status} ${response.statusText}`);
      if (response.status < 500 && response.status !== 429) {
        lastError.nonRetryable = true;
        throw lastError;
      }
    } catch (error) {
      if (signal && signal.aborted) {
        throw error;
      }
      if (error && error.nonRetryable) {
        throw error;
      }
      lastError = error;
    }

    if (attempt < DANAWA_FETCH_RETRIES) {
      await waitForCollectionRetry(300 * attempt, signal);
    }
  }

  throw lastError || new Error("Danawa request failed.");
}

async function collectDanawaDataset(page, kind, signal, onProgress) {
  const parseRows = kind === "opinion" ? parseDanawaProductOpinions : parseDanawaCompanyReviews;
  const rows = [];
  const seen = new Set();
  let pagesFetched = 0;

  for (let pageNumber = 1; pageNumber <= DANAWA_MAX_PAGES; pageNumber += 1) {
    const html = await fetchDanawaPage(danawaRequestUrl(page, kind, pageNumber), signal);
    if (String(html || "").trim() === "NO_CONTENT") {
      break;
    }

    const parsedRows = parseRows(html);
    if (!parsedRows.length) {
      break;
    }

    let added = 0;
    for (const row of parsedRows) {
      if (seen.has(row.key)) {
        continue;
      }
      seen.add(row.key);
      rows.push(row);
      added += 1;
    }

    pagesFetched = pageNumber;
    if (onProgress) {
      await onProgress({ kind, count: rows.length, pagesFetched });
    }
    if (!added) {
      break;
    }
    if (pageNumber === DANAWA_MAX_PAGES) {
      throw new Error(`Danawa ${kind} collection exceeded ${DANAWA_MAX_PAGES} pages.`);
    }
  }

  return { rows, pagesFetched };
}

async function enrichPageWithDanawaComments(page, signal, onProgress) {
  if (!isDanawaProductCollection(page)) {
    return page;
  }

  const progress = {
    opinion: { count: 0, pagesFetched: 0 },
    review: { count: 0, pagesFetched: 0 }
  };
  const reportProgress = async (update) => {
    progress[update.kind] = update;
    if (onProgress) {
      await onProgress(
        `다나와 전체 수집 중: 상품의견 ${progress.opinion.count.toLocaleString()}개 ` +
        `(${progress.opinion.pagesFetched}페이지), 쇼핑몰 후기 ${progress.review.count.toLocaleString()}개 ` +
        `(${progress.review.pagesFetched}페이지)`
      );
    }
  };
  const [opinions, reviews] = await Promise.all([
    collectDanawaDataset(page, "opinion", signal, reportProgress),
    collectDanawaDataset(page, "review", signal, reportProgress)
  ]);
  const comments = [...opinions.rows, ...reviews.rows].map((row) => row.text);

  return {
    ...page,
    comments: comments.length ? comments : page.comments,
    danawaCollection: {
      productOpinionCount: opinions.rows.length,
      productOpinionPages: opinions.pagesFetched,
      companyReviewCount: reviews.rows.length,
      companyReviewPages: reviews.pagesFetched,
      totalCount: comments.length,
      pageSize: DANAWA_PAGE_SIZE
    }
  };
}

function normalizeKakakuText(value) {
  return String(value || "")
    .replace(/\u00a0/g, " ")
    .replace(/\r/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function kakakuElementText(element) {
  if (!element) {
    return "";
  }

  const clone = element.cloneNode(true);
  for (const br of clone.querySelectorAll("br")) {
    br.replaceWith(br.ownerDocument.createTextNode("\n"));
  }
  return normalizeKakakuText(clone.textContent || "");
}

function isKakakuReviewCollection(page) {
  if (!page || !page.kakaku || !/^K\d+$/i.test(String(page.kakaku.productKey || ""))) {
    return false;
  }

  try {
    const url = new URL(page.url);
    return url.hostname === "review.kakaku.com" && /^\/review\/K\d+(?:\/|$)/i.test(url.pathname);
  } catch {
    return false;
  }
}

function isKakakuBbsCollection(page) {
  if (!page || !page.kakakuBbs || !/^K\d+$/i.test(String(page.kakakuBbs.productKey || ""))) {
    return false;
  }

  try {
    const url = new URL(page.url);
    return url.hostname === "bbs.kakaku.com" && /^\/bbs\/K\d+(?:\/|$)/i.test(url.pathname);
  } catch {
    return false;
  }
}

function parseKakakuReviewPage(html) {
  const parsed = new DOMParser().parseFromString(String(html || ""), "text/html");
  const rows = [];

  for (const review of parsed.querySelectorAll(".reviewBox")) {
    const entryDate = kakakuElementText(review.querySelector(".entryDate"));
    const reviewId = (entryDate.match(/\[([^\]]+)\]/) || [])[1] || "";
    const reviewCode = (
      review.querySelector(".reviewTitle a[href*='ReviewCD=']")?.getAttribute("href") || ""
    ).match(/ReviewCD=(\d+)/i)?.[1] || "";
    const date = normalizeKakakuText(entryDate.replace(/\s*\[[^\]]+\]\s*$/, ""));
    const author = kakakuElementText(review.querySelector(".userName a, .userName"));
    const title = kakakuElementText(review.querySelector(".reviewTitle"));
    const body = kakakuElementText(review.querySelector(".revEntryCont"));
    if (!title && !body) {
      continue;
    }

    const ratings = Array.from(review.querySelectorAll(".revRateBox tr")).map((row) => {
      const label = kakakuElementText(row.querySelector("th"));
      const value = kakakuElementText(row.querySelector("td"));
      return label && value ? `${label} ${value}` : "";
    }).filter(Boolean);
    const details = Array.from(review.querySelectorAll(".revDetailData dt")).map((term) => {
      const label = kakakuElementText(term);
      const value = kakakuElementText(term.nextElementSibling);
      return label && value ? `${label} ${value}` : "";
    }).filter(Boolean);
    const helpful = kakakuElementText(review.querySelector(".referCount"));
    const metadata = [
      author ? `작성자: ${author}` : "",
      date ? `등록: ${date}` : "",
      reviewId ? `리뷰 ID: ${reviewId}` : ""
    ].filter(Boolean).join(" | ");
    const text = normalizeKakakuText([
      `[가격닷컴 리뷰]${metadata ? ` ${metadata}` : ""}`,
      ratings.length ? `평점: ${ratings.join(", ")}` : "",
      title ? `제목: ${title}` : "",
      body ? `본문:\n${body}` : "",
      details.length ? `사용 정보: ${details.join(", ")}` : "",
      helpful ? `도움됨: ${helpful}` : ""
    ].filter(Boolean).join("\n"));

    rows.push({
      key: `review:${reviewId || reviewCode || `${rows.length}:${title}:${date}`}`,
      text
    });
  }

  const reportedCounts = Array.from(parsed.querySelectorAll(".reviewernum .num"))
    .map((element) => Number(normalizeKakakuText(element.textContent).replace(/[^\d]/g, "")))
    .filter((value) => Number.isFinite(value) && value >= 0);
  const totalReported = reportedCounts.length ? Math.max(...reportedCounts) : 0;
  const hasNextPage = Array.from(parsed.querySelectorAll("a[href*='Page=']")).some((link) => (
    /次のページ/.test(normalizeKakakuText(link.textContent))
  ));

  return { rows, totalReported, hasNextPage };
}

function kakakuRequestUrl(page, pageNumber) {
  const baseUrl = page.kakaku.baseUrl || `https://review.kakaku.com/review/${page.kakaku.productKey}/`;
  const url = new URL(baseUrl);
  if (pageNumber > 1) {
    url.searchParams.set("Page", String(pageNumber));
    url.hash = "tab";
  }
  return url.href;
}

async function fetchKakakuPage(url, signal) {
  let lastError = null;

  for (let attempt = 1; attempt <= KAKAKU_FETCH_RETRIES; attempt += 1) {
    throwIfCollectionAborted(signal);
    try {
      const response = await fetch(url, {
        method: "GET",
        credentials: "include",
        cache: "no-store",
        headers: { Accept: "text/html,application/xhtml+xml" },
        signal
      });

      if (response.ok) {
        const buffer = await response.arrayBuffer();
        return new TextDecoder("shift_jis").decode(buffer);
      }

      lastError = new Error(`Kakaku request failed: ${response.status} ${response.statusText}`);
      if (response.status < 500 && response.status !== 429) {
        lastError.nonRetryable = true;
        throw lastError;
      }
    } catch (error) {
      if (signal && signal.aborted) {
        throw error;
      }
      if (error && error.nonRetryable) {
        throw error;
      }
      lastError = error;
    }

    if (attempt < KAKAKU_FETCH_RETRIES) {
      await waitForCollectionRetry(300 * attempt, signal);
    }
  }

  throw lastError || new Error("Kakaku request failed.");
}

async function collectKakakuReviews(page, signal, onProgress) {
  const rows = [];
  const seen = new Set();
  let pagesFetched = 0;
  let totalReported = 0;

  for (let pageNumber = 1; pageNumber <= KAKAKU_MAX_PAGES; pageNumber += 1) {
    const html = await fetchKakakuPage(kakakuRequestUrl(page, pageNumber), signal);
    const parsed = parseKakakuReviewPage(html);
    if (!parsed.rows.length) {
      break;
    }

    let added = 0;
    for (const row of parsed.rows) {
      if (seen.has(row.key)) {
        continue;
      }
      seen.add(row.key);
      rows.push(row);
      added += 1;
    }

    pagesFetched = pageNumber;
    totalReported = Math.max(totalReported, parsed.totalReported);
    if (onProgress) {
      await onProgress(
        `가격닷컴 전체 리뷰 수집 중: ${rows.length.toLocaleString()}` +
        `${totalReported ? `/${totalReported.toLocaleString()}` : ""}개 (${pagesFetched}페이지)`
      );
    }
    if (!parsed.hasNextPage) {
      break;
    }
    if (!added) {
      throw new Error("Kakaku pagination returned only duplicate reviews.");
    }
    if (pageNumber === KAKAKU_MAX_PAGES) {
      throw new Error(`Kakaku review collection exceeded ${KAKAKU_MAX_PAGES} pages.`);
    }
  }

  if (totalReported && rows.length < totalReported) {
    throw new Error(`Kakaku review collection was incomplete: ${rows.length}/${totalReported}.`);
  }

  return { rows, pagesFetched, totalReported };
}

async function enrichPageWithKakakuReviews(page, signal, onProgress) {
  if (!isKakakuReviewCollection(page)) {
    return page;
  }

  const reviews = await collectKakakuReviews(page, signal, onProgress);
  return {
    ...page,
    comments: reviews.rows.length ? reviews.rows.map((row) => row.text) : page.comments,
    kakakuCollection: {
      reviewCount: reviews.rows.length,
      pagesFetched: reviews.pagesFetched,
      totalReported: reviews.totalReported
    }
  };
}

function kakakuBbsInfoValue(thread, label) {
  const item = Array.from(thread.querySelectorAll(".bbsInfoArea .good > p"))
    .find((candidate) => new RegExp(label).test(candidate.textContent || ""));
  if (!item) {
    return "";
  }

  return kakakuElementText(item.querySelector(".impact03")) || kakakuElementText(item);
}

function kakakuBbsPostBody(post) {
  const container = post.querySelector(".boxIn.clearfix.minH, .boxIn.minH");
  if (!container) {
    return "";
  }

  const clone = container.cloneNode(true);
  for (const metadata of clone.querySelectorAll(".date, .vote, script, style")) {
    metadata.remove();
  }
  return kakakuElementText(clone);
}

function parseKakakuBbsPage(html) {
  const parsed = new DOMParser().parseFromString(String(html || ""), "text/html");
  const rows = [];
  let threadCount = 0;

  for (const thread of parsed.querySelectorAll(".bbsArea")) {
    const titleLink = thread.querySelector(".colorMiddle strong a[href*='SortID=']");
    const title = kakakuElementText(titleLink);
    const threadId = (titleLink?.getAttribute("href") || "").match(/SortID=(\d+)/i)?.[1] || "";
    const threadDate = kakakuElementText(thread.querySelector(".colorMiddle .writeDateTime"));
    const threadNice = kakakuBbsInfoValue(thread, "ナイスクチコミ");
    const replyCount = kakakuBbsInfoValue(thread, "返信");
    const posts = Array.from(thread.querySelectorAll(".box06"));
    if (!posts.length) {
      continue;
    }
    threadCount += 1;

    for (const [index, post] of posts.entries()) {
      const body = kakakuBbsPostBody(post);
      if (!body) {
        continue;
      }

      const directId = Array.from(post.children).find((child) => child.id)?.id || "";
      const postNumber = kakakuElementText(post.querySelector(".date"));
      const postId = directId || (postNumber.match(/書込番号：(\d+)/) || [])[1] || "";
      const author = kakakuElementText(
        post.querySelector(".title a.impact05, .title .floatL a[href*='/auth/profile/']")
      );
      const date = kakakuElementText(post.querySelector(".title .writeDateTime")) || threadDate;
      const nice = kakakuElementText(post.querySelector(".vote .fontRed, .vote strong"));
      const isOriginal = index === 0;
      const metadata = [
        author ? `작성자: ${author}` : "",
        date ? `등록: ${date}` : "",
        postId ? `글 번호: ${postId}` : "",
        nice ? `공감: ${nice}점` : "",
        isOriginal && threadNice ? `스레드 공감: ${threadNice}` : "",
        isOriginal && replyCount ? `답글: ${replyCount}개` : ""
      ].filter(Boolean).join(" | ");
      const text = normalizeKakakuText([
        `[가격닷컴 BBS ${isOriginal ? "원글" : "답글"}]${title ? ` 스레드: ${title}` : ""}`,
        metadata,
        `본문:\n${body}`
      ].filter(Boolean).join("\n"));

      rows.push({
        key: `bbs:${postId || `${threadId}:${index}:${author}:${date}`}`,
        threadKey: threadId || title,
        text
      });
    }
  }

  const hasNextPage = Array.from(parsed.querySelectorAll("a[href*='/Page=']")).some((link) => (
    /次の6件/.test(normalizeKakakuText(link.textContent))
  ));

  return { rows, threadCount, hasNextPage };
}

function kakakuBbsRequestUrl(page, pageNumber) {
  const baseUrl = page.kakakuBbs.baseUrl ||
    `https://bbs.kakaku.com/bbs/${page.kakakuBbs.productKey}/`;
  if (pageNumber === 1) {
    return baseUrl;
  }

  return new URL(`SortRule=1/ResView=all/Page=${pageNumber}/#tab`, baseUrl).href;
}

async function collectKakakuBbsPosts(page, signal, onProgress) {
  const rows = [];
  const seenPosts = new Set();
  const seenThreads = new Set();
  let pagesFetched = 0;

  for (let pageNumber = 1; pageNumber <= KAKAKU_MAX_PAGES; pageNumber += 1) {
    const html = await fetchKakakuPage(kakakuBbsRequestUrl(page, pageNumber), signal);
    const parsed = parseKakakuBbsPage(html);
    if (!parsed.rows.length) {
      break;
    }

    let added = 0;
    for (const row of parsed.rows) {
      if (seenPosts.has(row.key)) {
        continue;
      }
      seenPosts.add(row.key);
      if (row.threadKey) {
        seenThreads.add(row.threadKey);
      }
      rows.push(row);
      added += 1;
    }

    pagesFetched = pageNumber;
    if (onProgress) {
      await onProgress(
        `가격닷컴 BBS 수집 중: 스레드 ${seenThreads.size.toLocaleString()}개, ` +
        `원글·답글 ${rows.length.toLocaleString()}개 (${pagesFetched}페이지)`
      );
    }
    if (!parsed.hasNextPage) {
      break;
    }
    if (!added) {
      throw new Error("Kakaku BBS pagination returned only duplicate posts.");
    }
    if (pageNumber === KAKAKU_MAX_PAGES) {
      throw new Error(`Kakaku BBS collection exceeded ${KAKAKU_MAX_PAGES} pages.`);
    }
  }

  return {
    rows,
    pagesFetched,
    threadCount: seenThreads.size
  };
}

async function enrichPageWithKakakuBbs(page, signal, onProgress) {
  if (!isKakakuBbsCollection(page)) {
    return page;
  }

  const posts = await collectKakakuBbsPosts(page, signal, onProgress);
  return {
    ...page,
    comments: posts.rows.length ? posts.rows.map((row) => row.text) : page.comments,
    kakakuBbsCollection: {
      threadCount: posts.threadCount,
      postCount: posts.rows.length,
      pagesFetched: posts.pagesFetched
    }
  };
}

function normalizeMaxChars(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return DEFAULT_MAX_CHARS;
  }

  return Math.max(MIN_MAX_CHARS, Math.floor(numeric));
}

function isAutoModelSetting(value) {
  return /^auto(?::|$)/i.test(String(value || "").trim());
}

function selectedModelIdentifier(modelSelection) {
  return [
    modelSelection && modelSelection.modelKey,
    modelSelection && modelSelection.instanceId,
    modelSelection && modelSelection.model && modelId(modelSelection.model)
  ].filter(Boolean).join(" ").toLowerCase();
}

function isGemmaModelSelection(modelSelection) {
  return /(^|[\s/_.-])gemma(?:[\s/_.-]|$)/i.test(selectedModelIdentifier(modelSelection));
}

function modelSupportsThinkingOff(modelSelection) {
  const options = Array.isArray(modelSelection && modelSelection.reasoningOptions)
    ? modelSelection.reasoningOptions
    : [];
  return options.some((option) => option === "off" || option === "none");
}

function usesFastChunkSizing(settings, modelSelection) {
  return isAutoModelSetting(settings && settings.model) || isGemmaModelSelection(modelSelection);
}

function effectiveMaxChars(settings, modelSelection) {
  const configured = normalizeMaxChars(settings && settings.maxChars);
  if (!usesFastChunkSizing(settings, modelSelection) || configured !== DEFAULT_MAX_CHARS) {
    return configured;
  }

  const contextLength = Number(modelSelection && modelSelection.contextLength) || 0;
  if (contextLength >= 65536) {
    return AUTO_LARGE_CONTEXT_MAX_CHARS;
  }
  if (contextLength >= 32768) {
    return AUTO_MEDIUM_CONTEXT_MAX_CHARS;
  }
  return configured;
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

function resolveLmStudioConcurrency(settings) {
  const configured = Number(settings && (settings.lmStudioConcurrency || settings.parallelRequests));
  if (Number.isFinite(configured) && configured > 0) {
    return Math.max(1, Math.min(MAX_LM_STUDIO_CONCURRENCY, Math.floor(configured)));
  }

  return DEFAULT_LM_STUDIO_CONCURRENCY;
}

function createTaskLimiter(limit, signal) {
  const queue = [];
  let active = 0;

  function rejectIfAborted() {
    if (signal && signal.aborted) {
      throw new Error("Summary job was cancelled.");
    }
  }

  function pump() {
    while (active < limit && queue.length) {
      const item = queue.shift();
      active += 1;

      Promise.resolve()
        .then(() => {
          rejectIfAborted();
          return item.task();
        })
        .then(item.resolve, item.reject)
        .finally(() => {
          active -= 1;
          pump();
        });
    }
  }

  return function schedule(task) {
    return new Promise((resolve, reject) => {
      try {
        rejectIfAborted();
      } catch (error) {
        reject(error);
        return;
      }

      queue.push({ task, resolve, reject });
      pump();
    });
  };
}

function extensionVersion() {
  try {
    return browser.runtime.getManifest().version || "unknown";
  } catch (error) {
    return "unknown";
  }
}

function pageContext(page) {
  const now = new Date();
  return [
    `확장 버전: ${extensionVersion()}`,
    `현재 날짜(사용자 PC 기준): ${now.toLocaleDateString("ko-KR")} (${now.toISOString().slice(0, 10)})`,
    `수집 시각: ${page.collectedAt || now.toISOString()}`,
    `제목: ${page.title || ""}`,
    `URL: ${page.url || ""}`,
    page.description ? `설명: ${page.description}` : "",
    page.selectedOnly ? "수집 범위: 사용자가 선택한 텍스트" : "수집 범위: 페이지 본문",
    `본문 추출: ${page.textSource || "selectors"}`,
    `본문 길이: ${(page.text || "").length.toLocaleString()}자`,
    `댓글 후보: ${(page.comments || []).length.toLocaleString()}개`,
    page.danawaCollection
      ? `다나와 전체 수집: 상품의견 ${page.danawaCollection.productOpinionCount.toLocaleString()}개, 쇼핑몰 후기 ${page.danawaCollection.companyReviewCount.toLocaleString()}개`
      : "",
    page.kakakuCollection
      ? `가격닷컴 전체 수집: 리뷰 ${page.kakakuCollection.reviewCount.toLocaleString()}개, ${page.kakakuCollection.pagesFetched}페이지`
      : "",
    page.kakakuBbsCollection
      ? `가격닷컴 BBS 전체 수집: 스레드 ${page.kakakuBbsCollection.threadCount.toLocaleString()}개, 원글·답글 ${page.kakakuBbsCollection.postCount.toLocaleString()}개, ${page.kakakuBbsCollection.pagesFetched}페이지`
      : "",
    page.xCollection
      ? `X 현재 대화 수집: 답글 ${page.xCollection.loadedReplyCount.toLocaleString()}개`
      : "",
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
      `${index + 1}. ${String(comment || "").trim()}`
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

function sectionSummaryMaxTokens(section) {
  if (!section || !section.key) {
    return SECTION_SUMMARY_MAX_TOKENS;
  }

  if (section.key === "comments") {
    return 950;
  }

  if (section.key === "ocr") {
    return 800;
  }

  if (section.key === "transcript") {
    return 950;
  }

  return SECTION_SUMMARY_MAX_TOKENS;
}

function sectionOutputRules(section) {
  if (section && section.key === "comments") {
    return [
      "출력은 8줄 이내의 bullet로 제한한다.",
      "반응의 큰 흐름, 반복되는 논쟁점, 반대 의견, 눈여겨볼 댓글만 남긴다.",
      "눈여겨볼 댓글은 짧은 원문 인용 3~5개만 포함한다.",
      "댓글을 모두 읽되, 비슷한 댓글은 묶어서 압축한다."
    ];
  }

  if (section && section.key === "ocr") {
    return [
      "출력은 6줄 이내의 bullet로 제한한다.",
      "이미지에서 새로 확인되는 텍스트, 수치, 표, 기사 캡처 내용만 남긴다.",
      "본문과 중복되거나 OCR 신뢰도가 낮은 파편은 길게 설명하지 않는다.",
      "불확실한 항목은 'OCR 불확실'이라고 짧게 표시한다."
    ];
  }

  if (section && section.key === "transcript") {
    return [
      "출력은 7줄 이내의 bullet로 제한한다.",
      "영상 흐름, 핵심 주장, 근거, 인용 가치가 있는 발언만 남긴다.",
      "반복 발언과 진행 멘트는 묶어서 압축한다."
    ];
  }

  return [
    "출력은 7줄 이내의 bullet로 제한한다.",
    "핵심 주장, 근거/수치, 판단 시 주의점만 남긴다.",
    "장점/단점 항목을 억지로 분리하지 말고, 최종 요약에 필요한 재료만 압축한다.",
    "원문 문장을 길게 다시 쓰지 않는다."
  ];
}

function outputMarkerRules() {
  return [
    `최종으로 저장할 답변은 반드시 ${OUTPUT_START_MARKER} 줄 다음부터 작성한다.`,
    `답변이 끝나면 반드시 ${OUTPUT_END_MARKER} 줄을 작성한다.`,
    "마커 밖에는 역할 설명, 작업 설명, 프롬프트 해석, 내부 사고 과정을 쓰지 않는다.",
    "마커 안쪽에는 한국어 결과만 작성한다."
  ];
}

function buildSectionMessages(context, section, chunk, chunkIndex, totalChunks) {
  return [
    {
      role: "system",
      content: [
        "너는 한국어 개인 리서치 보조자다.",
        "지금은 최종 요약 전 단계로, 페이지의 한 섹션만 분석한다.",
        "모든 출력은 한국어 문장으로만 작성한다. 영어 항목명, 영문 병기, 번역 설명을 쓰지 않는다.",
        "역할, 작업 설명, 프롬프트 해석, 내부 사고 과정을 출력하지 않는다.",
        "원문에 없는 내용을 추정하지 말고, 사실/주장/근거/불확실성을 구분한다.",
        "모델의 학습 시점, 기억, 사전 지식과 다르다는 이유로 원문을 가짜나 조작이라고 판정하지 않는다.",
        "날짜가 미래인지 판단할 때는 [페이지 정보]의 현재 날짜만 기준으로 삼는다.",
        "최종 답변에 바로 재사용할 수 있는 재료만 남기고, 중간 분석 자체를 길게 쓰지 않는다."
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
        "출력 규칙:",
        ...sectionOutputRules(section),
        ...outputMarkerRules(),
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
        "모든 출력은 한국어 문장으로만 작성한다. 영어 항목명, 영문 병기, 번역 설명을 쓰지 않는다.",
        "역할, 작업 설명, 프롬프트 해석, 내부 사고 과정을 출력하지 않는다.",
        "중복을 제거하되, 서로 다른 근거와 중요한 반응은 잃지 않는다.",
        "최종 요약 입력용 재료만 남기고 10줄 이내로 압축한다."
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
        "최종 답변 형식으로 꾸미지 말고 핵심 재료만 bullet로 남겨줘.",
        ...outputMarkerRules(),
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
        "최종 출력은 반드시 한국어로만 작성한다. 영어 제목, 영어 설명, 괄호 속 영문 번역을 넣지 않는다.",
        "역할, 작업 설명, 프롬프트 해석, 내부 사고 과정을 출력하지 않고 최종 결과만 작성한다.",
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
        ...outputMarkerRules(),
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

function buildKoreanRewriteMessages(context, summaryText) {
  return [
    {
      role: "system",
      content: [
        "너는 한국어 편집자다.",
        "아래 요약문을 한국어 최종 결과로 다시 작성한다.",
        "영어 제목, 영어 항목명, 괄호 속 영문 번역, 역할 설명, 작업 설명, 프롬프트 해석을 모두 제거한다.",
        "원래 요약의 정보와 짧은 댓글 인용은 유지하되, 문장은 자연스러운 한국어로 바꾼다.",
        "새 사실을 추가하지 않는다."
      ].join(" ")
    },
    {
      role: "user",
      content: [
        "[페이지 정보]",
        context,
        "",
        "아래 텍스트가 영어 또는 영어/한국어 혼합이면 한국어로만 다시 작성해줘.",
        "반드시 아래 번호 형식을 유지해줘.",
        ...outputMarkerRules(),
        "",
        "1. 핵심 요약",
        "2. 장점",
        "3. 단점",
        "4. 댓글/사용자 반응",
        "5. 눈여겨볼 댓글",
        "6. 이미지 OCR에서 확인한 내용",
        "7. YouTube transcript에서 확인한 내용",
        "8. 구매 또는 판단 시 주의점",
        "9. 출처에서 확인해야 할 부분",
        "",
        "[다시 작성할 텍스트]",
        summaryText
      ].join("\n")
    }
  ];
}

async function requestChatCompletion(model, messages, signal, maxTokens, requestOptions = {}) {
  const started = Date.now();
  const payload = {
    model,
    messages,
    temperature: 0.2,
    max_tokens: maxTokens,
    chat_template_kwargs: {
      enable_thinking: false,
      enableThinking: false
    },
    stream: false
  };
  if (requestOptions.disableThinking) {
    payload.reasoning_effort = "none";
  }
  const response = await fetch(LM_STUDIO_ENDPOINT, {
    method: "POST",
    signal,
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(payload)
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
    const reasoningOnly = hasReasoningOnlyCompletion(data);
    return {
      ok: false,
      status: response.status,
      errorKind: reasoningOnly ? "reasoning_only" : hasLengthLimitedCompletion(data) ? "length_limited" : "empty_summary",
      errorText: `LM Studio response did not contain a summary. ${describeCompletionResponse(data)}`
    };
  }

  return {
    ok: true,
    summary,
    model: data && data.model ? data.model : model,
    usage: data && data.usage ? data.usage : null,
    elapsedMs: Date.now() - started
  };
}

function extractCompletionText(data) {
  const directText = cleanCompletionText(extractTextValue(data && (data.output_text || data.text || data.content)), {
    allowUnmarked: true
  });
  if (directText) {
    return directText;
  }

  const outputs = Array.isArray(data && data.output) ? data.output : [];
  for (const output of outputs) {
    const text = cleanCompletionText(extractTextValue(output && (output.content || output.text)), {
      allowUnmarked: true
    });
    if (text) {
      return text;
    }
  }

  const choices = Array.isArray(data && data.choices) ? data.choices : [];
  for (const choice of choices) {
    const message = choice && choice.message ? choice.message : {};
    const visibleCandidates = [
      message.content,
      message.response,
      choice.text,
      choice.content,
      choice.delta && choice.delta.content
    ];

    for (const candidate of visibleCandidates) {
      const text = cleanCompletionText(extractTextValue(candidate), {
        allowUnmarked: true
      });
      if (text) {
        return text;
      }
    }

    const reasoningCandidates = [
      message.reasoning_content,
      message.reasoning
    ];

    for (const candidate of reasoningCandidates) {
      const text = cleanCompletionText(extractTextValue(candidate), {
        allowUnmarked: false
      });
      if (text) {
        return text;
      }
    }
  }

  return "";
}

function cleanCompletionText(text, options = {}) {
  const value = String(text || "").trim();
  if (!value) {
    return "";
  }

  const marked = extractMarkedOutput(value);
  if (marked) {
    return normalizeCompletionText(marked);
  }

  if (!options.allowUnmarked) {
    const numbered = extractKoreanNumberedSections(value);
    return numbered ? normalizeCompletionText(numbered) : "";
  }

  return normalizeCompletionText(value);
}

function extractMarkedOutput(text) {
  const value = String(text || "");
  const start = value.indexOf(OUTPUT_START_MARKER);
  if (start < 0) {
    return "";
  }

  const contentStart = start + OUTPUT_START_MARKER.length;
  const end = value.indexOf(OUTPUT_END_MARKER, contentStart);
  return (end >= 0 ? value.slice(contentStart, end) : value.slice(contentStart)).trim();
}

function extractKoreanNumberedSections(text) {
  const value = String(text || "");
  const matches = [...value.matchAll(/(?:^|\n)\s*(?:[*-]\s*)?(?:\*{1,2})?\s*1[.)]\s*핵심\s*요약/gi)];
  if (!matches.length) {
    return "";
  }

  const match = matches[matches.length - 1];
  return value.slice(match.index).trim();
}

function normalizeCompletionText(text) {
  return String(text || "")
    .replaceAll(OUTPUT_START_MARKER, "")
    .replaceAll(OUTPUT_END_MARKER, "")
    .replace(/\r\n/g, "\n")
    .replace(/^\s*\*\s+\*(\d+[.)]\s*[^:\n]+):\*\s*/gm, "$1\n")
    .replace(/^\s*(?:[*-]\s*)?\*{1,2}\s*(\d+[.)]\s*[^*\n:]+)\*{1,2}\s*:\s*/gm, "$1\n")
    .replace(/\s*\((?:Core Summary|Pros|Cons|Comments?\/User Reaction|Notable Comments|Image OCR Content|YouTube transcript|Cautions?[^)]*|Things to check[^)]*|Image OCR|Body|Comments?)\)/gi, "")
    .replace(/\s*\((?=[^)]*[A-Za-z])[^가-힣)]*\)/g, "")
    .replace(/\.{2,}/g, ".")
    .replace(/^\s*(?:Korean Personal Research Assistant|Korean Editor)\.\s*$/gim, "")
    .replace(/^\s*(?:Rewrite a summary into a final Korean version|Summarize the provided section-by-section analysis into a final report)\.\s*$/gim, "")
    .trim();
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

function hasReasoningOnlyCompletion(data) {
  const choices = Array.isArray(data && data.choices) ? data.choices : [];
  const hasReasoning = choices.some((choice) => {
    const message = choice && choice.message ? choice.message : {};
    return !!extractTextValue(message.reasoning_content || message.reasoning);
  });
  const hasVisibleContent = choices.some((choice) => {
    const message = choice && choice.message ? choice.message : {};
    return !!extractTextValue(message.content || message.response || choice.text || choice.content);
  });

  return hasReasoning && !hasVisibleContent;
}

function hasLengthLimitedCompletion(data) {
  const choices = Array.isArray(data && data.choices) ? data.choices : [];
  return choices.some((choice) => String(choice && choice.finish_reason || "").toLowerCase() === "length");
}

function previewText(value) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  return text.slice(0, 160);
}

function languageStats(text) {
  const value = String(text || "");
  const hangul = (value.match(/[가-힣]/g) || []).length;
  const latin = (value.match(/[A-Za-z]/g) || []).length;
  return { hangul, latin };
}

function needsKoreanRewrite(text) {
  const value = String(text || "");
  if (!value.trim()) {
    return false;
  }

  const stats = languageStats(value);
  if (stats.latin > Math.max(350, stats.hangul * 1.15)) {
    return true;
  }

  return /Korean Personal Research Assistant|Core Summary|Pros|Cons|Comment\/User Reaction|Notable Comments|Image OCR Content|Task:|Role:/i.test(value);
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

function retryOutputTokenBudgets(maxTokens) {
  const normalized = Math.max(256, Math.floor(Number(maxTokens) || SECTION_SUMMARY_MAX_TOKENS));
  return [...new Set([
    normalized,
    Math.max(normalized + 512, Math.ceil(normalized * 1.75)),
    Math.max(normalized + 900, Math.ceil(normalized * 2.5)),
    MAX_REASONING_RETRY_TOKENS
  ].map((value) => Math.min(MAX_REASONING_RETRY_TOKENS, value))
    .filter((value) => value >= normalized))]
    .sort((a, b) => a - b);
}

function isOutputBudgetRetryable(result) {
  return result && (result.errorKind === "reasoning_only" || result.errorKind === "length_limited");
}

function reasoningTokenCount(usage) {
  return Number(
    usage && usage.completion_tokens_details && usage.completion_tokens_details.reasoning_tokens
  ) || 0;
}

async function requestContentWithRetry(
  model,
  content,
  signal,
  maxChars,
  maxTokens,
  buildMessages,
  scheduleRequest,
  requestOptions = {}
) {
  let lastResult = null;
  let promptChars = normalizeMaxChars(maxChars);

  for (const attemptChars of retryCharBudgets(maxChars)) {
    promptChars = attemptChars;
    const messages = buildMessages(clampText(content, promptChars));
    const tokenBudgets = retryOutputTokenBudgets(maxTokens);

    for (const attemptTokens of tokenBudgets) {
      lastResult = await scheduleRequest(
        () => requestChatCompletion(
          model,
          messages,
          signal,
          attemptTokens,
          requestOptions
        )
      );

      if (lastResult.ok || !isOutputBudgetRetryable(lastResult)) {
        break;
      }
    }

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
    promptChars,
    model: lastResult.model || model,
    usage: lastResult.usage || null,
    elapsedMs: lastResult.elapsedMs || 0
  };
}

async function summarizeSection(
  model,
  context,
  section,
  maxChars,
  signal,
  report,
  sectionIndex,
  sectionCount,
  scheduleRequest,
  requestOptions
) {
  const timings = [];
  const chunkSummaries = await Promise.all(section.chunks.map(async (chunk, index) => {
    const result = await requestContentWithRetry(
      model,
      chunk,
      signal,
      maxChars,
      sectionSummaryMaxTokens(section),
      (content) => buildSectionMessages(context, section, content, index, section.chunks.length),
      (task) => scheduleRequest(async () => {
        if (report) {
          await report(`LM Studio 분석 중... ${section.title} ${sectionIndex + 1}/${sectionCount}, 조각 ${index + 1}/${section.chunks.length}`);
        }
        return task();
      }),
      requestOptions
    );
    timings.push({
      type: "section",
      section: section.title,
      chunk: index + 1,
      chunks: section.chunks.length,
      elapsedMs: result.elapsedMs,
      promptTokens: result.usage && result.usage.prompt_tokens,
      completionTokens: result.usage && result.usage.completion_tokens,
      reasoningTokens: reasoningTokenCount(result.usage),
      totalTokens: result.usage && result.usage.total_tokens
    });
    return result.summary;
  }));

  if (chunkSummaries.length === 1) {
    return { summary: chunkSummaries[0], timings };
  }

  const combinedSummary = chunkSummaries.map((summary, index) => `## 조각 ${index + 1}\n${summary}`).join("\n\n");
  const skipMergeLimit = Math.floor(normalizeMaxChars(maxChars) * SECTION_MERGE_SKIP_RATIO);
  if (combinedSummary.length <= skipMergeLimit) {
    return { summary: combinedSummary, timings };
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
    (content) => buildSectionMergeMessages(context, section, content),
    scheduleRequest,
    requestOptions
  );
  timings.push({
    type: "section-merge",
    section: section.title,
    elapsedMs: merged.elapsedMs,
    promptTokens: merged.usage && merged.usage.prompt_tokens,
    completionTokens: merged.usage && merged.usage.completion_tokens,
    reasoningTokens: reasoningTokenCount(merged.usage),
    totalTokens: merged.usage && merged.usage.total_tokens
  });

  return { summary: merged.summary, timings };
}

async function summarizeWithLMStudio(page, settings, signal, report) {
  const modelSelection = await selectLmStudioModel(settings.model, signal, report);
  const model = modelSelection.instanceId;
  const configuredMaxChars = normalizeMaxChars(settings.maxChars);
  const maxChars = effectiveMaxChars(settings, modelSelection);
  const requestOptions = {
    disableThinking: modelSupportsThinkingOff(modelSelection)
  };
  if (report && maxChars !== configuredMaxChars) {
    await report(`LM Studio 자동 청크 크기: ${maxChars.toLocaleString()}자`);
  }
  const context = pageContext(page);
  const sections = buildAnalysisSections(page, maxChars);
  const scheduleRequest = createTaskLimiter(resolveLmStudioConcurrency(settings), signal);

  if (!sections.length) {
    throw new Error("요약할 본문, 댓글, OCR, transcript 내용을 찾지 못했습니다.");
  }

  const lmTimings = [];
  const sectionSummaries = await Promise.all(sections.map(async (section, index) => {
    const result = await summarizeSection(
      model,
      context,
      section,
      maxChars,
      signal,
      report,
      index,
      sections.length,
      scheduleRequest,
      requestOptions
    );
    lmTimings.push(...result.timings);
    return {
      title: section.title,
      summary: result.summary
    };
  }));

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
    (content) => buildFinalMessages(context, content),
    scheduleRequest,
    requestOptions
  );
  lmTimings.push({
    type: "final",
    section: "final",
    elapsedMs: finalResult.elapsedMs,
    promptTokens: finalResult.usage && finalResult.usage.prompt_tokens,
    completionTokens: finalResult.usage && finalResult.usage.completion_tokens,
    reasoningTokens: reasoningTokenCount(finalResult.usage),
    totalTokens: finalResult.usage && finalResult.usage.total_tokens
  });

  let summary = finalResult.summary;
  if (needsKoreanRewrite(summary)) {
    if (report) {
      await report("LM Studio 한국어 결과 재작성 중...");
    }

    const rewritten = await requestContentWithRetry(
      model,
      summary,
      signal,
      maxChars,
      KOREAN_REWRITE_MAX_TOKENS,
      (content) => buildKoreanRewriteMessages(context, content),
      scheduleRequest,
      requestOptions
    );
    lmTimings.push({
      type: "final-rewrite",
      section: "final",
      elapsedMs: rewritten.elapsedMs,
      promptTokens: rewritten.usage && rewritten.usage.prompt_tokens,
      completionTokens: rewritten.usage && rewritten.usage.completion_tokens,
      reasoningTokens: reasoningTokenCount(rewritten.usage),
      totalTokens: rewritten.usage && rewritten.usage.total_tokens
    });
    summary = rewritten.summary;
  }

  return {
    summary,
    lmTimings,
    model: modelSelection.modelKey,
    modelInstanceId: modelSelection.instanceId,
    modelSource: modelSelection.source,
    modelContextLength: modelSelection.contextLength,
    configuredMaxChars,
    effectiveMaxChars: maxChars,
    thinkingDisabled: requestOptions.disableThinking
  };
}

function modelId(item) {
  return String(item && (item.key || item.id) || "").trim();
}

function isChatModel(item) {
  const id = modelId(item).toLowerCase();
  const type = String(item && item.type || "").toLowerCase();
  return Boolean(id) && type !== "embedding" && type !== "embeddings" && !/embedding|embed/.test(id);
}

function resolveConfiguredModel(configuredModel, models) {
  const requested = (configuredModel || "").trim();
  const chatModels = (Array.isArray(models) ? models : []).filter(isChatModel);

  if (requested && !requested.toLowerCase().startsWith("auto")) {
    const exact = chatModels.find((item) => modelId(item) === requested);
    if (exact) {
      return modelId(exact);
    }

    const partialMatches = chatModels.filter((item) => modelId(item).toLowerCase().includes(requested.toLowerCase()));
    if (partialMatches.length) {
      return modelId(pickBestModel(partialMatches));
    }

    return requested;
  }

  const query = requested.includes(":")
    ? requested.slice(requested.indexOf(":") + 1).trim().toLowerCase()
    : "";
  const candidates = query
    ? chatModels.filter((item) => modelId(item).toLowerCase().includes(query))
    : chatModels;
  const model = pickBestModel(candidates);

  if (!model || !modelId(model)) {
    const qualifier = query ? ` '${query}'` : "";
    throw new Error(`LM Studio에서 사용할${qualifier} chat 모델을 찾지 못했습니다.`);
  }

  return modelId(model);
}

async function fetchNativeLmStudioModels(signal) {
  const response = await fetch(LM_STUDIO_NATIVE_MODELS_ENDPOINT, { signal });
  if (response.status === 404 || response.status === 405) {
    return null;
  }
  if (!response.ok) {
    throw new Error(`LM Studio 네이티브 모델 목록 요청 실패: ${response.status}`);
  }

  const data = await response.json();
  return Array.isArray(data.models) ? data.models : [];
}

function loadedLmStudioModels(models) {
  const loaded = [];

  for (const model of (Array.isArray(models) ? models : []).filter(isChatModel)) {
    const key = modelId(model);
    const instances = Array.isArray(model.loaded_instances) ? model.loaded_instances : [];
    for (const instance of instances) {
      const instanceId = String(instance && (instance.id || instance.instance_id) || key).trim();
      if (!instanceId) {
        continue;
      }
      loaded.push({
        modelKey: key || instanceId,
        instanceId,
        model,
        contextLength: Number(instance && instance.config && instance.config.context_length) || 0,
        reasoningOptions: Array.isArray(model.capabilities?.reasoning?.allowed_options)
          ? model.capabilities.reasoning.allowed_options.map((option) => String(option).toLowerCase())
          : []
      });
    }
  }

  return loaded;
}

function chooseLoadedLmStudioModel(loadedModels, configuredModel) {
  const loaded = Array.isArray(loadedModels) ? loadedModels : [];
  if (loaded.length <= 1) {
    return loaded[0] || null;
  }

  const requested = String(configuredModel || "").trim().toLowerCase();
  if (requested && !requested.startsWith("auto")) {
    const exact = loaded.find((item) => (
      item.modelKey.toLowerCase() === requested || item.instanceId.toLowerCase() === requested
    ));
    if (exact) {
      return exact;
    }

    const partial = loaded.find((item) => (
      item.modelKey.toLowerCase().includes(requested) || item.instanceId.toLowerCase().includes(requested)
    ));
    if (partial) {
      return partial;
    }
  }

  return loaded[0];
}

async function loadLmStudioModel(modelKey, signal) {
  const response = await fetch(LM_STUDIO_LOAD_MODEL_ENDPOINT, {
    method: "POST",
    signal,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: modelKey, echo_load_config: true })
  });
  const responseText = await response.text();
  let data = {};
  if (responseText) {
    try {
      data = JSON.parse(responseText);
    } catch {
      data = {};
    }
  }

  if (!response.ok) {
    const detail = data && (data.error || data.message) ? data.error || data.message : responseText;
    throw new Error(`LM Studio 기본 모델 로드 실패: ${response.status}${detail ? ` ${detail}` : ""}`);
  }

  return {
    instanceId: String(data.instance_id || data.model_instance_id || modelKey),
    loadTimeSeconds: Number(data.load_time_seconds) || 0,
    contextLength: Number(data.load_config && data.load_config.context_length) || 0
  };
}

async function resolveLegacyModelName(configuredModel, signal) {
  const requested = (configuredModel || "").trim();
  const response = await fetch(LM_STUDIO_MODELS_ENDPOINT, { signal });
  if (!response.ok) {
    throw new Error(`LM Studio 모델 목록 요청 실패: ${response.status}`);
  }

  const data = await response.json();
  return resolveConfiguredModel(requested, Array.isArray(data.data) ? data.data : []);
}

async function selectLmStudioModel(configuredModel, signal, report) {
  const nativeModels = await fetchNativeLmStudioModels(signal);

  if (nativeModels) {
    const loaded = loadedLmStudioModels(nativeModels);
    const selectedLoaded = chooseLoadedLmStudioModel(loaded, configuredModel);
    if (selectedLoaded) {
      if (report) {
        await report(`LM Studio 로드된 모델 사용: ${selectedLoaded.modelKey}`);
      }
      return {
        ...selectedLoaded,
        source: "loaded"
      };
    }

    const defaultModel = resolveConfiguredModel(configuredModel || "auto:gemma", nativeModels);
    const defaultModelInfo = nativeModels.find((model) => modelId(model) === defaultModel) || null;
    if (report) {
      await report(`LM Studio 기본 모델 로드 중: ${defaultModel}`);
    }
    const loadedDefault = await loadLmStudioModel(defaultModel, signal);
    if (report) {
      await report(`LM Studio 기본 모델 로드 완료: ${defaultModel}`);
    }
    return {
      modelKey: defaultModel,
      instanceId: loadedDefault.instanceId,
      source: "default-loaded",
      contextLength: loadedDefault.contextLength,
      reasoningOptions: Array.isArray(defaultModelInfo?.capabilities?.reasoning?.allowed_options)
        ? defaultModelInfo.capabilities.reasoning.allowed_options.map((option) => String(option).toLowerCase())
        : []
    };
  }

  const legacyModel = await resolveLegacyModelName(configuredModel || "auto:gemma", signal);
  if (report) {
    await report(`LM Studio 모델 사용: ${legacyModel}`);
  }
  return {
    modelKey: legacyModel,
    instanceId: legacyModel,
    source: "legacy-jit",
    contextLength: 0,
    reasoningOptions: []
  };
}

function pickBestModel(models) {
  return [...models].sort((a, b) => {
    const bSize = Number(b && b.size_bytes) || extractModelSizeB(modelId(b));
    const aSize = Number(a && a.size_bytes) || extractModelSizeB(modelId(a));
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
    ocrResults: Array.isArray(data.results) ? data.results : [],
    ocrTiming: data && data.timing ? data.timing : null
  };
}

async function prepareImageForOcr(image, signal) {
  const url = preferredImageUrlForOcr(image);

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

function preferredImageUrlForOcr(image) {
  const imageUrl = image && image.url ? String(image.url) : "";
  const linkedUrl = image && image.linkedUrl ? String(image.linkedUrl) : "";

  if (isDcinsideRenderedImageUrl(imageUrl)) {
    return imageUrl;
  }

  return linkedUrl || imageUrl;
}

function isDcinsideRenderedImageUrl(url) {
  return /\/\/(?:(?:dcimg|dccdn)\d*\.dcinside\.co\.kr)\/viewimage\.php/i.test(String(url || ""));
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

async function saveResult(page, summary, lmTimings = []) {
  const saved = {
    ...page,
    summarizerVersion: extensionVersion(),
    summary,
    lmTimings,
    savedAt: new Date().toISOString()
  };

  await browser.storage.local.set({
    [storageKeyFor(page.url)]: saved,
    lastSavedUrl: page.url
  });

  return saved;
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

function sourceTextForMarkdown(saved) {
  const pageText = String(saved && saved.text || "").trim();
  const comments = Array.isArray(saved && saved.comments)
    ? saved.comments.map((comment) => String(comment || "").trim()).filter(Boolean)
    : [];
  const sections = [];

  if (pageText) {
    sections.push(`[페이지 본문]\n${pageText}`);
  }
  if (comments.length) {
    const entries = comments.map((comment, index) => (
      `[댓글/리뷰 항목 ${index + 1}/${comments.length}]\n${comment}`
    ));
    sections.push(`[수집된 댓글/리뷰: ${comments.length}개]\n${entries.join("\n\n")}`);
  }

  return sections.join("\n\n");
}

function markdownTextBlock(value) {
  const text = String(value || "");
  const longestFence = Math.max(0, ...Array.from(text.matchAll(/`+/g), (match) => match[0].length));
  const fence = "`".repeat(Math.max(3, longestFence + 1));
  return [`${fence}text`, text, fence];
}

function toMarkdown(saved) {
  const exportableOcrResults = Array.isArray(saved.ocrResults)
    ? saved.ocrResults.filter((result) => String(result?.text || result?.error || "").trim())
    : [];
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
  const ocrSection = exportableOcrResults.length
    ? [
      "## Image OCR",
      "",
      ...exportableOcrResults.flatMap((result) => [
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
    `- Summarizer version: ${saved.summarizerVersion || extensionVersion()}`,
    saved.lmModel ? `- LM Studio model: ${saved.lmModel}` : "",
    saved.lmModelSource ? `- LM Studio model source: ${saved.lmModelSource}` : "",
    saved.lmModelContextLength ? `- LM Studio model context: ${saved.lmModelContextLength}` : "",
    saved.lmEffectiveMaxChars ? `- LM Studio chunk chars: ${saved.lmConfiguredMaxChars || saved.lmEffectiveMaxChars} configured, ${saved.lmEffectiveMaxChars} effective` : "",
    typeof saved.lmThinkingDisabled === "boolean" ? `- LM Studio thinking disabled: ${saved.lmThinkingDisabled ? "yes" : "no"}` : "",
    `- Text extractor: ${saved.textSource || "selectors"}`,
    `- Collected: ${saved.collectedAt}`,
    `- Saved: ${saved.savedAt}`,
    `- Selected only: ${saved.selectedOnly ? "yes" : "no"}`,
    `- Comment candidates: ${(saved.comments || []).length}`,
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
    ...(saved.xCollection ? [
      `- X status ID: ${saved.xCollection.statusId}`,
      `- X loaded replies: ${saved.xCollection.loadedReplyCount}`
    ] : []),
    `- Image candidates: ${(saved.images || []).length}`,
    `- OCR results: ${(saved.ocrResults || []).filter((result) => result.text).length}`,
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
    ...markdownTextBlock(sourceTextForMarkdown(saved))
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
    if (isDanawaProductCollection(page)) {
      await setJobState({ message: "다나와 전체 상품의견과 쇼핑몰 후기 수집 중..." });
      page = await enrichPageWithDanawaComments(
        page,
        signal,
        (message) => setJobState({ message })
      );
    }
    if (isKakakuReviewCollection(page)) {
      await setJobState({ message: "가격닷컴 전체 리뷰 수집 중..." });
      page = await enrichPageWithKakakuReviews(
        page,
        signal,
        (message) => setJobState({ message })
      );
    }
    if (isKakakuBbsCollection(page)) {
      await setJobState({ message: "가격닷컴 BBS 전체 스레드와 답글 수집 중..." });
      page = await enrichPageWithKakakuBbs(
        page,
        signal,
        (message) => setJobState({ message })
      );
    }
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
    const lmResult = await summarizeWithLMStudio(page, request.settings, signal, (message) => setJobState({ message }));
    const summary = lmResult.summary;
    page = {
      ...page,
      lmModel: lmResult.model,
      lmModelInstanceId: lmResult.modelInstanceId,
      lmModelSource: lmResult.modelSource,
      lmModelContextLength: lmResult.modelContextLength,
      lmConfiguredMaxChars: lmResult.configuredMaxChars,
      lmEffectiveMaxChars: lmResult.effectiveMaxChars,
      lmThinkingDisabled: lmResult.thinkingDisabled
    };

    await setJobState({ message: "결과 저장 중..." });
    const saved = await saveResult(page, summary, lmResult.lmTimings);
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
