-- =============================================================================
-- FS Field Monitoring — schema v4–v9, consolidated
-- 4D Climate Solutions — AI-Powered Extension for Agricultural Resilience
--
-- WHY THIS FILE EXISTS
-- These changes were originally applied one at a time through the Supabase
-- dashboard, and schema.sql recorded only prose describing them. When the
-- project was deleted (Aug 2026) the prose was all that remained, and the
-- database had to be rebuilt from the client contract in app.js. Nothing may
-- live only in the dashboard again: every object the app depends on is defined
-- here, in the repo.
--
-- RUN ORDER for a fresh project:
--   1. schema.sql             (v1–v3: tables, auth, core RPCs, 18 sites)
--   2. schema_v4_v9.sql       (this file)
--   3. seed_supervisors.sql   (21 accounts — NOT committed, see REBUILD.md)
--   4. 2026-08_farmer_list_update.sql  (344 farmers)
--
-- Safe to run more than once.
-- =============================================================================

begin;

-- ---------------------------------------------------------------------------
-- v4: farmer registry, AI-advisory flag, issues
-- ---------------------------------------------------------------------------

create table if not exists fs_farmers (
  id            uuid primary key default gen_random_uuid(),
  site_id       int not null references fs_sites(id),
  name          text not null,
  village       text,
  gender        text check (gender in ('F','M')),
  age           int,
  production    text,                    -- 'H' | 'A' | 'H+A'
  field_size    text,
  crops         text,
  system        text,
  phone         text,
  source        text not null default 'profiled' check (source in ('profiled','fs_registered')),
  registered_by uuid references fs_supervisors(id),
  active        boolean not null default true,
  created_at    timestamptz not null default now()
);

create index if not exists fs_farmers_site_idx on fs_farmers (site_id) where active;

alter table fs_visits add column if not exists farmer_id       uuid references fs_farmers(id);
alter table fs_visits add column if not exists ai_administered boolean;
alter table fs_visits add column if not exists issue           text;

create index if not exists fs_visits_farmer_idx on fs_visits (farmer_id);

alter table fs_farmers enable row level security;
revoke all on fs_farmers from anon, authenticated;

-- ---------------------------------------------------------------------------
-- v8: read-only 'viewer' role
-- Roles: supervisor (the only role that captures), manager (monitoring + team
-- management + farmer corrections), viewer (read-only).
-- ---------------------------------------------------------------------------

alter table fs_supervisors drop constraint if exists fs_supervisors_role_check;
alter table fs_supervisors add  constraint fs_supervisors_role_check
  check (role in ('supervisor','manager','viewer'));

create or replace function fs_guard_not_viewer(p_role text)
returns void language plpgsql immutable set search_path = public as $$
begin
  if p_role = 'viewer' then
    raise exception 'This is a view-only account' using errcode = '28000';
  end if;
end $$;

-- Monitoring RPCs are open to manager + viewer; team management stays manager.
create or replace function fs_guard_monitor(p_role text)
returns void language plpgsql immutable set search_path = public as $$
begin
  if p_role not in ('manager','viewer') then
    raise exception 'Not available for this account' using errcode = '28000';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- v4/v5/v7: farmer register + edit (upsert, idempotent by client uuid)
-- Station-locked for supervisors. Managers may correct any farmer's details.
-- ---------------------------------------------------------------------------

create or replace function fs_register_farmer(p_token text, p_farmer jsonb)
returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare
  v_sup      fs_supervisors;
  v_id       uuid;
  v_site     int;
  v_existing fs_farmers;
