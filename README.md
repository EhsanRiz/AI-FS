# AI-FS — Field Supervisor Monitoring PWA

Offline-first Progressive Web App for monitoring **Field Supervisor activity** in the
**AI-Powered Extension for Agricultural Resilience** project (4D Climate Solutions, Lesotho,
with University of Virginia & National University of Lesotho). Field Supervisors log farmer
visits (who they saw, whether the AI advisory was administered, any issues observed), register
new farmers in their area, and — when applicable — capture soil-sensor validation data
(3 farms per validation site × 3 readings × 5 parameters + 0–20 cm topsoil samples).
339 profiled farmers across the 18 sub-areas are pre-loaded from the AI Farm Data workbook.

**No build step.** Plain HTML/JS/CSS served statically from the repo root.

## Hosting

Any static host works. To serve at `fs.4dcs.co.za` (or similar): create a Render **Static Site**
from this repo (publish directory `.`), add the custom subdomain, done. The app is installable
as a PWA from the browser menu on phones.

## Architecture

- **Frontend:** `index.html` + `app.js` (vanilla JS, hash routing) + `styles.css` (4DCS palette,
  Poppins/Nunito Sans) + Leaflet 1.9.4 (vendored in assets/vendor/ — no runtime CDN) for the
  map. Responsive navigation: bottom tabs + burger drawer on phones, persistent left sidebar on
  ≥900 px screens. Stat tiles everywhere open explainer/breakdown modals (X or Esc to close).
- **Offline:** `sw.js` precaches the app shell (opens with no signal in the field); visits are
  stored in **IndexedDB** with states `draft → queued → synced/failed` and sync automatically
  when connectivity returns (online event / app focus / manual "Sync now").
- **Backend:** Supabase project **4D-roster** (`kgoprnbxdzwehzkxedch`), repurposed as the AI-FS
  database. All objects are `fs_`-prefixed and isolated: tables are deny-all RLS; the only
  access path is the `SECURITY DEFINER` RPCs in `supabase/schema.sql`
  (`fs_login`, `fs_bootstrap`, `fs_submit_visit`, `fs_progress`, `fs_activity`,
  `fs_add_supervisor`, `fs_set_supervisor`).
- **Auth:** first-name username (or phone) + PIN — one login field takes either. `fs_login`
  returns a 60-day bearer token (sha256-hashed at rest; bcrypt PINs; 8 failed attempts →
  15-min lockout). Roles: `supervisor` (the ONLY role that records visits and registers
  farmers; station-locked), `viewer` (read-only monitoring) and `manager` (monitoring + team
  management + farmer data corrections — no visit capture). All write rules are enforced
  server-side, not just hidden in the UI. The 17 Field Officers are seeded with
  usernames = first names (the two Rorisangs are `rorisangt`/`rorisangs`); programme staff
  have personal accounts; phones can be added later.
- **Station lock:** each Field Officer is assigned their resource centre
  (`fs_supervisors.assigned_site_ids`; the Peka officer covers Peka + Tabola). The app only
  offers their own station for capture, and `fs_submit_visit` rejects any other site
  server-side. Managers are unrestricted.
- **MCP:** `.mcp.json` configures the Supabase MCP server for this project — run `claude /mcp`
  once in a regular terminal to authenticate.

## Roles & screens

| Screen | Who | What |
|---|---|---|
| Home | FS | Intelligent opening screen: greeting + station, nudges (unsynced visits, farmers not yet engaged, inactivity, soil-validation progress), personal stats (visits this week/total, farmers engaged, AI administered), engagement bar, quick actions |
| Home | manager/viewer | The monitoring dashboard is the landing view: "Needs attention" strip, stat tiles, bar charts (visits by FS with AI split, farmer engagement by site, visits per week), validation progress, team, activity feed |
| Sites | all | Validation-site targets + progress, all 18 sub-areas, start a visit |
| Farmers | all | Farmers in the FS's area (pre-loaded + FS-registered), search, register/edit farmers (offline-capable), tap a farmer for a detail card with full profile + visit history (synced + local), jump to a visit |
| Map | all | Leaflet map (vendored locally — no CDN), district colours, validation sites ringed gold; FS view zooms to their own station with a lime halo and ★ marker popup |
| Visit form | all | Site → farmer (dropdown of their area, or register new) → GPS capture (**required**) → advisory type — AI advisory or Conventional (**required**, form continues either way) → specific issue (optional) → optional soil section: farm, 3×7 readings grid, sample flag + ID → photos via 📷 Camera or 🖼 Gallery, up to 3 (**≥1 required**) + optional notes. A checklist above Save & sync shows what's missing; the button only activates (highlighted green) when GPS + AI answer + photo are present, and the server enforces the same rules. Drafts can always be saved locally. |
| Sync | all | Per-record state, edit/retry/delete, manual sync |
| Dashboard | manager | Totals vs targets, per-site progress bars, team last-seen/last-GPS, activity feed with data-quality flags (GPS >500 m from site, out-of-range values), add/deactivate members, reset PINs |

## Testing

See `TESTING.md` for the staff UAT script (install, offline drills, role checks). After
sign-off, wipe test data before go-live:

```sql
delete from fs_photos; delete from fs_readings; delete from fs_visits;
delete from fs_farmers where source = 'fs_registered';
```

## Managing accounts

Managers do this in-app (Dashboard → Field team). To reset a PIN in SQL instead:

```sql
update fs_supervisors set pin_hash = crypt('NEW_PIN', gen_salt('bf')) where phone = '<phone>';
```

## Validation sites note

The plan names 5 validation sites (Kolo, Sehlabeng/Thuoathe, Sefikeng, Maqhaka, Morija), but in
the 18-sub-area reference dataset "Sefikeng" is the RC whose sub-area **is** Thuoathe
(Sehlabeng-sa-Thuathe), so **4 distinct sites** are flagged: **Kolo, Thuoathe, Maqhaka, Morija**
(12 farms). Dashboard targets adapt automatically. Once the 5th site is confirmed, flag it:

```sql
update fs_sites set is_validation_site = true where sub_area = '<name>';
insert into fs_farms (id, site_id, label)
  select id*10+n, id, 'Farm '||n from fs_sites, generate_series(1,3) n where sub_area = '<name>';
```

## Cache busting

When editing `app.js`, `styles.css` or `data/sites.js`: bump their `?v=N` in `index.html`
**and** in `sw.js` PRECACHE, and bump `VERSION` in `sw.js` — otherwise installed PWAs keep
serving the old cached copy.

## Not in v1 (deliberate)

- Sesotho UI (English only for now; structure allows adding a string table later).
- Photos live in a `fs_photos` table as base64, downscaled on-device to 1600 px / q0.85
  (~0.3–1 MB each, up to 3/visit; server ceiling ~4 MB with automatic step-down);
  move to Supabase Storage if volume grows.
- Accuracy statistics (R², RMSE, MAE, bias) are computed later from the paired sensor/lab data —
  the schema stores everything needed (`sample_id` links sensor readings to lab results).
