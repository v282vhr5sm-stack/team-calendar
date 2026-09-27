/* 팀 캘린더 — 대표: 일정 작성/수정, 직원(링크): 보기 + 완료 체크 */
const $ = (s, el = document) => el.querySelector(s);
const cfg = window.APP_CONFIG || {};
const sb = supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_KEY);
const TOKEN_KEY = 'tc.token', NAME_KEY = 'tc.name';
const COLORS = ['#2563eb', '#16a34a', '#f59e0b', '#dc2626', '#9333ea', '#0891b2', '#db2777', '#64748b'];
const WD = ['일', '월', '화', '수', '목', '금', '토'];

const S = {
  mode: null,          // 'owner' | 'member'
  user: null, token: null,
  groups: [], events: [], company: '', group: null,
  y: 0, m: 0, sel: '', filter: 'all',
  ch: null, busy: new Set(), askedName: false, reqId: 0,
};

/* ---------- 유틸 ---------- */
const pad = n => String(n).padStart(2, '0');
const ymd = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const parse = s => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const hm = t => (t ? String(t).slice(0, 5) : '');
const lsGet = k => { try { return localStorage.getItem(k); } catch { return null; } };
const lsSet = (k, v) => { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch {} };
const shareUrl = token => `${location.origin}${location.pathname}?g=${token}`;
function fmtWhen(iso) { if (!iso) return ''; const d = new Date(iso); return `${d.getMonth() + 1}/${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}`; }
function timeText(e) { const a = hm(e.start_time), b = hm(e.end_time); return a && b ? `${a} – ${b}` : a ? `${a}~` : b ? `~${b}` : '종일'; }
function gridRange() { const first = new Date(S.y, S.m, 1); const a = new Date(first); a.setDate(1 - first.getDay()); const b = new Date(a); b.setDate(a.getDate() + 41); return [a, b]; }

let toastT;
function toast(msg) { const t = $('#toast'); t.textContent = msg; t.classList.add('show'); clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove('show'), 2400); }

/* ---------- 모달 ---------- */
function modal({ title, text = '', html = '', buttons = [], onMount }) {
  return new Promise(resolve => {
    const ov = document.createElement('div');
    ov.className = 'ov';
    ov.innerHTML = `<div class="modal" role="dialog" aria-modal="true"><h3>${esc(title)}</h3>${text ? `<p class="mtext">${esc(text)}</p>` : ''}<div class="mbody">${html}</div><div class="mbtns"></div></div>`;
    const box = $('.mbtns', ov);
    const close = v => { ov.remove(); document.removeEventListener('keydown', onKey); resolve(v); };
    const onKey = e => { if (e.key === 'Escape') close(undefined); };
    for (const b of buttons) {
      const el = document.createElement('button');
      el.type = 'button'; el.className = 'btn ' + (b.cls || ''); el.textContent = b.label;
      el.onclick = async () => {
        if (b.run) { el.disabled = true; let r; try { r = await b.run(ov); } finally { el.disabled = false; } if (r === false) return; }
        close(b.value);
      };
      box.appendChild(el);
    }
    ov.addEventListener('click', e => { if (e.target === ov) close(undefined); });
    document.addEventListener('keydown', onKey);
    document.body.appendChild(ov);
    onMount && onMount(ov, close);
  });
}
const confirmBox = (title, text, yes = '확인', no = '취소', danger = false) =>
  modal({ title, text, buttons: [{ label: no, value: false }, { label: yes, value: true, cls: danger ? 'danger fill' : 'primary' }] }).then(v => v === true);

/* ---------- 시작 ---------- */
async function boot() {
  const now = new Date(); S.y = now.getFullYear(); S.m = now.getMonth(); S.sel = ymd(now);
  bindUI();
  const t = new URLSearchParams(location.search).get('g');
  if (t) { lsSet(TOKEN_KEY, t); return startMember(t); }
  const { data: { session } } = await sb.auth.getSession();
  if (session) return startOwner(session.user);
  const saved = lsGet(TOKEN_KEY);
  if (saved) return startMember(saved);
  showLogin();
}

function show(id) { for (const s of ['login', 'main', 'notice']) $('#' + s).hidden = s !== id; }

