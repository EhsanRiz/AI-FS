# Testing

## Automated (e2e)

Playwright drives the real app in Chromium at Pixel-7 size, with every Supabase RPC
stubbed — the suite never touches the 4D-roster project.

```bash
npm install        # browsers are not downloaded; Chromium is already on the machine
npm test           # npm run test:headed to watch it, npm run test:report for the last run
```

`tests/photo-capture.spec.js` covers the visit form's photo path — the one thing that
blocks everything else, since a visit cannot sync without a photo. It has broken twice in
UAT (v13 and v16), so each test pins a specific way it failed on real phones: one picker
activation per tap, no `capture="environment"` on any file input, attach/downscale/cap/
remove, a decode failure that explains itself, the form surviving the phone discarding the
page mid-capture, and the photo actually reaching `fs_submit_visit`.

Both v16 faults are caught: run the suite against `git show 62a353a:app.js` and 5 tests fail.

The app has no build step — `tests/serve.js` is a dependency-free static server that serves
the repo root exactly as the edge does, and `.assetsignore` keeps all of this off Cloudflare.

## Staff testing (UAT)

The human-facing testing guide is the styled, interactive web page — share this link:

**https://fs.4dcs.co.za/testing.html**

(install steps, role table, phased plan, per-role checklists with progress saved on each
tester's phone, printable). It is also linked from the app's burger menu ("Testing guide").
Edit `testing.html` to change the content.

After sign-off, wipe practice data before go-live:

```sql
delete from fs_photos; delete from fs_readings; delete from fs_visits;
delete from fs_farmers where source = 'fs_registered';
```
