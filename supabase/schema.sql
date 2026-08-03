-- =============================================================================
-- FS Field Monitoring — Supabase schema (v1)
-- 4D Climate Solutions — AI-Powered Extension for Agricultural Resilience
--
-- Applied to Supabase project: 4D-roster (kgoprnbxdzwehzkxedch.supabase.co),
--   repurposed as the AI-FS database. All objects are prefixed fs_ and are
--   isolated from any pre-existing tables (deny-all RLS; access only via the
--   SECURITY DEFINER RPCs below). To move to another project, run this whole
--   file there, re-create supervisor accounts, and update
--   SUPABASE_URL / SUPABASE_ANON_KEY in app.js.
--
-- Security model: no direct table access for anon/authenticated. The PWA calls
-- RPCs with a bearer session token issued by fs_login (phone + PIN).
-- =============================================================================

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

create table if not exists fs_sites (
  id                 int primary key,
  district           text not null,
  rc                 text not null,
  sub_area           text not null,
  zone               text not null check (zone in ('Lowlands','Foothills','Mountains')),
  lat                double precision not null,
  lon                double precision not null,
  farmers            int not null default 0,
  is_validation_site boolean not null default false
);

create table if not exists fs_farms (
  id      int primary key,              -- convention: site_id * 10 + n (n = 1..3)
  site_id int not null references fs_sites(id),
  label   text not null,
  unique (site_id, label)
);

create table if not exists fs_supervisors (
  id              uuid primary key default gen_random_uuid(),
  name            text not null,
  phone           text not null unique,  -- normalized: digits only, no country code
  pin_hash        text not null,         -- bcrypt via crypt()
  role            text not null default 'supervisor' check (role in ('supervisor','manager')),
  active          boolean not null default true,
  failed_attempts int not null default 0,
  locked_until    timestamptz,
  created_at      timestamptz not null default now()
);

create table if not exists fs_sessions (
  token_hash    text primary key,        -- sha256 hex of the bearer token
  supervisor_id uuid not null references fs_supervisors(id) on delete cascade,
  created_at    timestamptz not null default now(),
  expires_at    timestamptz not null
);

create table if not exists fs_visits (
  id                  uuid primary key,  -- client-generated (idempotent sync)
  supervisor_id       uuid not null references fs_supervisors(id),
  site_id             int not null references fs_sites(id),
  farm_id             int references fs_farms(id),
  gps_lat             double precision,
  gps_lon             double precision,
  gps_accuracy_m      double precision,
  distance_from_site_m double precision, -- computed server-side on submit
  started_at          timestamptz,
  submitted_at        timestamptz,       -- when the FS saved it on-device
  synced_at           timestamptz not null default now(),
  sample_collected    boolean not null default false,
  sample_id           text,
  notes               text
);

create table if not exists fs_readings (
  id        bigint generated always as identity primary key,
  visit_id  uuid not null references fs_visits(id) on delete cascade,
  parameter text not null check (parameter in ('moisture','ph','ec','temperature','n','p','k')),
  replicate int not null check (replicate between 1 and 3),
  value     numeric,
  unit      text,
  unique (visit_id, parameter, replicate)
);

create table if not exists fs_photos (
  id          uuid primary key,
  visit_id    uuid not null references fs_visits(id) on delete cascade,
  mime        text not null default 'image/jpeg',
  data_base64 text not null,             -- client downscales to <=1280px JPEG
  created_at  timestamptz not null default now()
);

create index if not exists fs_visits_supervisor_idx on fs_visits (supervisor_id, synced_at desc);
create index if not exists fs_visits_site_idx       on fs_visits (site_id);
create index if not exists fs_readings_visit_idx    on fs_readings (visit_id);
create index if not exists fs_photos_visit_idx      on fs_photos (visit_id);
create index if not exists fs_sessions_expiry_idx   on fs_sessions (expires_at);

-- Deny-all RLS: no policies exist, so anon/authenticated cannot touch the
-- tables directly. All access is via the SECURITY DEFINER functions.
alter table fs_sites       enable row level security;
alter table fs_farms       enable row level security;
alter table fs_supervisors enable row level security;
alter table fs_sessions    enable row level security;
alter table fs_visits      enable row level security;
alter table fs_readings    enable row level security;
alter table fs_photos      enable row level security;

revoke all on fs_sites, fs_farms, fs_supervisors, fs_sessions, fs_visits,
              fs_readings, fs_photos from anon, authenticated;

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------

