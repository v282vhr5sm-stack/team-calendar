-- 팀 캘린더 — Supabase 대시보드 > SQL Editor 에 전체 붙여넣고 Run (한 번만, 다시 실행해도 안전)
-- 견적 앱과 같은 프로젝트를 쓰지만 cal_ 로 시작하는 별도 테이블이라 서로 영향이 없습니다.

-- 0) 이전 버전(그룹 방식) 정리 — 처음 실행이면 아무 일도 안 일어납니다
drop table if exists public.cal_groups cascade;
drop function if exists public.cal_groups_notify() cascade;

-- 1) 테이블 -----------------------------------------------------------------
create table if not exists public.cal_settings (
  owner uuid primary key default auth.uid() references auth.users(id) on delete cascade,
  company text not null default ''
);

create table if not exists public.cal_events (
  id uuid primary key default gen_random_uuid(),
  owner uuid not null default auth.uid() references auth.users(id) on delete cascade,
  title text not null,
  memo text not null default '',
  day date not null,
  start_time time,
  end_time time,
  done boolean not null default false,
  done_by text,
  done_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.cal_events drop column if exists group_ids;
alter table public.cal_events add column if not exists color text not null default '#2563eb';
create index if not exists cal_events_owner_day on public.cal_events (owner, day);

-- 색깔 분류 (예: 철수날짜=분홍, 납품완료=파랑). 설정에서 추가·수정·삭제
create table if not exists public.cal_categories (
  id uuid primary key default gen_random_uuid(),
  owner uuid not null default auth.uid() references auth.users(id) on delete cascade,
  name text not null,
  color text not null,
  sort int not null default 0,
  created_at timestamptz not null default now()
);
alter table public.cal_events add column if not exists category_id uuid references public.cal_categories(id) on delete set null;
alter table public.cal_settings add column if not exists cats_init boolean not null default false;

-- 공유 링크: kind = 'all'(전체) | 'weekdays'(요일별, 0=일~6=토) | 'dates'(선택한 날짜)
create table if not exists public.cal_links (
  id uuid primary key default gen_random_uuid(),
  owner uuid not null default auth.uid() references auth.users(id) on delete cascade,
  name text not null,
  kind text not null default 'all' check (kind in ('all', 'weekdays', 'dates')),
  weekdays int[] not null default '{}',
  dates date[] not null default '{}',
  token text not null unique default (replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '')),
  created_at timestamptz not null default now()
);

-- 2) 권한: 대표(로그인한 본인)만 자기 데이터를 읽고 쓸 수 있음 -------------------
alter table public.cal_settings enable row level security;
alter table public.cal_events   enable row level security;
alter table public.cal_links    enable row level security;
alter table public.cal_categories enable row level security;
drop policy if exists "cal_categories owner" on public.cal_categories;
create policy "cal_categories owner" on public.cal_categories for all to authenticated
  using (auth.uid() = owner) with check (auth.uid() = owner);
grant select, insert, update, delete on public.cal_categories to authenticated;
revoke all on public.cal_categories from anon;

drop policy if exists "cal_settings owner" on public.cal_settings;
create policy "cal_settings owner" on public.cal_settings for all to authenticated
  using (auth.uid() = owner) with check (auth.uid() = owner);
drop policy if exists "cal_events owner" on public.cal_events;
create policy "cal_events owner" on public.cal_events for all to authenticated
  using (auth.uid() = owner) with check (auth.uid() = owner);
drop policy if exists "cal_links owner" on public.cal_links;
create policy "cal_links owner" on public.cal_links for all to authenticated
  using (auth.uid() = owner) with check (auth.uid() = owner);

grant select, insert, update, delete on public.cal_settings, public.cal_events, public.cal_links to authenticated;
revoke all on public.cal_settings, public.cal_events, public.cal_links from anon;

