-- =============================================================================
-- v11: managers can remove a visit — reversibly
--
-- Removal is reached by swiping a row, which is very easy to trigger by
-- accident on a phone, and a visit carries GPS and a photo that cannot be
-- re-taken. So nothing is destroyed: the visit, its readings and its photos are
-- copied into fs_deleted_visits first, then removed from the live tables.
--
-- Archiving rather than flagging is deliberate. A `deleted_at` column would
-- have meant adding "and deleted_at is null" to fs_activity, fs_progress and
-- all four drill-down RPCs — six large functions to edit, each a chance to miss
-- one and leave deleted visits silently counted in the programme's totals.
-- Moving the row out means every existing query is correct without being
-- touched.
--
-- Applied to project AI-FS as migration fs_delete_visit.
-- =============================================================================

begin;

create table if not exists fs_deleted_visits (
  visit_id   uuid primary key,
  visit      jsonb not null,             -- the fs_visits row as it stood
  readings   jsonb not null default '[]'::jsonb,
  photos     jsonb not null default '[]'::jsonb,
  edits      jsonb not null default '[]'::jsonb,
  deleted_by uuid not null references fs_supervisors(id),
  deleted_at timestamptz not null default now(),
  reason     text
);

alter table fs_deleted_visits enable row level security;
revoke all on fs_deleted_visits from anon, authenticated;

create or replace function fs_delete_visit(p_token text, p_visit_id uuid,
                                           p_reason text default null)
returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare
  v_sup fs_supervisors;
  v_vis fs_visits;
begin
  v_sup := fs_auth(p_token);
  if v_sup.role <> 'manager' then
    raise exception 'Managers only' using errcode = '28000';
  end if;

  select * into v_vis from fs_visits where id = p_visit_id;
  if not found then
    raise exception 'Unknown visit';
  end if;

  insert into fs_deleted_visits (visit_id, visit, readings, photos, edits, deleted_by, reason)
  values (
    p_visit_id,
    to_jsonb(v_vis),
    coalesce((select jsonb_agg(to_jsonb(r) order by r.parameter, r.replicate)
              from fs_readings r where r.visit_id = p_visit_id), '[]'::jsonb),
    coalesce((select jsonb_agg(to_jsonb(p) order by p.created_at)
              from fs_photos p where p.visit_id = p_visit_id), '[]'::jsonb),
    coalesce((select jsonb_agg(to_jsonb(e) order by e.edited_at)
              from fs_visit_edits e where e.visit_id = p_visit_id), '[]'::jsonb),
    v_sup.id, nullif(trim(coalesce(p_reason,'')),'')
  )
  on conflict (visit_id) do update set
    visit = excluded.visit, readings = excluded.readings, photos = excluded.photos,
    edits = excluded.edits, deleted_by = excluded.deleted_by,
    deleted_at = now(), reason = excluded.reason;

  delete from fs_visits where id = p_visit_id;   -- readings/photos/edits cascade

  return jsonb_build_object('ok', true, 'visit_id', p_visit_id);
end $$;

-- Undo, for the accidental swipe.
create or replace function fs_restore_visit(p_token text, p_visit_id uuid)
returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare
  v_sup fs_supervisors;
  v_arc fs_deleted_visits;
  r jsonb;
begin
  v_sup := fs_auth(p_token);
  if v_sup.role <> 'manager' then
    raise exception 'Managers only' using errcode = '28000';
  end if;

  select * into v_arc from fs_deleted_visits where visit_id = p_visit_id;
  if not found then
    raise exception 'That visit is not in the deleted list';
  end if;
  if exists (select 1 from fs_visits where id = p_visit_id) then
    raise exception 'That visit is already back';
  end if;

  insert into fs_visits select * from jsonb_populate_record(null::fs_visits, v_arc.visit);

  for r in select * from jsonb_array_elements(v_arc.readings) loop
    insert into fs_readings (visit_id, parameter, replicate, value, unit)
    values (p_visit_id, r->>'parameter', (r->>'replicate')::int,
            nullif(r->>'value','')::numeric, r->>'unit')
    on conflict (visit_id, parameter, replicate) do nothing;
  end loop;

  for r in select * from jsonb_array_elements(v_arc.photos) loop
    insert into fs_photos (id, visit_id, mime, data_base64, created_at)
    values ((r->>'id')::uuid, p_visit_id, coalesce(r->>'mime','image/jpeg'),
            r->>'data_base64', coalesce((r->>'created_at')::timestamptz, now()))
    on conflict (id) do nothing;
  end loop;

  for r in select * from jsonb_array_elements(v_arc.edits) loop
    insert into fs_visit_edits (id, visit_id, edited_by, edited_at, changes)
    values ((r->>'id')::uuid, p_visit_id, (r->>'edited_by')::uuid,
            (r->>'edited_at')::timestamptz, r->'changes')
    on conflict (id) do nothing;
  end loop;

  delete from fs_deleted_visits where visit_id = p_visit_id;
  return jsonb_build_object('ok', true, 'visit_id', p_visit_id);
end $$;

-- What has been removed, so it can be reviewed or put back.
create or replace function fs_deleted_visits_list(p_token text)
returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare v_sup fs_supervisors;
begin
  v_sup := fs_auth(p_token);
  perform fs_guard_monitor(v_sup.role);
  return (
    select coalesce(jsonb_agg(jsonb_build_object(
      'visit_id', dv.visit_id,
      'supervisor', s.name,
      'site', st.sub_area,
      'submitted_at', dv.visit->>'submitted_at',
      'deleted_at', dv.deleted_at,
      'deleted_by', db.name,
      'reason', dv.reason,
      'photos', jsonb_array_length(dv.photos),
      'readings', jsonb_array_length(dv.readings)
    ) order by dv.deleted_at desc), '[]'::jsonb)
    from fs_deleted_visits dv
    left join fs_supervisors s on s.id = (dv.visit->>'supervisor_id')::uuid
    left join fs_sites st on st.id = (dv.visit->>'site_id')::int
    left join fs_supervisors db on db.id = dv.deleted_by
  );
end $$;

grant execute on function fs_delete_visit(text, uuid, text)  to anon;
grant execute on function fs_restore_visit(text, uuid)       to anon;
grant execute on function fs_deleted_visits_list(text)       to anon;

commit;
