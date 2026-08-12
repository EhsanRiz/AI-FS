/* Photo capture on the visit form.

   This is the path that has broken twice in UAT (v13 and again in v16) and it
   blocks everything: a visit cannot sync without a photo, so a dead photo
   button stops the field team recording anything at all. Each test below
   pins one of the specific ways it has failed on real Android phones. */
const { test, expect, completeVisitExceptPhoto } = require('./support/app-fixture');

test.describe('adding a photo to a visit', () => {

  test('one tap opens the picker exactly once', async ({ visitForm: page }) => {
    // v16 regression: #btnAddPhoto is a <label for>, so the OS activates the
    // input itself. A JS input.click() on the same tap made it fire twice, and
    // the second camera intent cancelled the first — the photo never came back.
    await page.evaluate(() => {
      window.__activations = 0;
      document.querySelector('#fPhoto')
        .addEventListener('click', () => { window.__activations++; }, true);
    });

    await page.click('#btnAddPhoto');

    expect(await page.evaluate(() => window.__activations)).toBe(1);
  });

  test('the input is a plain picker, with no forced camera intent', async ({ visitForm: page }) => {
    // capture="environment" is broken on several Android builds — it was
    // removed in v13 after a tester reported a dead button, and putting it
    // back in v16 broke capture again. The phone's own chooser offers Camera
    // first and still leaves a gallery path when a device's camera misbehaves.
    await expect(page.locator('#fPhoto')).toHaveAttribute('accept', 'image/*');
    // asserted across every file input on the form, not just #fPhoto: v16
    // added a *second*, capture-carrying input, which a check pinned to one
    // id would have sailed straight past
    const capture = await page.$$eval('input[type=file]',
      els => els.map(el => el.getAttribute('capture')));
    expect(capture).toEqual([null]);
  });

  test('a camera photo attaches, downscales and satisfies the requirement',
    async ({ visitForm: page, photo }) => {
      await expect(page.locator('.photo-thumb')).toHaveCount(0);

      await page.setInputFiles('#fPhoto', photo);
      await expect(page.locator('.photo-thumb')).toHaveCount(1);

      const b64 = await page.evaluate(() => window.form.photos[0].data_base64.length);
      expect(b64).toBeGreaterThan(1000);
      expect(b64).toBeLessThanOrEqual(5600000);   // fs_submit_visit's ceiling

      await expect(page.locator('.req-row.ok')).toContainText(['At least one photo added']);
    });

  test('photos can be added up to the cap and removed again',
    async ({ visitForm: page, photo }) => {
      for (let i = 0; i < 3; i++) {
        await page.setInputFiles('#fPhoto', photo);
        await expect(page.locator('.photo-thumb')).toHaveCount(i + 1);
      }
      // at the cap the add button goes away
      await expect(page.locator('#btnAddPhoto')).toHaveCount(0);

      await page.click('[data-rmphoto="0"]');
      await expect(page.locator('.photo-thumb')).toHaveCount(2);
      await expect(page.locator('#btnAddPhoto')).toHaveCount(1);
    });

  test('a file the phone cannot decode says why', async ({ visitForm: page }) => {
    await page.setInputFiles('#fPhoto', {
      name: 'broken.jpg', mimeType: 'image/jpeg', buffer: Buffer.from('not an image at all')
    });
    // a silent failure here is what sends testers to WhatsApp instead of to us
    await expect(page.locator('#toast')).toContainText('Could not add that photo — ');
    await expect(page.locator('.photo-thumb')).toHaveCount(0);
  });
});

test.describe('surviving an interrupted capture', () => {

  test('the visit is kept and resumed when the phone reclaims the page',
    async ({ visitForm: page, photo }) => {
      // Opening the camera can background the browser long enough for a
      // low-memory Android phone to discard the page. The form lives in memory
      // until Save, so this used to lose the whole visit.
      await page.setInputFiles('#fPhoto', photo);
      await expect(page.locator('.photo-thumb')).toHaveCount(1);
      await completeVisitExceptPhoto(page);

      await page.evaluate(() => {
        Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
        document.dispatchEvent(new Event('visibilitychange'));
      });
      await page.reload();                        // the page was discarded
      await page.waitForSelector('#photoStrip');

      const restored = await page.evaluate(() => ({
        photos: window.form.photos.length,
        notes: window.form.notes,
        gps: !!window.form.gps,
        advisory: window.form.ai_administered
      }));
      expect(restored).toEqual({ photos: 1, notes: 'maize looking good', gps: true, advisory: true });
      await expect(page.locator('#btnSave')).toBeEnabled();
    });

  test('an explicit save is not re-offered as an unfinished visit',
    async ({ visitForm: page, photo }) => {
      await page.setInputFiles('#fPhoto', photo);
      await completeVisitExceptPhoto(page);
      await page.click('#btnSave');
      await page.waitForURL(/#\/queue/);

      await page.goto('/index.html#/visit');
      await page.waitForSelector('#photoStrip');
      // a fresh, empty form — not the visit that was just submitted
      await expect(page.locator('.photo-thumb')).toHaveCount(0);
      expect(await page.evaluate(() => window.form.notes)).toBe('');
    });
});

test.describe('what reaches the server', () => {

  test('a visit cannot be queued without a photo', async ({ visitForm: page }) => {
    await completeVisitExceptPhoto(page);
    await expect(page.locator('#btnSave')).toBeDisabled();
  });

  test('the photo is carried through to fs_submit_visit',
    async ({ visitForm: page, photo, submissions }) => {
      await page.setInputFiles('#fPhoto', photo);
      await completeVisitExceptPhoto(page);
      await page.click('#btnSave');

      await expect.poll(() => submissions.length).toBe(1);
      const sent = submissions[0];
      expect(sent.p_photos).toHaveLength(1);
      expect(sent.p_photos[0].mime).toBe('image/jpeg');
      expect(sent.p_photos[0].data_base64.length).toBeLessThanOrEqual(5600000);
      expect(sent.p_visit.ai_administered).toBe(true);
      expect(sent.p_visit.gps_lat).toBeCloseTo(-29.5198, 3);
    });
});