function notice(icon, title, text, btn) {
  show('notice');
  $('#notice').innerHTML = `<div class="box"><div style="font-size:40px">${icon}</div><h2>${esc(title)}</h2><p>${esc(text)}</p>${btn ? `<button class="btn primary" id="nbtn">${esc(btn.label)}</button>` : ''}</div>`;
  if (btn) $('#nbtn').onclick = btn.run;
}

/* ---------- 로그인 ---------- */
let loginTab = 'in';
function showLogin() {
  stopRealtime(); S.mode = null; document.body.className = '';
  show('login');
}
function setLoginTab(tab) {
  loginTab = tab;
  document.querySelectorAll('.tabs button').forEach(b => b.classList.toggle('on', b.dataset.tab === tab));
  $('.only-up').hidden = tab !== 'up';
  const f = $('#loginForm');
  f.password.autocomplete = tab === 'up' ? 'new-password' : 'current-password';
  $('button[type=submit]', f).textContent = tab === 'up' ? '계정 만들기' : '로그인';
  $('#loginMsg').textContent = '';
}
async function onLogin(e) {
  e.preventDefault();
  const f = e.target, msg = $('#loginMsg'), btn = $('button[type=submit]', f);
  const email = f.email.value.trim(), password = f.password.value;
  msg.className = 'msg'; msg.textContent = ''; btn.disabled = true;
  try {
    if (loginTab === 'up') {
      const company = f.company.value.trim();
      if (company) lsSet('tc.pendingCompany', company);
      const { data, error } = await sb.auth.signUp({ email, password, options: { emailRedirectTo: location.origin + location.pathname } });
      if (error) throw error;
      if (data.session) return startOwner(data.session.user);
      msg.className = 'msg ok';
      msg.textContent = '확인 메일을 보냈어요. 메일의 링크를 누른 뒤 로그인하세요.';
      setTimeout(() => setLoginTab('in'), 50);
    } else {
      const { data, error } = await sb.auth.signInWithPassword({ email, password });
      if (error) throw error;
      startOwner(data.user);
    }
  } catch (err) {
    const m = String(err.message || err);
    msg.textContent = /Invalid login/i.test(m) ? '이메일 또는 비밀번호가 맞지 않아요.'
      : /not confirmed/i.test(m) ? '메일 인증이 아직 안 됐어요. 받은 메일의 링크를 눌러주세요.'
      : /signups? not allowed|disabled/i.test(m) ? '지금은 새 계정 만들기가 꺼져 있어요. (Supabase 설정에서 켜야 합니다)'
      : /already registered/i.test(m) ? '이미 가입된 이메일이에요. 로그인해 주세요.'
      : '오류: ' + m;
  } finally { btn.disabled = false; }
}

/* ---------- 대표 모드 ---------- */
async function startOwner(user) {
  S.mode = 'owner'; S.user = user; S.token = null;
  document.body.className = 'owner';
  show('main');
  $('#brandTitle').textContent = '팀 캘린더';
  $('#brandSub').textContent = user.email;
  $('#brandDot').style.background = 'var(--primary)';
  const ok = await reload();
  if (!ok) return;
  const pending = lsGet('tc.pendingCompany');
  if (pending && !S.company) { await sb.from('cal_settings').upsert({ owner: user.id, company: pending }); lsSet('tc.pendingCompany', null); S.company = pending; }
  if (!S.groups.length) {
    await sb.from('cal_groups').insert([{ name: '정규직', color: COLORS[0] }, { name: '주말 알바', color: COLORS[2] }]);
    await reload();
    toast('기본 그룹 “정규직”, “주말 알바”를 만들었어요');
  }
  subscribe('cal-owner-' + user.id);
}

async function loadOwner() {
  const [a, b] = gridRange();
  const [g, e, s] = await Promise.all([
    sb.from('cal_groups').select('*').order('created_at'),
    sb.from('cal_events').select('*').gte('day', ymd(a)).lte('day', ymd(b))
      .order('day').order('start_time', { nullsFirst: true }).order('created_at'),
    sb.from('cal_settings').select('company').maybeSingle(),
  ]);
  const err = g.error || e.error || s.error;
  if (err) throw err;
  return { groups: g.data, events: e.data, company: s.data?.company || '' };
}

/* ---------- 직원 모드 ---------- */
async function startMember(token) {
  S.mode = 'member'; S.token = token; S.user = null;
  document.body.className = 'member';
  show('main');
  updateNameBtn();
  const ok = await reload();
  if (ok) subscribe('cal-' + token);
}

