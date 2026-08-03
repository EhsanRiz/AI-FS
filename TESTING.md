# AI-FS — Staff Testing Guide (UAT)

App: **https://fs.4dcs.co.za** · Login: first-name username + PIN (issued separately — never
commit PINs to this repo).

## How to run the test (proposed)

**Phase 1 — office walkthrough (1–2 days).** Programme staff + 2–3 Field Officers, phones in
hand, working through the script below. Data captured now is test data.

**Phase 2 — field pilot (2–3 days).** The same 2–3 Field Officers run real visits at their own
stations, including at least one full day with no data bundle (offline drill).

**Go-live.** After sign-off, ask for the test-data wipe (visits, readings, photos, and
field-registered test farmers are cleared; the 339 profiled farmers, sites, and accounts stay).
Dashboards then start from zero for real monitoring.

## Test script

### A. Install & sign in (everyone)
- [ ] Open fs.4dcs.co.za in Chrome/Safari → menu → **Add to Home Screen** → opens full-screen with the 4D logo
- [ ] Sign in with first name + PIN; wrong PIN shows a clear error; 8 wrong tries locks for 15 min
- [ ] Header shows your name (and Manager/Viewer where applicable)

### B. Field Officer flow (supervisors)
- [ ] Home shows *your* station, your stats, and sensible nudges
- [ ] Sites: only your station is tappable; others greyed
- [ ] Map zooms to your station with the lime halo and ★ popup
- [ ] Farmers: only your area's farmers listed; search works; tap a farmer → detail card with profile + visit history
- [ ] Register a new farmer; edit an existing farmer (spelling/phone)
- [ ] New visit: farmer preselected site, capture GPS (distance shown), answer AI Yes/No, add photo → checklist ticks, **Save & sync turns green**
- [ ] Try to save & sync *without* a photo → blocked with the checklist showing what's missing; Save as draft still works
- [ ] Soil toggle reveals the readings grid; enter a couple of readings incl. one silly value (e.g. pH 99) — manager should later see the out-of-range flag
- [ ] **Offline drill:** aeroplane mode → capture a full visit + register a farmer → both show *queued* in Sync with the amber offline banner → aeroplane mode off → both sync automatically ("Back online — syncing…")
- [ ] Try recording a visit at another officer's station (edit a draft's site via another phone/user) — server refuses

### C. Viewer flow (Mantsatsi, Barth, Masupha)
- [ ] Opens directly on the monitoring dashboard; "Needs attention" strip present
- [ ] Stat tiles open info modals (X / outside tap / Esc closes)
- [ ] Team list visible but **no** PIN/On-Off buttons, no Add member form
- [ ] Sites/Farmers/Map browsable; **no** New visit button, no Register/Edit farmer, no Sync tab
- [ ] Farmer detail cards + visit history open normally

### D. Manager flow (Ehsan)
- [ ] Everything viewers see, **plus**: add a member, reset a PIN, deactivate/reactivate
- [ ] Activity feed shows the test visits with farmer, AI ✓/✗, issues, GPS distance, and flags for the silly reading / far-away GPS
- [ ] Change every seed PIN (Dashboard → Field team → PIN)

### E. Edge cases (anyone)
- [ ] Deny GPS permission → clear error, visit stays draftable
- [ ] Kill the app mid-form → reopen → draft still in Sync tab
- [ ] Two officers online at once → both sync fine
- [ ] Sign out with unsynced visits → warning mentions they stay on the phone

## Recording findings
Note issues as: *who / phone model / screen / what happened / what you expected.* Screenshots help.