-- 3) 직원용: 링크(token)를 아는 사람만 해당 일정 "보기" + "완료 체크"만 가능 --------
create or replace function public.cal_link_match(p_kind text, p_weekdays int[], p_dates date[], p_day date)
returns boolean language sql immutable as $$
  select case p_kind
    when 'all' then true
    when 'weekdays' then extract(dow from p_day)::int = any(p_weekdays)
    when 'dates' then p_day = any(p_dates)
    else false end;
$$;

drop function if exists public.cal_view(text, date, date);
create or replace function public.cal_view(p_token text, p_from date, p_to date)
returns jsonb language plpgsql security definer stable set search_path = public as $$
declare l public.cal_links;
begin
  select * into l from public.cal_links where token = p_token;
  if not found then return null; end if;
  if p_to - p_from > 120 then p_to := p_from + 120; end if;
  return jsonb_build_object(
    'link', jsonb_build_object('name', l.name, 'kind', l.kind, 'weekdays', to_jsonb(l.weekdays), 'dates', to_jsonb(l.dates)),
    'company', coalesce((select s.company from public.cal_settings s where s.owner = l.owner), ''),
    'categories', coalesce((select jsonb_agg(jsonb_build_object('id', c.id, 'name', c.name, 'color', c.color) order by c.sort, c.created_at)
      from public.cal_categories c where c.owner = l.owner), '[]'::jsonb),
    'events', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', e.id, 'title', e.title, 'memo', e.memo, 'day', e.day, 'color', coalesce(c.color, e.color), 'category_id', e.category_id,
        'start_time', e.start_time, 'end_time', e.end_time,
        'done', e.done, 'done_by', e.done_by, 'done_at', e.done_at)
        order by e.day, e.start_time nulls first, e.created_at)
      from public.cal_events e left join public.cal_categories c on c.id = e.category_id
      where e.owner = l.owner and e.day between p_from and p_to
        and public.cal_link_match(l.kind, l.weekdays, l.dates, e.day)), '[]'::jsonb));
end $$;

drop function if exists public.cal_set_done(text, uuid, boolean, text);
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
    and exists (select 1 from public.cal_links l
                where l.token = p_token and l.owner = e.owner
                  and public.cal_link_match(l.kind, l.weekdays, l.dates, e.day))
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

create or replace function public.cal_ping_owner(p_owner uuid)
returns void language plpgsql security definer set search_path = public as $$
declare t text;
begin
  perform public.cal_ping('cal-owner-' || p_owner);
  for t in select token from public.cal_links where owner = p_owner loop
    perform public.cal_ping('cal-' || t);
  end loop;
end $$;
revoke all on function public.cal_ping_owner(uuid) from public, anon, authenticated;

create or replace function public.cal_events_notify()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  perform public.cal_ping_owner(case when tg_op = 'DELETE' then old.owner else new.owner end);
  return null;
end $$;
drop trigger if exists cal_events_notify on public.cal_events;
create trigger cal_events_notify after insert or update or delete on public.cal_events
  for each row execute function public.cal_events_notify();

create or replace function public.cal_links_notify()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if tg_op in ('UPDATE', 'DELETE') then perform public.cal_ping('cal-' || old.token); end if;
  if tg_op in ('INSERT', 'UPDATE') then perform public.cal_ping('cal-' || new.token); end if;
  perform public.cal_ping('cal-owner-' || case when tg_op = 'DELETE' then old.owner else new.owner end);
  return null;
end $$;
drop trigger if exists cal_links_notify on public.cal_links;
create trigger cal_links_notify after insert or update or delete on public.cal_links
  for each row execute function public.cal_links_notify();

create or replace function public.cal_settings_notify()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  perform public.cal_ping_owner(new.owner);
  return null;
end $$;
drop trigger if exists cal_settings_notify on public.cal_settings;
create trigger cal_settings_notify after insert or update on public.cal_settings
  for each row execute function public.cal_settings_notify();

drop trigger if exists cal_categories_notify on public.cal_categories;
create trigger cal_categories_notify after insert or update or delete on public.cal_categories
  for each row execute function public.cal_events_notify();
