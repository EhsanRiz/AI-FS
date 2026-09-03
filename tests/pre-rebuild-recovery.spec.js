/* The database the app used until 24 Aug 2026 was lost. Visits that had already
   reached it are marked 'synced' on the phone, and sync only sends 'queued' and
   'failed' — so that fieldwork exists nowhere else and would never be sent
   again. These tests pin the one-time recovery: what gets re-queued, what is
   deliberately left alone, and that it cannot run twice or duplicate anything. */
const { test, expect, BOOT, SITE } = require('./support/app-fixture');

const REBUILD_AT = '2026-08-24T21:04:00.000Z';
const BEFORE = '2026-08-20T09:00:00.000Z';   // synced to the database that was lost
const AFTER  = '2026-08-26T09:00:00.000Z';   // synced to the rebuilt one

const PHOTO = [{ id: 'ffffffff-0000-4000-8000-00000000f001', mime: 'image/jpeg', data_base64: 'QUJD' }];
const GPS = { lat: -29.5198, lon: 27.4227, accuracy_m: 12 };

function visit(id, over) {
  return Object.assign({
    id, site_id: SITE.id, state: 'synced', readings: [], photos: PHOTO,
    gps: GPS, ai_administered: true, farmer_id: BOOT.farmers[0].id,
    farmer_name: 'Bokang Khutlisi',
    updated_at: BEFORE, submitted_at: BEFORE, synced_at: BEFORE
  }, over || {});
}

async function seed(page, records, regs) {
  await page.evaluate(async ([recs, rgs]) => {
    for (const r of recs) await idb.put('visits', r);
    for (const r of rgs) await idb.put('farmers', r);
  }, [records, regs || []]);
}

async function signedIn(page) {
  await page.addInitScript(b => {
    localStorage.setItem('fsm_token', 'test-token');
    localStorage.setItem('fsm_boot', JSON.stringify(b));
    localStorage.setItem('fsm_me', JSON.stringify(b.supervisor));
  }, BOOT);
  await page.goto('/index.html#/queue');
}

const stateOf = (page, id) => page.evaluate(async i =>
  ((await idb.all('visits')).find(r => r.id === i) || {}).state, id);

test.describe('fieldwork that reached the database before it was lost', () => {
  test('is re-queued and sent again', async ({ page, submissions }) => {
    await signedIn(page);
    await seed(page, [visit('aaaaaaaa-0000-4000-8000-000000000001')]);
    await page.reload();

    await page.waitForFunction(
      () => window.S.queue.every(r => r.state === 'synced') && window.S.queue.length > 0,
      null, { timeout: 20000 });

    const sent = submissions.find(s => s.p_visit.id === 'aaaaaaaa-0000-4000-8000-000000000001');
    expect(sent).toBeTruthy();
    expect(sent.p_visit.submitted_at).toBe(BEFORE);   // the original date is preserved
    expect(sent.p_visit.farmer_name).toBe('Bokang Khutlisi');
    expect(sent.p_photos).toHaveLength(1);
  });

  test('is left alone if it synced after the rebuild', async ({ page, submissions }) => {
    await signedIn(page);
    await seed(page, [visit('aaaaaaaa-0000-4000-8000-000000000002', { synced_at: AFTER })]);
    await page.reload();
    await page.waitForFunction(() => window.S.queue.length > 0);
    await page.waitForTimeout(1500);

    expect(submissions).toEqual([]);                 // already on the server
    expect(await stateOf(page, 'aaaaaaaa-0000-4000-8000-000000000002')).toBe('synced');
  });

  test('is not re-sent if it could never pass validation', async ({ page, submissions }) => {
    await signedIn(page);
    await seed(page, [
      visit('aaaaaaaa-0000-4000-8000-000000000003', { photos: [] }),        // no photo
      visit('aaaaaaaa-0000-4000-8000-000000000004', { gps: null }),         // no GPS
      visit('aaaaaaaa-0000-4000-8000-000000000005', { ai_administered: null })
    ]);
    await page.reload();
    await page.waitForFunction(() => window.S.queue.length === 3);
    await page.waitForTimeout(1500);

    // the server would refuse all three; re-queuing them would only leave the
    // Field Supervisor staring at permanent red failures
    expect(submissions).toEqual([]);
    for (const n of ['3', '4', '5']) {
      expect(await stateOf(page, 'aaaaaaaa-0000-4000-8000-00000000000' + n)).toBe('synced');
    }
  });

  test('runs once, not on every app open', async ({ page, submissions }) => {
    await signedIn(page);
    await seed(page, [visit('aaaaaaaa-0000-4000-8000-000000000006')]);
    await page.reload();
    await page.waitForFunction(
      () => window.S.queue.every(r => r.state === 'synced') && window.S.queue.length > 0,
      null, { timeout: 20000 });
    expect(submissions).toHaveLength(1);

    // the re-send stamped a post-rebuild synced_at, so the record no longer
    // looks stale and a later open must not pick it up again
    const stamped = await page.evaluate(async () =>
      (await idb.all('visits'))[0].synced_at);
    expect(stamped > '2026-08-24T21:04:00.000Z').toBe(true);
    await page.reload();
    await page.waitForFunction(() => window.S.queue.length > 0);
    await page.waitForTimeout(1500);
    expect(submissions).toHaveLength(1);
  });

  test('brings back farmers the Field Supervisor registered, before the visits that need them',
    async ({ page, submissions }) => {
      const reg = { id: 'dddddddd-0000-4000-8000-000000000001', site_id: SITE.id,
                    name: 'Palesa Mokoena', village: 'Thebesoa', state: 'synced' };
      await signedIn(page);
      await seed(page, [visit('aaaaaaaa-0000-4000-8000-000000000007', { farmer_id: reg.id })], [reg]);

      const order = [];
      await page.route('**/rest/v1/rpc/fs_register_farmer', async route => {
        order.push('farmer');
        await route.fulfill({ status: 200, contentType: 'application/json',
                              body: JSON.stringify({ ok: true, id: reg.id }) });
      });
      await page.reload();
      await page.waitForFunction(
        () => window.S.queue.every(r => r.state === 'synced') && window.S.queue.length > 0,
        null, { timeout: 20000 });

      expect(order).toContain('farmer');
      const sent = submissions.find(s => s.p_visit.id === 'aaaaaaaa-0000-4000-8000-000000000007');
      expect(sent).toBeTruthy();
      expect(sent.p_visit.farmer_id).toBe(reg.id);
    });
});