begin
  v_sup := fs_auth(p_token);
  perform fs_guard_not_viewer(v_sup.role);

  v_id   := nullif(p_farmer->>'id','')::uuid;
  v_site := nullif(p_farmer->>'site_id','')::int;

  if coalesce(trim(p_farmer->>'name'),'') = '' then
    raise exception 'Farmer name is required';
  end if;

  if v_id is not null then
    select * into v_existing from fs_farmers where id = v_id;
  end if;

  -- Station lock applies to the payload site AND to the farmer's existing site,
  -- so an FS cannot pull another station's farmer across to their own.
  if v_sup.role = 'supervisor'
     and coalesce(array_length(v_sup.assigned_site_ids, 1), 0) > 0 then
    if v_existing.id is null
       and not (coalesce(v_site, -1) = any(v_sup.assigned_site_ids)) then
      raise exception 'You can only register farmers at your own station (%)',
        (select string_agg(sub_area, ' + ' order by id) from fs_sites
         where id = any(v_sup.assigned_site_ids));
    end if;
    if v_existing.id is not null
       and not (v_existing.site_id = any(v_sup.assigned_site_ids)) then
      raise exception 'That farmer belongs to another station';
    end if;
  end if;

  if v_existing.id is not null then
    -- edit: site_id, source and registered_by never change
    update fs_farmers set
      name    = trim(p_farmer->>'name'),
      village = nullif(trim(coalesce(p_farmer->>'village','')),''),
      gender  = nullif(p_farmer->>'gender',''),
      age     = nullif(p_farmer->>'age','')::int,
      phone   = nullif(trim(coalesce(p_farmer->>'phone','')),'')
    where id = v_id;
    return jsonb_build_object('ok', true, 'id', v_id, 'created', false);
  end if;

  if v_site is null then
    raise exception 'Choose a site for this farmer';
  end if;

  insert into fs_farmers (id, site_id, name, village, gender, age, phone,
                          source, registered_by)
  values (coalesce(v_id, gen_random_uuid()), v_site, trim(p_farmer->>'name'),
          nullif(trim(coalesce(p_farmer->>'village','')),''),
          nullif(p_farmer->>'gender',''),
          nullif(p_farmer->>'age','')::int,
          nullif(trim(coalesce(p_farmer->>'phone','')),''),
          'fs_registered', v_sup.id)
  on conflict (id) do nothing
  returning id into v_id;

  return jsonb_build_object('ok', true, 'id', coalesce(v_id, (p_farmer->>'id')::uuid),
                            'created', v_id is not null);
end $$;

-- ---------------------------------------------------------------------------
-- v4/v5/v9: submit a visit
--   * carries farmer_id / ai_administered / issue
--   * GPS, an explicit advisory answer and >=1 photo are mandatory (the client
--     enforces the same rules; this is the authority)
--   * capture is Field-Supervisor-only, and station-locked
-- ---------------------------------------------------------------------------

create or replace function fs_submit_visit(p_token text, p_visit jsonb,
                                           p_readings jsonb default '[]'::jsonb,
                                           p_photos jsonb default '[]'::jsonb)
returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare
  v_sup    fs_supervisors;
  v_id     uuid;
  v_site   fs_sites;
  v_owner  uuid;
  v_dist   double precision;
  v_farmer fs_farmers;
  v_ai     boolean;
  r jsonb;
