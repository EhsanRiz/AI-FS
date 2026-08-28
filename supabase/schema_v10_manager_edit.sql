-- =============================================================================
-- FS Field Monitoring — schema v10: manager data corrections
-- 4D Climate Solutions — AI-Powered Extension for Agricultural Resilience
--
-- WHAT THIS ADDS
-- Managers can now correct synced visit data from inside the app — no SQL:
--   * fs_update_visit  — manager-only RPC that corrects a synced visit's
--     advisory answer, farmer, farm, issue, notes, sample and soil readings.
--     GPS, photos, timestamps, site and supervisor are the field evidence a
--     visit happened and stay immutable.
--   * fs_visit_edits   — audit log. Every correction records who, when and the
--     exact old → new values; fs_visit_detail surfaces the history so edits
--     are never silent (this is research data).
--   * fs_set_supervisor gains p_role, so a manager can change an account's
--     role from the Dashboard (e.g. promote a viewer to manager) — with a
--     guard against changing your own role.
--   * fs_visit_detail now also returns site_id / farmer_id / farm_id (the raw
--     ids the edit form needs) and the edit history.
--
-- RUN ORDER for a fresh project: schema.sql → schema_v4_v9.sql → this file
-- (then seed + farmer list, see REBUILD.md). Safe to run more than once.
-- =============================================================================

begin;

-- ---------------------------------------------------------------------------
-- v10a: audit log — one row per correction, old → new values as jsonb
-- ---------------------------------------------------------------------------

create table if not exists fs_visit_edits (
  id         uuid primary key default gen_random_uuid(),
  visit_id   uuid not null references fs_visits(id) on delete cascade,
  edited_by  uuid not null references fs_supervisors(id),
  edited_at  timestamptz not null default now(),
  changes    jsonb not null            -- {field: {from: …, to: …}, …}
);

create index if not exists fs_visit_edits_visit_idx on fs_visit_edits (visit_id);

alter table fs_visit_edits enable row level security;
revoke all on fs_visit_edits from anon, authenticated;

-- ---------------------------------------------------------------------------
-- v10b: correct a synced visit (managers only)
-- Only keys present in p_patch are touched; p_readings null = leave readings
-- alone. Unchanged values are not logged, and a no-op call writes no audit row.
-- ---------------------------------------------------------------------------

create or replace function fs_update_visit(p_token text, p_visit_id uuid,
                                           p_patch jsonb default '{}'::jsonb,
                                           p_readings jsonb default null)
returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare
  v_sup      fs_supervisors;
  v_vis      fs_visits;
  v_changes  jsonb := '{}'::jsonb;
  v_farmer   fs_farmers;
  v_farm     fs_farms;
  v_bool     boolean;
  v_text     text;
  v_uuid     uuid;
  v_int      int;
  v_old_read jsonb;
  v_new_read jsonb;