async function loadMember() {
  const [a, b] = gridRange();
  const { data, error } = await sb.rpc('cal_view', { p_token: S.token, p_from: ymd(a), p_to: ymd(b) });
  if (error) throw error;
  return data;
}

function updateNameBtn() { const n = lsGet(NAME_KEY); $('#btnName').textContent = n ? `👤 ${n}` : '👤 이름 설정'; }

async function askName(first) {
  const cur = lsGet(NAME_KEY) || '';
  const v = await modal({
    title: first ? '이름을 알려주세요' : '내 이름',
    text: '완료 체크할 때 누가 했는지 함께 표시돼요. 이 기기에만 저장됩니다.',
    html: `<label>이름<input id="nm" maxlength="30" value="${esc(cur)}" placeholder="예: 김민수"></label>`,
    buttons: [{ label: first ? '건너뛰기' : '취소', value: null }, { label: '저장', cls: 'primary', run: ov => { lsSet(NAME_KEY, $('#nm', ov).value.trim() || null); } , value: 'saved' }],
    onMount: ov => { const i = $('#nm', ov); i.focus(); i.addEventListener('keydown', e => { if (e.key === 'Enter') $('.btn.primary', ov).click(); }); },
  });
  S.askedName = true; updateNameBtn();
  return v;
}

/* ---------- 불러오기 & 실시간 ---------- */
async function reload() {
  const id = ++S.reqId;
  try {
    if (S.mode === 'owner') {
      const r = await loadOwner();
      if (id !== S.reqId) return true;
      S.groups = r.groups; S.events = r.events; S.company = r.company;
      $('#brandTitle').textContent = S.company || '팀 캘린더';
      if (S.filter !== 'all' && S.filter !== 'none' && !S.groups.some(g => g.id === S.filter)) S.filter = 'all';
    } else if (S.mode === 'member') {
      const r = await loadMember();
      if (id !== S.reqId) return true;
      if (!r) {
        stopRealtime(); lsSet(TOKEN_KEY, null);
        notice('🔒', '링크를 열 수 없어요', '링크가 바뀌었거나 삭제되었어요. 대표님께 새 링크를 받아주세요.', { label: '대표 로그인', run: showLogin });
        return false;
      }
      S.group = r.group; S.company = r.company; S.events = r.events;
      $('#brandTitle').textContent = `${r.group.name} 일정`;
      $('#brandSub').textContent = r.company || '';
      $('#brandDot').style.background = r.group.color;
      document.title = `${r.group.name} 일정 · ${r.company || '팀 캘린더'}`;
    } else return false;
    render();
    return true;
  } catch (err) {
    console.error(err);
    const m = String(err.message || err.code || err);
    if (/cal_|schema cache|does not exist|PGRST20/i.test(m)) {
      notice('🛠️', '데이터베이스 준비가 필요해요', 'Supabase SQL Editor에서 supabase.sql 을 한 번 실행해 주세요.');
      return false;
    }
    if (/JWT|session/i.test(m) && S.mode === 'owner') { await sb.auth.signOut(); showLogin(); return false; }
    if (!S.events.length && !$('#grid').children.length) render();
    toast('불러오기 실패 — 인터넷 연결을 확인하세요');
    return S.mode != null;
  }
}

let reloadT;
function scheduleReload(delay = 200) { clearTimeout(reloadT); reloadT = setTimeout(reload, delay); }

function setLive(state) {
  const el = $('#live');
  el.className = 'live ' + (state === 'on' ? 'on' : state === 'off' ? 'off' : '');
  $('b', el).textContent = state === 'on' ? '실시간' : state === 'off' ? '재연결 중' : '연결 중';
}

function subscribe(topic) {
  stopRealtime();
  setLive('wait');
  S.ch = sb.channel(topic)
    .on('broadcast', { event: 'changed' }, () => scheduleReload())
    .subscribe(status => {
      if (status === 'SUBSCRIBED') { setLive('on'); scheduleReload(0); }   // 끊겼던 사이 변경도 반영
      else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') setLive('off');
    });
}
function stopRealtime() { if (S.ch) { sb.removeChannel(S.ch); S.ch = null; } }

// 실시간 신호를 놓쳐도 맞춰지도록: 화면 복귀·온라인 복귀 시, 그리고 30초마다 확인
document.addEventListener('visibilitychange', () => { if (!document.hidden && S.mode) scheduleReload(0); });
window.addEventListener('online', () => S.mode && scheduleReload(0));
setInterval(() => { if (!document.hidden && S.mode) reload(); }, 30000);

