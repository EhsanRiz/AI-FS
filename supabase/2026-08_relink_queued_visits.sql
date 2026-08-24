-- =============================================================================
-- Re-link visits queued on phones before the Aug-2026 rebuild
--
-- The rebuild gave every profiled farmer a NEW uuid (the old ones died with the
-- deleted project). Visits already sitting in a Field Supervisor's offline
-- queue still carry the OLD uuid, so without this they would be rejected as
-- 'Unknown farmer' and that FS's fieldwork would be lost on sync.
--
-- Two layers of recovery:
--   1. app.js now stamps farmer_name onto queued visits (resolved from the boot
--      cache the phone still holds) and sends it alongside farmer_id. An
--      unknown id is re-linked by name, within the visit's own site.
--   2. If it still cannot be matched, the visit is stored anyway with the
--      orphan reference kept in farmer_unmatched, instead of being refused.
--      A visit with GPS, a photo and an advisory answer is worth far more than
--      the farmer link, and the link can be reconciled later.
--
-- Applied to project AI-FS as migration fs_relink_queued_visits_after_rebuild.
-- Superseded by nothing — this is the current fs_submit_visit.
-- =============================================================================

alter table fs_visits add column if not exists farmer_unmatched text;

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
  v_fid    uuid;
  v_unmatched text;
  v_name   text;
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

  -- resolve the farmer: by id, else by name within this site, else keep the
  -- orphan reference so the visit itself still lands
  v_fid := nullif(p_visit->>'farmer_id','')::uuid;
  v_name := nullif(trim(coalesce(p_visit->>'farmer_name','')),'');
  if v_fid is not null then
    select * into v_farmer from fs_farmers where id = v_fid;
    if found and v_farmer.site_id <> v_site.id then
      raise exception 'That farmer is not registered at this site';
    end if;
    if not found then
      if v_name is not null then
        select * into v_farmer from fs_farmers
        where site_id = v_site.id and active
          and lower(regexp_replace(name, '[^a-zA-Z]', '', 'g'))
            = lower(regexp_replace(v_name, '[^a-zA-Z]', '', 'g'))
        limit 1;
      end if;
      if v_farmer.id is null then
        v_unmatched := coalesce(v_name || ' <' || v_fid::text || '>', v_fid::text);
        v_fid := null;
      else
        v_fid := v_farmer.id;
      end if;
    end if;
  end if;

  v_dist := round(fs_haversine_m((p_visit->>'gps_lat')::double precision,
                                 (p_visit->>'gps_lon')::double precision,
                                 v_site.lat, v_site.lon));

  insert into fs_visits as v (id, supervisor_id, site_id, farm_id, farmer_id,
    farmer_unmatched, ai_administered, issue, gps_lat, gps_lon, gps_accuracy_m,
    distance_from_site_m, started_at, submitted_at,
    sample_collected, sample_id, notes)
  values (
    v_id, v_sup.id, v_site.id, nullif(p_visit->>'farm_id','')::int,
    v_fid, v_unmatched, v_ai, nullif(trim(coalesce(p_visit->>'issue','')),''),
    (p_visit->>'gps_lat')::double precision, (p_visit->>'gps_lon')::double precision,
    (p_visit->>'gps_accuracy_m')::double precision, v_dist,
    (p_visit->>'started_at')::timestamptz, (p_visit->>'submitted_at')::timestamptz,
    coalesce((p_visit->>'sample_collected')::boolean, false),
    nullif(p_visit->>'sample_id',''), nullif(p_visit->>'notes','')
  )
  on conflict (id) do update set
    farm_id = excluded.farm_id, farmer_id = excluded.farmer_id,
    farmer_unmatched = excluded.farmer_unmatched,
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

  return jsonb_build_object('ok', true, 'visit_id', v_id,
                            'distance_from_site_m', v_dist,
                            'farmer_relinked', v_fid is not null and v_fid <> nullif(p_visit->>'farmer_id','')::uuid,
                            'farmer_unmatched', v_unmatched);
end $$;

grant execute on function fs_submit_visit(text, jsonb, jsonb, jsonb) to anon;

-- Reconciliation: after the FS have synced, list anything that could not be
-- matched so it can be fixed by hand.
--   select v.id, v.farmer_unmatched, s.name as fs, st.sub_area, v.submitted_at
--   from fs_visits v
--   join fs_supervisors s on s.id = v.supervisor_id
--   join fs_sites st on st.id = v.site_id
--   where v.farmer_unmatched is not null
--   order by v.submitted_at;
