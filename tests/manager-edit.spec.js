/* v10: managers correct synced data from inside the app — no SQL. These tests
   drive the dashboard as a manager: open a synced visit, correct it, and
   change a team member's role; each asserts the exact RPC payload that would
   reach the server (the server re-checks the manager role either way). */
const { test, expect, BOOT } = require('./support/app-fixture');

const FARMER_BOKANG = '98193853-13fa-4cf8-b63c-592f508d8df9';
const FARMER_KABELO = '0c3c0cc3-a26a-4365-9e59-6d3a75241918';
const VISIT_ID = 'cccccccc-0000-4000-8000-000000000001';
const VIEWER_ID = 'dddddddd-0000-4000-8000-000000000002';

const MGR_BOOT = JSON.parse(JSON.stringify(BOOT));
MGR_BOOT.supervisor = {
  id: '00000000-0000-0000-0000-0000000000bb', name: 'Mantsatsi Test',
  phone: null, role: 'manager', username: 'mantsatsi', assigned_site_ids: []
};

const PROG = {
  totals: { visits: 1, farmers: 2, farmers_engaged: 1, ai_visits: 0, issues: 0,
            farms_complete: 0, readings: 0, samples: 0 },
  targets: { validation_farms: 12 },
  supervisors: [], sites: []
};
const ACT = {
  visits: [{
    id: VISIT_ID, supervisor: 'Test FS', site: 'Mahuu',
    synced_at: new Date().toISOString(), farmer: 'Bokang Khutlisi',
    ai_administered: false, readings_count: 0, photos: 1, gps_lat: -29.5198
  }],
  team: [
    MGR_BOOT.supervisor,
    { id: VIEWER_ID, name: 'Viewer Test', role: 'viewer', username: 'viewertest', active: true }
  ]
};
const DETAIL = {
  visit: {
    id: VISIT_ID, supervisor: 'Test FS', site: 'Mahuu', rc: 'Rothe',
    site_id: 1, farmer_id: FARMER_BOKANG, farm_id: null, farmer: 'Bokang Khutlisi',
    ai_administered: false, issue: null, notes: null,
    synced_at: new Date().toISOString(), submitted_at: new Date().toISOString(),
    gps_lat: -29.5198, gps_lon: 27.4227, gps_accuracy_m: 12,
    distance_from_site_m: 40, sample_collected: false, sample_id: null
  },
  readings: [], photos: [], edits: []
};

async function managerDash(page, rpcLog) {
  await page.route('**/rest/v1/rpc/**', async route => {
    const fn = route.request().url().split('/rpc/')[1].split('?')[0];
    let body = {};
    if (fn === 'fs_bootstrap') body = MGR_BOOT;
    else if (fn === 'fs_progress') body = PROG;
    else if (fn === 'fs_activity') body = ACT;
    else if (fn === 'fs_visit_detail') body = DETAIL;
    else if (fn === 'fs_update_visit' || fn === 'fs_set_supervisor') {
      rpcLog.push({ fn, payload: route.request().postDataJSON() });
      body = { ok: true, changed: true };
    }
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
  });
  await page.route(/^https:\/\/(fonts|.*tile)\./, route => route.abort());
  await page.addInitScript(b => {
    localStorage.setItem('fsm_token', 'test-token');
    localStorage.setItem('fsm_boot', JSON.stringify(b));
    localStorage.setItem('fsm_me', JSON.stringify(b.supervisor));
  }, MGR_BOOT);
  await page.goto('/index.html#/home');
  await page.waitForSelector('#dashBody .act-row[data-visit]');
}

test.describe('manager data corrections (v10)', () => {
  test('corrects a synced visit and sends only what the server may change',
    async ({ page }) => {
      const calls = [];
      await managerDash(page, calls);

      await page.click('.act-row[data-visit="' + VISIT_ID + '"]');
      await page.click('#btnEditVisit');

      // wrong farmer attached and the advisory answer was mis-recorded
      await page.selectOption('#eAi', 'true');
      await page.selectOption('#eFarmer', FARMER_KABELO);
      await page.fill('#eIssue', 'aphids on cabbage');
      await page.fill('#editReadings input[data-param="ph"][data-rep="1"]', '6.4');
      await page.click('#btnSaveEdit');

      await expect.poll(() => calls.length).toBe(1);
      expect(calls[0].fn).toBe('fs_update_visit');
      const p = calls[0].payload;
      expect(p.p_visit_id).toBe(VISIT_ID);
      expect(p.p_patch.ai_administered).toBe(true);
      expect(p.p_patch.farmer_id).toBe(FARMER_KABELO);
      expect(p.p_patch.issue).toBe('aphids on cabbage');
      expect(p.p_readings).toEqual([{ parameter: 'ph', replicate: 1, value: 6.4, unit: '' }]);
      // immutable evidence never travels in the patch
      expect(p.p_patch.gps_lat).toBeUndefined();
      expect(Object.keys(p.p_patch)).not.toContain('site_id');
    });

  test('shows the correction history on the visit, so edits are never silent',
    async ({ page }) => {
      DETAIL.edits = [{
        by: 'Mantsatsi Test', at: new Date().toISOString(),
        changes: { ai_administered: { from: false, to: true } }
      }];
      const calls = [];
      await managerDash(page, calls);
      await page.click('.act-row[data-visit="' + VISIT_ID + '"]');
      await expect(page.locator('#modalBody')).toContainText('Corrected by Mantsatsi Test');
      DETAIL.edits = [];
    });

  test('changes a team member role from the Dashboard', async ({ page }) => {
    const calls = [];
    await managerDash(page, calls);
    page.on('dialog', d => d.accept(d.type() === 'prompt' ? 'manager' : undefined));

    await page.click('[data-role="' + VIEWER_ID + '"]');
    await expect.poll(() => calls.length).toBe(1);
    expect(calls[0].fn).toBe('fs_set_supervisor');
    expect(calls[0].payload.p_id).toBe(VIEWER_ID);
    expect(calls[0].payload.p_role).toBe('manager');
  });

  test('offers no Role button on the manager\'s own row', async ({ page }) => {
    await managerDash(page, []);
    await expect(page.locator('[data-role="' + MGR_BOOT.supervisor.id + '"]')).toHaveCount(0);
    await expect(page.locator('[data-role="' + VIEWER_ID + '"]')).toHaveCount(1);
  });
});