/* ---------- 그리기 ---------- */
function groupById(id) { return S.groups.find(g => g.id === id); }
function evColor(e) {
  if (S.mode === 'member') return S.group?.color || 'var(--primary)';
  const g = (e.group_ids || []).map(groupById).find(Boolean);
  return g ? g.color : '#94a3b8';
}
function visibleEvents() {
  if (S.mode !== 'owner' || S.filter === 'all') return S.events;
  if (S.filter === 'none') return S.events.filter(e => !(e.group_ids || []).some(groupById));
  return S.events.filter(e => (e.group_ids || []).includes(S.filter));
}

function render() { renderFilters(); renderCal(); renderDay(); }

function renderFilters() {
  if (S.mode !== 'owner') return;
  const items = [{ id: 'all', name: '전체', color: 'var(--text)' }, ...S.groups.map(g => ({ id: g.id, name: g.name, color: g.color }))];
  if (S.events.some(e => !(e.group_ids || []).some(groupById))) items.push({ id: 'none', name: '공유 안 함', color: '#94a3b8' });
  $('#filters').innerHTML = items.map(i =>
    `<button class="fchip ${S.filter === i.id ? 'on' : ''}" data-f="${i.id}" style="--c:${i.color}">${i.id === 'all' ? '' : '<i></i>'}${esc(i.name)}</button>`).join('');
}

function renderCal() {
  $('#monthLabel').textContent = `${S.y}년 ${S.m + 1}월`;
  const [start] = gridRange(), today = ymd(new Date());
  const byDay = {};
  for (const e of visibleEvents()) (byDay[e.day] ||= []).push(e);
  let html = '';
  for (let i = 0; i < 42; i++) {
    const d = new Date(start); d.setDate(start.getDate() + i);
    const k = ymd(d), evs = byDay[k] || [], done = evs.filter(e => e.done).length;
    const cls = ['cell', d.getMonth() !== S.m && 'out', k === today && 'today', k === S.sel && 'sel', d.getDay() === 0 && 'sun', d.getDay() === 6 && 'sat'].filter(Boolean).join(' ');
    html += `<button class="${cls}" data-day="${k}" aria-label="${d.getMonth() + 1}월 ${d.getDate()}일 일정 ${evs.length}개">
      <span class="num">${d.getDate()}</span>
      ${evs.length ? `<span class="cnt ${done === evs.length ? 'all' : ''}">${done}/${evs.length}</span>` : ''}
      <span class="chips">${evs.slice(0, 3).map(e => `<span class="chip ${e.done ? 'done' : ''}" style="--c:${evColor(e)}">${esc(e.title)}</span>`).join('')}
      ${evs.length > 3 ? `<span class="more">+${evs.length - 3}</span>` : ''}</span></button>`;
  }
  $('#grid').innerHTML = html;
}

function renderDay() {
  const d = parse(S.sel);
  $('#dayTitle').textContent = `${d.getMonth() + 1}월 ${d.getDate()}일 (${WD[d.getDay()]})`;
  const evs = visibleEvents().filter(e => e.day === S.sel);
  const done = evs.filter(e => e.done).length;
  $('#dayCount').textContent = evs.length ? `완료 ${done}/${evs.length}` : '';
  const owner = S.mode === 'owner';
  $('#dayList').innerHTML = evs.length ? evs.map(e => {
    const tags = owner ? (e.group_ids || []).map(groupById).filter(Boolean).map(g => `<span class="tag" style="--c:${g.color}"><i></i>${esc(g.name)}</span>`).join('') || '<span class="tag">🔒 공유 안 함</span>' : '';
    const dm = e.done ? `<span class="donemark">✓ 완료${e.done_by ? ' · ' + esc(e.done_by) : ''}${e.done_at ? ' · ' + fmtWhen(e.done_at) : ''}</span>` : '';
    return `<div class="ev ${e.done ? 'done' : ''}" style="--c:${evColor(e)}">
      <button class="check ${e.done ? 'on' : ''}" data-check="${e.id}" aria-pressed="${e.done}" aria-label="${e.done ? '완료 취소' : '완료 체크'}" ${S.busy.has(e.id) ? 'disabled' : ''}>✓</button>
      <${owner ? 'button' : 'div'} class="body ${owner ? 'edit' : ''}" ${owner ? `data-edit="${e.id}" type="button"` : ''}>
        <div class="time">${timeText(e)}</div>
        <div class="t">${esc(e.title)}</div>
        ${e.memo ? `<div class="memo">${esc(e.memo)}</div>` : ''}
        ${tags || dm ? `<div class="meta">${tags}${dm}</div>` : ''}
      </${owner ? 'button' : 'div'}>
    </div>`;
  }).join('') : `<div class="empty">${owner ? '일정이 없어요. “+ 일정”으로 추가하세요.' : '이 날은 일정이 없어요.'}</div>`;
}

