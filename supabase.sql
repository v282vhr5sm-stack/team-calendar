-- 팀 캘린더 — Supabase 대시보드 > SQL Editor 에 전체 붙여넣고 Run (한 번만, 다시 실행해도 안전)
-- 견적 앱과 같은 프로젝트를 쓰지만 cal_ 로 시작하는 별도 테이블이라 서로 영향이 없습니다.

-- 1) 테이블 -----------------------------------------------------------------
create table if not exists public.cal_settings (
  owner uuid primary key default auth.uid() references auth.users(id) on delete cascade,
  company text not null default ''
);

create table if not exists public.cal_groups (
  id uuid primary key default gen_random_uuid(),
  owner uuid not null default auth.uid() references auth.users(id) on delete cascade,
  name text not null,
  color text not null default '#2563eb',
  token text not null unique default (replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '')),
  created_at timestamptz not null default now()
);

create table if not exists public.cal_events (
  id uuid primary key default gen_random_uuid(),
  owner uuid not null default auth.uid() references auth.users(id) on delete cascade,
  title text not null,
  memo text not null default '',
  day date not null,
  start_time time,
  end_time time,
  group_ids uuid[] not null default '{}',
  done boolean not null default false,
  done_by text,
  done_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists cal_events_owner_day on public.cal_events (owner, day);
create index if not exists cal_events_groups on public.cal_events using gin (group_ids);

-- 2) 권한: 대표(로그인한 본인)만 자기 데이터를 읽고 쓸 수 있음 -------------------
alter table public.cal_settings enable row level security;
alter table public.cal_groups   enable row level security;
alter table public.cal_events   enable row level security;

drop policy if exists "cal_settings owner" on public.cal_settings;
create policy "cal_settings owner" on public.cal_settings for all to authenticated
  using (auth.uid() = owner) with check (auth.uid() = owner);
drop policy if exists "cal_groups owner" on public.cal_groups;
create policy "cal_groups owner" on public.cal_groups for all to authenticated
  using (auth.uid() = owner) with check (auth.uid() = owner);
drop policy if exists "cal_events owner" on public.cal_events;
create policy "cal_events owner" on public.cal_events for all to authenticated
  using (auth.uid() = owner) with check (auth.uid() = owner);

grant select, insert, update, delete on public.cal_settings, public.cal_groups, public.cal_events to authenticated;
revoke all on public.cal_settings, public.cal_groups, public.cal_events from anon;

-- 3) 직원용: 링크(token)를 아는 사람만 그 그룹 일정을 "보기" + "완료 체크"만 가능 ------
create or replace function public.cal_view(p_token text, p_from date, p_to date)
returns jsonb language plpgsql security definer stable set search_path = public as $$
declare g public.cal_groups;
begin
  select * into g from public.cal_groups where token = p_token;
  if not found then return null; end if;
  if p_to - p_from > 120 then p_to := p_from + 120; end if;
  return jsonb_build_object(
    'group', jsonb_build_object('name', g.name, 'color', g.color),
    'company', coalesce((select s.company from public.cal_settings s where s.owner = g.owner), ''),
    'events', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', e.id, 'title', e.title, 'memo', e.memo, 'day', e.day,
        'start_time', e.start_time, 'end_time', e.end_time,
        'done', e.done, 'done_by', e.done_by, 'done_at', e.done_at)
        order by e.day, e.start_time nulls first, e.created_at)
      from public.cal_events e
      where g.id = any(e.group_ids) and e.day between p_from and p_to), '[]'::jsonb));
end $$;

create or replace function public.cal_set_done(p_token text, p_event uuid, p_done boolean, p_name text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare r public.cal_events;
begin
  update public.cal_events e set
    done = p_done,
    done_by = case when p_done then nullif(left(trim(coalesce(p_name, '')), 30), '') end,
    done_at = case when p_done then now() end,
    updated_at = now()
  where e.id = p_event
    and exists (select 1 from public.cal_groups g where g.token = p_token and g.id = any(e.group_ids))
  returning * into r;
  if not found then raise exception 'not allowed'; end if;
  return jsonb_build_object('done', r.done, 'done_by', r.done_by, 'done_at', r.done_at);
end $$;

revoke all on function public.cal_view(text, date, date) from public;
revoke all on function public.cal_set_done(text, uuid, boolean, text) from public;
grant execute on function public.cal_view(text, date, date) to anon, authenticated;
grant execute on function public.cal_set_done(text, uuid, boolean, text) to anon, authenticated;

-- 4) 실시간 알림: 변경이 생기면 해당 화면들에 "새로 불러와" 신호만 보냄 (내용은 안 보냄) --
create or replace function public.cal_ping(p_topic text)
returns void language plpgsql security definer set search_path = public as $$
begin
  perform realtime.send('{}'::jsonb, 'changed', p_topic, false);
exception when others then null;  -- 알림 실패가 저장을 막지 않게
end $$;
revoke all on function public.cal_ping(text) from public, anon, authenticated;

create or replace function public.cal_events_notify()
returns trigger language plpgsql security definer set search_path = public as $$
declare ids uuid[] := '{}'; own uuid; t text;
begin
  if tg_op in ('UPDATE', 'DELETE') then ids := ids || old.group_ids; own := old.owner; end if;
  if tg_op in ('INSERT', 'UPDATE') then ids := ids || new.group_ids; own := new.owner; end if;
  perform public.cal_ping('cal-owner-' || own);
  for t in select token from public.cal_groups where id = any(ids) loop
    perform public.cal_ping('cal-' || t);
  end loop;
  return null;
end $$;
drop trigger if exists cal_events_notify on public.cal_events;
create trigger cal_events_notify after insert or update or delete on public.cal_events
  for each row execute function public.cal_events_notify();

create or replace function public.cal_groups_notify()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if tg_op in ('UPDATE', 'DELETE') then perform public.cal_ping('cal-' || old.token); end if;
  if tg_op = 'DELETE' then
    update public.cal_events set group_ids = array_remove(group_ids, old.id) where old.id = any(group_ids);
    perform public.cal_ping('cal-owner-' || old.owner);
  else
    perform public.cal_ping('cal-owner-' || new.owner);
  end if;
  return null;
end $$;
drop trigger if exists cal_groups_notify on public.cal_groups;
create trigger cal_groups_notify after insert or update or delete on public.cal_groups
  for each row execute function public.cal_groups_notify();

create or replace function public.cal_settings_notify()
returns trigger language plpgsql security definer set search_path = public as $$
declare t text;
begin
  perform public.cal_ping('cal-owner-' || new.owner);
  for t in select token from public.cal_groups where owner = new.owner loop
    perform public.cal_ping('cal-' || t);
  end loop;
  return null;
end $$;
drop trigger if exists cal_settings_notify on public.cal_settings;
create trigger cal_settings_notify after insert or update on public.cal_settings
  for each row execute function public.cal_settings_notify();