begin
  v_sup := fs_auth(p_token);
  perform fs_guard_not_viewer(v_sup.role);
  if v_sup.role <> 'supervisor' then
    raise exception 'Only Field Supervisors record visits' using errcode = '28000';
  end if;

  v_id := (p_visit->>'id')::uuid;
  select * into v_site from fs_sites where id = (p_visit->>'site_id')::int;
  if not found then
    raise exception 'Unknown site';
  end if;

  if coalesce(array_length(v_sup.assigned_site_ids, 1), 0) > 0
     and not (v_site.id = any(v_sup.assigned_site_ids)) then
    raise exception 'You can only record visits at your own station (%)',
      (select string_agg(sub_area, ' + ' order by id) from fs_sites
       where id = any(v_sup.assigned_site_ids));
  end if;

  select supervisor_id into v_owner from fs_visits where id = v_id;
  if found and v_owner <> v_sup.id then
    raise exception 'Visit id conflict';
  end if;

  -- mandatory fields ---------------------------------------------------------
  if (p_visit->>'gps_lat') is null or (p_visit->>'gps_lon') is null then
    raise exception 'GPS location is required — capture it before syncing';
  end if;
  v_ai := (p_visit->>'ai_administered')::boolean;
  if v_ai is null then
    raise exception 'Record whether the AI advisory was administered';
  end if;
  if jsonb_array_length(coalesce(p_photos, '[]'::jsonb)) < 1 then
    raise exception 'At least one photo is required';
  end if;

  if nullif(p_visit->>'farmer_id','') is not null then
    select * into v_farmer from fs_farmers where id = (p_visit->>'farmer_id')::uuid;
    if not found then
      raise exception 'Unknown farmer';
    end if;
    if v_farmer.site_id <> v_site.id then
      raise exception 'That farmer is not registered at this site';
    end if;
  end if;

  v_dist := round(fs_haversine_m((p_visit->>'gps_lat')::double precision,
                                 (p_visit->>'gps_lon')::double precision,
                                 v_site.lat, v_site.lon));

  insert into fs_visits as v (id, supervisor_id, site_id, farm_id, farmer_id,
    ai_administered, issue, gps_lat, gps_lon, gps_accuracy_m,
    distance_from_site_m, started_at, submitted_at,
    sample_collected, sample_id, notes)
  values (
    v_id, v_sup.id, v_site.id, nullif(p_visit->>'farm_id','')::int,
    nullif(p_visit->>'farmer_id','')::uuid, v_ai, nullif(trim(coalesce(p_visit->>'issue','')),''),
    (p_visit->>'gps_lat')::double precision, (p_visit->>'gps_lon')::double precision,
    (p_visit->>'gps_accuracy_m')::double precision, v_dist,
    (p_visit->>'started_at')::timestamptz, (p_visit->>'submitted_at')::timestamptz,
    coalesce((p_visit->>'sample_collected')::boolean, false),
    nullif(p_visit->>'sample_id',''), nullif(p_visit->>'notes','')
  )
  on conflict (id) do update set
    farm_id = excluded.farm_id, farmer_id = excluded.farmer_id,
    ai_administered = excluded.ai_administered, issue = excluded.issue,
    gps_lat = excluded.gps_lat, gps_lon = excluded.gps_lon,
    gps_accuracy_m = excluded.gps_accuracy_m,
    distance_from_site_m = excluded.distance_from_site_m,
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
    if length(r->>'data_base64') > 5600000 then
      raise exception 'Photo too large (max about 4 MB)';
    end if;
    insert into fs_photos (id, visit_id, mime, data_base64)
    values ((r->>'id')::uuid, v_id, coalesce(r->>'mime','image/jpeg'), r->>'data_base64');
  end loop;

  return jsonb_build_object('ok', true, 'visit_id', v_id, 'distance_from_site_m', v_dist);
end $$;

-- ---------------------------------------------------------------------------
-- v4/v6: progress — totals, per-site and per-supervisor intelligence
-- ---------------------------------------------------------------------------

create or replace function fs_progress(p_token text)
returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare v_sup fs_supervisors;
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
             count(distinct v.farmer_id) filter (where v.farmer_id is not null) as farmers_engaged,
             (select count(*) from fs_farmers fa
               where fa.site_id = s.id and fa.active) as farmers_total,
             count(distinct v.id) filter (where v.ai_administered) as ai_visits,
             count(distinct v.id) filter (where v.issue is not null) as issues,
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
      select s.id, s.name, s.username, s.role, s.active,
             count(v.id) as visits,
             count(v.id) filter (where v.synced_at > now() - interval '7 days') as visits_7d,
             count(distinct v.farmer_id) filter (where v.farmer_id is not null) as farmers_engaged,
             count(v.id) filter (where v.ai_administered) as ai_visits,
             count(v.id) filter (where v.issue is not null) as issues,
             (select count(*) from fs_farmers fa where fa.registered_by = s.id) as farmers_registered,
             max(v.synced_at) as last_synced_at
      from fs_supervisors s
      left join fs_visits v on v.supervisor_id = s.id
      where s.role = 'supervisor'          -- programme staff stay out of FS performance lists
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
        'visits_7d',(select count(*) from fs_visits where synced_at > now() - interval '7 days'),
        'farms_visited', (select count(distinct farm_id) from fs_visits where farm_id is not null),
        'farms_complete', (select count(*) from farm_readings where readings_done >= 21),
        'readings', (select count(*) from fs_readings where value is not null),
        'samples',  (select count(*) from fs_visits where sample_collected),
        'farmers',  (select count(*) from fs_farmers where active),
        'farmers_engaged', (select count(distinct farmer_id) from fs_visits where farmer_id is not null),
        'ai_visits',(select count(*) from fs_visits where ai_administered),
        'issues',   (select count(*) from fs_visits where issue is not null)
      ),
      'sites', (select coalesce(jsonb_agg(to_jsonb(p) order by p.is_validation_site desc, p.site_id), '[]'::jsonb)
                from per_site p),
      'supervisors', (select coalesce(jsonb_agg(to_jsonb(p) order by p.name), '[]'::jsonb)
                      from per_supervisor p)
    )
  );