/* ---------- 완료 체크 ---------- */
async function toggleDone(id) {
  const e = S.events.find(x => x.id === id);
  if (!e || S.busy.has(id)) return;
  if (e.done) {
    const ok = await confirmBox('완료를 취소할까요?', `“${e.title}” 일정을 미완료로 되돌립니다.`, '완료 취소', '아니요', true);
    if (!ok) return;
  } else if (S.mode === 'member' && !lsGet(NAME_KEY) && !S.askedName) {
    await askName(true);
  }
  const next = !e.done, prev = { done: e.done, done_by: e.done_by, done_at: e.done_at };
  const who = S.mode === 'owner' ? '대표' : (lsGet(NAME_KEY) || null);
  Object.assign(e, { done: next, done_by: next ? who : null, done_at: next ? new Date().toISOString() : null });
  S.busy.add(id); render();
  try {
    if (S.mode === 'member') {
      const { data, error } = await sb.rpc('cal_set_done', { p_token: S.token, p_event: id, p_done: next, p_name: who });
      if (error) throw error;
      Object.assign(e, data);
    } else {
      const { error } = await sb.from('cal_events').update({ done: next, done_by: next ? who : null, done_at: next ? new Date().toISOString() : null, updated_at: new Date().toISOString() }).eq('id', id);
      if (error) throw error;
    }
    if (next) toast('완료로 체크했어요 ✓');
  } catch (err) {
    console.error(err); Object.assign(e, prev);
    toast('저장하지 못했어요 — 인터넷 연결을 확인하세요');
  } finally { S.busy.delete(id); render(); }
}

/* ---------- 일정 편집 (대표) ---------- */
async function editEvent(id) {
  const e = id ? S.events.find(x => x.id === id) : null;
  const gids = e ? e.group_ids || [] : (S.filter !== 'all' && S.filter !== 'none' ? [S.filter] : S.groups.map(g => g.id));
  const html = `
    <label>일정 제목<input id="f_title" maxlength="100" required value="${esc(e?.title)}" placeholder="예: 매장 오픈 준비"></label>
    <label>날짜<input id="f_day" type="date" required value="${e?.day || S.sel}"></label>
    <div class="row2">
      <label>시작 (선택)<input id="f_st" type="time" value="${hm(e?.start_time)}"></label>
      <label>종료 (선택)<input id="f_et" type="time" value="${hm(e?.end_time)}"></label>
    </div>
    <label>메모 (선택)<textarea id="f_memo" rows="3" maxlength="1000" placeholder="준비물, 장소 등">${esc(e?.memo)}</textarea></label>
    <div class="fieldlabel">누구에게 보여줄까요?</div>
    <div class="gpick">${S.groups.map(g => `<label style="--c:${g.color}"><input type="checkbox" value="${g.id}" ${gids.includes(g.id) ? 'checked' : ''}>${esc(g.name)}</label>`).join('') || '<span class="fieldlabel">먼저 “공유 링크”에서 그룹을 만드세요.</span>'}</div>`;
  const save = async ov => {
    const title = $('#f_title', ov).value.trim(), day = $('#f_day', ov).value;
    if (!title) { $('#f_title', ov).focus(); toast('제목을 입력하세요'); return false; }
    if (!day) { toast('날짜를 선택하세요'); return false; }
    const row = {
      title, day, memo: $('#f_memo', ov).value.trim(),
      start_time: $('#f_st', ov).value || null, end_time: $('#f_et', ov).value || null,
      group_ids: [...ov.querySelectorAll('.gpick input:checked')].map(i => i.value),
      updated_at: new Date().toISOString(),
    };
    const q = e ? sb.from('cal_events').update(row).eq('id', e.id) : sb.from('cal_events').insert(row);
    const { error } = await q;
    if (error) { console.error(error); toast('저장 실패: ' + error.message); return false; }
    S.sel = day; const d = parse(day); S.y = d.getFullYear(); S.m = d.getMonth();
    await reload();
    toast(e ? '수정했어요' : '일정을 추가했어요');
  };
  const buttons = [];
  if (e) buttons.push({ label: '삭제', cls: 'danger left', run: async () => {
    if (!(await confirmBox('일정을 삭제할까요?', `“${e.title}” — 직원 화면에서도 사라집니다.`, '삭제', '취소', true))) return false;
    const { error } = await sb.from('cal_events').delete().eq('id', e.id);
    if (error) { toast('삭제 실패: ' + error.message); return false; }
    await reload(); toast('삭제했어요');
  } });
  buttons.push({ label: '취소', value: null }, { label: e ? '저장' : '추가', cls: 'primary', run: save });
  await modal({ title: e ? '일정 수정' : '새 일정', html, buttons, onMount: ov => { if (!e) $('#f_title', ov).focus(); } });
}

