const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const version = JSON.parse(fs.readFileSync(path.join(__dirname, '../manifest.json'), 'utf8')).version;
const source = fs.readFileSync(path.join(__dirname, '../background.js'), 'utf8');

async function run(host, prefix) {
  const url = `https://${host}${prefix}/Lightweight-Removable-Power-Cordless-Telescopic-VS20R9046T3/dp/B087V5LZMH?ie=UTF8`;
  const product = { url, text: 'Samsung cordless vacuum', comments: [], amazon: {
    asin: 'B087V5LZMH', pageType: 'product', localePrefix: prefix, currentStar: 0
  } };
  const tabs = new Map();
  const closed = [];
  const created = [];
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
        assert.ok(options.url.startsWith(`https://${host}${prefix}/portal/customer-reviews/B087V5LZMH/`));
        const id = created.length + 2;
        tabs.set(id, { url: options.url, reads: 0 });
        created.push(id);
        return { id };
      },
      remove: async (id) => closed.push(id),
      sendMessage: async (id, message) => {
        if (message.type === 'SUMMARIZER_READY') return { ready: true, version };
        if (id === 1) return product;
        const reviewUrl = tabs.get(id).url;
        const star = ['one_star', 'two_star', 'three_star'].indexOf(new URL(reviewUrl).searchParams.get('filterByStar')) + 1;
        return { url: reviewUrl, amazon: { asin: 'B087V5LZMH', pageType: 'review', currentStar: star },
          comments: [`[Amazon review | ${star}/5 | R${star}]\nBody: Full original review ${star}`] };
      }
    }
  };
  const context = vm.createContext({ browser, URL, console, clearTimeout,
    setTimeout: (fn, ms) => setTimeout(fn, ms === 45000 ? ms : 0) });
  vm.runInContext(source, context);
  const initial = await context.collectPageFromTab(1);
  const result = await context.enrichPageWithAmazonReviews(initial, undefined, undefined, 1);
  assert.equal(result.comments.length, 3);
  assert.equal(created.length, 3);
  assert.deepEqual(closed, created);
  assert.equal(result.url, url);
  console.log(`PASS product-only entry, automatic 1/2/3-star collection, tab cleanup: ${host}`);
}
(async () => {
  await run('www.amazon.com', '');
  await run('www.amazon.co.jp', '/-/en');
})().catch((error) => { console.error(error); process.exitCode = 1; });