end $$;

-- ---------------------------------------------------------------------------
-- v4/v7: bootstrap — everything the app caches for offline use
-- Farmers are scoped to a supervisor's station(s); staff see all.
-- ---------------------------------------------------------------------------

create or replace function fs_bootstrap(p_token text)
returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare v_sup fs_supervisors;
begin
  v_sup := fs_auth(p_token);
  return jsonb_build_object(
    'supervisor', jsonb_build_object('id', v_sup.id, 'name', v_sup.name,
                                     'phone', v_sup.phone, 'role', v_sup.role,
                                     'username', v_sup.username,
                                     'assigned_site_ids', to_jsonb(v_sup.assigned_site_ids)),
    'sites', (select coalesce(jsonb_agg(to_jsonb(s) order by s.id), '[]'::jsonb) from fs_sites s),
    'farms', (select coalesce(jsonb_agg(to_jsonb(f) order by f.id), '[]'::jsonb) from fs_farms f),
    'farmers', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'id', f.id, 'site_id', f.site_id, 'name', f.name, 'village', f.village,
        'gender', f.gender, 'age', f.age, 'production', f.production,
        'field_size', f.field_size, 'crops', f.crops, 'system', f.system,
        'phone', f.phone, 'source', f.source
      ) order by f.name), '[]'::jsonb)
      from fs_farmers f
      where f.active
        and (v_sup.role <> 'supervisor'
             or coalesce(array_length(v_sup.assigned_site_ids, 1), 0) = 0
             or f.site_id = any(v_sup.assigned_site_ids))
    ),
    'progress', fs_progress(p_token)
  );
end $$;

-- ---------------------------------------------------------------------------
-- v4: activity & data-quality feed (manager + viewer)
-- ---------------------------------------------------------------------------

create or replace function fs_activity(p_token text)
returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare v_sup fs_supervisors;
begin
  v_sup := fs_auth(p_token);
  perform fs_guard_monitor(v_sup.role);
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
            'district', st.district, 'farm', f.label, 'farmer', fa.name,
            'ai_administered', v.ai_administered, 'issue', v.issue,
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
          left join fs_farmers fa on fa.id = v.farmer_id
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
          'farmers_registered', (select count(*) from fs_farmers fa where fa.registered_by = s.id),
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
-- v7: drill-downs. Every stat in the app is tappable, so each one needs a
-- detail RPC behind it. Supervisors get their own station's data only.
-- ---------------------------------------------------------------------------

create or replace function fs_visit_detail(p_token text, p_visit_id uuid)
returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare
  v_sup fs_supervisors;
  v_vis fs_visits;