create or replace function fs_norm_phone(p text)
returns text language sql immutable set search_path = public as $$
  select case
    when length(regexp_replace(coalesce(p,''), '\D', '', 'g')) > 8
     and regexp_replace(coalesce(p,''), '\D', '', 'g') like '266%'
    then substr(regexp_replace(coalesce(p,''), '\D', '', 'g'), 4)
    else regexp_replace(coalesce(p,''), '\D', '', 'g')
  end
$$;

create or replace function fs_token_hash(p_token text)
returns text language sql immutable set search_path = public, extensions as $$
  select encode(digest(coalesce(p_token,''), 'sha256'), 'hex')
$$;

-- Great-circle distance in metres (haversine)
create or replace function fs_haversine_m(lat1 double precision, lon1 double precision,
                                          lat2 double precision, lon2 double precision)
returns double precision language sql immutable set search_path = public as $$
  select 2 * 6371000 * asin( least(1.0, sqrt(
    sin(radians((lat2-lat1)/2))^2 +
    cos(radians(lat1)) * cos(radians(lat2)) * sin(radians((lon2-lon1)/2))^2
  )))
$$;

-- Resolve a bearer token to an active supervisor; raises on failure.
create or replace function fs_auth(p_token text)
returns fs_supervisors
language plpgsql security definer set search_path = public, extensions as $$
declare v_sup fs_supervisors;
begin
  select s.* into v_sup
  from fs_sessions ses
  join fs_supervisors s on s.id = ses.supervisor_id
  where ses.token_hash = fs_token_hash(p_token)
    and ses.expires_at > now()
    and s.active;
  if not found then
    raise exception 'AUTH' using errcode = '28000';
  end if;
  return v_sup;
end $$;

-- ---------------------------------------------------------------------------
-- RPC: login (phone + PIN) -> bearer token
-- ---------------------------------------------------------------------------

create or replace function fs_login(p_phone text, p_pin text)
returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare
  v_sup fs_supervisors;
  v_token text;
begin
  select * into v_sup from fs_supervisors where phone = fs_norm_phone(p_phone);
  if not found or not v_sup.active then
    raise exception 'Invalid phone number or PIN' using errcode = '28000';
  end if;
  if v_sup.locked_until is not null and v_sup.locked_until > now() then
    raise exception 'Too many attempts. Try again in a few minutes.' using errcode = '28000';
  end if;
  if v_sup.pin_hash <> crypt(coalesce(p_pin,''), v_sup.pin_hash) then
    update fs_supervisors
       set failed_attempts = failed_attempts + 1,
           locked_until = case when failed_attempts + 1 >= 8
                               then now() + interval '15 minutes' else null end
     where id = v_sup.id;
    raise exception 'Invalid phone number or PIN' using errcode = '28000';
  end if;

  update fs_supervisors set failed_attempts = 0, locked_until = null where id = v_sup.id;
  v_token := encode(gen_random_bytes(32), 'hex');
  insert into fs_sessions (token_hash, supervisor_id, expires_at)
  values (fs_token_hash(v_token), v_sup.id, now() + interval '60 days');
  delete from fs_sessions where expires_at < now();

  return jsonb_build_object(
    'token', v_token,
    'supervisor', jsonb_build_object('id', v_sup.id, 'name', v_sup.name, 'role', v_sup.role)
  );
end $$;

-- ---------------------------------------------------------------------------
-- RPC: bootstrap — everything the app needs after login (cached for offline)
-- ---------------------------------------------------------------------------

create or replace function fs_bootstrap(p_token text)
returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare
  v_sup fs_supervisors;
begin
  v_sup := fs_auth(p_token);
  return jsonb_build_object(
    'supervisor', jsonb_build_object('id', v_sup.id, 'name', v_sup.name,
                                     'phone', v_sup.phone, 'role', v_sup.role),
    'sites', (select coalesce(jsonb_agg(to_jsonb(s) order by s.id), '[]'::jsonb) from fs_sites s),
    'farms', (select coalesce(jsonb_agg(to_jsonb(f) order by f.id), '[]'::jsonb) from fs_farms f),
    'progress', fs_progress(p_token)
  );
end $$;

-- ---------------------------------------------------------------------------
-- RPC: submit a visit (idempotent — client retries with the same UUID)
-- ---------------------------------------------------------------------------

create or replace function fs_submit_visit(p_token text, p_visit jsonb,
                                           p_readings jsonb default '[]'::jsonb,
                                           p_photos jsonb default '[]'::jsonb)
returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare
  v_sup fs_supervisors;
  v_id uuid;
  v_site fs_sites;
  v_owner uuid;
  v_dist double precision;
  r jsonb;
