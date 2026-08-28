# Rebuilding the AI-FS database from scratch

The Supabase project **4D-roster** (`kgoprnbxdzwehzkxedch`) was deleted in
August 2026. Everything in it was lost — Supabase treats project deletion as
permanent and it removes the backups too. Only UAT practice data was affected;
no production monitoring data existed yet.

The database now lives in project **AI-FS** (`kwhnpzhckjdlzawvvhvt`, eu-west-1).

## What made the loss worse than it needed to be

`schema.sql` carried only v1–v3. Everything from v4 onward — the `fs_farmers`
table, `fs_register_farmer`, the four drill-down RPCs, the viewer role, the
mandatory-field validation — had been applied through the Supabase dashboard
and survived in the repo only as **comments describing what it did**. Those
RPCs had to be rewritten from the client contract in `app.js`.

**The rule that follows from this: nothing goes into the database that is not
in this directory first.** No dashboard-only migrations, ever. If you apply
something by hand, commit the SQL in the same change.

## Run order for a fresh project

| # | File | What it creates |
|---|---|---|
| 1 | `schema.sql` | tables, RLS, auth helpers, core RPCs, the 18 sites, validation farms |
| 2 | `schema_v4_v9.sql` | `fs_farmers`, roles, register/edit, drill-downs, progress |
| 3 | `2026-08_relink_queued_visits.sql` | current `fs_submit_visit` (supersedes the one in step 2) |
| 4 | `schema_v10_manager_edit.sql` | manager visit corrections (`fs_update_visit`), `fs_visit_edits` audit log, in-app role changes |
| 5 | *account seed* | the 21 accounts — **not in the repo**, see below |
| 6 | `2026-08_farmer_list_update.sql` | the 344 profiled farmers |
| 7 | `2026-08_promote_mantsatsi.sql` | Mantsatsi viewer → manager (no-op once applied) |

Then point the app at the new project — `SUPABASE_URL` and
`SUPABASE_ANON_KEY` at the top of `app.js` — and bump the cache version
(`?v=N` in `index.html` and `sw.js`, plus `VERSION` in `sw.js`).

## Accounts

The 21 accounts (17 Field Supervisors, 1 manager, 3 viewers) are seeded with
their **already-issued PINs**, so a rebuild does not force a re-notification.
The PINs are deliberately **not committed** — they live in the credentials PDF
that was distributed to staff. To regenerate the seed, read the usernames,
roles, station assignments and PINs from that PDF and write:

```sql
insert into fs_supervisors (name, username, pin_hash, role, assigned_site_ids)
values ('<name>', '<username>',
        extensions.crypt('<pin>', extensions.gen_salt('bf')),
        '<supervisor|manager|viewer>', '{<site ids>}')
on conflict (username) do update set
  pin_hash = excluded.pin_hash, role = excluded.role,
  assigned_site_ids = excluded.assigned_site_ids, name = excluded.name,
  active = true, failed_attempts = 0, locked_until = null;
```

Station assignments map to `fs_sites.id`: Mahuu 1, Matela 2, Likalaneng 3,
Morija 4, Nyakosoba 5, Makhaleng 6, Mekaling 7, Peka 8, Tabola 9,
Tsehlanyane 10, Seetsa 11, Pilot 12, Thuoathe 13, Maqhaka 14, CX 15,
Matelile 16, Kolo 17, Ramokoatsi 18. The Peka officer covers `{8,9}`.

Anyone who had changed their PIN in the app reverts to their issued one.

## Work already on Field Supervisors' phones

A rebuild gives every profiled farmer a **new uuid**, so visits sitting in an
offline queue point at ids the new database has never seen. Handled in two
layers, both already in place — see `2026-08_relink_queued_visits.sql`:

1. `app.js` stamps `farmer_name` onto queued visits at startup, resolved from
   the boot cache the phone still holds, and sends it with `farmer_id`. An
   unknown id is re-linked by name within the visit's own site.
2. If it still cannot be matched the visit is **saved anyway**, with the orphan
   reference kept in `fs_visits.farmer_unmatched`.

After the field has synced, reconcile whatever could not be matched:

```sql
select v.id, v.farmer_unmatched, s.name as fs, st.sub_area, v.submitted_at
from fs_visits v
join fs_supervisors s on s.id = v.supervisor_id
join fs_sites st on st.id = v.site_id
where v.farmer_unmatched is not null
order by v.submitted_at;
```

## Verifying a rebuild

Rehearse on a scratch Postgres before touching anything live. Mirror Supabase's
layout first, or the `search_path = public, extensions` on every function will
not resolve `crypt()`:

```sql
create schema if not exists extensions;
create extension if not exists pgcrypto with schema extensions;
```

Expected end state: **344 active farmers, 21 accounts, 18 sites, 12 validation
farms, 19 `fs_` functions**, and zero visits.

To prove a live database matches a rehearsed one, compare function definitions
rather than trusting that the SQL was transcribed correctly:

```sql
select p.proname, md5(lower(regexp_replace(regexp_replace(
         pg_get_functiondef(p.oid), '--[^\n]*', '', 'g'), '\s+', '', 'g')))
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public' and p.proname like 'fs\_%'
order by 1;
```

(Stripping comments and whitespace keeps cosmetic differences from masking real
ones. All 19 hashes should be identical on both sides.)

## Before go-live

Wipe practice data so real monitoring starts from zero:

```sql
delete from fs_photos; delete from fs_readings; delete from fs_visits;
delete from fs_farmers where source = 'fs_registered';
```