begin
  v_sup := fs_auth(p_token);
  select * into v_vis from fs_visits where id = p_visit_id;
  if not found then
    raise exception 'Unknown visit';
  end if;
  if v_sup.role = 'supervisor' and v_vis.supervisor_id <> v_sup.id then
    raise exception 'Not your visit' using errcode = '28000';
  end if;

  return jsonb_build_object(
    'visit', (
      select jsonb_build_object(
        'id', v.id, 'supervisor', s.name, 'site', st.sub_area, 'rc', st.rc,
        'farm', f.label, 'farmer', fa.name,
        'ai_administered', v.ai_administered, 'issue', v.issue,
        'started_at', v.started_at, 'submitted_at', v.submitted_at, 'synced_at', v.synced_at,
        'gps_lat', v.gps_lat, 'gps_lon', v.gps_lon, 'gps_accuracy_m', v.gps_accuracy_m,
        'distance_from_site_m', v.distance_from_site_m,
        'sample_collected', v.sample_collected, 'sample_id', v.sample_id, 'notes', v.notes)
      from fs_visits v
      join fs_supervisors s on s.id = v.supervisor_id
      join fs_sites st on st.id = v.site_id
      left join fs_farms f on f.id = v.farm_id
      left join fs_farmers fa on fa.id = v.farmer_id
      where v.id = p_visit_id
    ),
    'readings', (select coalesce(jsonb_agg(jsonb_build_object(
                   'parameter', r.parameter, 'replicate', r.replicate,
                   'value', r.value, 'unit', r.unit)
                   order by r.parameter, r.replicate), '[]'::jsonb)
                 from fs_readings r where r.visit_id = p_visit_id),
    'photos', (select coalesce(jsonb_agg(jsonb_build_object(
                 'id', p.id, 'mime', p.mime, 'data_base64', p.data_base64)
                 order by p.created_at), '[]'::jsonb)
               from fs_photos p where p.visit_id = p_visit_id)
  );
end $$;

create or replace function fs_farmer_detail(p_token text, p_farmer_id uuid)
returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare
  v_sup fs_supervisors;
  v_far fs_farmers;
begin
  v_sup := fs_auth(p_token);
  select * into v_far from fs_farmers where id = p_farmer_id;
  if not found then
    raise exception 'Unknown farmer';
  end if;
  if v_sup.role = 'supervisor'
     and coalesce(array_length(v_sup.assigned_site_ids, 1), 0) > 0
     and not (v_far.site_id = any(v_sup.assigned_site_ids)) then
    raise exception 'That farmer is at another station' using errcode = '28000';
  end if;

  return jsonb_build_object(
    'farmer', (
      select jsonb_build_object(
        'id', f.id, 'site_id', f.site_id, 'name', f.name, 'village', f.village,
        'gender', f.gender, 'age', f.age, 'production', f.production,
        'field_size', f.field_size, 'crops', f.crops, 'system', f.system,
        'phone', f.phone, 'source', f.source, 'active', f.active,
        'site', st.sub_area, 'rc', st.rc, 'district', st.district,
        'registered_by', rb.name)
      from fs_farmers f
      join fs_sites st on st.id = f.site_id
      left join fs_supervisors rb on rb.id = f.registered_by
      where f.id = p_farmer_id
    ),
    'stats', (
      select jsonb_build_object(
        'visits', count(*),
        'last_visit_at', max(v.synced_at),
        'ai_visits', count(*) filter (where v.ai_administered),
        'issues', count(*) filter (where v.issue is not null))
      from fs_visits v where v.farmer_id = p_farmer_id
    ),
    'visits', (
      select coalesce(jsonb_agg(rec order by rec->>'synced_at' desc), '[]'::jsonb) from (
        select jsonb_build_object(
          'id', v.id, 'supervisor', s.name,
          'ai_administered', v.ai_administered, 'issue', v.issue,
          'submitted_at', v.submitted_at, 'synced_at', v.synced_at,
          'readings_count', (select count(*) from fs_readings r
                              where r.visit_id = v.id and r.value is not null),
          'sample_collected', v.sample_collected, 'sample_id', v.sample_id,
          'notes', v.notes) as rec
        from fs_visits v
        join fs_supervisors s on s.id = v.supervisor_id
        where v.farmer_id = p_farmer_id
        order by v.synced_at desc
        limit 50
      ) t
    )
  );
end $$;