begin
  v_sup := fs_auth(p_token);
  v_id := (p_visit->>'id')::uuid;
  select * into v_site from fs_sites where id = (p_visit->>'site_id')::int;
  if not found then
    raise exception 'Unknown site';
  end if;

  select supervisor_id into v_owner from fs_visits where id = v_id;
  if found and v_owner <> v_sup.id then
    raise exception 'Visit id conflict';
  end if;

  if (p_visit->>'gps_lat') is not null and (p_visit->>'gps_lon') is not null then
    v_dist := round(fs_haversine_m((p_visit->>'gps_lat')::double precision,
                                   (p_visit->>'gps_lon')::double precision,
                                   v_site.lat, v_site.lon));
  end if;

  insert into fs_visits as v (id, supervisor_id, site_id, farm_id, gps_lat, gps_lon,
    gps_accuracy_m, distance_from_site_m, started_at, submitted_at,
    sample_collected, sample_id, notes)
  values (
    v_id, v_sup.id, v_site.id, nullif(p_visit->>'farm_id','')::int,
    (p_visit->>'gps_lat')::double precision, (p_visit->>'gps_lon')::double precision,
    (p_visit->>'gps_accuracy_m')::double precision, v_dist,
    (p_visit->>'started_at')::timestamptz, (p_visit->>'submitted_at')::timestamptz,
    coalesce((p_visit->>'sample_collected')::boolean, false),
    nullif(p_visit->>'sample_id',''), nullif(p_visit->>'notes','')
  )
  on conflict (id) do update set
    farm_id = excluded.farm_id, gps_lat = excluded.gps_lat, gps_lon = excluded.gps_lon,
    gps_accuracy_m = excluded.gps_accuracy_m, distance_from_site_m = excluded.distance_from_site_m,
    started_at = excluded.started_at, submitted_at = excluded.submitted_at,
    sample_collected = excluded.sample_collected, sample_id = excluded.sample_id,
    notes = excluded.notes, synced_at = now();

  delete from fs_readings where visit_id = v_id;
  for r in select * from jsonb_array_elements(coalesce(p_readings, '[]'::jsonb)) loop
    insert into fs_readings (visit_id, parameter, replicate, value, unit)
    values (v_id, r->>'parameter', (r->>'replicate')::int,
            nullif(r->>'value','')::numeric, r->>'unit')
    on conflict (visit_id, parameter, replicate) do update
      set value = excluded.value, unit = excluded.unit;
  end loop;

  delete from fs_photos where visit_id = v_id;
  for r in select * from jsonb_array_elements(coalesce(p_photos, '[]'::jsonb)) loop
    if length(r->>'data_base64') > 1500000 then
      raise exception 'Photo too large';
    end if;
    insert into fs_photos (id, visit_id, mime, data_base64)
    values ((r->>'id')::uuid, v_id, coalesce(r->>'mime','image/jpeg'), r->>'data_base64');
  end loop;

  return jsonb_build_object('ok', true, 'visit_id', v_id, 'distance_from_site_m', v_dist);
end $$;

-- ---------------------------------------------------------------------------
-- RPC: progress vs the validation plan (any signed-in user)
-- Targets are dynamic: flagged validation sites × 3 farms × (5 params × 3 reps).
-- A farm counts as "complete" when, across its synced visits, all 21 readings
-- exist (moisture, ph, ec, temperature, n, p, k × replicates 1–3).
-- ---------------------------------------------------------------------------

create or replace function fs_progress(p_token text)
returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare
  v_sup fs_supervisors;
begin
  v_sup := fs_auth(p_token);
  return (
    with farm_readings as (
      select f.id as farm_id, f.site_id,
             count(distinct (r.parameter, r.replicate))
               filter (where r.value is not null) as readings_done
      from fs_farms f
      left join fs_visits v on v.farm_id = f.id
      left join fs_readings r on r.visit_id = v.id
      group by f.id, f.site_id
    ),
    per_site as (
      select s.id as site_id, s.sub_area, s.rc, s.district, s.zone, s.is_validation_site,
             count(distinct v.id) as visits,
             count(distinct v.farm_id) filter (where v.farm_id is not null) as farms_visited,
             coalesce((select count(*) from farm_readings fr
                       where fr.site_id = s.id and fr.readings_done >= 21), 0) as farms_complete,
             coalesce((select sum(fr.readings_done) from farm_readings fr
                       where fr.site_id = s.id), 0) as readings_done,
             (select count(*) * 21 from fs_farms f where f.site_id = s.id) as readings_target,
             max(v.synced_at) as last_visit_at
      from fs_sites s
      left join fs_visits v on v.site_id = s.id
      group by s.id
    ),
    per_supervisor as (
      select s.id, s.name, s.active,
             count(v.id) as visits,
             max(v.synced_at) as last_synced_at
      from fs_supervisors s
      left join fs_visits v on v.supervisor_id = s.id
      group by s.id
    )
    select jsonb_build_object(
      'targets', jsonb_build_object(
        'validation_sites', (select count(*) from fs_sites where is_validation_site),
        'validation_farms', (select count(*) from fs_farms),
        'readings_per_farm', 21
      ),
      'totals', jsonb_build_object(
        'visits',   (select count(*) from fs_visits),
        'farms_visited', (select count(distinct farm_id) from fs_visits where farm_id is not null),
        'farms_complete', (select count(*) from farm_readings where readings_done >= 21),
        'readings', (select count(*) from fs_readings where value is not null),
        'samples',  (select count(*) from fs_visits where sample_collected)
      ),
      'sites', (select coalesce(jsonb_agg(to_jsonb(p) order by p.is_validation_site desc, p.site_id), '[]'::jsonb)
                from per_site p),
      'supervisors', (select coalesce(jsonb_agg(to_jsonb(p) order by p.name), '[]'::jsonb)
                      from per_supervisor p)
    )
  );
