/* 팀 캘린더 — 대표: 일정 작성/수정, 직원(링크): 보기 + 완료 체크 */
const $ = (s, el = document) => el.querySelector(s);
const cfg = window.APP_CONFIG || {};
// 대표 로그인은 이 기기에 저장되고 자동으로 갱신됨 → 직접 로그아웃하기 전까지 자동 로그인
const sb = supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_KEY, {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
});
const TOKEN_KEY = 'tc.token', NAME_KEY = 'tc.name';
const WD = ['일', '월', '화', '수', '목', '금', '토'];
const COLORS = [
  ['#2563eb', '파랑'], ['#16a34a', '초록'], ['#f59e0b', '주황'], ['#dc2626', '빨강'],
  ['#9333ea', '보라'], ['#0891b2', '청록'], ['#db2777', '분홍'], ['#64748b', '회색'],
];
const COLOR_KEY = 'tc.lastColor';
const evColor = e => e.color || COLORS[0][0];
const KIND_LABEL = { all: '전체 일정', weekdays: '요일별', dates: '날짜 선택' };
const KIND_ICON = { all: '📋', weekdays: '🔁', dates: '📌' };

const S = {
  mode: null,          // 'owner' | 'member'
  user: null, token: null,
  links: [], events: [], company: '', link: null,
  y: 0, m: 0, sel: '', filter: 'all',
  ch: null, busy: new Set(), askedName: false, reqId: 0,
};

/* ---------- 유틸 ---------- */
const pad = n => String(n).padStart(2, '0');
const ymd = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const parse = s => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
const md = s => { const d = parse(s); return `${d.getMonth() + 1}/${d.getDate()}(${WD[d.getDay()]})`; };
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const hm = t => (t ? String(t).slice(0, 5) : '');
const lsGet = k => { try { return localStorage.getItem(k); } catch { return null; } };
const lsSet = (k, v) => { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch {} };
const shareUrl = token => `${location.origin}${location.pathname}?g=${token}`;
const newToken = () => crypto.randomUUID().replace(/-/g, '') + crypto.randomUUID().replace(/-/g, '');
function fmtWhen(iso) { if (!iso) return ''; const d = new Date(iso); return `${d.getMonth() + 1}/${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}`; }
function gridRange() { const first = new Date(S.y, S.m, 1); const a = new Date(first); a.setDate(1 - first.getDay()); const b = new Date(a); b.setDate(a.getDate() + 41); return [a, b]; }

// 링크 규칙: 이 날짜가 링크에 포함되는지
function linkMatch(l, day) {
  if (!l) return true;
  if (l.kind === 'all') return true;
  if (l.kind === 'weekdays') return (l.weekdays || []).includes(parse(day).getDay());
  if (l.kind === 'dates') return (l.dates || []).includes(day);
  return false;
}
function linkDesc(l) {
  if (l.kind === 'all') return '모든 일정';
  if (l.kind === 'weekdays') {
    const w = [...(l.weekdays || [])].sort((a, b) => ((a + 6) % 7) - ((b + 6) % 7));   // 월~일 순
    return w.length ? `매주 ${w.map(i => WD[i]).join('·')}` : '요일 없음';
  }
  const d = [...(l.dates || [])].sort();
  if (!d.length) return '날짜 없음';
  return d.slice(0, 5).map(md).join(', ') + (d.length > 5 ? ` 외 ${d.length - 5}일` : '');
}

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
    const onKey = e => { if (e.key === 'Escape' && ov === document.querySelector('.ov:last-of-type')) close(undefined); };
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
  S.mode = 'owner'; S.user = user; S.token = null; S.link = null;
  document.body.className = 'owner';
  show('main');
  $('#brandTitle').textContent = '팀 캘린더';
  $('#brandSub').textContent = user.email;
  const ok = await reload();
  if (!ok) return;
  const pending = lsGet('tc.pendingCompany');
  if (pending && !S.company) { await sb.from('cal_settings').upsert({ owner: user.id, company: pending }); lsSet('tc.pendingCompany', null); S.company = pending; }
  if (!S.links.length && !lsGet('tc.linksInit.' + user.id)) {
    const { error } = await sb.from('cal_links').insert({ name: '전체 일정', kind: 'all' });
    if (!error) { lsSet('tc.linksInit.' + user.id, '1'); await reload(); toast('“전체 일정” 공유 링크를 만들었어요'); }
  }
  subscribe('cal-owner-' + user.id);
}