create or replace function fs_site_detail(p_token text, p_site_id int)
returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare v_sup fs_supervisors;
begin
  v_sup := fs_auth(p_token);
  if not exists (select 1 from fs_sites where id = p_site_id) then
    raise exception 'Unknown site';
  end if;

  return jsonb_build_object(
    'site', (select to_jsonb(s) from fs_sites s where s.id = p_site_id),
    'stats', (
      select jsonb_build_object(
        'visits', count(distinct v.id),
        'ai_visits', count(distinct v.id) filter (where v.ai_administered),
        'issues', count(distinct v.id) filter (where v.issue is not null),
        'samples', count(distinct v.id) filter (where v.sample_collected),
        'farmers_engaged', count(distinct v.farmer_id) filter (where v.farmer_id is not null),
        'farmers_total', (select count(*) from fs_farmers fa
                           where fa.site_id = p_site_id and fa.active),
        'farms_complete', (
          select count(*) from (
            select f.id from fs_farms f
            left join fs_visits v2 on v2.farm_id = f.id
            left join fs_readings r on r.visit_id = v2.id
            where f.site_id = p_site_id
            group by f.id
            having count(distinct (r.parameter, r.replicate))
                     filter (where r.value is not null) >= 21) c),
        'readings_done', (
          select count(*) from fs_readings r
          join fs_visits v3 on v3.id = r.visit_id
          where v3.site_id = p_site_id and r.value is not null),
        'readings_target', (select count(*) * 21 from fs_farms f where f.site_id = p_site_id))
      from fs_visits v where v.site_id = p_site_id
    ),
    'supervisors', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'id', s.id, 'name', s.name, 'username', s.username,
        'visits_here', (select count(*) from fs_visits v
                         where v.supervisor_id = s.id and v.site_id = p_site_id),
        'last_synced_at', (select max(v.synced_at) from fs_visits v
                            where v.supervisor_id = s.id and v.site_id = p_site_id)
      ) order by s.name), '[]'::jsonb)
      from fs_supervisors s
      where s.role = 'supervisor' and p_site_id = any(s.assigned_site_ids)
    ),
    'farmers', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'id', f.id, 'name', f.name, 'village', f.village,
        'visits', (select count(*) from fs_visits v where v.farmer_id = f.id),
        'ai_ever', exists (select 1 from fs_visits v
                            where v.farmer_id = f.id and v.ai_administered)
      ) order by f.name), '[]'::jsonb)
      from fs_farmers f where f.site_id = p_site_id and f.active
    ),
    'visits', (
      select coalesce(jsonb_agg(rec order by rec->>'synced_at' desc), '[]'::jsonb) from (
        select jsonb_build_object(
          'id', v.id, 'supervisor', s.name, 'site', st.sub_area, 'rc', st.rc,
          'farmer', fa.name, 'ai_administered', v.ai_administered, 'issue', v.issue,
          'submitted_at', v.submitted_at, 'synced_at', v.synced_at,
          'gps_lat', v.gps_lat, 'gps_lon', v.gps_lon,
          'distance_from_site_m', v.distance_from_site_m,
          'gps_flag', coalesce(v.distance_from_site_m > 500, v.gps_lat is null),
          'readings_count', (select count(*) from fs_readings r
                              where r.visit_id = v.id and r.value is not null),
          'photos', (select count(*) from fs_photos p where p.visit_id = v.id)) as rec
        from fs_visits v
        join fs_supervisors s on s.id = v.supervisor_id
        join fs_sites st on st.id = v.site_id
        left join fs_farmers fa on fa.id = v.farmer_id
        where v.site_id = p_site_id
        order by v.synced_at desc
        limit 50
      ) t
    )
  );
end $$;