end $$;

-- ---------------------------------------------------------------------------
-- RPC: activity & data-quality feed (managers only)
-- Flags: GPS more than 500 m from the site; readings outside plausible ranges.
-- ---------------------------------------------------------------------------

create or replace function fs_activity(p_token text)
returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare
  v_sup fs_supervisors;
begin
  v_sup := fs_auth(p_token);
  if v_sup.role <> 'manager' then
    raise exception 'Managers only' using errcode = '28000';
  end if;
  return (
    with visit_quality as (
      select v.id,
             count(r.id) filter (where r.value is not null) as readings_count,
             count(r.id) filter (where r.value is not null and (
               (r.parameter = 'moisture'    and (r.value < 0   or r.value > 100)) or
               (r.parameter = 'ph'          and (r.value < 3   or r.value > 10))  or
               (r.parameter = 'ec'          and (r.value < 0   or r.value > 20000)) or
               (r.parameter = 'temperature' and (r.value < -5  or r.value > 60)) or
               (r.parameter in ('n','p','k') and (r.value < 0  or r.value > 3000))
             )) as out_of_range
      from fs_visits v
      left join fs_readings r on r.visit_id = v.id
      group by v.id
    )
    select jsonb_build_object(
      'visits', (
        select coalesce(jsonb_agg(rec order by rec->>'synced_at' desc), '[]'::jsonb) from (
          select jsonb_build_object(
            'id', v.id, 'supervisor', s.name, 'site', st.sub_area, 'rc', st.rc,
            'district', st.district, 'farm', f.label,
            'started_at', v.started_at, 'submitted_at', v.submitted_at, 'synced_at', v.synced_at,
            'gps_lat', v.gps_lat, 'gps_lon', v.gps_lon,
            'distance_from_site_m', v.distance_from_site_m,
            'gps_flag', coalesce(v.distance_from_site_m > 500, v.gps_lat is null),
            'readings_count', q.readings_count, 'out_of_range', q.out_of_range,
            'sample_collected', v.sample_collected, 'sample_id', v.sample_id,
            'photos', (select count(*) from fs_photos p where p.visit_id = v.id),
            'notes', v.notes
          ) as rec
          from fs_visits v
          join fs_supervisors s on s.id = v.supervisor_id
          join fs_sites st on st.id = v.site_id
          left join fs_farms f on f.id = v.farm_id
          left join visit_quality q on q.id = v.id
          order by v.synced_at desc
          limit 200
        ) t
      ),
      'team', (
        select coalesce(jsonb_agg(jsonb_build_object(
          'id', s.id, 'name', s.name, 'phone', s.phone, 'role', s.role, 'active', s.active,
          'visits', (select count(*) from fs_visits v where v.supervisor_id = s.id),
          'last_synced_at', (select max(v.synced_at) from fs_visits v where v.supervisor_id = s.id),
          'last_gps', (select jsonb_build_object('lat', v.gps_lat, 'lon', v.gps_lon,
                                                 'site', st.sub_area, 'at', v.synced_at)
                       from fs_visits v join fs_sites st on st.id = v.site_id
                       where v.supervisor_id = s.id and v.gps_lat is not null
                       order by v.synced_at desc limit 1)
        ) order by s.name), '[]'::jsonb)
        from fs_supervisors s
      )
    )
  );
end $$;

-- ---------------------------------------------------------------------------
-- RPC: team management (managers only)
-- ---------------------------------------------------------------------------

create or replace function fs_add_supervisor(p_token text, p_name text, p_phone text,
                                             p_pin text, p_role text default 'supervisor')
returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare
  v_sup fs_supervisors;
  v_phone text;
  v_id uuid;
begin
  v_sup := fs_auth(p_token);
  if v_sup.role <> 'manager' then
    raise exception 'Managers only' using errcode = '28000';
  end if;
  if coalesce(p_pin,'') !~ '^\d{4,8}$' then
    raise exception 'PIN must be 4-8 digits';
  end if;
  if p_role not in ('supervisor','manager') then
    raise exception 'Invalid role';
  end if;
  v_phone := fs_norm_phone(p_phone);
  if length(v_phone) < 4 then
    raise exception 'Invalid phone number';
  end if;
  insert into fs_supervisors (name, phone, pin_hash, role)
  values (trim(p_name), v_phone, crypt(p_pin, gen_salt('bf')), p_role)
  returning id into v_id;
  return jsonb_build_object('ok', true, 'id', v_id);
exception when unique_violation then
  raise exception 'That phone number is already registered';
end $$;

create or replace function fs_set_supervisor(p_token text, p_id uuid,
                                             p_active boolean default null,
                                             p_new_pin text default null,
                                             p_name text default null)
returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare
  v_sup fs_supervisors;
begin
  v_sup := fs_auth(p_token);
  if v_sup.role <> 'manager' then
    raise exception 'Managers only' using errcode = '28000';
  end if;
  if p_new_pin is not null and p_new_pin !~ '^\d{4,8}$' then
    raise exception 'PIN must be 4-8 digits';
  end if;
  update fs_supervisors set
    active = coalesce(p_active, active),
    name = coalesce(nullif(trim(p_name),''), name),
    pin_hash = case when p_new_pin is not null then crypt(p_new_pin, gen_salt('bf')) else pin_hash end,
    failed_attempts = case when p_new_pin is not null then 0 else failed_attempts end,
    locked_until = case when p_new_pin is not null then null else locked_until end
  where id = p_id;
  if not found then
    raise exception 'Unknown supervisor';
  end if;
  if p_active is false then
    delete from fs_sessions where supervisor_id = p_id;
  end if;
  return jsonb_build_object('ok', true);
end $$;

-- ---------------------------------------------------------------------------
-- Grants: RPCs only
-- ---------------------------------------------------------------------------

revoke execute on function fs_auth(text) from public, anon, authenticated;
grant execute on function fs_login(text, text)                       to anon;
grant execute on function fs_bootstrap(text)                         to anon;
grant execute on function fs_submit_visit(text, jsonb, jsonb, jsonb) to anon;
grant execute on function fs_progress(text)                          to anon;
grant execute on function fs_activity(text)                          to anon;
grant execute on function fs_add_supervisor(text, text, text, text, text) to anon;
grant execute on function fs_set_supervisor(text, uuid, boolean, text, text) to anon;

-- ---------------------------------------------------------------------------
-- Seed: 18 GPS-tagged sub-areas (17 resource centres; Peka RC has 2 sub-areas)
-- Validation sites flagged per the sampling plan: Kolo, Thuoathe (Sefikeng RC,
-- a.k.a. Sehlabeng-sa-Thuathe), Maqhaka, Morija. NOTE: the plan lists 5 sites
-- but "Sefikeng" and "Sehlabeng/Thuoathe" both map to Sefikeng RC's Thuoathe
-- sub-area in the reference dataset — confirm the 5th site and flag it with:
--   update fs_sites set is_validation_site = true where sub_area = '<name>';
--   insert into fs_farms (id, site_id, label)
--     select id*10+n, id, 'Farm '||n from fs_sites, generate_series(1,3) n
--     where sub_area = '<name>';
-- Targets in the dashboard adapt automatically.
-- ---------------------------------------------------------------------------

