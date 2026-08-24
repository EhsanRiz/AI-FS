/* Field-conditions test: the app posts to a REAL local HTTP endpoint over a
   throttled uplink, so payload size and retry behave as they do on rural LTE.
   Nothing here touches the live project. */
const http = require('http');
const { chromium } = require('@playwright/test');

const UPLINK_KBPS = 150;          // weak rural LTE uplink
const APP = 'http://localhost:8191';

let mode = 'ok';                  // 'ok' | 'dropfirst'
let attempts = 0;
const seen = [];

const api = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Max-Age', '600');
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }

  const fn = req.url.split('/rpc/')[1] || '';
  let bytes = 0;
  const started = Date.now();
  req.on('data', c => { bytes += c.length; });
  req.on('end', () => {
    if (fn === 'fs_submit_visit') {
      attempts++;
      seen.push({ bytes, ms: Date.now() - started });
      if (mode === 'dropfirst' && attempts === 1) { req.destroy(); return; }  // link drops mid-flight
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ ok: true, visit_id: 'x', distance_from_site_m: 12 }));
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(fn === 'fs_bootstrap' ? BOOT : { sites: [] }));
  });
});

const SITE = { id: 1, rc: 'Rothe', lat: -29.519759, lon: 27.422734, zone: 'Lowlands',
               farmers: 19, district: 'Maseru', sub_area: 'Mahuu', is_validation_site: false };
const BOOT = {
  supervisor: { id: 'aa', name: 'Test FS', role: 'supervisor', username: 'testfs', assigned_site_ids: [1] },
  sites: [SITE], farms: [], farmers: [{ id: 'f1', site_id: 1, name: 'Bokang Khutlisi', village: 'Thebesoa' }],
  progress: { sites: [] }, activity: []
};

async function newFS(browser, apiPort) {
  const ctx = await browser.newContext({
    viewport: { width: 390, height: 844 },
    geolocation: { latitude: -29.5198, longitude: 27.4227 }, permissions: ['geolocation']
  });
  const page = await ctx.newPage();
  await page.addInitScript(([boot, port]) => {
    localStorage.setItem('fsm_token', 'test-token');
    localStorage.setItem('fsm_boot', JSON.stringify(boot));
    localStorage.setItem('fsm_me', JSON.stringify(boot.supervisor));
    // point the app at the local endpoint so the upload really crosses the wire
    window.addEventListener('DOMContentLoaded', () => { window.SUPABASE_URL = 'http://localhost:' + port; });
  }, [BOOT, apiPort]);
  await page.route(/^https:\/\/(fonts|.*tile)\./, r => r.abort());
  return { ctx, page };
}

async function throttle(page, kbps) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Network.enable');
  await cdp.send('Network.emulateNetworkConditions', {
    offline: false, latency: 300,
    downloadThroughput: (kbps * 1024) / 8,
    uploadThroughput: (kbps * 1024) / 8
  });
  return cdp;
}

async function captureVisit(page, photoPath, nPhotos) {
  await page.goto(APP + '/index.html#/visit');
  await page.waitForSelector('#photoStrip');
  await page.click('#btnGps');
  await page.waitForFunction(() => !!window.form.gps);
  await page.click('[data-ai="1"]');
  for (let i = 0; i < nPhotos; i++) {
    await page.setInputFiles('#fPhoto', photoPath);
    await page.waitForFunction(n => window.form.photos.length === n, i + 1);
  }
  return page.evaluate(() => window.form.photos.reduce((t, p) => t + p.data_base64.length, 0));
}

