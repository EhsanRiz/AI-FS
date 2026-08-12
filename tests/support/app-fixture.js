/* Shared setup: signs a Field Supervisor in, stubs every Supabase RPC, and
   hands back a page sitting on the visit form. Nothing here talks to the real
   project — the tests must never write to 4D-roster. */
const base = require('@playwright/test');

const SITE = {
  id: 1, rc: 'Rothe', lat: -29.519759, lon: 27.422734, zone: 'Lowlands',
  farmers: 19, district: 'Maseru', sub_area: 'Mahuu', is_validation_site: false
};

const BOOT = {
  supervisor: {
    id: '00000000-0000-0000-0000-0000000000aa', name: 'Test FS', phone: null,
    role: 'supervisor', username: 'testfs', assigned_site_ids: [SITE.id]
  },
  sites: [SITE],
  farms: [],
  farmers: [
    { id: '98193853-13fa-4cf8-b63c-592f508d8df9', site_id: 1, name: 'Bokang Khutlisi', village: 'Thebesoa' },
    { id: '0c3c0cc3-a26a-4365-9e59-6d3a75241918', site_id: 1, name: 'Kabelo Motseki', village: 'Thebesoa' }
  ],
  progress: { sites: [] },
  activity: []
};

const test = base.test.extend({
  // every RPC the app can reach, answered locally; `submissions` collects the
  // fs_submit_visit payloads so a test can assert what would reach the server
  submissions: async ({ page }, use) => {
    const submissions = [];
    await page.route('**/rest/v1/rpc/**', async route => {
      const fn = route.request().url().split('/rpc/')[1].split('?')[0];
      let body = {};
      if (fn === 'fs_bootstrap') {
        body = BOOT;
      } else if (fn === 'fs_submit_visit') {
        submissions.push(route.request().postDataJSON());
        body = { ok: true, visit_id: 'stub', distance_from_site_m: 12 };
      } else {
        body = { sites: [] };
      }
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
    });
    // keep the run hermetic: no webfonts, no map tiles
    await page.route(/^https:\/\/(fonts|.*tile)\./, route => route.abort());
    await use(submissions);
  },

  // a camera-sized JPEG (~4 MP), built once per worker
  photo: [async ({ browser }, use) => {
    const page = await browser.newPage();
    const b64 = await page.evaluate(() => {
      const c = document.createElement('canvas');
      c.width = 2400; c.height = 1800;
      const g = c.getContext('2d');
      for (let i = 0; i < 400; i++) {
        g.fillStyle = `hsl(${(i * 37) % 360} 70% ${30 + (i % 50)}%)`;
        g.fillRect((i * 97) % 2400, (i * 53) % 1800, 180, 140);
      }
      return c.toDataURL('image/jpeg', 0.95).split(',')[1];
    });
    await page.close();
    await use({ name: 'field.jpg', mimeType: 'image/jpeg', buffer: Buffer.from(b64, 'base64') });
  }, { scope: 'worker' }],

  // a signed-in supervisor on a blank visit form
  visitForm: async ({ page, submissions }, use) => {
    await page.addInitScript(boot => {
      localStorage.setItem('fsm_token', 'test-token');
      localStorage.setItem('fsm_boot', JSON.stringify(boot));
      localStorage.setItem('fsm_me', JSON.stringify(boot.supervisor));
    }, BOOT);
    await page.goto('/index.html#/visit');
    await page.waitForSelector('#photoStrip');
    await use(page);
  }
});

// fill in everything a visit needs except the photo
async function completeVisitExceptPhoto(page) {
  await page.click('#btnGps');
  await page.waitForFunction(() => !!window.form.gps);
  await page.click('[data-ai="1"]');
  await page.fill('#fNotes', 'maize looking good');
}

module.exports = { test, expect: base.expect, BOOT, SITE, completeVisitExceptPhoto };