insert into fs_sites (id, district, rc, sub_area, zone, lat, lon, farmers, is_validation_site) values
  ( 1, 'Maseru',        'Rothe',           'Mahuu',       'Lowlands',  -29.519759, 27.422734, 19, false),
  ( 2, 'Maseru',        'Ntsi',            'Matela',      'Lowlands',  -29.378881, 27.773753, 23, false),
  ( 3, 'Maseru',        'Marakabei',       'Likalaneng',  'Mountains', -29.476349, 28.050857, 20, false),
  ( 4, 'Maseru',        'Morija',          'Morija',      'Lowlands',  -29.622674, 27.500640, 20, true ),
  ( 5, 'Maseru',        'Ramabanta',       'Nyakosoba',   'Foothills', -29.524466, 27.773905, 20, false),
  ( 6, 'Mohale''s Hoek','Makhaleng',       'Makhaleng',   'Lowlands',  -30.160589, 27.466777, 20, false),
  ( 7, 'Mohale''s Hoek','Mekaling',        'Mekaling',    'Foothills', -30.294823, 27.502955, 20, false),
  ( 8, 'Leribe',        'Peka',            'Peka',        'Lowlands',  -28.968918, 27.761519, 10, false),
  ( 9, 'Leribe',        'Peka',            'Tabola',      'Lowlands',  -28.950056, 27.818802, 10, false),
  (10, 'Leribe',        'Khabo',           'Tsehlanyane', 'Foothills', -28.837927, 28.223056, 20, false),
  (11, 'Leribe',        'Mahobong',        'Seetsa',      'Foothills', -28.936543, 28.237824, 20, false),
  (12, 'Berea',         'Pilot',           'Pilot',       'Foothills', -29.212233, 27.862336, 20, false),
  (13, 'Berea',         'Sefikeng',        'Thuoathe',    'Lowlands',  -29.326586, 27.576908, 20, true ),
  (14, 'Berea',         'Maqhaka',         'Maqhaka',     'Lowlands',  -29.246008, 27.604973, 20, true ),
  (15, 'Berea',         'Corner Exchange', 'CX',          'Foothills', -28.973164, 27.975466, 20, false),
  (16, 'Mafeteng',      'Matelile',        'Matelile',    'Foothills', -29.819832, 27.515345, 20, false),
  (17, 'Mafeteng',      'Kolo',            'Kolo',        'Foothills', -29.607740, 27.325150, 20, true ),
  (18, 'Mafeteng',      'Ramokoatsi',      'Ramokoatsi',  'Lowlands',  -29.748099, 27.346324, 22, false)
on conflict (id) do nothing;

-- 3 validation farms per flagged site
insert into fs_farms (id, site_id, label)
select s.id * 10 + n, s.id, 'Farm ' || n
from fs_sites s, generate_series(1, 3) n
where s.is_validation_site
on conflict (id) do nothing;

-- ---------------------------------------------------------------------------
-- Seed accounts: run manually (do NOT commit real PINs to the repo)
-- ---------------------------------------------------------------------------
-- insert into fs_supervisors (name, phone, pin_hash, role) values
--   ('Programme Manager', '<phone digits>', crypt('<pin>', gen_salt('bf')), 'manager');

-- =============================================================================
-- v2 (2026-08): first-name username login + optional phone + assigned stations
-- Applied as migration fs_username_login_and_assigned_sites. Running this file
-- top-to-bottom on a fresh project yields the current schema.
-- =============================================================================

alter table fs_supervisors add column if not exists username text unique;
alter table fs_supervisors add column if not exists assigned_site_ids int[] not null default '{}';
alter table fs_supervisors alter column phone drop not null;

create or replace function fs_norm_username(p text)
returns text language sql immutable set search_path = public as $$
  select lower(regexp_replace(coalesce(p,''), '[^a-zA-Z0-9]', '', 'g'))
$$;

-- Login accepts a first-name username OR a phone number in the same field.
create or replace function fs_login(p_phone text, p_pin text)
returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare
  v_sup fs_supervisors;
  v_login text;
  v_token text;
begin
  v_login := trim(coalesce(p_phone,''));
  if v_login ~ '[a-zA-Z]' then
    select * into v_sup from fs_supervisors where username = fs_norm_username(v_login);
  else
    select * into v_sup from fs_supervisors where phone = fs_norm_phone(v_login);
  end if;
  if not found or not v_sup.active then
    raise exception 'Invalid name/phone or PIN' using errcode = '28000';
  end if;
  if v_sup.locked_until is not null and v_sup.locked_until > now() then
    raise exception 'Too many attempts. Try again in a few minutes.' using errcode = '28000';
  end if;
  if v_sup.pin_hash <> crypt(coalesce(p_pin,''), v_sup.pin_hash) then
    update fs_supervisors
       set failed_attempts = failed_attempts + 1,
           locked_until = case when failed_attempts + 1 >= 8
                               then now() + interval '15 minutes' else null end
     where id = v_sup.id;
    raise exception 'Invalid name/phone or PIN' using errcode = '28000';
  end if;

  update fs_supervisors set failed_attempts = 0, locked_until = null where id = v_sup.id;
  v_token := encode(gen_random_bytes(32), 'hex');
  insert into fs_sessions (token_hash, supervisor_id, expires_at)
  values (fs_token_hash(v_token), v_sup.id, now() + interval '60 days');
  delete from fs_sessions where expires_at < now();

  return jsonb_build_object(
    'token', v_token,
    'supervisor', jsonb_build_object('id', v_sup.id, 'name', v_sup.name, 'role', v_sup.role,
                                     'username', v_sup.username,
                                     'assigned_site_ids', to_jsonb(v_sup.assigned_site_ids))
  );