function say(line) { console.log(line); }
async function state(page) {
  return page.evaluate(() => (window.S.queue || []).map(r => r.state + (r.error ? ' (' + r.error + ')' : '')));
}
(async () => {
  const apiPort = 8899;
  await new Promise(r => api.listen(apiPort, r));
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
  const photo = process.argv[2];
  const out = [];

  // ---- 1. a 2-photo visit over a 150 kbps uplink, as shipped ----
  {
    const { ctx, page } = await newFS(browser, apiPort);
    const b64 = await captureVisit(page, photo, 2);
    await throttle(page, UPLINK_KBPS);
    seen.length = 0; attempts = 0; mode = 'ok';
    const t0 = Date.now();
    await page.click('#btnSave');
    await page.waitForFunction(() => window.S.queue.every(r => r.state === 'synced'), null, { timeout: 120000 })
      .catch(async e => { console.error('queue state:', await state(page), 'server saw:', seen); throw e; });
    const ms = Date.now() - t0;
    say(`1. 2-photo visit on a ${UPLINK_KBPS} kbps uplink: ${Math.round(b64 / 1024)} KB of photo, ` +
             `${Math.round(seen[0].bytes / 1024)} KB posted, SYNCED in ${(ms / 1000).toFixed(1)}s ` +
             `(timeout is 90s — ${ms < 90000 ? 'inside' : 'OVER'})`);
    await ctx.close();
  }

  // ---- 2. same visit, but the link drops mid-upload ----
  {
    const { ctx, page } = await newFS(browser, apiPort);
    await captureVisit(page, photo, 1);
    await throttle(page, UPLINK_KBPS);
    seen.length = 0; attempts = 0; mode = 'dropfirst';
    const t0 = Date.now();
    await page.click('#btnSave');
    await page.waitForFunction(() => window.S.queue.every(r => r.state === 'synced'), null, { timeout: 120000 })
      .catch(async e => { console.error('  diag:', await state(page), 'attempts:', attempts); throw e; });
    say(`2. link drops mid-upload: ${attempts} attempts, recovered by itself in ` +
             `${((Date.now() - t0) / 1000).toFixed(1)}s, no FS action`);
    await ctx.close();
  }

  // ---- 3. Molapo's phone: a failed visit holding a pre-budget photo ----
  {
    const { ctx, page } = await newFS(browser, apiPort);
    await page.goto(APP + '/index.html#/queue');
    await page.waitForSelector('#syncProgress', { state: 'attached' });
    const before = await page.evaluate(async () => {
      const c = document.createElement('canvas');
      c.width = 3200; c.height = 2400;
      const g = c.getContext('2d'), im = g.createImageData(c.width, c.height);
      let s = 11;
      for (let i = 0; i < im.data.length; i += 4) {
        s = (s * 1103515245 + 12345) & 0x7fffffff;
        im.data[i] = 40 + (s >> 16) % 180; im.data[i + 1] = 60 + (s >> 9) % 170;
        im.data[i + 2] = 20 + (s >> 3) % 120; im.data[i + 3] = 255;
      }
      g.putImageData(im, 0, 0);
      const big = c.toDataURL('image/jpeg', 0.99).split(',')[1];
      await idb.put('visits', {
        id: 'molapo-1', site_id: 1, state: 'failed', error: 'Failed to fetch',
        readings: [], updated_at: new Date().toISOString(), submitted_at: new Date().toISOString(),
        gps: { lat: -29.5198, lon: 27.4227, accuracy_m: 12 }, ai_administered: true,
        issue: 'pest outbreak', photos: [{ id: 'p1', mime: 'image/jpeg', data_base64: big }]
      });
      await loadQueue();
      return big.length;
    });
    await throttle(page, UPLINK_KBPS);
    seen.length = 0; attempts = 0; mode = 'ok';
    const t0 = Date.now();
    await page.evaluate(() => syncAll(true));
    await page.waitForFunction(() => window.S.queue.every(r => r.state === 'synced'), null, { timeout: 120000 })
      .catch(async e => { console.error('  diag:', await state(page), 'attempts:', attempts); throw e; });
    const after = await page.evaluate(() => window.S.queue[0].photos[0].data_base64.length);
    say(`3. stuck "Failed to fetch" visit: photo shrunk ${Math.round(before / 1024)} KB -> ` +
             `${Math.round(after / 1024)} KB in place, SYNCED in ${((Date.now() - t0) / 1000).toFixed(1)}s ` +
             `(nothing re-photographed)`);
    await ctx.close();
  }

  // ---- 4. Kotelo's phone: five complete drafts never queued ----
  {
    const { ctx, page } = await newFS(browser, apiPort);
    const b64 = await captureVisit(page, photo, 1);
    await page.evaluate(async (one) => {
      const src = window.form.photos[0].data_base64;
      for (let i = 0; i < 5; i++) {
        await idb.put('visits', {
          id: 'kotelo-' + i, site_id: 1, state: 'draft', readings: [],
          updated_at: new Date().toISOString(), submitted_at: new Date().toISOString(),
          gps: { lat: -29.5198, lon: 27.4227, accuracy_m: 12 }, ai_administered: false,
          issue: 'issue noted', photos: [{ id: 'kp' + i, mime: 'image/jpeg', data_base64: src }]
        });
      }
      await loadQueue();
      location.hash = '#/queue'; render();
    }, b64);
    await page.waitForSelector('#btnQueueAll');
    const label = await page.textContent('#btnQueueAll');
    await throttle(page, UPLINK_KBPS);
    seen.length = 0; attempts = 0; mode = 'ok';
    const t0 = Date.now();
    await page.click('#btnQueueAll');
    await page.waitForFunction(() => window.S.queue.filter(r => r.state === 'synced').length >= 5, null, { timeout: 180000 })
      .catch(async e => { console.error('  diag:', await state(page), 'server saw:', seen.length); throw e; });
    say(`4. five stranded drafts: "${label.trim()}" -> all 5 sent in ` +
             `${((Date.now() - t0) / 1000).toFixed(1)}s on the same weak uplink`);
    await ctx.close();
  }

  await browser.close();
  api.close();
})().catch(e => { console.error('FAIL: ' + e.message); process.exit(1); });