create or replace function fs_supervisor_detail(p_token text, p_supervisor_id uuid)
returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare v_sup fs_supervisors;
begin
  v_sup := fs_auth(p_token);
  -- an FS may look at their own card; staff may look at anyone's
  if v_sup.role = 'supervisor' and v_sup.id <> p_supervisor_id then
    perform fs_guard_monitor(v_sup.role);
  end if;
  if not exists (select 1 from fs_supervisors where id = p_supervisor_id) then
    raise exception 'Unknown team member';
  end if;

  return jsonb_build_object(
    'supervisor', (
      select jsonb_build_object(
        'id', s.id, 'name', s.name, 'username', s.username, 'phone', s.phone,
        'role', s.role, 'active', s.active,
        'station', (select string_agg(st.sub_area, ' + ' order by st.id)
                    from fs_sites st where st.id = any(s.assigned_site_ids)))
      from fs_supervisors s where s.id = p_supervisor_id
    ),
    'stats', (
      select jsonb_build_object(
        'visits', count(*),
        'visits_7d', count(*) filter (where v.synced_at > now() - interval '7 days'),
        'ai_visits', count(*) filter (where v.ai_administered),
        'issues', count(*) filter (where v.issue is not null),
        'samples', count(*) filter (where v.sample_collected),
        'farmers_engaged', count(distinct v.farmer_id) filter (where v.farmer_id is not null),
        'farmers_registered', (select count(*) from fs_farmers fa
                                where fa.registered_by = p_supervisor_id),
        'last_synced_at', max(v.synced_at),
        'last_gps', (select jsonb_build_object('lat', v2.gps_lat, 'lon', v2.gps_lon,
                                               'site', st.sub_area, 'at', v2.synced_at)
                     from fs_visits v2 join fs_sites st on st.id = v2.site_id
                     where v2.supervisor_id = p_supervisor_id and v2.gps_lat is not null
                     order by v2.synced_at desc limit 1))
      from fs_visits v where v.supervisor_id = p_supervisor_id
    ),
    'visits', (
      select coalesce(jsonb_agg(rec order by rec->>'synced_at' desc), '[]'::jsonb) from (
        select jsonb_build_object(
          'id', v.id, 'supervisor', s.name, 'site', st.sub_area, 'rc', st.rc,
          'farmer', fa.name, 'ai_administered', v.ai_administered, 'issue', v.issue,
          'submitted_at', v.submitted_at, 'synced_at', v.synced_at,
          'gps_lat', v.gps_lat, 'gps_lon', v.gps_lon,
          'distance_from_site_m', v.distance_from_site_m,
          'gps_flag', coalesce(v.distance_from_site_m > 500, v.gps_lat is null),
          'readings_count', (select count(*) from fs_readings r
                              where r.visit_id = v.id and r.value is not null),
          'photos', (select count(*) from fs_photos p where p.visit_id = v.id)) as rec
        from fs_visits v
        join fs_supervisors s on s.id = v.supervisor_id
        join fs_sites st on st.id = v.site_id
        left join fs_farmers fa on fa.id = v.farmer_id
        where v.supervisor_id = p_supervisor_id
        order by v.synced_at desc
        limit 20
      ) t
    )
  );
end $$;

-- ---------------------------------------------------------------------------
-- v8: fs_add_supervisor accepts the viewer role
-- ---------------------------------------------------------------------------

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
  if p_role not in ('supervisor','manager','viewer') then
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

-- ---------------------------------------------------------------------------
-- Grants: RPCs only. The tables stay deny-all.
-- ---------------------------------------------------------------------------

grant execute on function fs_register_farmer(text, jsonb)                to anon;
grant execute on function fs_submit_visit(text, jsonb, jsonb, jsonb)     to anon;
grant execute on function fs_progress(text)                              to anon;
grant execute on function fs_bootstrap(text)                             to anon;
grant execute on function fs_activity(text)                              to anon;
grant execute on function fs_visit_detail(text, uuid)                    to anon;
grant execute on function fs_farmer_detail(text, uuid)                   to anon;
grant execute on function fs_site_detail(text, int)                      to anon;
grant execute on function fs_supervisor_detail(text, uuid)               to anon;
grant execute on function fs_add_supervisor(text, text, text, text, text, text) to anon;
revoke execute on function fs_guard_not_viewer(text) from public, anon, authenticated;
revoke execute on function fs_guard_monitor(text)    from public, anon, authenticated;

commit;
