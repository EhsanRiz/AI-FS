/* Mantsatsi asked to correct one detail at a time — a pencil on the line she
   wants, not the whole visit re-presented as a form — and to reach edit and
   delete by swiping a row. These tests pin both, and that a patch carries only
   the field she touched, so a correction can never blank the rest of a visit. */
const { test, expect, BOOT, SITE } = require('./support/app-fixture');

const VISIT_ID = 'eeeeeeee-0000-4000-8000-000000000001';
const MANAGER = Object.assign({}, BOOT.supervisor, { role: 'manager', name: 'Mantsatsi' });

const DETAIL = {
  visit: {
    id: VISIT_ID, supervisor: 'Mathloliso Mabitle', site: 'Morija', rc: 'Morija',
    site_id: SITE.id, farmer: null, farmer_id: null,
    ai_administered: false, issue: null, notes: null,
    sample_collected: false, sample_id: null,
    submitted_at: '2026-08-25T10:17:00.000Z', synced_at: '2026-08-25T10:20:00.000Z',
    gps_lat: -29.35967, gps_lon: 27.56554, gps_accuracy_m: 600, distance_from_site_m: 29900
  },
  readings: [], photos: [], edits: []
};

const ACTIVITY = {
  visits: [{ id: VISIT_ID, supervisor: 'Mathloliso Mabitle', site: 'Morija', rc: 'Morija',
             district: 'Maseru', farmer: null, ai_administered: false,
             synced_at: '2026-08-25T10:20:00.000Z', gps_lat: -29.35967, gps_lon: 27.56554,
             distance_from_site_m: 29900, gps_flag: true, photos: 1, readings_count: 0 }],
  team: []
};

async function asManager(page, patches) {
  await page.route('**/rest/v1/rpc/**', async route => {
    const fn = route.request().url().split('/rpc/')[1].split('?')[0];
    let body = {};
    if (fn === 'fs_bootstrap') body = Object.assign({}, BOOT, { supervisor: MANAGER });
    else if (fn === 'fs_visit_detail') body = DETAIL;
    else if (fn === 'fs_activity') body = ACTIVITY;
    else if (fn === 'fs_update_visit') {
      patches.push(route.request().postDataJSON());
      body = { ok: true, changed: true };
    } else if (fn === 'fs_delete_visit') {
      patches.push(route.request().postDataJSON());
      body = { ok: true };
    } else body = { sites: [], totals: {}, supervisors: [] };
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
  });
  await page.route(/^https:\/\/(fonts|.*tile)\./, r => r.abort());
  await page.addInitScript(b => {
    localStorage.setItem('fsm_token', 'test-token');
    localStorage.setItem('fsm_boot', JSON.stringify(b));
    localStorage.setItem('fsm_me', JSON.stringify(b.supervisor));
  }, Object.assign({}, BOOT, { supervisor: MANAGER }));
  await page.goto('/index.html#/home');
  await page.waitForFunction(() => !!window.S && !!window.S.me);
}

async function openDetail(page) {
  await page.evaluate(id => visitDetailModal(id), VISIT_ID);
  await page.waitForSelector('[data-fieldrow="issue"]');
}

test.describe('correcting one detail at a time', () => {
  test('every changeable line has its own pencil, and the evidence lines have none',
    async ({ page }) => {
      const patches = [];
      await asManager(page, patches);
      await openDetail(page);

      for (const f of ['farmer_id', 'ai_administered', 'issue', 'sample', 'notes']) {
        await expect(page.locator('[data-fieldrow="' + f + '"] .row-edit')).toHaveCount(1);
      }
      // GPS, time, supervisor and site are what prove the visit happened
      expect(await page.locator('[data-fieldrow=""] .row-edit').count()).toBe(0);
    });

  test('the pencil opens that line only — not a form of the whole visit', async ({ page }) => {
    const patches = [];
    await asManager(page, patches);
    await openDetail(page);
    await page.click('[data-fieldrow="issue"] .row-edit');

    await expect(page.locator('[data-fieldrow="issue"] .row-editor')).toHaveCount(1);
    // the other lines are untouched and still readable
    await expect(page.locator('.row-editor')).toHaveCount(1);
    await expect(page.locator('[data-fieldrow="ai_administered"] .row-val')).toBeVisible();
  });

  test('saving sends only the field that was changed', async ({ page }) => {
    const patches = [];
    await asManager(page, patches);
    await openDetail(page);
    await page.click('[data-fieldrow="issue"] .row-edit');
    await page.fill('#rfInput', 'wrong farmer recorded');
    await page.click('#rfSave');
    await page.waitForFunction(() => window.__patched === undefined);   // let the call settle
    await expect.poll(() => patches.length).toBeGreaterThan(0);

    const p = patches[0];
    expect(p.p_visit_id).toBe(VISIT_ID);
    expect(p.p_patch).toEqual({ issue: 'wrong farmer recorded' });      // nothing else
    expect(p.p_readings).toBeUndefined();                               // readings left alone
  });

  test('the advisory line edits as a choice, not free text', async ({ page }) => {
    const patches = [];
    await asManager(page, patches);
    await openDetail(page);
    await page.click('[data-fieldrow="ai_administered"] .row-edit');
    await expect(page.locator('select#rfInput')).toHaveCount(1);
    await page.selectOption('#rfInput', 'true');
    await page.click('#rfSave');
    await expect.poll(() => patches.length).toBeGreaterThan(0);
    expect(patches[0].p_patch).toEqual({ ai_administered: true });
  });

  test('cancel puts the line back and sends nothing', async ({ page }) => {
    const patches = [];
    await asManager(page, patches);
    await openDetail(page);
    await page.click('[data-fieldrow="issue"] .row-edit');
    await page.click('#rfCancel');
    await expect(page.locator('.row-editor')).toHaveCount(0);
    await expect(page.locator('[data-fieldrow="issue"] .row-edit')).toHaveCount(1);
    expect(patches).toEqual([]);
  });
});