end $$;

create or replace function fs_bootstrap(p_token text)
returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare
  v_sup fs_supervisors;
begin
  v_sup := fs_auth(p_token);
  return jsonb_build_object(
    'supervisor', jsonb_build_object('id', v_sup.id, 'name', v_sup.name,
                                     'phone', v_sup.phone, 'role', v_sup.role,
                                     'username', v_sup.username,
                                     'assigned_site_ids', to_jsonb(v_sup.assigned_site_ids)),
    'sites', (select coalesce(jsonb_agg(to_jsonb(s) order by s.id), '[]'::jsonb) from fs_sites s),
    'farms', (select coalesce(jsonb_agg(to_jsonb(f) order by f.id), '[]'::jsonb) from fs_farms f),
    'progress', fs_progress(p_token)
  );
end $$;

-- New signature (adds p_username); drop the old 5-arg version so no overload lingers.
drop function if exists fs_add_supervisor(text, text, text, text, text);
create or replace function fs_add_supervisor(p_token text, p_name text, p_phone text,
                                             p_pin text, p_role text default 'supervisor',
                                             p_username text default null)
returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare
  v_sup fs_supervisors;
  v_phone text;
  v_user text;
  v_id uuid;
begin
  v_sup := fs_auth(p_token);
  if v_sup.role <> 'manager' then
    raise exception 'Managers only' using errcode = '28000';
  end if;
  if coalesce(p_pin,'') !~ '^\d{4,8}$' then
    raise exception 'PIN must be 4-8 digits';
  end if;
  if p_role not in ('supervisor','manager') then
    raise exception 'Invalid role';
  end if;
  v_phone := case when trim(coalesce(p_phone,'')) = '' then null else fs_norm_phone(p_phone) end;
  v_user  := case when trim(coalesce(p_username,'')) = '' then null else fs_norm_username(p_username) end;
  if v_phone is null and v_user is null then
    raise exception 'Provide a username or a phone number';
  end if;
  if v_phone is not null and length(v_phone) < 4 then
    raise exception 'Invalid phone number';
  end if;
  if v_user is not null and length(v_user) < 3 then
    raise exception 'Username must be at least 3 letters';
  end if;
  insert into fs_supervisors (name, phone, username, pin_hash, role)
  values (trim(p_name), v_phone, v_user, crypt(p_pin, gen_salt('bf')), p_role)
  returning id into v_id;
  return jsonb_build_object('ok', true, 'id', v_id);
exception when unique_violation then
  raise exception 'That username or phone number is already registered';
end $$;
grant execute on function fs_add_supervisor(text, text, text, text, text, text) to anon;

-- v2 fs_activity: 'team' entries additionally carry username + station names.
create or replace function fs_activity(p_token text)
returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare
  v_sup fs_supervisors;
begin
  v_sup := fs_auth(p_token);
  if v_sup.role <> 'manager' then
    raise exception 'Managers only' using errcode = '28000';
  end if;
  return (
    with visit_quality as (
      select v.id,
             count(r.id) filter (where r.value is not null) as readings_count,
             count(r.id) filter (where r.value is not null and (
               (r.parameter = 'moisture'    and (r.value < 0   or r.value > 100)) or
               (r.parameter = 'ph'          and (r.value < 3   or r.value > 10))  or
               (r.parameter = 'ec'          and (r.value < 0   or r.value > 20000)) or
               (r.parameter = 'temperature' and (r.value < -5  or r.value > 60)) or
               (r.parameter in ('n','p','k') and (r.value < 0  or r.value > 3000))
             )) as out_of_range
      from fs_visits v
      left join fs_readings r on r.visit_id = v.id
      group by v.id
    )
    select jsonb_build_object(
      'visits', (
        select coalesce(jsonb_agg(rec order by rec->>'synced_at' desc), '[]'::jsonb) from (
          select jsonb_build_object(
            'id', v.id, 'supervisor', s.name, 'site', st.sub_area, 'rc', st.rc,
            'district', st.district, 'farm', f.label,
            'started_at', v.started_at, 'submitted_at', v.submitted_at, 'synced_at', v.synced_at,
            'gps_lat', v.gps_lat, 'gps_lon', v.gps_lon,
            'distance_from_site_m', v.distance_from_site_m,
            'gps_flag', coalesce(v.distance_from_site_m > 500, v.gps_lat is null),
            'readings_count', q.readings_count, 'out_of_range', q.out_of_range,
            'sample_collected', v.sample_collected, 'sample_id', v.sample_id,
            'photos', (select count(*) from fs_photos p where p.visit_id = v.id),
            'notes', v.notes
          ) as rec
          from fs_visits v
          join fs_supervisors s on s.id = v.supervisor_id
          join fs_sites st on st.id = v.site_id
          left join fs_farms f on f.id = v.farm_id
          left join visit_quality q on q.id = v.id
          order by v.synced_at desc
          limit 200
        ) t
      ),
      'team', (
        select coalesce(jsonb_agg(jsonb_build_object(
          'id', s.id, 'name', s.name, 'phone', s.phone, 'username', s.username,
          'role', s.role, 'active', s.active,
          'station', (select string_agg(st.sub_area, ' + ' order by st.id)
                      from fs_sites st where st.id = any(s.assigned_site_ids)),
          'visits', (select count(*) from fs_visits v where v.supervisor_id = s.id),
          'last_synced_at', (select max(v.synced_at) from fs_visits v where v.supervisor_id = s.id),
          'last_gps', (select jsonb_build_object('lat', v.gps_lat, 'lon', v.gps_lon,
                                                 'site', st.sub_area, 'at', v.synced_at)
                       from fs_visits v join fs_sites st on st.id = v.site_id
                       where v.supervisor_id = s.id and v.gps_lat is not null
                       order by v.synced_at desc limit 1)
        ) order by s.name), '[]'::jsonb)
        from fs_supervisors s
      )
    )
  );