/* ---------- 그룹·공유 링크 (대표) ---------- */
async function openGroups() {
  await modal({
    title: '공유 링크',
    text: '그룹마다 링크가 따로 있어요. 링크를 받은 직원은 그 그룹 일정만 보고, 완료 체크만 할 수 있어요.',
    html: `<div class="glist" id="glist"></div><div style="margin-top:12px"><button class="btn wide" id="gadd">+ 그룹 추가</button></div>`,
    buttons: [{ label: '닫기', cls: 'primary' }],
    onMount: ov => {
      const draw = () => {
        $('#glist', ov).innerHTML = S.groups.map(g => `
          <div class="gitem" style="--c:${g.color}">
            <div class="gname">${esc(g.name)}</div>
            <div class="glink">${esc(shareUrl(g.token))}</div>
            <div class="gbtns">
              <button class="btn sm primary" data-a="copy" data-id="${g.id}">링크 복사</button>
              ${navigator.share ? `<button class="btn sm" data-a="share" data-id="${g.id}">보내기</button>` : ''}
              <button class="btn sm" data-a="edit" data-id="${g.id}">이름·색</button>
              <button class="btn sm" data-a="regen" data-id="${g.id}">링크 새로 만들기</button>
              <button class="btn sm danger" data-a="del" data-id="${g.id}">삭제</button>
            </div>
          </div>`).join('') || '<div class="empty">그룹이 없어요.</div>';
      };
      draw();
      $('#gadd', ov).onclick = async () => { if (await editGroup()) draw(); };
      $('#glist', ov).onclick = async ev => {
        const b = ev.target.closest('button[data-a]'); if (!b) return;
        const g = groupById(b.dataset.id); if (!g) return;
        const url = shareUrl(g.token), a = b.dataset.a;
        if (a === 'copy') {
          try { await navigator.clipboard.writeText(url); toast('링크를 복사했어요. 카톡 등에 붙여넣으세요'); }
          catch { window.prompt('아래 링크를 복사하세요', url); }
        } else if (a === 'share') {
          navigator.share({ title: `${g.name} 일정`, text: `${S.company || '회사'} ${g.name} 일정표입니다.`, url }).catch(() => {});
        } else if (a === 'edit') {
          if (await editGroup(g)) draw();
        } else if (a === 'regen') {
          if (!(await confirmBox('링크를 새로 만들까요?', `“${g.name}”의 기존 링크는 더 이상 열리지 않아요. 새 링크를 다시 보내줘야 합니다.`, '새로 만들기', '취소', true))) return;
          const token = crypto.randomUUID().replace(/-/g, '') + crypto.randomUUID().replace(/-/g, '');
          const { error } = await sb.from('cal_groups').update({ token }).eq('id', g.id);
          if (error) return toast('실패: ' + error.message);
          await reload(); draw(); toast('새 링크를 만들었어요');
        } else if (a === 'del') {
          if (!(await confirmBox('그룹을 삭제할까요?', `“${g.name}” 링크가 사라지고, 일정은 남지만 이 그룹에는 더 이상 공유되지 않아요.`, '삭제', '취소', true))) return;
          const { error } = await sb.from('cal_groups').delete().eq('id', g.id);
          if (error) return toast('실패: ' + error.message);
          await reload(); draw(); toast('삭제했어요');
        }
      };
    },
  });
}

