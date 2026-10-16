const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const { before, after, test } = require('node:test');
const { chromium } = require('playwright');

const root = path.join(__dirname, '..');
const script = readFileSync(path.join(root,
  'custom_components/ha_proxy/frontend/ha-proxy-panel.js'), 'utf8');
let browser;
before(async () => {
  browser = await chromium.launch({
    executablePath: process.env.BROWSER_PATH || undefined,
  });
});
after(async () => { await browser?.close(); });

test('frontend and backend revisions match; panel owns safe areas', () => {
  const constants = readFileSync(path.join(root,
    'custom_components/ha_proxy/const.py'), 'utf8');
  assert.equal(script.match(/const PANEL_JS_REV = (\d+)/)[1],
    constants.match(/PANEL_JS_REV: Final = "(\d+)"/)[1]);
  const registration = readFileSync(path.join(root,
    'custom_components/ha_proxy/__init__.py'), 'utf8');
  assert.match(registration, /"handle_safe_area": True/);
});

async function mount(page, insets, sidebar, wrapperDisplay) {
  // No real HA credentials or upstream service: all network traffic is mocked.
  await page.route('**/*', route => route.fulfill({
    contentType: 'text/html', body: '<!doctype html><body>Mock upstream</body>',
  }));
  await page.goto('http://ha.test/');
  await page.setContent('<style>body { margin: 0; }</style><home-assistant></home-assistant>');
  await page.addScriptTag({ content: script });
  await page.evaluate(({ insets, sidebar, wrapperDisplay }) => {
    window.fetch = url => url.startsWith('/api/ha_proxy_session/')
      ? new Promise(resolve => { window.finishSession = resolve; })
      : Promise.resolve({ status: 200 });
    const ha = document.querySelector('home-assistant');
    const shadow = ha.attachShadow({ mode: 'open' });
    // HA-like light-DOM wrapper nested beneath a shadow root. Deliberately
    // no definite ancestor heights: percentage heights alone cannot fix this.
    shadow.innerHTML = `
      <style>
        .content { margin-left: ${sidebar}px; }
        ha-panel-custom { display: ${wrapperDisplay}; flex-direction: column; }
      </style>
      <div class="content"><ha-panel-custom></ha-panel-custom></div>`;
    const wrapper = shadow.querySelector('ha-panel-custom');
    for (const [key, value] of Object.entries(insets)) {
      wrapper.style.setProperty('--safe-area-' + key, value + 'px');
    }
    // handle_safe_area=true means HA adds NO wrapper padding.
    const panel = document.createElement('ha-proxy-panel');
    window.testPanel = panel;
    panel.panel = { config: { slug: 'test' } };
    panel.hass = { auth: { data: { access_token: 'mock-only' } } };
    wrapper.append(panel);
  }, { insets, sidebar, wrapperDisplay });
}

async function assertLayout(page, selector, insets, sidebar) {
  const bounds = await page.evaluate(selector => {
    const panel = window.testPanel;
    const box = el => {
      const r = el.getBoundingClientRect();
      return { x: r.x, y: r.y, width: r.width, height: r.height };
    };
    return {
      panel: box(panel), child: box(panel.querySelector(selector)),
      wrapper: box(panel.parentElement),
      documentHeight: document.documentElement.scrollHeight,
      documentWidth: document.documentElement.scrollWidth,
      viewport: { width: innerWidth, height: innerHeight },
      styleVisible: [...panel.querySelectorAll('style')].some(
        el => getComputedStyle(el).display !== 'none'),
    };
  }, selector);
  const top = insets['inset-top'] || 0;
  const bottom = insets['inset-bottom'] || 0;
  const left = insets['content-inset-left'] ?? insets['inset-left'] ?? 0;
  const right = insets['content-inset-right'] ?? insets['inset-right'] ?? 0;
  assert.deepEqual(bounds.child, {
    x: sidebar + left, y: top,
    width: bounds.viewport.width - sidebar - left - right,
    height: bounds.viewport.height - top - bottom,
  });
  assert.equal(bounds.panel.height, bounds.viewport.height);
  assert.equal(bounds.wrapper.height, bounds.viewport.height);
  assert.equal(bounds.documentHeight, bounds.viewport.height);
  assert.equal(bounds.documentWidth, bounds.viewport.width);
  assert.equal(bounds.styleVisible, false);
}

test('removing host layout reproduces the 150px iframe; restoring it fixes it', async () => {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  page.setDefaultTimeout(5000);
  try {
    await mount(page, {}, 256, 'block');
    await page.evaluate(() => window.finishSession({ ok: true }));
    await page.waitForSelector('ha-proxy-panel iframe');
    const height = await page.evaluate(() => {
      const panel = window.testPanel;
      const sheet = panel.querySelector('style').sheet;
      window.hostRule = sheet.cssRules[0].cssText;
      sheet.deleteRule(0);
      return panel.querySelector('iframe').getBoundingClientRect().height;
    });
    assert.equal(height, 150);
    await page.evaluate(() => {
      window.testPanel.querySelector('style').sheet.insertRule(window.hostRule, 0);
    });
    await assertLayout(page, 'iframe', {}, 256);
  } finally {
    await page.close();
  }
});

for (const fixture of [
  { name: 'desktop with sidebar, block wrapper', sidebar: 256,
    viewport: { width: 1280, height: 900 }, insets: {}, display: 'block' },
  { name: 'mobile portrait with safe areas', sidebar: 0,
    viewport: { width: 390, height: 844 }, display: 'block',
    insets: { 'inset-top': 47, 'inset-bottom': 34 } },
  { name: 'landscape, sidebar absorbs left inset', sidebar: 256,
    viewport: { width: 1024, height: 480 }, display: 'block',
    insets: { 'inset-top': 12, 'inset-bottom': 21,
      'inset-left': 44, 'inset-right': 44, 'content-inset-left': 0 } },
  { name: 'flex wrapper compatibility', sidebar: 56,
    viewport: { width: 900, height: 700 }, insets: {}, display: 'flex' },
]) {
  test(fixture.name + ': loading, iframe, resize and error fill panel', async () => {
    const page = await browser.newPage({ viewport: fixture.viewport });
    page.setDefaultTimeout(5000);
    try {
      await mount(page, fixture.insets, fixture.sidebar, fixture.display);
      await assertLayout(page, '.ha-proxy-spinner', fixture.insets, fixture.sidebar);
      await page.evaluate(() => window.finishSession({ ok: true }));
      await page.waitForSelector('ha-proxy-panel iframe'); // Playwright pierces shadow roots.
      await assertLayout(page, 'iframe', fixture.insets, fixture.sidebar);
      await page.evaluate(() => { window.originalFrame = window.testPanel.querySelector('iframe'); });
      await page.setViewportSize({ width: 1100, height: 600 });
      await assertLayout(page, 'iframe', fixture.insets, fixture.sidebar);
      assert.equal(await page.evaluate(() =>
        window.originalFrame === window.testPanel.querySelector('iframe')), true);
      await page.evaluate(() => window.testPanel._renderError('Test failure <unsafe>'));
      await assertLayout(page, '.ha-proxy-error', fixture.insets, fixture.sidebar);
      assert.equal(await page.evaluate(() =>
        window.testPanel.querySelector('unsafe')), null);
    } finally {
      await page.close();
    }
  });
}