test.describe('swiping a visit row', () => {
  test('a Field Supervisor gets no edit or delete actions', async ({ page }) => {
    const patches = [];
    await page.route('**/rest/v1/rpc/**', route => route.fulfill({
      status: 200, contentType: 'application/json', body: JSON.stringify(ACTIVITY) }));
    await page.addInitScript(b => {
      localStorage.setItem('fsm_token', 'test-token');
      localStorage.setItem('fsm_boot', JSON.stringify(b));
      localStorage.setItem('fsm_me', JSON.stringify(b.supervisor));
    }, BOOT);                                    // role: supervisor
    await page.goto('/index.html#/home');
    await page.waitForFunction(() => !!window.S && !!window.S.me);
    const html = await page.evaluate(v => actRowHTML(v), ACTIVITY.visits[0]);
    expect(html).not.toContain('swipe-btn');
    expect(html).not.toContain('data-swipedel');
  });

  test('a manager gets Edit and Delete behind the row', async ({ page }) => {
    const patches = [];
    await asManager(page, patches);
    const html = await page.evaluate(v => actRowHTML(v), ACTIVITY.visits[0]);
    expect(html).toContain('data-swipeedit="' + VISIT_ID + '"');
    expect(html).toContain('data-swipedel="' + VISIT_ID + '"');
    expect(html).toContain('swipeable');
  });

  test('Delete asks first, and says the visit is archived rather than destroyed',
    async ({ page }) => {
      const patches = [];
      await asManager(page, patches);
      await page.evaluate(v => {
        document.body.insertAdjacentHTML('beforeend', actRowHTML(v));
      }, ACTIVITY.visits[0]);

      // the actions sit behind the row until it is swiped, so reveal them first
      await page.evaluate(() => document.querySelector('.act-row.swipeable').classList.add('swiped'));

      let asked = '';
      page.on('dialog', d => { asked = d.message(); d.dismiss(); });
      await page.click('[data-swipedel]');
      await expect.poll(() => asked).toContain('archived');
      expect(patches).toEqual([]);               // dismissed: nothing sent

      page.removeAllListeners('dialog');
      page.on('dialog', d => d.accept());
      await page.click('[data-swipedel]');
      await expect.poll(() => patches.length).toBeGreaterThan(0);
      expect(patches[0].p_visit_id).toBe(VISIT_ID);
    });

  test('a left drag opens the actions; a vertical drag scrolls instead', async ({ page }) => {
    const patches = [];
    await asManager(page, patches);
    await page.evaluate(v => {
      document.body.insertAdjacentHTML('beforeend', actRowHTML(v));
    }, ACTIVITY.visits[0]);

    const drag = (dx, dy) => page.evaluate(([dx, dy]) => {
      const row = document.querySelector('.act-row.swipeable');
      row.classList.remove('swiped');
      const box = row.getBoundingClientRect();
      const x = box.left + box.width - 20, y = box.top + box.height / 2;
      const touch = (cx, cy) =>
        [new Touch({ identifier: 1, target: row, clientX: cx, clientY: cy })];
      row.dispatchEvent(new TouchEvent('touchstart', { bubbles: true, touches: touch(x, y) }));
      row.dispatchEvent(new TouchEvent('touchmove', { bubbles: true, touches: touch(x + dx, y + dy) }));
      row.dispatchEvent(new TouchEvent('touchend', { bubbles: true, touches: [] }));
      return row.classList.contains('swiped');
    }, [dx, dy]);

    expect(await drag(-80, 0)).toBe(true);     // a clear left swipe opens it
    expect(await drag(0, -80)).toBe(false);    // scrolling the list must not
    expect(await drag(-10, 0)).toBe(false);    // a nudge is not a swipe
  });
});
