/* The Aug-2026 rebuild renumbered every farmer. A Field Supervisor's phone is
   still holding visits that reference the OLD uuids, and the only thing on the
   phone that can translate an old uuid into a name is the boot cache — which
   signing in again destroys.

   These tests walk the exact sequence a real phone goes through on the morning
   after the rebuild, because getting the order wrong loses fieldwork silently:
   stamp the names at startup, survive the forced sign-out, then sync. */
const { test, expect, BOOT, SITE } = require('./support/app-fixture');

// what the phone cached before the rebuild
const OLD_FARMER = '98193853-13fa-4cf8-b63c-592f508d8df9';   // Bokang Khutlisi, old id
// what the rebuilt database issued for the same person
const NEW_FARMER = 'c1d2e3f4-0000-4000-8000-000000000001';
const NEW_BOOT = JSON.parse(JSON.stringify(BOOT));
NEW_BOOT.farmers = [{ id: NEW_FARMER, site_id: 1, name: 'Bokang Khutlisi', village: 'Thebesoa' }];

const QUEUED_VISIT = {
  id: 'aaaaaaaa-0000-4000-8000-00000000beef',
  site_id: SITE.id, state: 'queued', readings: [],
  farmer_id: OLD_FARMER,                 // points at a farmer the new DB never heard of
  ai_administered: true, issue: 'aphids on cabbage',
  gps: { lat: -29.5198, lon: 27.4227, accuracy_m: 12 },
  photos: [{ id: 'bbbbbbbb-0000-4000-8000-00000000cafe', mime: 'image/jpeg', data_base64: 'QUJD' }]
};

async function bootWith(page, boot) {
  await page.addInitScript(b => {
    localStorage.setItem('fsm_token', 'test-token');
    localStorage.setItem('fsm_boot', JSON.stringify(b));
    localStorage.setItem('fsm_me', JSON.stringify(b.supervisor));
  }, boot);
}

async function seedQueuedVisit(page, rec) {
  await page.evaluate(async r => {
    r.updated_at = new Date().toISOString();
    r.submitted_at = new Date().toISOString();
    await idb.put('visits', r);
  }, rec);
}

const storedVisit = page => page.evaluate(async id =>
  (await idb.all('visits')).find(r => r.id === id), QUEUED_VISIT.id);

test.describe('a phone carrying work from before the rebuild', () => {
  test('stamps the farmer name at startup, while the cache that resolves it still exists',
    async ({ page, submissions }) => {
      await bootWith(page, BOOT);              // pre-rebuild cache, old uuids
      await page.goto('/index.html#/queue');
      await seedQueuedVisit(page, QUEUED_VISIT);

      // the record as the phone has been holding it: an id, and no name
      expect((await storedVisit(page)).farmer_name).toBeUndefined();

      await page.reload();                     // next time the FS opens the app
      await page.waitForFunction(async id =>
        !!(await idb.all('visits')).find(r => r.id === id && r.farmer_name),
        QUEUED_VISIT.id, { timeout: 10000 });

      expect((await storedVisit(page)).farmer_name).toBe('Bokang Khutlisi');

      // the app also syncs automatically on startup, so the stamping has to win
      // that race — a visit that goes up before it is stamped is unmatchable
      await page.waitForFunction(() => window.S.queue.every(r => r.state === 'synced'),
        null, { timeout: 20000 });
      const auto = submissions.find(s => s.p_visit.id === QUEUED_VISIT.id);
      expect(auto).toBeTruthy();
      expect(auto.p_visit.farmer_name).toBe('Bokang Khutlisi');
    });

  test('keeps the name through the forced sign-out that wipes the cache',
    async ({ page }) => {
      await bootWith(page, BOOT);
      await page.goto('/index.html#/queue');
      await seedQueuedVisit(page, QUEUED_VISIT);
      await page.reload();
      await page.waitForFunction(async id =>
        !!(await idb.all('visits')).find(r => r.id === id && r.farmer_name),
        QUEUED_VISIT.id, { timeout: 10000 });

      // the old session is not in the rebuilt database, so the app signs them out
      await page.evaluate(() => doLogout(true));
      expect(await page.evaluate(() => localStorage.getItem('fsm_boot'))).toBeNull();

      // the visit — and the name it needs to be re-linked — are still on the phone
      const rec = await storedVisit(page);
      expect(rec.farmer_name).toBe('Bokang Khutlisi');
      expect(rec.photos).toHaveLength(1);
      expect(rec.state).toBe('queued');
    });

  test('sends the name with the visit so the server can re-link it',
    async ({ page, submissions }) => {
      await bootWith(page, BOOT);
      await page.goto('/index.html#/queue');
      await seedQueuedVisit(page, QUEUED_VISIT);
      await page.reload();
      await page.waitForFunction(async id =>
        !!(await idb.all('visits')).find(r => r.id === id && r.farmer_name),
        QUEUED_VISIT.id, { timeout: 10000 });

      // signed back in: the farmer list now carries the NEW uuids
      await page.evaluate(b => localStorage.setItem('fsm_boot', JSON.stringify(b)), NEW_BOOT);
      await page.reload();
      await page.waitForFunction(() => window.S.queue.length > 0);
      await page.evaluate(() => syncAll(true));
      await page.waitForFunction(
        () => window.S.queue.every(r => r.state === 'synced'), null, { timeout: 20000 });

      const sent = submissions.find(s => s.p_visit.id === QUEUED_VISIT.id);
      expect(sent).toBeTruthy();
      expect(sent.p_visit.farmer_name).toBe('Bokang Khutlisi');   // the re-link key
      expect(sent.p_visit.farmer_id).toBe(OLD_FARMER);            // server matches on the name
      expect(sent.p_visit.ai_administered).toBe(true);
      expect(sent.p_visit.issue).toBe('aphids on cabbage');
      expect(sent.p_photos).toHaveLength(1);
    });

  test('still shows who the visit was with, though the old id resolves to nobody',
    async ({ page }) => {
      await bootWith(page, BOOT);
      await page.goto('/index.html#/queue');
      await seedQueuedVisit(page, QUEUED_VISIT);
      await page.reload();
      await page.waitForFunction(async id =>
        !!(await idb.all('visits')).find(r => r.id === id && r.farmer_name),
        QUEUED_VISIT.id, { timeout: 10000 });

      await page.evaluate(b => localStorage.setItem('fsm_boot', JSON.stringify(b)), NEW_BOOT);
      await page.goto('/index.html#/queue');
      await page.waitForSelector('.queue-item');
      // without the fallback this row reads as a visit with no farmer at all
      await expect(page.locator('#view')).toContainText('Bokang Khutlisi');
    });
});
