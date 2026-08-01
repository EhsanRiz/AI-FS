# AI-FS — FS Field Monitoring PWA

Offline-first Progressive Web App for monitoring Field Supervisor (FS) soil-data-collection
work in the **AI-Powered Extension for Agricultural Resilience** project (4D Climate Solutions,
Lesotho, with University of Virginia & National University of Lesotho). Covers the 17 resource
centres / 18 sub-areas and the sensor-vs-lab validation plan: 3 farms per validation site ×
3 readings × 5 soil parameters (moisture, temperature, pH, EC, NPK) + a 0–20 cm topsoil sample
per farm for paired lab analysis.

**No build step.** Plain HTML/JS/CSS served statically from the repo root.

## Hosting

Any static host works. To serve at `fs.4dcs.co.za` (or similar): create a Render **Static Site**
from this repo (publish directory `.`), add the custom subdomain, done. The app is installable
as a PWA from the browser menu on phones.

## Architecture

- **Frontend:** `index.html` + `app.js` (vanilla JS, hash routing) + `styles.css` (4DCS palette,
  Poppins/Nunito Sans) + Leaflet 1.9.4 (pinned CDN) for the map.
- **Offline:** `sw.js` precaches the app shell (opens with no signal in the field); visits are
  stored in **IndexedDB** with states `draft → queued → synced/failed` and sync automatically
  when connectivity returns (online event / app focus / manual "Sync now").
- **Backend:** Supabase project **4D-roster** (`kgoprnbxdzwehzkxedch`), repurposed as the AI-FS
  database. All objects are `fs_`-prefixed and isolated: tables are deny-all RLS; the only
  access path is the `SECURITY DEFINER` RPCs in `supabase/schema.sql`
  (`fs_login`, `fs_bootstrap`, `fs_submit_visit`, `fs_progress`, `fs_activity`,
  `fs_add_supervisor`, `fs_set_supervisor`).
- **Auth:** phone + PIN (low-friction for field use). `fs_login` returns a 60-day bearer token
  (sha256-hashed at rest; bcrypt PINs; 8 failed attempts → 15-min lockout).
  Roles: `supervisor` (capture) and `manager` (dashboard, activity feed, team management).
- **MCP:** `.mcp.json` configures the Supabase MCP server for this project — run `claude /mcp`
  once in a regular terminal to authenticate.

## Roles & screens

| Screen | Who | What |
|---|---|---|
| Sites | all | Validation-site targets + progress, all 18 sub-areas, start a visit |
| Map | all | Leaflet map, district colours, validation sites ringed gold |
| Visit form | all | Site → farm → GPS capture (distance vs known coords) → 3×7 readings grid (moisture, temp, pH, EC, N, P, K) → sample flag + ID → up to 2 photos (downscaled) → notes |
| Sync | all | Per-record state, edit/retry/delete, manual sync |
| Dashboard | manager | Totals vs targets, per-site progress bars, team last-seen/last-GPS, activity feed with data-quality flags (GPS >500 m from site, out-of-range values), add/deactivate members, reset PINs |

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
- Photos live in a `fs_photos` table as downscaled base64 (~100–200 KB each, capped at 2/visit);
  move to Supabase Storage if volume grows.
- Accuracy statistics (R², RMSE, MAE, bias) are computed later from the paired sensor/lab data —
  the schema stores everything needed (`sample_id` links sensor readings to lab results).
