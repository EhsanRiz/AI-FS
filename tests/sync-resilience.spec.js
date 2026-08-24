/* Sync has to survive a rural LTE link: photos small enough to finish
   uploading, dropped connections retried, GPS that does not dead-end, and
   nothing stranded on the phone. Every assertion here traces to a Field
   Supervisor report during UAT. */
const { test, expect, completeVisitExceptPhoto } = require('./support/app-fixture');

const SYNCED = () => window.S.queue.every(r => r.state === 'synced');

async function attachPhoto(page, photo) {
  await page.setInputFiles('#fPhoto', photo);
  await page.waitForFunction(() => window.form.photos.length === 1);
}

test.describe('photo upload budget', () => {
  test('a camera photo is squeezed to the upload budget, not just under the ceiling', async ({ visitForm: page, photo }) => {
    await attachPhoto(page, photo);
    const { size, budget } = await page.evaluate(() => ({
      size: window.form.photos[0].data_base64.length,
      budget: window.PHOTO_TARGET_B64
    }));
    // the old build shipped ~1.4 MB per photo, which is what kept timing out
    expect(size).toBeLessThanOrEqual(budget);
    expect(size).toBeGreaterThan(20000); // still a real photo, not a blank frame
  });

  test('a visit captured before the budget is shrunk in place rather than re-photographed', async ({ visitForm: page }) => {
    const result = await page.evaluate(async () => {
      // an oversized photo, as the pre-budget build would have stored it —
      // fine-grained noise so JPEG cannot flatter it, like real foliage
      const c = document.createElement('canvas');
      c.width = 3200; c.height = 2400;
      const g = c.getContext('2d');
      const img = g.createImageData(c.width, c.height);
      let seed = 7;
      for (let i = 0; i < img.data.length; i += 4) {
        seed = (seed * 1103515245 + 12345) & 0x7fffffff;
        img.data[i] = 40 + (seed >> 16) % 180;
        img.data[i + 1] = 60 + (seed >> 9) % 170;
        img.data[i + 2] = 20 + (seed >> 3) % 120;
        img.data[i + 3] = 255;
      }
      g.putImageData(img, 0, 0);
      const big = c.toDataURL('image/jpeg', 0.99).split(',')[1];
      const rec = {
        id: 'legacy-1', site_id: 1, state: 'failed', readings: [],
        updated_at: new Date().toISOString(),
        photos: [{ id: 'p1', mime: 'image/jpeg', data_base64: big }]
      };
      await idb.put('visits', rec);
      const out = await shrinkStoredPhotos(rec);
      const stored = (await idb.all('visits')).find(r => r.id === 'legacy-1');
      return { before: big.length, after: out.photos[0].data_base64.length,
               persisted: stored.photos[0].data_base64.length, budget: window.PHOTO_TARGET_B64 };
    });
    expect(result.before).toBeGreaterThan(result.budget * 1.4);
    expect(result.after).toBeLessThanOrEqual(result.budget);
    expect(result.persisted).toBe(result.after); // the shrink is saved, not redone every retry
  });
});

test.describe('a dropped connection', () => {
  test('is retried until it goes through', async ({ visitForm: page, photo }) => {
    let attempts = 0;
    await page.route('**/rest/v1/rpc/fs_submit_visit', async route => {
      attempts++;
      if (attempts <= 2) return route.abort('connectionfailed');
      return route.fulfill({
        status: 200, contentType: 'application/json',
        body: JSON.stringify({ ok: true, visit_id: 'stub', distance_from_site_m: 12 })
      });
    });

    await completeVisitExceptPhoto(page);
    await attachPhoto(page, photo);
    await page.click('#btnSave');
    await page.waitForFunction(SYNCED, null, { timeout: 30000 });

    expect(attempts).toBe(3); // two failures absorbed, no FS involvement
  });

  test('reports something a Field Supervisor can act on, never "Failed to fetch"', async ({ visitForm: page, photo }) => {
    await page.route('**/rest/v1/rpc/fs_submit_visit', route => route.abort('connectionfailed'));

    await completeVisitExceptPhoto(page);
    await attachPhoto(page, photo);
    await page.click('#btnSave');
    await page.waitForFunction(
      () => window.S.queue.some(r => r.state === 'failed'), null, { timeout: 30000 });

    const shown = await page.textContent('#view');
    expect(shown).toContain('Connection lost while sending');
    expect(shown).not.toContain('Failed to fetch');
    // the visit is still on the phone, ready for the next attempt
    expect(await page.evaluate(() => window.S.queue[0].photos.length)).toBe(1);
  });
});

test.describe('GPS', () => {
  test('falls back to network location instead of blocking the visit', async ({ visitForm: page }) => {
    const calls = await page.evaluate(async () => {
      const seen = [];
      navigator.geolocation.getCurrentPosition = (ok, fail, opts) => {
        seen.push(opts.enableHighAccuracy);
        if (opts.enableHighAccuracy) return fail({ code: 2 }); // no satellite fix
        ok({ coords: { latitude: -29.5198, longitude: 27.4227, accuracy: 900 } });
      };
      document.getElementById('btnGps').click();
      await new Promise(r => setTimeout(r, 300));
      return { seen, gps: !!window.form.gps };
    });
    expect(calls.seen).toEqual([true, false]); // tried precise, then fell back
    expect(calls.gps).toBe(true);
  });

  test('a denied permission says how to fix it and does not retry pointlessly', async ({ visitForm: page }) => {
    const out = await page.evaluate(async () => {
      let n = 0;
      navigator.geolocation.getCurrentPosition = (ok, fail) => { n++; fail({ code: 1 }); };
      document.getElementById('btnGps').click();
      await new Promise(r => setTimeout(r, 300));
      return { n, text: document.getElementById('gpsStatus').textContent };
    });
    expect(out.n).toBe(1);
    expect(out.text).toContain('permission denied');
    expect(out.text).toContain('browser settings');
  });
});

test.describe('drafts stranded on the phone', () => {
  test('a completed draft can be sent in one tap', async ({ visitForm: page, photo }) => {
    await completeVisitExceptPhoto(page);
    await attachPhoto(page, photo);
    await page.click('#btnDraft');                       // saved, but never queued
    await page.waitForSelector('.queue-item');

    const queueAll = page.locator('#btnQueueAll');
    await expect(queueAll).toContainText('Queue all 1 completed draft');
    await queueAll.click();
    await page.waitForFunction(SYNCED, null, { timeout: 30000 });
  });

  test('an incomplete draft is not offered, so nothing half-finished is sent', async ({ visitForm: page, photo }) => {
    await attachPhoto(page, photo);                      // no GPS, no advisory answer
    await page.click('#btnDraft');
    await page.waitForSelector('.queue-item');
    await expect(page.locator('#btnQueueAll')).toHaveCount(0);
  });
});