async function loadOwner() {
  const [a, b] = gridRange();
  const [l, e, s] = await Promise.all([
    sb.from('cal_links').select('*').order('created_at'),
    sb.from('cal_events').select('*').gte('day', ymd(a)).lte('day', ymd(b))
      .order('day').order('start_time', { nullsFirst: true }).order('created_at'),
    sb.from('cal_settings').select('company').maybeSingle(),
  ]);
  const err = l.error || e.error || s.error;
  if (err) throw err;
  return { links: l.data, events: e.data, company: s.data?.company || '' };
}

/* ---------- 직원 모드 ---------- */
async function startMember(token) {
  S.mode = 'member'; S.token = token; S.user = null;
  document.body.className = 'member';
  show('main');
  updateNameBtn();
  const ok = await reload();
  if (!ok) return;
  // 날짜 선택 링크: 오늘이 포함 안 되면 가장 가까운 공유 날짜로 이동
  if (S.link.kind === 'dates' && S.link.dates.length && !S.link.dates.includes(S.sel)) {
    const ds = [...S.link.dates].sort(), today = ymd(new Date());
    const target = ds.find(d => d >= today) || ds[ds.length - 1];
    const d = parse(target); S.sel = target;
    if (d.getFullYear() !== S.y || d.getMonth() !== S.m) { S.y = d.getFullYear(); S.m = d.getMonth(); await reload(); } else render();
  }
  subscribe('cal-' + token);
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
    buttons: [{ label: first ? '건너뛰기' : '취소', value: null }, { label: '저장', cls: 'primary', value: 'saved', run: ov => { lsSet(NAME_KEY, $('#nm', ov).value.trim() || null); } }],
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
      S.links = r.links; S.events = r.events; S.company = r.company;
      $('#brandTitle').textContent = S.company || '팀 캘린더';
      if (S.filter !== 'all' && !S.links.some(l => l.id === S.filter)) S.filter = 'all';
    } else if (S.mode === 'member') {
      const r = await loadMember();
      if (id !== S.reqId) return true;
      if (!r) {
        stopRealtime(); lsSet(TOKEN_KEY, null);
        notice('🔒', '링크를 열 수 없어요', '링크가 바뀌었거나 삭제되었어요. 대표님께 새 링크를 받아주세요.', { label: '대표 로그인', run: showLogin });
        return false;
      }
      S.link = r.link; S.company = r.company; S.events = r.events;
      $('#brandTitle').textContent = r.link.name;
      $('#brandSub').textContent = [r.company, linkDesc(r.link)].filter(Boolean).join(' · ');
      document.title = `${r.link.name} · ${r.company || '팀 캘린더'}`;
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
    // 로그인 토큰 만료 등: 로그아웃시키지 않고 조용히 갱신 후 다시 시도
    if (/JWT|expired|401/i.test(m) && S.mode === 'owner' && !S.retried) {
      S.retried = true;
      const { error } = await sb.auth.refreshSession();
      S.retried = false;
      if (!error) return reload();
      if (/refresh token|not found|invalid/i.test(error.message || '')) { showLogin(); return false; }
    }
    render();
    toast('불러오기 실패 — 인터넷 연결을 확인하세요');
    return S.mode === 'owner' || !!S.link;
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
// 지금 화면에 적용되는 링크 규칙 (직원: 받은 링크, 대표: 미리보기로 고른 링크)
function activeLink() { return S.mode === 'member' ? S.link : S.links.find(l => l.id === S.filter) || null; }
function visibleEvents() { const l = activeLink(); return l ? S.events.filter(e => linkMatch(l, e.day)) : S.events; }

function render() { renderFilters(); renderCal(); renderDay(); }

function renderFilters() {
  if (S.mode !== 'owner') return;
  const items = [{ id: 'all', name: '내 전체 일정' }, ...S.links.map(l => ({ id: l.id, name: `${KIND_ICON[l.kind]} ${l.name}` }))];
  $('#filters').innerHTML = (S.links.length ? '<span class="flabel">직원 화면 미리보기</span>' : '') +
    items.map(i => `<button class="fchip ${S.filter === i.id ? 'on' : ''}" data-f="${i.id}">${esc(i.name)}</button>`).join('');
}

function renderCal() {
  $('#monthLabel').textContent = `${S.y}년 ${S.m + 1}월`;
  const [start] = gridRange(), today = ymd(new Date()), l = activeLink();
  const byDay = {};
  for (const e of visibleEvents()) (byDay[e.day] ||= []).push(e);
  let html = '';
  for (let i = 0; i < 42; i++) {
    const d = new Date(start); d.setDate(start.getDate() + i);
    const k = ymd(d), evs = byDay[k] || [], done = evs.filter(e => e.done).length;
    const cls = ['cell', d.getMonth() !== S.m && 'out', l && !linkMatch(l, k) && 'off', l && l.kind !== 'all' && linkMatch(l, k) && 'shared',
      k === today && 'today', k === S.sel && 'sel', d.getDay() === 0 && 'sun', d.getDay() === 6 && 'sat'].filter(Boolean).join(' ');
    html += `<button class="${cls}" data-day="${k}" aria-label="${d.getMonth() + 1}월 ${d.getDate()}일 일정 ${evs.length}개">
      <span class="num">${d.getDate()}</span>
      ${evs.length ? `<span class="cnt ${done === evs.length ? 'all' : ''}">${done}/${evs.length}</span>` : ''}
      <span class="chips">${evs.slice(0, 3).map(e => `<span class="chip ${e.done ? 'done' : ''}" style="--c:${evColor(e)}">${esc(e.title)}</span>`).join('')}
      ${evs.length > 3 ? `<span class="more">+${evs.length - 3}</span>` : ''}</span></button>`;
  }
  $('#grid').innerHTML = html;
}

function renderDay() {
  const d = parse(S.sel), l = activeLink();
  $('#dayTitle').textContent = `${d.getMonth() + 1}월 ${d.getDate()}일 (${WD[d.getDay()]})`;
  const evs = visibleEvents().filter(e => e.day === S.sel);
  const done = evs.filter(e => e.done).length;
  $('#dayCount').textContent = evs.length ? `완료 ${done}/${evs.length}` : '';
  const owner = S.mode === 'owner';
  const shareTags = e => {
    const ls = S.links.filter(x => linkMatch(x, e.day));
    return ls.length ? ls.map(x => `<span class="tag">${KIND_ICON[x.kind]} ${esc(x.name)}</span>`).join('') : '<span class="tag">🔒 공유 안 됨</span>';
  };
  $('#dayList').innerHTML = evs.length ? evs.map(e => {
    const dm = e.done ? `<span class="donemark">✓ 완료${e.done_by ? ' · ' + esc(e.done_by) : ''}${e.done_at ? ' · ' + fmtWhen(e.done_at) : ''}</span>` : '';
    const tags = owner ? shareTags(e) : '';
    return `<div class="ev ${e.done ? 'done' : ''}" style="--c:${evColor(e)}">
      <button class="check ${e.done ? 'on' : ''}" data-check="${e.id}" aria-pressed="${e.done}" aria-label="${e.done ? '완료 취소' : '완료 체크'}" ${S.busy.has(e.id) ? 'disabled' : ''}>✓</button>
      <${owner ? 'button' : 'div'} class="body ${owner ? 'edit' : ''}" ${owner ? `data-edit="${e.id}" type="button"` : ''}>
        <div class="t">${esc(e.title)}</div>
        ${e.memo ? `<div class="memo">${esc(e.memo)}</div>` : ''}
        ${tags || dm ? `<div class="meta">${dm}${tags}</div>` : ''}
      </${owner ? 'button' : 'div'}>
    </div>`;
  }).join('') : `<div class="empty">${
      l && !linkMatch(l, S.sel) ? (owner ? `이 날은 “${esc(l.name)}” 링크에 포함되지 않아요.` : '이 날은 공유된 일정이 없어요.')
      : owner ? '일정이 없어요. “+ 일정”으로 추가하세요.' : '이 날은 일정이 없어요.'}</div>`;
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
  let color = e?.color || lsGet(COLOR_KEY) || COLORS[0][0];
  const html = `
    <label>일정 제목<input id="f_title" maxlength="100" required value="${esc(e?.title)}" placeholder="예: 매장 오픈 준비"></label>
    <label>날짜<input id="f_day" type="date" required value="${e?.day || S.sel}"></label>
    <label>메모 (선택)<textarea id="f_memo" rows="3" maxlength="1000" placeholder="준비물, 장소 등">${esc(e?.memo)}</textarea></label>
    <div class="fieldlabel">색깔</div>
    <div class="colors" id="f_colors">${COLORS.map(([c, n]) => `<button type="button" style="--c:${c}" data-c="${c}" class="${c === color ? 'on' : ''}" aria-label="${n}" title="${n}"></button>`).join('')}</div>
    <p class="fieldlabel" id="f_share"></p>`;
  const showShare = ov => {
    const day = $('#f_day', ov).value, ls = day ? S.links.filter(l => linkMatch(l, day)) : [];
    $('#f_share', ov).textContent = !day ? '' : ls.length ? `이 날짜 일정이 보이는 링크: ${ls.map(l => l.name).join(', ')}` : '이 날짜는 어떤 공유 링크에도 포함되지 않아요 (대표만 보임)';
  };
  const save = async ov => {
    const title = $('#f_title', ov).value.trim(), day = $('#f_day', ov).value;
    if (!title) { $('#f_title', ov).focus(); toast('제목을 입력하세요'); return false; }
    if (!day) { toast('날짜를 선택하세요'); return false; }
    const row = {
      title, day, color, memo: $('#f_memo', ov).value.trim(),
      start_time: null, end_time: null,
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
  if (e) buttons.push({ label: '📄 복사', value: 'copy' });
  buttons.push({ label: '취소', value: null }, { label: e ? '저장' : '추가', cls: 'primary', run: save });
  const res = await modal({ title: e ? '일정 수정' : '새 일정', html, buttons, onMount: ov => {
    showShare(ov); $('#f_day', ov).addEventListener('change', () => showShare(ov));
    $('#f_colors', ov).onclick = ev => {
      const b = ev.target.closest('[data-c]'); if (!b) return;
      color = b.dataset.c; lsSet(COLOR_KEY, color);
      ov.querySelectorAll('#f_colors button').forEach(x => x.classList.toggle('on', x === b));
    };
    if (!e) $('#f_title', ov).focus();
  } });
  if (res === 'copy') copyEvent(e);
}

// 여러 날짜를 고르는 작은 달력 (dates: 선택된 'YYYY-MM-DD' Set)
function miniCal(root, dates, y, m, mark) {
  root.innerHTML = `<div class="mini">
      <div class="mini-bar"><button type="button" class="btn ghost icon" data-mm="-1">‹</button><b></b><button type="button" class="btn ghost icon" data-mm="1">›</button></div>
      <div class="mini-dow">${WD.map(w => `<span>${w}</span>`).join('')}</div>
      <div class="mini-grid"></div>
    </div>
    <div class="picked"></div>`;
  const draw = () => {
    $('.mini-bar b', root).textContent = `${y}년 ${m + 1}월`;
    const f = new Date(y, m, 1), start = new Date(f); start.setDate(1 - f.getDay());
    const today = ymd(new Date());
    let h = '';
    for (let i = 0; i < 42; i++) {
      const d = new Date(start); d.setDate(start.getDate() + i); const k = ymd(d);
      h += `<button type="button" data-d="${k}" class="${[d.getMonth() !== m && 'out', dates.has(k) && 'on', k === today && 'today', k === mark && 'mark'].filter(Boolean).join(' ')}">${d.getDate()}</button>`;
    }
    $('.mini-grid', root).innerHTML = h;
    const ds = [...dates].sort();
    $('.picked', root).innerHTML = ds.length
      ? `<span class="fieldlabel">${ds.length}일 선택</span>` + ds.map(k => `<button type="button" class="pchip" data-x="${k}">${md(k)} ✕</button>`).join('')
      : '<span class="fieldlabel">선택한 날짜가 없어요</span>';
  };
  root.onclick = e => {
    const mm = e.target.closest('[data-mm]'), d = e.target.closest('[data-d]'), x = e.target.closest('[data-x]');
    if (mm) { m += +mm.dataset.mm; if (m < 0) { m = 11; y--; } if (m > 11) { m = 0; y++; } }
    else if (d) dates.has(d.dataset.d) ? dates.delete(d.dataset.d) : dates.add(d.dataset.d);
    else if (x) dates.delete(x.dataset.x);
    else return;
    draw();
  };
  draw();
  return { draw, go(yy, mo) { y = yy; m = mo; draw(); } };
}

/* ---------- 일정 복사 (대표) ---------- */
async function copyEvent(e) {
  const dates = new Set(), base = parse(e.day);
  await modal({
    title: '일정 복사',
    text: `“${e.title}” 일정을 제목·메모·색깔 그대로 복사해요. 복사할 날짜를 고르세요 (여러 날 가능, 점선이 원래 날짜).`,
    html: `<div class="quick">
        <button type="button" class="btn sm" data-add="1">다음 날</button>
        <button type="button" class="btn sm" data-add="7">다음 주 같은 요일</button>
        <button type="button" class="btn sm" data-add="w4">앞으로 4주 매주</button>
      </div>
      <div id="cp_cal" style="margin-top:8px"></div>`,
    buttons: [{ label: '취소', value: false }, { label: '복사하기', cls: 'primary', value: true, run: async () => {
      if (!dates.size) { toast('복사할 날짜를 고르세요'); return false; }
      const rows = [...dates].sort().map(day => ({ title: e.title, memo: e.memo || '', color: evColor(e), day }));
      const { error } = await sb.from('cal_events').insert(rows);
      if (error) { toast('복사 실패: ' + error.message); return false; }
      await reload(); toast(`${rows.length}개 날짜에 복사했어요`);
    } }],
    onMount: ov => {
      const cal = miniCal($('#cp_cal', ov), dates, base.getFullYear(), base.getMonth(), e.day);
      $('.quick', ov).onclick = ev => {
        const a = ev.target.closest('[data-add]')?.dataset.add; if (!a) return;
        const add = n => { const d = new Date(base); d.setDate(d.getDate() + n); dates.add(ymd(d)); return d; };
        let last;
        if (a === 'w4') for (let i = 1; i <= 4; i++) last = add(7 * i); else last = add(+a);
        cal.go(last.getFullYear(), last.getMonth());
      };
    },
  });
}

/* ---------- 공유 링크 (대표) ---------- */
async function openLinks() {
  await modal({
    title: '공유 링크',
    text: '링크를 받은 직원은 일정을 보기만 하고, 완료 체크만 할 수 있어요.',
    html: `<div class="addrow">
        <button class="btn" data-new="all">📋 전체 일정</button>
        <button class="btn" data-new="weekdays">🔁 요일별</button>
        <button class="btn" data-new="dates">📌 날짜 선택</button>
      </div>
      <div class="glist" id="glist"></div>`,
    buttons: [{ label: '닫기', cls: 'primary' }],
    onMount: ov => {
      const draw = () => {
        $('#glist', ov).innerHTML = S.links.map(l => `
          <div class="gitem">
            <div class="gtop"><span class="kind">${KIND_ICON[l.kind]} ${KIND_LABEL[l.kind]}</span><span class="gname">${esc(l.name)}</span></div>
            <div class="gdesc">${esc(linkDesc(l))}</div>
            <div class="glink">${esc(shareUrl(l.token))}</div>
            <div class="gbtns">
              <button class="btn sm primary" data-a="copy" data-id="${l.id}">링크 복사</button>
              ${navigator.share ? `<button class="btn sm" data-a="share" data-id="${l.id}">보내기</button>` : ''}
              <button class="btn sm" data-a="edit" data-id="${l.id}">수정</button>
              <button class="btn sm" data-a="regen" data-id="${l.id}">링크 새로 만들기</button>
              <button class="btn sm danger" data-a="del" data-id="${l.id}">삭제</button>
            </div>
          </div>`).join('') || '<div class="empty">위 버튼으로 공유 링크를 만드세요.</div>';
      };
      draw();
      ov.querySelectorAll('[data-new]').forEach(b => b.onclick = async () => { if (await editLink(null, b.dataset.new)) draw(); });
      $('#glist', ov).onclick = async ev => {
        const b = ev.target.closest('button[data-a]'); if (!b) return;
        const l = S.links.find(x => x.id === b.dataset.id); if (!l) return;
        const url = shareUrl(l.token), a = b.dataset.a;
        if (a === 'copy') {
          try { await navigator.clipboard.writeText(url); toast('링크를 복사했어요. 카톡 등에 붙여넣으세요'); }
          catch { window.prompt('아래 링크를 복사하세요', url); }
        } else if (a === 'share') {
          navigator.share({ title: l.name, text: `${S.company ? S.company + ' ' : ''}${l.name} (${linkDesc(l)})`, url }).catch(() => {});
        } else if (a === 'edit') {
          if (await editLink(l)) draw();
        } else if (a === 'regen') {
          if (!(await confirmBox('링크를 새로 만들까요?', `“${l.name}”의 기존 링크는 더 이상 열리지 않아요. 새 링크를 다시 보내줘야 합니다.`, '새로 만들기', '취소', true))) return;
          const { error } = await sb.from('cal_links').update({ token: newToken() }).eq('id', l.id);
          if (error) return toast('실패: ' + error.message);
          await reload(); draw(); toast('새 링크를 만들었어요');
        } else if (a === 'del') {
          if (!(await confirmBox('링크를 삭제할까요?', `“${l.name}” 링크로는 더 이상 볼 수 없어요. 일정은 그대로 남아요.`, '삭제', '취소', true))) return;
          const { error } = await sb.from('cal_links').delete().eq('id', l.id);
          if (error) return toast('실패: ' + error.message);
          await reload(); draw(); toast('삭제했어요');
        }
      };
    },
  });
}

async function editLink(l, kind0) {
  let kind = l?.kind || kind0 || 'all';
  const wd = new Set(l?.weekdays || (kind === 'weekdays' ? [6, 0] : []));
  const dates = new Set(l?.dates || (kind === 'dates' ? [S.sel] : []));
  const first = [...dates].sort()[0];
  let py = first ? parse(first).getFullYear() : S.y, pm = first ? parse(first).getMonth() : S.m;
  const defName = { all: '전체 일정', weekdays: '주말 일정', dates: '선택한 날짜 일정' };
  let nameTouched = !!l;

  const r = await modal({
    title: l ? '공유 링크 수정' : '새 공유 링크',
    html: `<div class="seg" id="l_kind">${['all', 'weekdays', 'dates'].map(k => `<button type="button" data-k="${k}">${KIND_ICON[k]} ${KIND_LABEL[k]}</button>`).join('')}</div>
      <label>링크 이름 (직원 화면 제목)<input id="l_name" maxlength="30" value="${esc(l?.name || defName[kind])}"></label>
      <div id="p_all" class="fieldlabel">모든 날짜의 일정이 보여요.</div>
      <div id="p_weekdays"><div class="fieldlabel">보여줄 요일 (매주 반복)</div>
        <div class="wdays">${[1, 2, 3, 4, 5, 6, 0].map(i => `<button type="button" data-w="${i}" class="${i === 0 ? 'sun' : i === 6 ? 'sat' : ''}">${WD[i]}</button>`).join('')}</div>
        <div class="quick"><button type="button" class="btn sm" data-q="weekend">주말</button><button type="button" class="btn sm" data-q="weekday">평일</button><button type="button" class="btn sm" data-q="clear">지우기</button></div>
      </div>
      <div id="p_dates"><div class="fieldlabel">보여줄 날짜를 누르세요 (여러 개 선택 가능)</div>
        <div class="mini">
          <div class="mini-bar"><button type="button" class="btn ghost icon" data-mm="-1">‹</button><b id="mini_label"></b><button type="button" class="btn ghost icon" data-mm="1">›</button></div>
          <div class="mini-dow">${WD.map(w => `<span>${w}</span>`).join('')}</div>
          <div class="mini-grid" id="mini_grid"></div>
        </div>
        <div class="picked" id="picked"></div>
      </div>`,
    buttons: [{ label: '취소', value: false }, { label: '저장', cls: 'primary', value: true, run: async ov => {
      const name = $('#l_name', ov).value.trim();
      if (!name) { toast('링크 이름을 입력하세요'); return false; }
      if (kind === 'weekdays' && !wd.size) { toast('요일을 하나 이상 고르세요'); return false; }
      if (kind === 'dates' && !dates.size) { toast('날짜를 하나 이상 고르세요'); return false; }
      const row = { name, kind, weekdays: kind === 'weekdays' ? [...wd].sort() : [], dates: kind === 'dates' ? [...dates].sort() : [] };
      const { error } = l ? await sb.from('cal_links').update(row).eq('id', l.id) : await sb.from('cal_links').insert(row);
      if (error) { toast('저장 실패: ' + error.message); return false; }
      await reload(); toast(l ? '수정했어요' : '링크를 만들었어요. “링크 복사”로 보내세요');
    } }],
    onMount: ov => {
      const nameEl = $('#l_name', ov);
      nameEl.addEventListener('input', () => { nameTouched = true; });
      const drawKind = () => {
        ov.querySelectorAll('#l_kind button').forEach(b => b.classList.toggle('on', b.dataset.k === kind));
        for (const k of ['all', 'weekdays', 'dates']) $('#p_' + k, ov).hidden = k !== kind;
        if (!nameTouched) nameEl.value = defName[kind];
      };
      const drawWd = () => ov.querySelectorAll('[data-w]').forEach(b => b.classList.toggle('on', wd.has(+b.dataset.w)));
      const drawMini = () => {
        $('#mini_label', ov).textContent = `${py}년 ${pm + 1}월`;
        const f = new Date(py, pm, 1), start = new Date(f); start.setDate(1 - f.getDay());
        const today = ymd(new Date());
        let h = '';
        for (let i = 0; i < 42; i++) {
          const d = new Date(start); d.setDate(start.getDate() + i); const k = ymd(d);
          const has = S.events.some(e => e.day === k);
          h += `<button type="button" data-d="${k}" class="${[d.getMonth() !== pm && 'out', dates.has(k) && 'on', k === today && 'today', has && 'has'].filter(Boolean).join(' ')}">${d.getDate()}</button>`;
        }
        $('#mini_grid', ov).innerHTML = h;
        const ds = [...dates].sort();
        $('#picked', ov).innerHTML = ds.length ? `<span class="fieldlabel">${ds.length}일 선택</span>` + ds.map(k => `<button type="button" class="pchip" data-x="${k}">${md(k)} ✕</button>`).join('') : '<span class="fieldlabel">선택한 날짜가 없어요</span>';
      };
      $('#l_kind', ov).onclick = e => { const b = e.target.closest('[data-k]'); if (!b) return; kind = b.dataset.k; if (kind === 'weekdays' && !wd.size) { wd.add(6); wd.add(0); drawWd(); } if (kind === 'dates' && !dates.size) { dates.add(S.sel); drawMini(); } drawKind(); };
      $('.wdays', ov).onclick = e => { const b = e.target.closest('[data-w]'); if (!b) return; const w = +b.dataset.w; wd.has(w) ? wd.delete(w) : wd.add(w); drawWd(); };
      $('.quick', ov).onclick = e => { const q = e.target.closest('[data-q]')?.dataset.q; if (!q) return; wd.clear(); if (q === 'weekend') [6, 0].forEach(x => wd.add(x)); if (q === 'weekday') [1, 2, 3, 4, 5].forEach(x => wd.add(x)); drawWd(); };
      $('.mini-bar', ov).onclick = e => { const b = e.target.closest('[data-mm]'); if (!b) return; pm += +b.dataset.mm; if (pm < 0) { pm = 11; py--; } if (pm > 11) { pm = 0; py++; } drawMini(); };
      $('#mini_grid', ov).onclick = e => { const b = e.target.closest('[data-d]'); if (!b) return; const k = b.dataset.d; dates.has(k) ? dates.delete(k) : dates.add(k); drawMini(); };
      $('#picked', ov).onclick = e => { const b = e.target.closest('[data-x]'); if (!b) return; dates.delete(b.dataset.x); drawMini(); };
      drawKind(); drawWd(); drawMini();
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
  $('#btnGroups').onclick = openLinks;
  $('#btnSettings').onclick = openSettings;
  $('#btnName').onclick = () => askName(false);
  $('#btnOwnerLogin').onclick = showLogin;
  sb.auth.onAuthStateChange(ev => { if (ev === 'SIGNED_OUT' && S.mode === 'owner') showLogin(); });
}

if ('serviceWorker' in navigator && !/^(localhost|127\.0\.0\.1)$/.test(location.hostname)) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
boot();