end $$;

-- Officer accounts are seeded with usernames = first names (duplicates get a
-- surname initial, e.g. rorisangt / rorisangs) and per-officer PINs (not
-- committed). Add phones when known:
--   update fs_supervisors set phone = fs_norm_phone('<number>') where username = '<username>';

-- =============================================================================
-- v3 (2026-08): station enforcement — a supervisor with assigned_site_ids may
-- only submit visits for those sites (managers/unassigned unrestricted).
-- Applied as migration fs_enforce_assigned_station. Change adds this guard to
-- fs_submit_visit immediately after the site lookup:
--
--   if v_sup.role = 'supervisor'
--      and coalesce(array_length(v_sup.assigned_site_ids, 1), 0) > 0
--      and not (v_site.id = any(v_sup.assigned_site_ids)) then
--     raise exception 'You can only record visits at your own station (%)',
--       (select string_agg(sub_area, ' + ') from fs_sites
--        where id = any(v_sup.assigned_site_ids));
--   end if;
--
-- Assign / change a station:
--   update fs_supervisors set assigned_site_ids = array[<site_id>[, <site_id>]]
--   where username = '<username>';

-- =============================================================================
-- v4 (2026-08): farmer register/engagement, AI-administered flag, issues,
-- optional soil data. Applied as migration fs_farmers_ai_and_issues.
-- Summary of changes (full bodies live in the applied migration):
--   * new table fs_farmers (id, site_id, name, village, gender, age, production,
--     field_size, crops, system, phone, source profiled|fs_registered,
--     registered_by, active) — deny-all RLS; 339 profiled farmers seeded from
--     the "AI Farm Data in Resource Centre" workbook (matched to sites by GPS).
--   * fs_visits gains farmer_id (FK), ai_administered boolean, issue text.
--   * new RPC fs_register_farmer(p_token, p_farmer jsonb) — idempotent by
--     client uuid, station-locked, records registered_by.
--   * fs_submit_visit accepts farmer_id/ai_administered/issue and validates
--     the farmer belongs to the visit's site.
--   * fs_bootstrap returns 'farmers' scoped to the supervisor's station(s).
--   * fs_progress totals add farmers, farmers_engaged, ai_visits, issues;
--     per-site adds farmers_total / farmers_engaged.
--   * fs_activity visit rows add farmer name, ai_administered, issue; team rows
--     add farmers_registered.
-- To rebuild a fresh project: run this file, then re-apply migration
-- fs_farmers_ai_and_issues from the Supabase dashboard history (or ask Claude
-- to re-emit it), then re-seed farmers from the workbook.

-- =============================================================================
-- v5 (2026-08): farmer editing + mandatory visit fields.
-- Applied as migration fs_farmer_edit_and_mandatory_visit_fields.
--   * fs_register_farmer is now an upsert: an existing id updates name/village/
--     gender/age/phone (site_id and source/registered_by never change; station
--     lock applies to both the payload site and the farmer's existing site).
--   * fs_submit_visit rejects submissions missing GPS coordinates, an explicit
--     ai_administered answer (true/false), or at least one photo.
-- =============================================================================
