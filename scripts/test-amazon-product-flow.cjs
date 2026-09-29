const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const version = JSON.parse(fs.readFileSync(path.join(__dirname, '../manifest.json'), 'utf8')).version;
const source = fs.readFileSync(path.join(__dirname, '../background.js'), 'utf8');

async function run(host, prefix, failTwoStarFilter = false, paginate = false, ajaxExpand = false) {
  const url = `https://${host}${prefix}/Lightweight-Removable-Power-Cordless-Telescopic-VS20R9046T3/dp/B087V5LZMH?ie=UTF8`;
  const portalUrl = `https://${host}${prefix}/portal/customer-reviews/B087V5LZMH/ref=cm_cr_dp_d_show_all_top?reviewerType=all_reviews`;
  const productReviewsUrl = new URL(portalUrl);
  productReviewsUrl.pathname = productReviewsUrl.pathname.replace('/portal/customer-reviews/', '/product-reviews/');
  const product = { url, text: 'Samsung cordless vacuum', comments: [], amazon: {
    asin: 'B087V5LZMH', pageType: 'product', localePrefix: prefix, currentStar: 0, reviewPortalUrl: portalUrl
  } };
  const tabs = new Map();
  const closed = [];
  const created = [];
  const updatedUrls = [];
  const expansions = new Map();
  const renderedStarLinks = Object.fromEntries(['one_star', 'two_star', 'three_star'].map((filter) => {
    const href = new URL(productReviewsUrl.href);
    href.searchParams.set('filterByStar', filter);
    href.searchParams.set('ref_', `amazon_rendered_filter_${filter}`);
    return [filter, href.href];
  }));
  const browser = {
    runtime: { getManifest: () => ({ version }), onMessage: { addListener() {} } },
    tabs: {
      onUpdated: { addListener() {}, removeListener() {} },
      get: async (id) => {
        if (id === 1) return { url, windowId: 5, cookieStoreId: 'firefox-container-2', status: 'complete' };
        const tab = tabs.get(id);
        if (++tab.reads < 3) return { url: 'about:blank', status: 'complete' };
        return { url: tab.url, status: 'complete' };
      },
      create: async (options) => {
        assert.equal(options.active, false);
        assert.equal(options.windowId, 5);
        assert.equal(options.cookieStoreId, 'firefox-container-2');
        assert.equal(options.url, productReviewsUrl.href);
        const id = created.length + 2;
        tabs.set(id, { url: options.url, reads: 0 });
        created.push(id);
        return { id };
      },
      update: async (id, update) => {
        tabs.get(id).url = update.url;
        updatedUrls.push(update.url);
        return { id, ...update, status: 'complete' };
      },
      remove: async (id) => closed.push(id),
      sendMessage: async (id, message) => {
        if (message.type === 'SUMMARIZER_READY') return { ready: true, version };
        if (id === 1) return product;
        const reviewUrl = tabs.get(id).url;
        if (message.type === 'GET_AMAZON_STAR_FILTER_URL') {
          return { url: renderedStarLinks[message.filterName] };
        }
        const star = ['one_star', 'two_star', 'three_star'].indexOf(new URL(reviewUrl).searchParams.get('filterByStar')) + 1;
        const pageNumber = Number(new URL(reviewUrl).searchParams.get('pageNumber')) || 1;
        if (message.type === 'GET_AMAZON_PAGE_STATE') {
          return { url: reviewUrl, amazon: { asin: 'B087V5LZMH', pageType: 'review', currentStar: star, pageNumber } };
        }
        if (message.type === 'EXPAND_AMAZON_REVIEWS_ONCE') {
          expansions.set(id, (expansions.get(id) || 0) + 1);
          return { clicked: true, grew: true, count: 20, url: reviewUrl };
        }
        assert.equal(message.amazonExpectedStar, star);
        const isTwoStar = star === 2;
        const pageTwo = paginate && pageNumber === 2;
        const isExpanded = ajaxExpand && (expansions.get(id) || 0) > 0;
        const matchingCount = failTwoStarFilter && isTwoStar ? 0 : isExpanded ? 2 : 1;
        const mismatchedCount = isTwoStar && !pageTwo ? (failTwoStarFilter ? 2 : 1) : 0;
        const cardsFound = matchingCount + mismatchedCount;
        const ratingsByStar = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
        ratingsByStar[star] = matchingCount;
        if (isTwoStar) ratingsByStar[5] = mismatchedCount;
        let nextReviewUrl = '';
        if (paginate && pageNumber === 1) {
          const next = new URL(productReviewsUrl.href);
          next.pathname += '/ref=cm_cr_arp_d_paging_btm_2';
          next.search = '';
          nextReviewUrl = next.href;
        }
        const reviewId = `R${star}${pageTwo ? 'P2' : ''}`;
        const reviewIds = failTwoStarFilter && isTwoStar ? [] : [reviewId];
        if (isExpanded) reviewIds.push(`${reviewId}MORE`);
        return { url: reviewUrl, amazon: { asin: 'B087V5LZMH', pageType: 'review', currentStar: star,
          pageNumber,
          nextReviewUrl,
          hasMoreReviewsButton: ajaxExpand && !isExpanded,
          ratingDiagnostics: {
            expectedStar: star,
            cardsFound,
            ratingsParsed: cardsFound,
            ratingsUnparsed: 0,
            matchingCount,
            mismatchedCount,
            bodyMissingCount: 0,
            reviewIds,
            ratingsByStar,
            bodiesMissingByStar: { 1: 0, 2: 0, 3: 0 }
          } },
          comments: (failTwoStarFilter && isTwoStar ? [] : [
            `[Amazon review | ${star}/5 | ${reviewId}]\nBody: Full original review ${star}${pageTwo ? ' page two' : ''}`,
            ...(isExpanded ? [`[Amazon review | ${star}/5 | ${reviewId}MORE]\nBody: Expanded review ${star}`] : [])
          ]) };
      }
    }
  };
  const context = vm.createContext({ browser, URL, console, clearTimeout,
    setTimeout: (fn, ms) => setTimeout(fn, ms === 45000 ? ms : 0) });
  vm.runInContext(source, context);
  const initial = await context.collectPageFromTab(1);
  let result;
  let collectionError;
  try {
    result = await context.enrichPageWithAmazonReviews(initial, undefined, undefined, 1);
  } catch (error) {
    collectionError = error;
  }
  if (failTwoStarFilter) {
    assert.match(collectionError?.message || '', /Amazon 2점 필터가 1페이지에서 적용되지 않았습니다/);
    assert.deepEqual(closed, created);
    console.log(`PASS all-mismatch filter is rejected with diagnostics: ${host}`);
    return;
  }

  assert.equal(collectionError, undefined);
  assert.equal(result.comments.length, (paginate || ajaxExpand) ? 6 : 3);
  assert.equal(created.length, 3);
  assert.deepEqual(closed, created);
  assert.equal(result.url, url);
  for (const star of [1, 2, 3]) {
    const expectedCards = (paginate || ajaxExpand) ? (star === 2 ? 3 : 2) : star === 2 ? 2 : 1;
    assert.equal(result.amazonCollection.ratingDiagnostics[star].cardsFound, expectedCards);
    assert.equal(result.amazonCollection.ratingDiagnostics[star].ratingsParsed, expectedCards);
    assert.equal(result.amazonCollection.ratingDiagnostics[star].reviewsSaved, (paginate || ajaxExpand) ? 2 : 1);
  }
  assert.equal(result.amazonCollection.ratingDiagnostics[2].matchingCount, (paginate || ajaxExpand) ? 2 : 1);
  assert.equal(result.amazonCollection.ratingDiagnostics[2].mismatchedCount, 1);
  if (ajaxExpand) {
    assert.equal(result.amazonCollection.moreClicks, 3);
    assert.deepEqual(JSON.parse(JSON.stringify(result.amazonCollection.pagesFetchedByStar)), { 1: 1, 2: 1, 3: 1 });
    console.log('PASS AJAX-style Amazon review expansion is collected after the initial page');
  }
  if (paginate) {
    assert.deepEqual(JSON.parse(JSON.stringify(result.amazonCollection.pagesFetchedByStar)), { 1: 2, 2: 2, 3: 2 });
    const pageTwoUrls = updatedUrls.map((value) => new URL(value)).filter((value) => value.searchParams.get('pageNumber') === '2');
    assert.equal(pageTwoUrls.length, 3);
    for (const [index, value] of pageTwoUrls.entries()) {
      assert.equal(value.searchParams.get('reviewerType'), 'all_reviews');
      assert.equal(value.searchParams.get('filterByStar'), ['one_star', 'two_star', 'three_star'][index]);
    }
    console.log('PASS page 2 links that drop filters are repaired and both pages are retained');
  }
  console.log(`PASS product-only entry, automatic 1/2/3-star collection, tab cleanup: ${host}`);
}
(async () => {
  await run('www.amazon.com', '');
  await run('www.amazon.com', '', false, true);
  await run('www.amazon.co.jp', '/-/en');
  await run('www.amazon.co.jp', '/-/en', false, false, true);
  await run('www.amazon.co.jp', '/-/en', true);
})().catch((error) => { console.error(error); process.exitCode = 1; });