async function editGroup(g) {
  let color = g?.color || COLORS[S.groups.length % COLORS.length];
  const r = await modal({
    title: g ? '그룹 수정' : '새 그룹',
    html: `<label>그룹 이름<input id="g_name" maxlength="30" value="${esc(g?.name)}" placeholder="예: 평일 알바, 매니저"></label>
      <div class="fieldlabel">색상</div>
      <div class="colors">${COLORS.map(c => `<button type="button" style="--c:${c}" data-c="${c}" class="${c === color ? 'on' : ''}" aria-label="색 ${c}"></button>`).join('')}</div>`,
    buttons: [{ label: '취소', value: false }, { label: '저장', cls: 'primary', value: true, run: async ov => {
      const name = $('#g_name', ov).value.trim();
      if (!name) { toast('이름을 입력하세요'); return false; }
      const q = g ? sb.from('cal_groups').update({ name, color }).eq('id', g.id) : sb.from('cal_groups').insert({ name, color });
      const { error } = await q;
      if (error) { toast('저장 실패: ' + error.message); return false; }
      await reload();
    } }],
    onMount: ov => {
      $('#g_name', ov).focus();
      $('.colors', ov).onclick = e => { const b = e.target.closest('[data-c]'); if (!b) return; color = b.dataset.c; ov.querySelectorAll('.colors button').forEach(x => x.classList.toggle('on', x === b)); };
    },
  });
  return r === true;
}

async function openSettings() {
  await modal({
    title: '설정',
    html: `<label>회사 이름 (직원 화면 상단에 표시)<input id="s_co" maxlength="40" value="${esc(S.company)}"></label>
      <p class="fieldlabel">로그인: ${esc(S.user?.email)}</p>`,
    buttons: [
      { label: '로그아웃', cls: 'danger left', run: async () => { await sb.auth.signOut(); showLogin(); } },
      { label: '닫기' },
      { label: '저장', cls: 'primary', run: async ov => {
        const company = $('#s_co', ov).value.trim();
        const { error } = await sb.from('cal_settings').upsert({ owner: S.user.id, company });
        if (error) { toast('저장 실패: ' + error.message); return false; }
        await reload(); toast('저장했어요');
      } },
    ],
  });
}

/* ---------- 이벤트 연결 ---------- */
function goMonth(delta) {
  S.m += delta; if (S.m < 0) { S.m = 11; S.y--; } if (S.m > 11) { S.m = 0; S.y++; }
  S.events = []; render(); reload();
}
function bindUI() {
  document.querySelectorAll('.tabs button').forEach(b => b.onclick = () => setLoginTab(b.dataset.tab));
  $('#loginForm').addEventListener('submit', onLogin);
  $('#prev').onclick = () => goMonth(-1);
  $('#next').onclick = () => goMonth(1);
  $('#today').onclick = () => { const n = new Date(); const same = n.getFullYear() === S.y && n.getMonth() === S.m; S.y = n.getFullYear(); S.m = n.getMonth(); S.sel = ymd(n); same ? render() : goMonth(0); };
  $('#grid').onclick = e => {
    const c = e.target.closest('[data-day]'); if (!c) return;
    const k = c.dataset.day, d = parse(k);
    S.sel = k;
    if (d.getMonth() !== S.m || d.getFullYear() !== S.y) { S.y = d.getFullYear(); S.m = d.getMonth(); goMonth(0); } else render();
    if (window.innerWidth < 900) $('.day').scrollIntoView({ behavior: 'smooth', block: 'start' });
  };
  $('#dayList').onclick = e => {
    const c = e.target.closest('[data-check]'); if (c) return toggleDone(c.dataset.check);
    const ed = e.target.closest('[data-edit]'); if (ed && S.mode === 'owner') editEvent(ed.dataset.edit);
  };
  $('#filters').onclick = e => { const b = e.target.closest('[data-f]'); if (!b) return; S.filter = b.dataset.f; render(); };
  $('#btnAdd').onclick = () => editEvent(null);
  $('#btnGroups').onclick = openGroups;
  $('#btnSettings').onclick = openSettings;
  $('#btnName').onclick = () => askName(false);
  $('#btnOwnerLogin').onclick = showLogin;
  sb.auth.onAuthStateChange((ev, session) => {
    if (ev === 'SIGNED_OUT' && S.mode === 'owner') showLogin();
  });
}

if ('serviceWorker' in navigator && !/^(localhost|127\.0\.0\.1)$/.test(location.hostname)) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
boot();
