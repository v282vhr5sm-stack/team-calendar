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
--    보안: 링크 사용 중지 / 사용 기한 / PIN(숫자 비밀번호, 10번 틀리면 15분 잠금)
create extension if not exists pgcrypto with schema extensions;

alter table public.cal_links add column if not exists active boolean not null default true;
alter table public.cal_links add column if not exists expires_on date;
alter table public.cal_links add column if not exists pin_hash text;
alter table public.cal_links add column if not exists pin_fails int not null default 0;
alter table public.cal_links add column if not exists pin_locked_until timestamptz;
alter table public.cal_links add column if not exists last_seen timestamptz;

create or replace function public.cal_link_match(p_kind text, p_weekdays int[], p_dates date[], p_day date)
returns boolean language sql immutable as $$
  select case p_kind
    when 'all' then true
    when 'weekdays' then extract(dow from p_day)::int = any(p_weekdays)
    when 'dates' then p_day = any(p_dates)
    else false end;
$$;

-- 링크가 지금 쓸 수 있는 상태인지 (PIN 제외)
create or replace function public.cal_link_open(l public.cal_links)
returns boolean language sql stable as $$
  select l.active and (l.expires_on is null or l.expires_on >= (now() at time zone 'Asia/Seoul')::date);
$$;

drop function if exists public.cal_view(text, date, date);
create or replace function public.cal_view(p_token text, p_from date, p_to date, p_pin text default null)
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare l public.cal_links;
begin
  select * into l from public.cal_links where token = p_token;
  if not found then return null; end if;
  if not l.active then return jsonb_build_object('error', 'inactive'); end if;
  if not public.cal_link_open(l) then return jsonb_build_object('error', 'expired'); end if;
  if l.pin_hash is not null then
    if l.pin_locked_until > now() then return jsonb_build_object('error', 'locked', 'name', l.name); end if;
    if coalesce(p_pin, '') = '' then return jsonb_build_object('error', 'pin', 'name', l.name); end if;
    if extensions.crypt(p_pin, l.pin_hash) <> l.pin_hash then
      update public.cal_links set pin_fails = pin_fails + 1,
        pin_locked_until = case when pin_fails + 1 >= 10 then now() + interval '15 minutes' end
        where id = l.id;
      return jsonb_build_object('error', case when l.pin_fails + 1 >= 10 then 'locked' else 'badpin' end, 'name', l.name);
    end if;
  end if;
  if l.pin_fails > 0 or l.last_seen is null or l.last_seen < now() - interval '10 minutes' then
    update public.cal_links set pin_fails = 0, pin_locked_until = null, last_seen = now() where id = l.id;
  end if;
  if p_to - p_from > 120 then p_to := p_from + 120; end if;
  return jsonb_build_object(
    'link', jsonb_build_object('name', l.name, 'kind', l.kind, 'weekdays', to_jsonb(l.weekdays), 'dates', to_jsonb(l.dates)),
    'company', coalesce((select s.company from public.cal_settings s where s.owner = l.owner), ''),
    'categories', coalesce((select jsonb_agg(jsonb_build_object('id', c.id, 'name', c.name, 'color', c.color) order by c.sort, c.created_at)
      from public.cal_categories c where c.owner = l.owner), '[]'::jsonb),
    'events', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', e.id, 'title', e.title, 'memo', e.memo, 'day', e.day, 'color', coalesce(c.color, e.color), 'category_id', e.category_id,
        'done', e.done, 'done_by', e.done_by, 'done_at', e.done_at)
        order by e.day, e.created_at)
      from public.cal_events e left join public.cal_categories c on c.id = e.category_id
      where e.owner = l.owner and e.day between p_from and p_to
        and public.cal_link_match(l.kind, l.weekdays, l.dates, e.day)), '[]'::jsonb));
end $$;

