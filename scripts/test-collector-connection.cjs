const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../background.js'), 'utf8');
const version = JSON.parse(fs.readFileSync(path.join(__dirname, '../manifest.json'), 'utf8')).version;
async function scenario(mode) {
  let injected = false;
  let transient = mode === 'navigation';
  let collections = 0;
  let injections = 0;
  let reads = 0;
  const missing = () => new Error('Could not establish connection. Receiving end does not exist.');
  const browser = {
    runtime: { getManifest: () => ({ version }), onMessage: { addListener() {} } },
    tabs: {
      onUpdated: { addListener() {}, removeListener() {} },
      get: async () => {
        reads++;
        if (mode === 'no_metadata') return { status: 'complete' };
        if (mode === 'blank' && reads < 4) return { url: 'about:blank', status: 'complete' };
        if (mode === 'restricted') return { url: 'about:addons', status: 'complete' };
        return { url: 'https://www.amazon.com/portal/customer-reviews/B0BZ3P5J7Q', status: 'complete' };
      },
      executeScript: async (_, options) => {
        if (options.file === 'contentScript.js') { injections++; injected = true; }
      },
      sendMessage: async (_, message, options) => {
        assert.equal(options.frameId, 0);
        if (mode === 'missing' || !injected) throw missing();
        if (message.type === 'SUMMARIZER_READY') {
          if (transient) { transient = false; throw missing(); }
          return { ready: true, version };
        }
        collections++;
        if (mode === 'extraction') throw new Error('Review body extraction failed');
        return { url: 'https://www.amazon.com/', comments: [] };
      }
    }
  };
  const context = vm.createContext({ browser, console, URL, clearTimeout,
    setTimeout: (fn, ms) => setTimeout(fn, ms === 45000 ? ms : 0) });
  vm.runInContext(source, context);
  if (mode === 'missing') {
    await assert.rejects(context.collectPageFromTab(9), /주입 후 연결 확인 \/ 탭 9/);
    assert.equal(injections, 3);
    assert.equal(collections, 0);
  } else if (mode === 'restricted') {
    await assert.rejects(context.collectPageFromTab(9), /about:addons/);
    assert.equal(injections, 0);
  } else if (mode === 'extraction') {
    await assert.rejects(context.collectPageFromTab(9), /페이지 수집.*Review body extraction failed/);
    assert.equal(collections, 1);
    assert.equal(injections, 1);
  } else {
    assert.equal((await context.collectPageFromTab(9)).url, 'https://www.amazon.com/');
    assert.equal(collections, 1);
  }
  console.log(`PASS ${mode}`);
}
(async () => {
  for (const mode of ['initial', 'navigation', 'extraction', 'missing', 'blank', 'no_metadata', 'restricted']) await scenario(mode);
})().catch((error) => { console.error(error); process.exitCode = 1; });