begin
  v_sup := fs_auth(p_token);
  if v_sup.role <> 'manager' then
    raise exception 'Managers only' using errcode = '28000';
  end if;

  select * into v_vis from fs_visits where id = p_visit_id;
  if not found then
    raise exception 'Unknown visit';
  end if;

  -- advisory answer: mandatory at capture, so it cannot be blanked -----------
  if p_patch ? 'ai_administered' then
    v_bool := (p_patch->>'ai_administered')::boolean;
    if v_bool is null then
      raise exception 'Record whether the AI advisory was administered';
    end if;
    if v_bool is distinct from v_vis.ai_administered then
      v_changes := v_changes || jsonb_build_object('ai_administered',
        jsonb_build_object('from', v_vis.ai_administered, 'to', v_bool));
      v_vis.ai_administered := v_bool;
    end if;
  end if;

  -- farmer: must exist at the visit's site; null = general visit -------------
  if p_patch ? 'farmer_id' then
    v_uuid := nullif(p_patch->>'farmer_id','')::uuid;
    if v_uuid is not null then
      select * into v_farmer from fs_farmers where id = v_uuid;
      if not found then
        raise exception 'Unknown farmer';
      end if;
      if v_farmer.site_id <> v_vis.site_id then
        raise exception 'That farmer is not registered at this site';
      end if;
    end if;
    if v_uuid is distinct from v_vis.farmer_id then
      v_changes := v_changes || jsonb_build_object('farmer_id',
        jsonb_build_object('from', v_vis.farmer_id, 'to', v_uuid));
      v_vis.farmer_id := v_uuid;
    end if;
  end if;

  -- validation farm: must belong to the visit's site --------------------------
  if p_patch ? 'farm_id' then
    v_int := nullif(p_patch->>'farm_id','')::int;
    if v_int is not null then
      select * into v_farm from fs_farms where id = v_int;
      if not found or v_farm.site_id <> v_vis.site_id then
        raise exception 'That farm is not at this site';
      end if;
    end if;
    if v_int is distinct from v_vis.farm_id then
      v_changes := v_changes || jsonb_build_object('farm_id',
        jsonb_build_object('from', v_vis.farm_id, 'to', v_int));
      v_vis.farm_id := v_int;
    end if;
  end if;

  if p_patch ? 'issue' then
    v_text := nullif(trim(coalesce(p_patch->>'issue','')),'');
    if v_text is distinct from v_vis.issue then
      v_changes := v_changes || jsonb_build_object('issue',
        jsonb_build_object('from', v_vis.issue, 'to', v_text));
      v_vis.issue := v_text;
    end if;
  end if;

  if p_patch ? 'notes' then
    v_text := nullif(trim(coalesce(p_patch->>'notes','')),'');
    if v_text is distinct from v_vis.notes then
      v_changes := v_changes || jsonb_build_object('notes',
        jsonb_build_object('from', v_vis.notes, 'to', v_text));
      v_vis.notes := v_text;
    end if;
  end if;

  if p_patch ? 'sample_collected' then
    v_bool := coalesce((p_patch->>'sample_collected')::boolean, false);
    if v_bool is distinct from v_vis.sample_collected then
      v_changes := v_changes || jsonb_build_object('sample_collected',
        jsonb_build_object('from', v_vis.sample_collected, 'to', v_bool));
      v_vis.sample_collected := v_bool;
    end if;
  end if;

  if p_patch ? 'sample_id' then
    v_text := nullif(trim(coalesce(p_patch->>'sample_id','')),'');
    if v_text is distinct from v_vis.sample_id then
      v_changes := v_changes || jsonb_build_object('sample_id',
        jsonb_build_object('from', v_vis.sample_id, 'to', v_text));
      v_vis.sample_id := v_text;
    end if;
  end if;

  -- soil readings: full replacement, logged as old array → new array ---------
  -- Blank values are dropped on both sides so "left empty" and "absent"
  -- compare equal, exactly as the capture form treats them.
  if p_readings is not null then
    select coalesce(jsonb_agg(jsonb_build_object(
        'parameter', x.parameter, 'replicate', x.replicate,
        'value', x.value, 'unit', x.unit) order by x.parameter, x.replicate),
      '[]'::jsonb)
    into v_new_read
    from (
      select e->>'parameter' as parameter, (e->>'replicate')::int as replicate,
             nullif(e->>'value','')::numeric as value,
             coalesce(e->>'unit','') as unit
      from jsonb_array_elements(p_readings) e
      where nullif(e->>'value','') is not null
    ) x;

    select coalesce(jsonb_agg(jsonb_build_object(
        'parameter', r.parameter, 'replicate', r.replicate,
        'value', r.value, 'unit', coalesce(r.unit,'')) order by r.parameter, r.replicate),
      '[]'::jsonb)
    into v_old_read
    from fs_readings r
    where r.visit_id = p_visit_id and r.value is not null;

    if v_new_read is distinct from v_old_read then
      v_changes := v_changes || jsonb_build_object('readings',
        jsonb_build_object('from', v_old_read, 'to', v_new_read));
      delete from fs_readings where visit_id = p_visit_id;
      insert into fs_readings (visit_id, parameter, replicate, value, unit)
      select p_visit_id, e->>'parameter', (e->>'replicate')::int,
             (e->>'value')::numeric, e->>'unit'
      from jsonb_array_elements(v_new_read) e;
    end if;
  end if;

  if v_changes = '{}'::jsonb then
    return jsonb_build_object('ok', true, 'changed', false);
  end if;

  update fs_visits set
    ai_administered  = v_vis.ai_administered,
    farmer_id        = v_vis.farmer_id,
    farm_id          = v_vis.farm_id,
    issue            = v_vis.issue,
    notes            = v_vis.notes,
    sample_collected = v_vis.sample_collected,
    sample_id        = v_vis.sample_id
  where id = p_visit_id;

  insert into fs_visit_edits (visit_id, edited_by, changes)
  values (p_visit_id, v_sup.id, v_changes);

  return jsonb_build_object('ok', true, 'changed', true, 'changes', v_changes);
end $$;

-- ---------------------------------------------------------------------------
-- v10c: fs_visit_detail — add the raw ids the edit form needs + edit history
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
        'site_id', v.site_id, 'farmer_id', v.farmer_id, 'farm_id', v.farm_id,
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
               from fs_photos p where p.visit_id = p_visit_id),
    'edits', (select coalesce(jsonb_agg(jsonb_build_object(
                'by', s2.name, 'at', e.edited_at, 'changes', e.changes)
                order by e.edited_at desc), '[]'::jsonb)
              from fs_visit_edits e
              join fs_supervisors s2 on s2.id = e.edited_by
              where e.visit_id = p_visit_id)
  );
end $$;

-- ---------------------------------------------------------------------------
-- v10d: fs_set_supervisor gains p_role — role changes from the Dashboard.
-- The old 5-arg signature must be dropped: leaving both overloads in place
-- makes PostgREST's named-parameter dispatch ambiguous (same as the v8
-- fs_add_supervisor change).
-- ---------------------------------------------------------------------------

drop function if exists fs_set_supervisor(text, uuid, boolean, text, text);

create or replace function fs_set_supervisor(p_token text, p_id uuid,
                                             p_active boolean default null,
                                             p_new_pin text default null,
                                             p_name text default null,
                                             p_role text default null)
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
  if p_role is not null then
    if p_role not in ('supervisor','manager','viewer') then
      raise exception 'Invalid role';
    end if;
    -- a manager demoting themselves would lock the team out of management
    if p_id = v_sup.id then
      raise exception 'You cannot change your own role';
    end if;
  end if;
  update fs_supervisors set
    active = coalesce(p_active, active),
    name = coalesce(nullif(trim(p_name),''), name),
    role = coalesce(p_role, role),
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
-- Grants: RPCs only. The tables stay deny-all.
-- ---------------------------------------------------------------------------

grant execute on function fs_update_visit(text, uuid, jsonb, jsonb)          to anon;
grant execute on function fs_set_supervisor(text, uuid, boolean, text, text, text) to anon;

commit;