drop function if exists public.cal_set_done(text, uuid, boolean, text);
create or replace function public.cal_set_done(p_token text, p_event uuid, p_done boolean, p_name text default null, p_pin text default null)
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare r public.cal_events;
begin
  update public.cal_events e set
    done = p_done,
    done_by = case when p_done then nullif(left(trim(coalesce(p_name, '')), 30), '') end,
    done_at = case when p_done then now() end,
    updated_at = now()
  where e.id = p_event
    and exists (select 1 from public.cal_links l
                where l.token = p_token and l.owner = e.owner and public.cal_link_open(l)
                  and (l.pin_hash is null or (coalesce(l.pin_locked_until, now()) <= now()
                        and extensions.crypt(coalesce(p_pin, ''), l.pin_hash) = l.pin_hash))
                  and public.cal_link_match(l.kind, l.weekdays, l.dates, e.day))
  returning * into r;
  if not found then raise exception 'not allowed'; end if;
  return jsonb_build_object('done', r.done, 'done_by', r.done_by, 'done_at', r.done_at);
end $$;

-- 대표가 링크 PIN 설정/해제 (빈 값 = 해제). 숫자 4~8자리, 암호화해서 저장
create or replace function public.cal_set_link_pin(p_link uuid, p_pin text)
returns void language plpgsql security definer set search_path = public, extensions as $$
begin
  if coalesce(p_pin, '') <> '' and p_pin !~ '^[0-9]{4,8}$' then raise exception 'PIN은 숫자 4~8자리로 입력하세요'; end if;
  update public.cal_links set
    pin_hash = case when coalesce(p_pin, '') = '' then null else extensions.crypt(p_pin, extensions.gen_salt('bf')) end,
    pin_fails = 0, pin_locked_until = null
  where id = p_link and owner = auth.uid();
  if not found then raise exception 'not allowed'; end if;
end $$;

revoke all on function public.cal_view(text, date, date, text) from public;
revoke all on function public.cal_set_done(text, uuid, boolean, text, text) from public;
revoke all on function public.cal_set_link_pin(uuid, text) from public, anon;
grant execute on function public.cal_view(text, date, date, text) to anon, authenticated;
grant execute on function public.cal_set_done(text, uuid, boolean, text, text) to anon, authenticated;
grant execute on function public.cal_set_link_pin(uuid, text) to authenticated;

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
  -- 접속 기록·PIN 실패 횟수만 바뀐 경우는 알리지 않음
  if tg_op = 'UPDATE' and (to_jsonb(new) - 'last_seen' - 'pin_fails' - 'pin_locked_until') = (to_jsonb(old) - 'last_seen' - 'pin_fails' - 'pin_locked_until') then return null; end if;
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

-- 5) 안전망: 수정·삭제되기 직전 내용을 기록 (화면에는 안 보임, 실수로 지운 일정을 관리자가 되살릴 때 사용) --------
create table if not exists public.cal_history (
  id bigserial primary key,
  owner uuid not null,
  tbl text not null,
  op text not null,
  row_id uuid,
  data jsonb not null,
  at timestamptz not null default now()
);
create index if not exists cal_history_owner_at on public.cal_history (owner, at desc);
alter table public.cal_history enable row level security;
drop policy if exists "cal_history owner read" on public.cal_history;
create policy "cal_history owner read" on public.cal_history for select to authenticated using (auth.uid() = owner);
grant select on public.cal_history to authenticated;
revoke all on public.cal_history from anon;

create or replace function public.cal_history_log()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.cal_history (owner, tbl, op, row_id, data)
  values (old.owner, tg_table_name, tg_op, old.id, to_jsonb(old) - 'pin_hash');
  return null;
end $$;
drop trigger if exists cal_events_history on public.cal_events;
create trigger cal_events_history after update or delete on public.cal_events
  for each row execute function public.cal_history_log();
drop trigger if exists cal_categories_history on public.cal_categories;
create trigger cal_categories_history after update or delete on public.cal_categories
  for each row execute function public.cal_history_log();
