const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../contentScript.js'), 'utf8');
let messageListener = null;
const location = {
  hostname: 'www.amazon.co.jp',
  pathname: '/-/en/portal/customer-reviews/B0DP481Y24/ref=cm_cr_dp_d_show_all_top',
  href: 'https://www.amazon.co.jp/-/en/portal/customer-reviews/B0DP481Y24/ref=cm_cr_dp_d_show_all_top?pageNumber=2&filterByKeyword=broken#reviews-filter-bar'
};
let reviewCards = [];
const reviewRoot = { querySelectorAll: () => reviewCards };
const document = { querySelector: () => reviewRoot, querySelectorAll: () => [] };
const context = vm.createContext({
  browser: {
    runtime: {
      onMessage: { addListener(listener) { messageListener = listener; }, removeListener() {} },
      getManifest: () => ({ version: 'test' })
    }
  },
  document,
  location,
  URL,
  window: {}
});

vm.runInContext(source, context);

function ratingCard(text) {
  return {
    querySelector: () => ({
      getAttribute: () => '',
      textContent: text
    })
  };
}

function reviewCard(id, rating, body) {
  const ratingElement = { getAttribute: () => '', textContent: rating };
  return {
    id: `customer_review-${id}`,
    parentElement: null,
    getAttribute: (name) => name === 'data-review-id' ? id : '',
    querySelector(selector) {
      if (selector.includes('review-star-rating') || selector === '.a-icon-alt') return ratingElement;
      if (selector === "[data-hook='review-body']") {
        return { cloneNode: () => ({ querySelectorAll: () => [], textContent: body }) };
      }
      return null;
    }
  };
}

const parseRating = context.__localPageSummarizerAmazonRatingFromCard;
assert.equal(parseRating(ratingCard('5つ星のうち1.0')), 1);
assert.equal(parseRating(ratingCard('5つ星のうち3.0')), 3);
assert.equal(parseRating(ratingCard('1.0 out of 5 stars')), 1);
assert.equal(parseRating(ratingCard('1,0 von 5 Sternen')), 1);
assert.equal(parseRating(ratingCard('5つ星')), 0);
assert.equal(parseRating(ratingCard('1.0')), 0);

reviewCards = [
  reviewCard('TWO', '5つ星のうち2.0', 'Expected two-star review'),
  reviewCard('FIVE', '5つ星のうち5.0', 'Unrelated five-star card')
];
const collectReviews = context.__localPageSummarizerCollectAmazonReviews;
const filtered = collectReviews(2);
assert.equal(filtered.comments.length, 1);
assert.match(filtered.comments[0], /\[Amazon review \| 2\/5 \| TWO\]/);
assert.equal(filtered.ratingDiagnostics.cardsFound, 2);
assert.equal(filtered.ratingDiagnostics.matchingCount, 1);
assert.equal(filtered.ratingDiagnostics.mismatchedCount, 1);
assert.equal(filtered.ratingDiagnostics.reviewsSavedByStar[2], 1);

(async () => {
  const fallback = await messageListener({ type: 'GET_AMAZON_STAR_FILTER_URL', filterName: 'one_star' });
  const fallbackUrl = new URL(fallback.url);
  assert.match(fallbackUrl.pathname, /\/product-reviews\/B0DP481Y24/);
  assert.equal(fallbackUrl.searchParams.get('filterByStar'), 'one_star');
  assert.equal(fallbackUrl.searchParams.get('reviewerType'), 'all_reviews');
  assert.equal(fallbackUrl.searchParams.has('pageNumber'), false);
  assert.equal(fallbackUrl.searchParams.has('filterByKeyword'), false);

  const renderedLink = new URL(location.href);
  renderedLink.pathname = renderedLink.pathname.replace('/portal/customer-reviews/', '/product-reviews/');
  renderedLink.search = '?filterByStar=two_star';
  document.querySelectorAll = () => [{
    href: renderedLink.href,
    value: '',
    getAttribute: () => ''
  }];
  const rendered = await messageListener({ type: 'GET_AMAZON_STAR_FILTER_URL', filterName: 'two_star' });
  assert.equal(new URL(rendered.url).searchParams.get('filterByStar'), 'two_star');
  console.log('PASS Japanese/English/European ratings and Amazon.co.jp star URL fallback');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