drop trigger if exists cal_links_history on public.cal_links;
create trigger cal_links_history after delete on public.cal_links
  for each row execute function public.cal_history_log();

-- 6) 계정(이메일) 찾기: 회사 이름으로 가려진 이메일만 보여줌 (예: in*****t@naver.com) ----------
create or replace function public.cal_find_account(p_company text)
returns jsonb language sql security definer stable set search_path = public as $$
  select coalesce(jsonb_agg(
    left(split_part(u.email, '@', 1), 2) || repeat('*', greatest(length(split_part(u.email, '@', 1)) - 3, 1))
    || right(split_part(u.email, '@', 1), 1) || '@' || split_part(u.email, '@', 2)), '[]'::jsonb)
  from auth.users u join public.cal_settings s on s.owner = u.id
  where length(trim(coalesce(p_company, ''))) >= 2
    and lower(replace(s.company, ' ', '')) = lower(replace(p_company, ' ', ''));
$$;
revoke all on function public.cal_find_account(text) from public;
grant execute on function public.cal_find_account(text) to anon, authenticated;

-- 7) 비밀번호 찾기 (메일 없이): 대표가 설정에서 정한 "확인번호"로 새 비밀번호 설정 -------------
--    확인번호는 암호화해서 저장, 5번 틀리면 30분 잠금
alter table public.cal_settings add column if not exists recovery_hash text;
alter table public.cal_settings add column if not exists recovery_fails int not null default 0;
alter table public.cal_settings add column if not exists recovery_locked_until timestamptz;

create or replace function public.cal_set_recovery_code(p_code text)
returns void language plpgsql security definer set search_path = public, extensions as $$
begin
  if auth.uid() is null then raise exception 'not allowed'; end if;
  if coalesce(p_code, '') !~ '^[0-9]{4,12}$' then raise exception '확인번호는 숫자 4~12자리로 정하세요'; end if;
  insert into public.cal_settings (owner, recovery_hash, recovery_fails, recovery_locked_until)
  values (auth.uid(), extensions.crypt(p_code, extensions.gen_salt('bf')), 0, null)
  on conflict (owner) do update set recovery_hash = excluded.recovery_hash, recovery_fails = 0, recovery_locked_until = null;
end $$;
revoke all on function public.cal_set_recovery_code(text) from public, anon;
grant execute on function public.cal_set_recovery_code(text) to authenticated;

create or replace function public.cal_reset_password(p_email text, p_code text, p_new text)
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare uid uuid; st public.cal_settings;
begin
  if length(coalesce(p_new, '')) < 6 then return jsonb_build_object('error', 'short'); end if;
  select u.id into uid from auth.users u where lower(u.email) = lower(trim(coalesce(p_email, ''))) limit 1;
  if uid is null then return jsonb_build_object('error', 'bad'); end if;
  select * into st from public.cal_settings where owner = uid;
  if st.owner is null or st.recovery_hash is null then return jsonb_build_object('error', 'nocode'); end if;
  if st.recovery_locked_until > now() then return jsonb_build_object('error', 'locked'); end if;
  if extensions.crypt(coalesce(p_code, ''), st.recovery_hash) <> st.recovery_hash then
    update public.cal_settings set recovery_fails = recovery_fails + 1,
      recovery_locked_until = case when recovery_fails + 1 >= 5 then now() + interval '30 minutes' end
      where owner = uid;
    return jsonb_build_object('error', case when st.recovery_fails + 1 >= 5 then 'locked' else 'bad' end);
  end if;
  update auth.users set encrypted_password = extensions.crypt(p_new, extensions.gen_salt('bf')), updated_at = now() where id = uid;
  update public.cal_settings set recovery_fails = 0, recovery_locked_until = null where owner = uid;
  return jsonb_build_object('ok', true);
end $$;
revoke all on function public.cal_reset_password(text, text, text) from public;
grant execute on function public.cal_reset_password(text, text, text) to anon, authenticated;
