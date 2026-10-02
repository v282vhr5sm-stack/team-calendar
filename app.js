/* 팀 캘린더 — 대표: 일정 작성/수정, 직원(링크): 보기 + 완료 체크 */
const $ = (s, el = document) => el.querySelector(s);
const cfg = window.APP_CONFIG || {};
// 비밀번호 재설정 메일의 링크로 들어왔는지 (주소의 #type=recovery), 링크 오류(만료 등)
const AUTH_HASH = location.hash;
const RECOVERY = /type=recovery/.test(AUTH_HASH);
const AUTH_ERR = /error_code=([^&]+)/.exec(AUTH_HASH)?.[1] || '';
// 대표 로그인은 이 기기에 저장되고 자동으로 갱신됨 → 직접 로그아웃하기 전까지 자동 로그인
const sb = supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_KEY, {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, flowType: 'implicit' },
});
const TOKEN_KEY = 'tc.token', NAME_KEY = 'tc.name';
const WD = ['일', '월', '화', '수', '목', '금', '토'];
const COLORS = [
  ['#2563eb', '파랑'], ['#16a34a', '초록'], ['#f59e0b', '주황'], ['#dc2626', '빨강'],
  ['#9333ea', '보라'], ['#0891b2', '청록'], ['#db2777', '분홍'], ['#64748b', '회색'],
];
const CAT_KEY = 'tc.lastCat';
let HOL = {};        // 대한민국 공휴일 { 'YYYY-MM-DD': '추석' } — holidays.json (매주 자동 갱신)
let CHIP_MAX = 4;   // 달력 한 칸에 보여줄 일정 줄 수 (폰에서는 칸 높이에 맞춰 자동 계산, 넘치면 오른쪽 위에 +N)
// 달력의 완료 표시: 검은 테두리 노란 별
const STAR = '<svg class="star" viewBox="0 0 24 24" aria-label="완료"><path d="M12 2.2l2.95 6.1 6.7.9-4.9 4.65 1.25 6.65L12 17.3l-6 3.2 1.25-6.65L2.35 9.2l6.7-.9z" fill="#facc15" stroke="#000" stroke-width="2.2" stroke-linejoin="round"/></svg>';
// 처음 쓸 때 넣어두는 기본 분류 (설정 > 분류 관리에서 자유롭게 수정)
const DEFAULT_CATS = [
  ['철수날짜', '#ef5cf5'], ['철수완료', '#16b34a'], ['연장', '#98703f'], ['AS', '#ff4f0f'],
  ['연기', '#5661b0'], ['납품완료', '#0b35f5'], ['전날입고가능', '#ff9fd0'],
];
const catById = id => S.cats.find(c => c.id === id);
const evColor = e => catById(e.category_id)?.color || e.color || COLORS[0][0];
const KIND_LABEL = { all: '전체 일정', weekdays: '요일별', dates: '날짜 선택' };
const KIND_ICON = { all: '📋', weekdays: '🔁', dates: '📌' };

const S = {
  mode: null,          // 'owner' | 'member'
  user: null, token: null,
  links: [], events: [], cats: [], company: '', catsInit: true, link: null,
  y: 0, m: 0, sel: '', filter: 'all',
  ch: null, gate: null, busy: new Set(), askedName: false, reqId: 0,
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

/* ---------- 뒤로가기 (안드로이드 뒤로 버튼·브라우저 ‹) ---------- */
// 뒤로 갈 기록이 없으면 앱 안 브라우저(네이버·카톡 등)가 통째로 닫힘 → 기록 한 칸을 깔아두고 가로챔
const modalStack = [];
let lastBack = 0;
// 주의: 기록은 반드시 사용자가 탭한 순간에만 깔아야 함. 자동으로(뒤로가기 처리 중에) 깔면
// 크롬이 그 아래 기록을 '건너뛸 기록'으로 표시해서 다음 뒤로가기 때 사이트가 통째로 닫힘
function armBack() {
  if (history.state && history.state.tcGuard) return;
  if (navigator.userActivation && !navigator.userActivation.isActive) return;   // 사용자 동작 중이 아니면 깔지 않음
  history.pushState({ tcGuard: 1 }, '');
}
window.addEventListener('popstate', () => {
  // 여기서는 pushState 하지 않음 (다음 탭 때 다시 깔림)
  if (modalStack.length) { modalStack[modalStack.length - 1](undefined); return; }
  lastBack = Date.now(); toast('뒤로 버튼을 한 번 더 누르면 닫혀요');
});
// 폰은 손가락을 뗄 때(탭)만 '사용자 동작'으로 인정됨 → 그때 기록을 깔아야 뒤로가기에서 무시되지 않음
['pointerup', 'touchend', 'click', 'keydown'].forEach(ev => document.addEventListener(ev, armBack, true));

/* ---------- 모달 ---------- */
function modal({ title, text = '', html = '', buttons = [], onMount, protect = true }) {
  return new Promise(resolve => {
    const ov = document.createElement('div');
    ov.className = 'ov';
    ov.innerHTML = `<div class="modal" role="dialog" aria-modal="true"><h3>${esc(title)}</h3>${text ? `<p class="mtext">${esc(text)}</p>` : ''}<div class="mbody">${html}</div><div class="mbtns"></div></div>`;
    const box = $('.mbtns', ov);
    let dirty = false, asking = false;
    const close = v => {
      if (!ov.isConnected) return;
      ov.remove(); document.removeEventListener('keydown', onKey);
      const i = modalStack.indexOf(soft); if (i >= 0) modalStack.splice(i, 1);
      resolve(v);
    };
    // 버튼이 아닌 방법(바깥 누르기·뒤로가기·Esc·취소)으로 닫을 때: 입력한 게 있으면 먼저 물어봄
    const soft = async v => {
      if (!ov.isConnected || asking) return;
      if (protect && dirty) {
        asking = true;
        const ok = await confirmBox('작성 중인 내용이 있어요', '지금 닫으면 입력한 내용이 저장되지 않아요. 닫을까요?', '저장 안 하고 닫기', '계속 작성', true);
        asking = false;
        if (!ok) return;
      }
      close(v);
    };
    ov.addEventListener('input', () => { dirty = true; });
    ov.addEventListener('click', e => { if (e.target.closest('.catpick, .colors, .wdays, .mini-grid, .seg, .quick')) dirty = true; });
    modalStack.push(soft);
    armBack();
    const onKey = e => { if (e.key === 'Escape' && ov === document.querySelector('.ov:last-of-type')) soft(undefined); };
    for (const b of buttons) {
      const el = document.createElement('button');
      el.type = 'button'; el.className = 'btn ' + (b.cls || ''); el.textContent = b.label;
      el.onclick = async () => {
        if (b.soft) return soft(b.value);
        if (b.run) {
          if (el.disabled) return;   // 두 번 눌러도 한 번만 실행
          el.disabled = true; let r;
          try { r = await b.run(ov); }
          catch (err) { console.error(err); toast('처리하지 못했어요 — 입력한 내용은 그대로 있어요. 다시 눌러주세요'); r = false; }
          finally { el.disabled = false; }
          if (r === false) return;
        }
        close(b.value);
      };
      box.appendChild(el);
    }
    ov.addEventListener('click', e => { if (e.target === ov) soft(undefined); });
    document.addEventListener('keydown', onKey);
    document.body.appendChild(ov);
    onMount && onMount(ov, close);
  });
}
const confirmBox = (title, text, yes = '확인', no = '취소', danger = false) =>
  modal({ title, text, buttons: [{ label: no, value: false }, { label: yes, value: true, cls: danger ? 'danger fill' : 'primary' }] }).then(v => v === true);

/* ---------- 시작 ---------- */
// 공휴일 목록 불러오기 (실패해도 달력은 그대로 동작)
function loadHolidays() {
  fetch('holidays.json', { cache: 'no-cache' }).then(r => r.ok ? r.json() : null)
    .then(j => { if (j && j.days) { HOL = j.days; if (S.mode && !$('#main').hidden) render(); } }).catch(() => {});
}
async function boot() {
  loadHolidays();
  const now = new Date(); S.y = now.getFullYear(); S.m = now.getMonth(); S.sel = ymd(now);
  bindUI();
  const t = new URLSearchParams(location.search).get('g');
  if (t) { lsSet(TOKEN_KEY, t); return startMember(t); }
  const { data: { session } } = await sb.auth.getSession();
  if (RECOVERY || AUTH_ERR) history.replaceState(null, '', location.pathname);   // 주소창의 인증 정보 지우기
  if (AUTH_ERR && !session) {
    showLogin();
    return modal({ title: '링크를 쓸 수 없어요', text: '메일의 링크가 만료됐거나 이미 사용됐어요. “비밀번호를 잊었어요”로 다시 받아주세요.', buttons: [{ label: '확인', cls: 'primary' }] });
  }
  if (session && RECOVERY) { await startOwner(session.user); return setNewPassword(); }
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
  stopRealtime(); S.mode = null; S.gate = null; document.body.className = '';
  show('login');
  const f = $('#loginForm'); if (!f.email.value) f.email.value = lsGet('tc.lastEmail') || '';
}

async function forgotPassword() {
  await modal({
    title: '비밀번호 찾기',
    text: '설정에서 정해둔 "비밀번호 찾기용 확인번호"를 입력하면 새 비밀번호로 바꿀 수 있어요.',
    html: `<label>가입한 이메일<input id="fp_email" type="email" autocomplete="email" value="${esc($('#loginForm').email.value || lsGet('tc.lastEmail') || '')}"></label>
      <label>확인번호<input id="fp_code" type="password" inputmode="numeric" pattern="[0-9]*" maxlength="12" autocomplete="off"></label>
      <label>새 비밀번호 (6자 이상)<input id="fp_new1" type="password" autocomplete="new-password"></label>
      <label>새 비밀번호 한 번 더<input id="fp_new2" type="password" autocomplete="new-password"></label>
      <p class="msg" id="fp_msg"></p>`,
    buttons: [{ label: '취소' }, { label: '비밀번호 바꾸기', cls: 'primary', run: async ov => {
      const email = $('#fp_email', ov).value.trim(), code = $('#fp_code', ov).value.trim();
      const a = $('#fp_new1', ov).value, b = $('#fp_new2', ov).value, msg = $('#fp_msg', ov);
      const say = t => { msg.textContent = t; return false; };
      if (!/^\S+@\S+\.\S+$/.test(email)) return say('이메일을 확인하세요');
      if (!code) return say('확인번호를 입력하세요');
      if (a.length < 6) return say('새 비밀번호는 6자 이상으로 정하세요');
      if (a !== b) return say('새 비밀번호 두 개가 달라요');
      const { data, error } = await sb.rpc('cal_reset_password', { p_email: email, p_code: code, p_new: a });
      if (error) return say('바꾸지 못했어요: ' + error.message);
      if (data?.error) return say({
        bad: '이메일 또는 확인번호가 맞지 않아요',
        nocode: '이 계정은 확인번호를 정해두지 않았어요. 관리자에게 문의하세요',
        locked: '여러 번 틀려서 30분 동안 잠겼어요. 잠시 후 다시 해주세요',
        short: '새 비밀번호는 6자 이상으로 정하세요',
      }[data.error] || '바꾸지 못했어요');
      // 바뀐 비밀번호로 바로 로그인
      const { data: li, error: le } = await sb.auth.signInWithPassword({ email, password: a });
      lsSet('tc.lastEmail', email);
      if (le) { toast('비밀번호를 바꿨어요. 새 비밀번호로 로그인하세요'); return; }
      toast('비밀번호를 바꾸고 로그인했어요');
      startOwner(li.user);
    } }],
  });
}

// 비밀번호 찾기용 확인번호 정하기/바꾸기 (대표, 로그인 상태)
async function setRecoveryCode() {
  return modal({
    title: '비밀번호 찾기용 확인번호',
    text: '비밀번호를 잊었을 때 이 번호로 새 비밀번호를 정할 수 있어요. 대표님만 아는 숫자로 정하고 잘 기억해 두세요. (5번 틀리면 30분 잠김)',
    html: `<label>확인번호 (숫자 4~12자리)<input id="rc1" type="password" inputmode="numeric" pattern="[0-9]*" maxlength="12" autocomplete="off"></label>
      <label>한 번 더<input id="rc2" type="password" inputmode="numeric" pattern="[0-9]*" maxlength="12" autocomplete="off"></label>
      <p class="msg" id="rc_msg"></p>`,
    buttons: [{ label: '나중에', value: false }, { label: '저장', cls: 'primary', value: true, run: async ov => {
      const a = $('#rc1', ov).value.trim(), b = $('#rc2', ov).value.trim(), msg = $('#rc_msg', ov);
      if (!/^[0-9]{4,12}$/.test(a)) { msg.textContent = '숫자 4~12자리로 정하세요'; return false; }
      if (a !== b) { msg.textContent = '두 번호가 달라요'; return false; }
      const { error } = await sb.rpc('cal_set_recovery_code', { p_code: a });
      if (error) { msg.textContent = '저장 실패: ' + error.message; return false; }
      S.hasRecovery = true; toast('확인번호를 저장했어요');
    } }],
    onMount: ov => $('#rc1', ov).focus(),
  });
}

async function forgotEmail() {
  await modal({
    title: '아이디(이메일) 찾기',
    text: '가입할 때 적은 회사 이름을 입력하면, 가입한 이메일을 일부 가려서 보여드려요.',
    html: `<label>회사 이름<input id="fe_co" maxlength="40" placeholder="예: 당근렌탈"></label><p class="msg ok" id="fe_out"></p>`,
    buttons: [{ label: '닫기' }, { label: '찾기', cls: 'primary', run: async ov => {
      const co = $('#fe_co', ov).value.trim();
      if (co.length < 2) { toast('회사 이름을 입력하세요'); return false; }
      const { data, error } = await sb.rpc('cal_find_account', { p_company: co });
      const out = $('#fe_out', ov);
      if (error) { out.className = 'msg'; out.textContent = '찾지 못했어요: ' + error.message; return false; }
      out.className = data.length ? 'msg ok' : 'msg';
      out.textContent = data.length ? '가입한 이메일: ' + data.join(', ') : '그 회사 이름으로 가입한 계정을 찾지 못했어요. 설정의 회사 이름과 똑같이 입력해 보세요.';
      return false;   // 창을 닫지 않고 결과를 보여줌
    } }],
  });
}

async function setNewPassword() {
  await modal({
    title: '새 비밀번호 정하기',
    text: '앞으로 로그인할 때 쓸 새 비밀번호를 입력하세요.',
    html: `<label>새 비밀번호 (6자 이상)<input id="np1" type="password" autocomplete="new-password" minlength="6"></label>
      <label>한 번 더<input id="np2" type="password" autocomplete="new-password" minlength="6"></label>`,
    buttons: [{ label: '나중에' }, { label: '저장', cls: 'primary', run: async ov => {
      const a = $('#np1', ov).value, b = $('#np2', ov).value;
      if (a.length < 6) { toast('6자 이상 입력하세요'); return false; }
      if (a !== b) { toast('두 비밀번호가 달라요'); return false; }
      const { error } = await sb.auth.updateUser({ password: a });
      if (error) { toast('저장 실패: ' + error.message); return false; }
      toast('새 비밀번호로 바꿨어요');
    } }],
  });
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
      lsSet('tc.lastEmail', email);
      if (data.session) return startOwner(data.session.user);
      msg.className = 'msg ok';
      msg.textContent = '확인 메일을 보냈어요. 메일의 링크를 누른 뒤 로그인하세요.';
      setTimeout(() => setLoginTab('in'), 50);
    } else {
      const { data, error } = await sb.auth.signInWithPassword({ email, password });
      if (error) throw error;
      lsSet('tc.lastEmail', email);
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
  // 브라우저가 저장 공간(로그인 정보)을 임의로 비우지 않도록 요청 → 비밀번호 저장(삼성패스 등) 없이도 로그인 유지
  try { navigator.storage?.persist?.(); } catch {}
  lsSet('tc.owner', '1');
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
  const lastBk = +lsGet('tc.lastBackup') || 0, nag = lsGet('tc.backupNag');
  if (S.events.length && Date.now() - lastBk > 14 * 864e5 && nag !== ymd(new Date())) {
    lsSet('tc.backupNag', ymd(new Date()));
    setTimeout(() => toast('💾 백업한 지 2주가 넘었어요 — 컴퓨터에서 ⚙️ 설정 → 내 컴퓨터에 백업하기'), 2500);
  }
  if (!S.catsInit) {
    if (!S.cats.length) await sb.from('cal_categories').insert(DEFAULT_CATS.map(([name, color], i) => ({ name, color, sort: i })));
    await sb.from('cal_settings').upsert({ owner: user.id, company: S.company, cats_init: true });
    await reload();
  }
  subscribe('cal-owner-' + user.id);
  if (!S.hasRecovery && lsGet('tc.recNag') !== ymd(new Date())) {
    lsSet('tc.recNag', ymd(new Date()));
    setTimeout(() => { if (!document.querySelector('.ov')) setRecoveryCode(); }, 1200);
  }
}

async function loadOwner() {
  const [a, b] = gridRange();
  const [l, e, s, c] = await Promise.all([
    sb.from('cal_links').select('*').order('created_at'),
    sb.from('cal_events').select('*').gte('day', ymd(a)).lte('day', ymd(b))
      .order('day').order('sort', { ascending: true, nullsFirst: false }).order('created_at'),
    sb.from('cal_settings').select('company, cats_init, recovery_hash').maybeSingle(),
    sb.from('cal_categories').select('*').order('sort').order('created_at'),
  ]);
  const err = l.error || e.error || s.error || c.error;
  if (err) throw err;
  return { links: l.data, events: e.data, company: s.data?.company || '', catsInit: !!s.data?.cats_init, hasRecovery: !!s.data?.recovery_hash, cats: c.data };
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
  if (!S.ch) subscribe('cal-' + token);
}

// 링크가 PIN을 요구하거나, 멈춤/기한 만료/잠김일 때 보여줄 화면
function memberGate(err, name) {
  S.gate = err;
  if (err === 'inactive') return notice('⏸️', '잠시 멈춘 링크예요', '대표님이 이 링크를 잠시 멈췄어요. 다시 열리면 이 화면에서 자동으로 보여요.');
  if (err === 'expired') return notice('📅', '사용 기간이 끝난 링크예요', '대표님께 새 링크를 받아주세요.');
  if (err === 'locked') return notice('⏳', '잠시 잠겼어요', 'PIN을 여러 번 틀려서 15분 동안 잠겼어요. 잠시 후 다시 열어주세요.');
  if (err === 'badpin') lsSet('tc.pin.' + S.token, null);
  show('notice');
  $('#notice').innerHTML = `<div class="box"><div style="font-size:40px">🔒</div><h2>${esc(name || '팀 캘린더')}</h2>
    <p>이 일정표는 PIN(숫자 비밀번호)이 필요해요.<br>대표님께 받은 PIN을 입력하세요.</p>
    <form id="pinForm"><input id="pinInput" class="pin" type="password" inputmode="numeric" pattern="[0-9]*" maxlength="8" autocomplete="off" placeholder="PIN">
    <p class="msg">${err === 'badpin' ? 'PIN이 맞지 않아요. 다시 확인해 주세요.' : ''}</p>
    <button class="btn primary wide">확인</button></form></div>`;
  $('#pinInput').focus();
  $('#pinForm').onsubmit = e => {
    e.preventDefault();
    const v = $('#pinInput').value.trim(); if (!v) return;
    lsSet('tc.pin.' + S.token, v); S.gate = null; reload();
  };
}

async function loadMember() {
  const [a, b] = gridRange();
  const { data, error } = await sb.rpc('cal_view', { p_token: S.token, p_from: ymd(a), p_to: ymd(b), p_pin: lsGet('tc.pin.' + S.token) });
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
  if (dragging) { scheduleReload(800); return true; }   // 끄는 중에는 화면을 다시 그리지 않음
  const id = ++S.reqId;
  try {
    if (S.mode === 'owner') {
      const r = await loadOwner();
      if (id !== S.reqId) return true;
      S.links = r.links; S.events = r.events; S.company = r.company; S.cats = r.cats; S.catsInit = r.catsInit; S.hasRecovery = r.hasRecovery;
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
      if (r.error) { stopRealtime(); memberGate(r.error, r.name); return false; }
      S.gate = null; show('main');
      if (!S.ch) subscribe('cal-' + S.token);
      S.link = r.link; S.company = r.company; S.events = r.events; S.cats = r.categories || [];
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
const canPoll = () => S.mode && S.gate !== 'pin' && S.gate !== 'badpin';   // PIN 입력 중에는 화면을 건드리지 않음
document.addEventListener('visibilitychange', () => { if (!document.hidden && canPoll()) scheduleReload(0); });
window.addEventListener('online', () => canPoll() && scheduleReload(0));
let fitT; window.addEventListener('resize', () => { clearTimeout(fitT); fitT = setTimeout(() => { if (S.mode && !dragging) renderCal(); }, 150); });
setInterval(() => { if (!document.hidden && canPoll()) reload(); }, 30000);

/* ---------- 그리기 ---------- */
// 지금 화면에 적용되는 링크 규칙 (직원: 받은 링크, 대표: 미리보기로 고른 링크)
function activeLink() { return S.mode === 'member' ? S.link : S.links.find(l => l.id === S.filter) || null; }
function visibleEvents() { const l = activeLink(); return l ? S.events.filter(e => linkMatch(l, e.day)) : S.events; }

// 하루 안에서 보여줄 순서: 아직 안 한 일정(대표가 정한 순서) 위, 완료한 일정은 아래로 — 먼저 체크한 것부터
function dayOrder(evs) {
  const open = evs.filter(e => !e.done);
  const done = evs.filter(e => e.done).sort((a, b) => String(a.done_at || '').localeCompare(String(b.done_at || '')));
  return [...open, ...done];
}
// 화면에 보여줄 일정 제목: 직원(링크)과 대표의 "직원 화면 미리보기"에서는 직원용 제목
const staffTitle = e => (e.staff_title && e.staff_title.trim()) || e.title;
const showTitle = e => (S.mode === 'owner' && activeLink() ? staffTitle(e) : e.title);
function render() { renderFilters(); $('#legend').innerHTML = legendHtml(); renderCal(); renderDay(); }

function renderFilters() {
  if (S.mode !== 'owner') return;
  const items = [{ id: 'all', name: '내 전체 일정' }, ...S.links.map(l => ({ id: l.id, name: `${KIND_ICON[l.kind]} ${l.name}` }))];
  $('#filters').innerHTML = (S.links.length ? '<span class="flabel">👀 직원 화면 미리보기</span>' : '') +
    items.map(i => `<button class="fchip ${S.filter === i.id ? 'on' : ''}" data-f="${i.id}">${esc(i.name)}</button>`).join('') +
    (activeLink() ? '<div class="preview-note">지금 직원에게 보이는 화면이에요 (직원용 제목). “내 전체 일정”을 누르면 돌아가요.</div>' : '');
}

// 폰: 한 달 달력이 화면 한 페이지 안에 들어오도록 달력 높이와 칸당 줄 수를 계산
function fitCalendar(weeks) {
  const cal = $('.cal'), grid = $('#grid');
  if (window.innerWidth >= 700 || $('#main').hidden) { cal.style.height = ''; grid.style.gridTemplateRows = ''; CHIP_MAX = 4; return; }
  const top = cal.getBoundingClientRect().top + window.scrollY;           // 페이지 맨 위에서 달력이 시작하는 위치
  const h = Math.max(430, Math.floor(window.innerHeight - top));          // 화면 아래 끝까지
  cal.style.height = h + 'px';
  const head = $('.month-bar').offsetHeight + $('.dow').offsetHeight + ($('#legend').offsetHeight || 0);
  const rowH = (h - head - 1) / weeks;
  grid.style.gridTemplateRows = `repeat(${weeks}, minmax(0, 1fr))`;
  CHIP_MAX = Math.max(1, Math.floor((rowH - 26) / 18.5));                 // 날짜 숫자 줄을 빼고 들어가는 일정 줄 수
}
function renderCal() {
  $('#monthLabel').textContent = `${S.y}년 ${S.m + 1}월`;
  const [start] = gridRange(), today = ymd(new Date()), l = activeLink();
  const byDay = {};
  for (const e of visibleEvents()) (byDay[e.day] ||= []).push(e);
  for (const k in byDay) byDay[k] = dayOrder(byDay[k]);
  let html = '';
  // 그 달에 필요한 주만 (4~6주)
  const weeks = Math.ceil((new Date(S.y, S.m, 1).getDay() + new Date(S.y, S.m + 1, 0).getDate()) / 7);
  fitCalendar(weeks);
  for (let i = 0; i < weeks * 7; i++) {
    const d = new Date(start); d.setDate(start.getDate() + i);
    const k = ymd(d), evs = byDay[k] || [], done = evs.filter(e => e.done).length;
    const cls = ['cell', d.getMonth() !== S.m && 'out', l && !linkMatch(l, k) && 'off', l && l.kind !== 'all' && linkMatch(l, k) && 'shared',
      k === today && 'today', k === S.sel && 'sel', HOL[k] && 'hol', d.getDay() === 0 && 'sun', d.getDay() === 6 && 'sat'].filter(Boolean).join(' ');
    html += `<button class="${cls}" data-day="${k}" aria-label="${d.getMonth() + 1}월 ${d.getDate()}일 일정 ${evs.length}개">
      <span class="num">${d.getDate()}</span>
      ${evs.length > CHIP_MAX ? `<span class="cnt more-n">+${evs.length - CHIP_MAX}</span>` : ''}
      <span class="chips">${evs.slice(0, CHIP_MAX).map(e => `<span class="chip ${e.done ? 'done' : ''}" style="--c:${evColor(e)}">${e.done ? STAR : ''}${esc(showTitle(e))}</span>`).join('')}</span></button>`;
  }
  $('#grid').innerHTML = html;
}

function renderDay() {
  const d = parse(S.sel), l = activeLink();
  $('#dayTitle').innerHTML = esc(`${d.getMonth() + 1}월 ${d.getDate()}일 (${WD[d.getDay()]})`) + (HOL[S.sel] ? ` <span class="holname">${esc(HOL[S.sel])}</span>` : '');
  const evs = dayOrder(visibleEvents().filter(e => e.day === S.sel));
  const done = evs.filter(e => e.done).length;
  $('#dayCount').textContent = evs.length ? `완료 ${done}/${evs.length}` : '';
  const owner = S.mode === 'owner';
  const canDrag = owner && !l && evs.filter(e => !e.done).length > 1;
  $('#dayList').innerHTML = evs.length ? evs.map(e => {
    const who = e.done ? [e.done_by, e.done_at && fmtWhen(e.done_at)].filter(Boolean).map(esc).join(' · ') || '완료' : '';
    const cat = catById(e.category_id);
    return `<div class="ev ${e.done ? 'done' : ''}" data-id="${e.id}" style="--c:${evColor(e)}">
      <button class="check ${e.done ? 'on' : ''}" data-check="${e.id}" aria-pressed="${e.done}" aria-label="${e.done ? '완료 취소' : '완료 체크'}" ${S.busy.has(e.id) ? 'disabled' : ''}>✓</button>
      <button class="body" type="button" data-open="${e.id}" title="${esc([cat?.name, e.memo].filter(Boolean).join(' — '))}">
        <i class="dot"></i><span class="t">${esc(showTitle(e))}</span>${owner && !l && e.staff_title && e.staff_title.trim() && e.staff_title.trim() !== e.title ? '<span class="staff-diff" title="직원에게는 다른 제목으로 보여요">👥</span>' : ''}${e.memo ? '<span class="has-memo">📝</span>' : ''}
        ${who ? `<span class="who">${who}</span>` : ''}
      </button>
      ${canDrag && !e.done ? '<span class="grip" data-grip role="button" aria-label="끌어서 순서 바꾸기" title="끌어서 순서 바꾸기"><i></i><i></i><i></i></span>' : ''}
    </div>`;
  }).join('') : `<div class="empty">${
      l && !linkMatch(l, S.sel) ? (owner ? `이 날은 “${esc(l.name)}” 링크에 포함되지 않아요.` : '이 날은 공유된 일정이 없어요.')
      : owner ? '일정이 없어요. “+ 일정”으로 추가하세요.' : '이 날은 일정이 없어요.'}</div>`;
}

/* ---------- 하루 일정 순서 바꾸기 (대표, 손잡이를 끌기) ---------- */
const byOrder = (a, b) => a.day.localeCompare(b.day) || (a.sort ?? 1e9) - (b.sort ?? 1e9) || String(a.created_at || '').localeCompare(String(b.created_at || ''));
let dragging = false;
function setupReorder() {
  const list = $('#dayList');
  list.addEventListener('pointerdown', e => {
    const grip = e.target.closest('[data-grip]');
    if (!grip || S.mode !== 'owner' || dragging) return;
    e.preventDefault();
    const row = grip.closest('.ev'), before = [...list.querySelectorAll('.ev:not(.done)')].map(r => r.dataset.id);
    let startY = e.clientY, lastY = e.clientY;
    dragging = true;
    row.classList.add('dragging');
    try { grip.setPointerCapture(e.pointerId); } catch {}
    const place = () => {
      row.style.transform = `translateY(${lastY - startY}px)`;
      const prev = row.previousElementSibling, next = row.nextElementSibling;
      if (next && next.classList.contains('ev') && !next.classList.contains('done')) {
        const r = next.getBoundingClientRect();
        if (lastY > r.top + r.height / 2) { const t = row.offsetTop; list.insertBefore(next, row); startY += row.offsetTop - t; return place(); }
      }
      if (prev && prev.classList.contains('ev') && !prev.classList.contains('done')) {
        const r = prev.getBoundingClientRect();
        if (lastY < r.top + r.height / 2) { const t = row.offsetTop; list.insertBefore(row, prev); startY += row.offsetTop - t; return place(); }
      }
    };
    let scrollTimer = null;
    const autoScroll = () => {   // 화면 위·아래 끝으로 끌면 자동으로 스크롤
      const edge = 70, h = window.innerHeight;
      const dy = lastY < edge ? -8 : lastY > h - edge ? 8 : 0;
      if (dy) { const y0 = window.scrollY; window.scrollBy(0, dy); startY -= window.scrollY - y0; place(); }
      scrollTimer = requestAnimationFrame(autoScroll);
    };
    scrollTimer = requestAnimationFrame(autoScroll);
    const move = ev => { lastY = ev.clientY; place(); };
    const end = () => {
      cancelAnimationFrame(scrollTimer);
      grip.removeEventListener('pointermove', move);
      grip.removeEventListener('pointerup', end);
      grip.removeEventListener('pointercancel', end);
      row.classList.remove('dragging'); row.style.transform = '';
      dragging = false;
      const after = [...list.querySelectorAll('.ev:not(.done)')].map(r => r.dataset.id);
      if (after.join() !== before.join()) saveOrder(after);
    };
    grip.addEventListener('pointermove', move);
    grip.addEventListener('pointerup', end);
    grip.addEventListener('pointercancel', end);
  });
}
async function saveOrder(ids) {
  // 화면에는 바로 반영 (순서 칸만 바뀜 — 일정 내용은 절대 건드리지 않음)
  const prev = ids.map(id => [id, S.events.find(x => x.id === id)?.sort]);
  ids.forEach((id, i) => { const ev = S.events.find(x => x.id === id); if (ev) ev.sort = i + 1; });
  S.events.sort(byOrder); render();
  const { error } = await sb.rpc('cal_reorder', { p_ids: ids });
  if (error) {
    console.error(error);
    prev.forEach(([id, v]) => { const ev = S.events.find(x => x.id === id); if (ev) ev.sort = v; });
    S.events.sort(byOrder); render();
    toast('순서를 저장하지 못했어요 — 인터넷 연결을 확인하고 다시 해주세요');
    return;
  }
  toast('순서를 바꿨어요');
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
      const { data, error } = await sb.rpc('cal_set_done', { p_token: S.token, p_event: id, p_done: next, p_name: who, p_pin: lsGet('tc.pin.' + S.token) });
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
  // 작성 중 내용은 폰에 계속 임시 저장 → 앱이 꺼져도 다시 열면 이어서 작성
  const draftKey = 'tc.draft.' + (e ? e.id : 'new.' + S.sel);
  let draft = null; try { draft = JSON.parse(lsGet(draftKey) || 'null'); } catch {}
  const newId = draft?.newId || (e ? null : crypto.randomUUID());   // 새 일정 id를 미리 정해두면 다시 눌러도 두 번 생기지 않음
  let catId = e ? e.category_id : (catById(lsGet(CAT_KEY)) ? lsGet(CAT_KEY) : S.cats[0]?.id) || null;
  const catButtons = () => S.cats.map(c => `<button type="button" style="--c:${c.color}" data-cat="${c.id}" class="${c.id === catId ? 'on' : ''}"><i></i>${esc(c.name)}</button>`).join('');
  const html = `
    <label>일정 제목 <small>(대표용 · 대표 달력에 보임)</small><input id="f_title" maxlength="100" required value="${esc(e?.title)}" placeholder="예: 매장 오픈 준비"></label>
    <label class="staffbox">직원용 제목 <small>(직원 달력에 보임 · 대표 제목이 자동으로 복사돼요)</small>
      <input id="f_stitle" maxlength="100" value="${esc(e ? staffTitle(e) : '')}" placeholder="비워두면 대표 제목이 그대로 보여요">
      <button type="button" class="linkbtn" id="f_srelink" hidden>↺ 대표 제목과 똑같이</button></label>
    ${e ? `<label>날짜<input id="f_day" type="date" required value="${e.day}"></label>` : ""}
    <label>메모 (선택)<textarea id="f_memo" rows="3" maxlength="1000" placeholder="준비물, 장소 등">${esc(e?.memo)}</textarea></label>
    <div class="fieldlabel">분류 (색깔) <button type="button" class="linkbtn" id="f_cats_edit">분류 관리</button></div>
    <div class="catpick" id="f_cats">${catButtons() || '<span class="fieldlabel">분류 관리에서 분류를 먼저 만드세요.</span>'}</div>
    <p class="fieldlabel" id="f_share"></p>`;
  const showShare = ov => {
    const day = e ? $('#f_day', ov).value : S.sel, ls = day ? S.links.filter(l => linkMatch(l, day)) : [];
    $('#f_share', ov).textContent = !day ? '' : ls.length ? `이 날짜 일정이 보이는 링크: ${ls.map(l => l.name).join(', ')}` : '이 날짜는 어떤 공유 링크에도 포함되지 않아요 (대표만 보임)';
  };
  // 직원용 제목이 대표 제목과 같으면 "연결됨" → 대표 제목을 고치면 같이 바뀜. 직원용을 따로 고치면 연결이 풀림
  let staffLinked = !e || !(e.staff_title && e.staff_title.trim()) || e.staff_title.trim() === e.title;
  const saveDraft = ov => lsSet(draftKey, JSON.stringify({
    newId, title: $('#f_title', ov).value, stitle: $('#f_stitle', ov).value, staffLinked, memo: $('#f_memo', ov).value, catId, day: e ? $('#f_day', ov).value : S.sel, at: Date.now() }));
  const save = async ov => {
    saveDraft(ov);
    const title = $('#f_title', ov).value.trim(), day = e ? $('#f_day', ov).value : S.sel;
    if (!title) { $('#f_title', ov).focus(); toast('제목을 입력하세요'); return false; }
    if (!day) { toast('날짜를 선택하세요'); return false; }
    const st = $('#f_stitle', ov).value.trim();
    const row = {
      title, staff_title: st && st !== title ? st : null, day, category_id: catId, color: catById(catId)?.color || e?.color || COLORS[0][0], memo: $('#f_memo', ov).value.trim(),
      start_time: null, end_time: null,
      updated_at: new Date().toISOString(),
    };
    const q = e ? sb.from('cal_events').update(row).eq('id', e.id)
                : sb.from('cal_events').upsert({ ...row, id: newId }, { onConflict: 'id', ignoreDuplicates: true });
    const { error } = await q;
    if (error) {
      console.error(error);
      toast(/fetch|network|Failed/i.test(error.message || '') ? '인터넷 연결이 불안정해요. 입력한 내용은 그대로 있어요 — 다시 저장을 눌러주세요' : '저장 실패: ' + error.message);
      return false;
    }
    lsSet(draftKey, null);   // 저장 성공 → 임시 저장 삭제
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
  buttons.push({ label: '취소', value: null, soft: true }, { label: e ? '저장' : '추가', cls: 'primary', run: save });
  const res = await modal({ title: e ? '일정 수정' : `${parse(S.sel).getMonth() + 1}월 ${parse(S.sel).getDate()}일 (${WD[parse(S.sel).getDay()]}) 일정 추가`, html, buttons, onMount: ov => {
    // 이어서 작성할 내용이 있으면 불러오기
    if (draft && (draft.title || draft.memo) && (draft.title !== (e?.title || '') || draft.memo !== (e?.memo || '') || (e && draft.day !== e.day) || (draft.stitle !== undefined && draft.stitle !== (e ? staffTitle(e) : '')))) {
      $('#f_title', ov).value = draft.title || '';
      if (draft.stitle !== undefined) { $('#f_stitle', ov).value = draft.stitle; staffLinked = draft.staffLinked !== false; }
      $('#f_memo', ov).value = draft.memo || '';
      if (e && draft.day) $('#f_day', ov).value = draft.day;
      if (draft.catId && catById(draft.catId)) { catId = draft.catId; $('#f_cats', ov).innerHTML = catButtons(); }
      ov.dispatchEvent(new Event('input'));
      toast('작성 중이던 내용을 불러왔어요');
    }
    const ft = $('#f_title', ov), fs2 = $('#f_stitle', ov), relink = $('#f_srelink', ov);
    const drawLink = () => { relink.hidden = staffLinked; fs2.classList.toggle('linked', staffLinked); };
    ft.addEventListener('input', () => { if (staffLinked) fs2.value = ft.value; });
    fs2.addEventListener('input', () => { staffLinked = fs2.value.trim() === ft.value.trim(); drawLink(); });
    relink.onclick = () => { staffLinked = true; fs2.value = ft.value; drawLink(); saveDraft(ov); };
    drawLink();
    ov.addEventListener('input', () => saveDraft(ov));
    ov.addEventListener('click', () => setTimeout(() => ov.isConnected && saveDraft(ov), 0));
    showShare(ov); e && $('#f_day', ov).addEventListener('change', () => showShare(ov));
    $('#f_cats', ov).onclick = ev => {
      const b = ev.target.closest('[data-cat]'); if (!b) return;
      catId = b.dataset.cat; lsSet(CAT_KEY, catId);
      ov.querySelectorAll('#f_cats button').forEach(x => x.classList.toggle('on', x === b));
    };
    $('#f_cats_edit', ov).onclick = async () => { await openCategories(); $('#f_cats', ov).innerHTML = catButtons(); };
    if (!e) $('#f_title', ov).focus();
  } });
  if (res === undefined || res === null) lsSet(draftKey, null);   // 확인하고 닫은 경우만 임시 저장 삭제
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
      const rows = [...dates].sort().map(day => ({ title: e.title, staff_title: e.staff_title || null, memo: e.memo || '', color: evColor(e), category_id: e.category_id || null, day }));
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
            <div class="gbadges">${l.active === false ? '<span class="bdg off">⏸ 멈춤</span>' : ''}${l.pin_hash ? '<span class="bdg">🔒 PIN</span>' : ''}${l.expires_on ? `<span class="bdg">⏳ ${md(l.expires_on)}까지</span>` : ''}<span class="bdg muted">${l.last_seen ? '최근 접속 ' + fmtWhen(l.last_seen) : '아직 접속 없음'}</span></div>
            <div class="glink">${esc(shareUrl(l.token))}</div>
            <div class="gbtns">
              <button class="btn sm primary" data-a="copy" data-id="${l.id}">링크 복사</button>
              ${navigator.share ? `<button class="btn sm" data-a="share" data-id="${l.id}">보내기</button>` : ''}
              <button class="btn sm" data-a="edit" data-id="${l.id}">수정·보안</button>
              <button class="btn sm" data-a="toggle" data-id="${l.id}">${l.active === false ? '▶ 다시 열기' : '⏸ 멈추기'}</button>
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
          try { await navigator.clipboard.writeText(url); toast(l.pin_hash ? '링크를 복사했어요. PIN은 따로 알려주세요' : '링크를 복사했어요. 카톡 등에 붙여넣으세요'); }
          catch { window.prompt('아래 링크를 복사하세요', url); }
        } else if (a === 'share') {
          navigator.share({ title: l.name, text: `${S.company ? S.company + ' ' : ''}${l.name} (${linkDesc(l)})`, url }).catch(() => {});
        } else if (a === 'edit') {
          if (await editLink(l)) draw();
        } else if (a === 'toggle') {
          const { error } = await sb.from('cal_links').update({ active: l.active === false }).eq('id', l.id);
          if (error) return toast('실패: ' + error.message);
          await reload(); draw(); toast(l.active === false ? '링크를 다시 열었어요' : '링크를 멈췄어요. 직원 화면이 잠시 안 보여요');
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
      </div>
      <div class="secbox">
        <div class="sectitle">🔐 링크 보안</div>
        <label class="switch"><input type="checkbox" id="l_active" ${l?.active === false ? '' : 'checked'}> 링크 사용 중 <small>(끄면 직원 화면이 잠시 멈춰요)</small></label>
        <label>사용 기한 (선택) — 이 날짜까지만 열려요<input type="date" id="l_exp" value="${l?.expires_on || ''}"></label>
        <label>PIN 숫자 비밀번호 (선택, 4~8자리)<input id="l_pin" inputmode="numeric" pattern="[0-9]*" maxlength="8" autocomplete="off"
          placeholder="${l?.pin_hash ? '설정됨 · 바꾸려면 새로 입력' : '비워두면 링크만으로 열려요'}"></label>
        ${l?.pin_hash ? '<label class="switch"><input type="checkbox" id="l_pin_off"> PIN 없애기</label>' : ''}
        <p class="fieldlabel">PIN을 걸면 링크가 새어 나가도 PIN을 모르는 사람은 볼 수 없어요. PIN은 링크와 따로 알려주세요. (10번 틀리면 15분 잠김)</p>
      </div>`,
    buttons: [{ label: '취소', value: false }, { label: '저장', cls: 'primary', value: true, run: async ov => {
      const name = $('#l_name', ov).value.trim();
      const pin = $('#l_pin', ov).value.trim();
      if (pin && !/^[0-9]{4,8}$/.test(pin)) { toast('PIN은 숫자 4~8자리로 입력하세요'); return false; }
      if (!name) { toast('링크 이름을 입력하세요'); return false; }
      if (kind === 'weekdays' && !wd.size) { toast('요일을 하나 이상 고르세요'); return false; }
      if (kind === 'dates' && !dates.size) { toast('날짜를 하나 이상 고르세요'); return false; }
      const row = { name, kind, weekdays: kind === 'weekdays' ? [...wd].sort() : [], dates: kind === 'dates' ? [...dates].sort() : [],
        active: $('#l_active', ov).checked, expires_on: $('#l_exp', ov).value || null };
      const { data: saved, error } = l ? await sb.from('cal_links').update(row).eq('id', l.id).select('id').single()
                                       : await sb.from('cal_links').insert(row).select('id').single();
      if (error) { toast('저장 실패: ' + error.message); return false; }
      const pinOff = $('#l_pin_off', ov)?.checked;
      if (pin || pinOff) {
        const { error: pe } = await sb.rpc('cal_set_link_pin', { p_link: saved.id, p_pin: pinOff && !pin ? '' : pin });
        if (pe) { toast('PIN 저장 실패: ' + pe.message); return false; }
      }
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
      <div class="fieldlabel">분류 (색깔)</div>
      <div class="catlegend" id="s_cats"></div>
      <button type="button" class="btn wide" id="s_cats_btn" style="margin:8px 0 12px">🎨 분류 관리 (추가·수정·삭제)</button>
      <div class="sectitle">💾 백업</div>
      <p class="fieldlabel">일정은 지우기 전까지 사이트에 계속 남아 있어요. 혹시 모를 때를 위해 가끔 대표님 컴퓨터에 백업해 두세요.</p>
      <button type="button" class="btn primary wide" id="s_bk_json">💾 내 컴퓨터에 백업하기</button>
      <p class="fieldlabel" id="s_bk_last" style="margin-top:6px"></p>
      <div class="bk-more"><button type="button" class="linkbtn" id="s_bk_csv">엑셀 파일로도 받기</button><button type="button" class="linkbtn" id="s_bk_restore">백업 파일로 되돌리기</button></div>
      <input type="file" id="s_bk_file" accept=".json,application/json" hidden>
      <div class="sectitle">🔑 비밀번호 찾기용 확인번호</div>
      <div class="recrow"><span id="s_rec_state"></span><button type="button" class="btn sm" id="s_rec_btn"></button></div>
      <a class="btn wide helpbtn" href="help.html">📘 관리 안내서 (문제가 생겼을 때 · Claude 없이 관리하기)</a>
      <p class="fieldlabel">로그인: ${esc(S.user?.email)} · 이 기기에서 자동 로그인 유지</p>`,
    onMount: ov => {
      const draw = () => { $('#s_cats', ov).innerHTML = legendHtml() || '<span class="fieldlabel">분류가 없어요</span>'; };
      draw();
      $('#s_cats_btn', ov).onclick = async () => { await openCategories(); draw(); };
      const drawRec = () => {
        $('#s_rec_state', ov).innerHTML = S.hasRecovery ? '<b class="ok">✓ 설정됨</b>' : '<b class="warn">아직 없음 — 꼭 정해두세요</b>';
        $('#s_rec_btn', ov).textContent = S.hasRecovery ? '바꾸기' : '정하기';
      };
      drawRec();
      $('#s_rec_btn', ov).onclick = async () => { await setRecoveryCode(); drawRec(); };
      const last = +lsGet('tc.lastBackup') || 0;
      $('#s_bk_last', ov).textContent = last ? '마지막 백업: ' + fmtWhen(new Date(last).toISOString()) : '아직 백업한 적이 없어요';
      const busy = async (btn, fn) => { btn.disabled = true; try { await fn(); } catch (e) { console.error(e); toast('실패: ' + (e.message || e)); } finally { btn.disabled = false; } };
      $('#s_bk_json', ov).onclick = e => busy(e.currentTarget, backupJson);
      $('#s_bk_csv', ov).onclick = e => busy(e.currentTarget, backupCsv);
      $('#s_bk_restore', ov).onclick = () => $('#s_bk_file', ov).click();
      $('#s_bk_file', ov).onchange = e => { const f = e.target.files[0]; e.target.value = ''; if (f) busy($('#s_bk_restore', ov), () => restoreBackup(f)); };
    },
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

/* ---------- 일정 검색 (대표, 전체 기간) ---------- */
async function searchEvents(q) {
  const pat = '%' + q.replace(/[\\%_]/g, m => '\\' + m) + '%';
  const low = q.toLowerCase();
  const catIds = S.cats.filter(c => c.name.toLowerCase().includes(low)).map(c => c.id);
  const cols = 'id, title, staff_title, memo, day, category_id, color, done, done_by, done_at';
  const qs = [
    sb.from('cal_events').select(cols).ilike('title', pat).order('day', { ascending: false }).limit(300),
    sb.from('cal_events').select(cols).ilike('memo', pat).order('day', { ascending: false }).limit(300),
    sb.from('cal_events').select(cols).ilike('staff_title', pat).order('day', { ascending: false }).limit(300),
  ];
  if (catIds.length) qs.push(sb.from('cal_events').select(cols).in('category_id', catIds).order('day', { ascending: false }).limit(300));
  const rs = await Promise.all(qs);
  const err = rs.find(r => r.error)?.error; if (err) throw err;
  const map = new Map(); rs.forEach(r => r.data.forEach(e => map.set(e.id, e)));
  return [...map.values()];
}
function hl(text, q) {   // 검색어 부분 강조 (안전하게 글자 단위로 처리)
  const t = String(text || ''), i = t.toLowerCase().indexOf(q.toLowerCase());
  return i < 0 ? esc(t) : esc(t.slice(0, i)) + '<mark>' + esc(t.slice(i, i + q.length)) + '</mark>' + esc(t.slice(i + q.length));
}
async function openSearch() {
  let timer, seq = 0;
  await modal({
    title: '🔍 일정 검색',
    protect: false,
    html: `<input id="q" class="searchbox" type="search" enterkeyhint="search" placeholder="제목·메모·분류로 찾기" autocomplete="off">
      <p class="fieldlabel" id="q_info">저장된 모든 일정에서 찾아요</p>
      <div class="sresults" id="q_list"></div>`,
    buttons: [{ label: '닫기', cls: 'primary' }],
    onMount: (ov, close) => {
      const input = $('#q', ov), info = $('#q_info', ov), list = $('#q_list', ov);
      input.value = S.lastQuery || '';
      const run = async () => {
        const q = input.value.trim(); S.lastQuery = q;
        const my = ++seq;
        if (!q) { list.innerHTML = ''; info.textContent = '저장된 모든 일정에서 찾아요'; return; }
        info.textContent = '찾는 중…';
        let res;
        try { res = await searchEvents(q); } catch (err) { console.error(err); if (my === seq) info.textContent = '검색하지 못했어요 — 인터넷 연결을 확인하고 다시 입력해 보세요'; return; }
        if (my !== seq) return;   // 더 최근 검색이 있으면 무시
        const today = ymd(new Date());
        const next = res.filter(e => e.day >= today).sort((a, b) => a.day.localeCompare(b.day) || a.title.localeCompare(b.title));
        const past = res.filter(e => e.day < today).sort((a, b) => b.day.localeCompare(a.day) || a.title.localeCompare(b.title));
        info.textContent = res.length ? `${res.length}개 찾았어요${res.length >= 300 ? ' (많아서 일부만 보여요)' : ''}` : '찾는 일정이 없어요';
        const row = e => {
          const cat = catById(e.category_id);
          const memoHit = e.memo && e.memo.toLowerCase().includes(q.toLowerCase());
          const staffHit = e.staff_title && e.staff_title !== e.title && e.staff_title.toLowerCase().includes(q.toLowerCase());
          return `<button type="button" class="srow" data-day="${e.day}" style="--c:${evColor(e)}">
            <i class="dot"></i><span class="sd">${e.day.slice(0, 4) !== today.slice(0, 4) ? e.day.slice(2, 4) + '년 ' : ''}${md(e.day)}</span>
            <span class="sbody"><span class="t">${e.done ? STAR : ''}${hl(e.title, q)}</span>
            ${staffHit ? `<span class="sm">👥 ${hl(e.staff_title, q)}</span>` : memoHit ? `<span class="sm">${hl(e.memo, q)}</span>` : cat ? `<span class="sm">${hl(cat.name, q)}</span>` : ''}</span></button>`;
        };
        list.innerHTML = (next.length ? `<div class="shead">다가오는 일정</div>${next.map(row).join('')}` : '')
                       + (past.length ? `<div class="shead">지난 일정</div>${past.map(row).join('')}` : '');
      };
      input.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(run, 250); });
      input.addEventListener('keydown', e => { if (e.key === 'Enter') { clearTimeout(timer); run(); input.blur(); } });
      list.onclick = e => {
        const b = e.target.closest('[data-day]'); if (!b) return;
        const k = b.dataset.day, d = parse(k);
        close();
        S.sel = k;
        if (d.getFullYear() !== S.y || d.getMonth() !== S.m) { S.y = d.getFullYear(); S.m = d.getMonth(); goMonth(0); } else render();
        setTimeout(() => $('.day').scrollIntoView({ behavior: 'smooth', block: 'start' }), 150);
      };
      setTimeout(() => input.focus(), 50);
      if (input.value) run();
    },
  });
}

/* ---------- 백업·복원 (대표) ---------- */
async function fetchAll() {
  const [e, c, l, st] = await Promise.all([
    sb.from('cal_events').select('*').order('day').order('created_at'),
    sb.from('cal_categories').select('*').order('sort'),
    sb.from('cal_links').select('id, name, kind, weekdays, dates, active, expires_on, created_at'),
    sb.from('cal_settings').select('company').maybeSingle(),
  ]);
  const err = e.error || c.error || l.error || st.error; if (err) throw err;
  return { company: st.data?.company || '', categories: c.data, events: e.data, links: l.data };
}
function saveFile(name, text, type) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type })); a.download = name;
  document.body.appendChild(a); a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 2000);
}
async function backupJson() {
  const d = await fetchAll();
  saveFile(`팀캘린더-백업-${ymd(new Date())}.json`, JSON.stringify({ app: 'team-calendar', version: 1, exported_at: new Date().toISOString(), ...d }, null, 1), 'application/json');
  lsSet('tc.lastBackup', String(Date.now()));
  toast(`컴퓨터에 백업했어요 (일정 ${d.events.length}개) — 다운로드 폴더에 저장됐어요`);
}
async function backupCsv() {
  const d = await fetchAll(), cat = Object.fromEntries(d.categories.map(c => [c.id, c.name]));
  const q = v => '"' + String(v ?? '').replace(/"/g, '""') + '"';
  const lines = [['날짜', '요일', '분류', '일정', '직원용 제목', '메모', '완료', '완료한 사람', '완료 시각'].map(q).join(',')]
    .concat(d.events.map(e => [e.day, WD[parse(e.day).getDay()], cat[e.category_id] || '', e.title, e.staff_title || '', e.memo, e.done ? 'O' : '', e.done_by, e.done_at ? fmtWhen(e.done_at) : ''].map(q).join(',')));
  saveFile(`팀캘린더-${ymd(new Date())}.csv`, '\ufeff' + lines.join('\r\n'), 'text/csv;charset=utf-8');
  toast(`엑셀용 파일을 받았어요 (일정 ${d.events.length}개)`);
}
async function restoreBackup(file) {
  let d;
  try { d = JSON.parse(await file.text()); } catch { throw new Error('백업 파일(.json)이 아니에요'); }
  if (d?.app !== 'team-calendar' || !Array.isArray(d.events)) throw new Error('팀 캘린더 백업 파일이 아니에요');
  if (!(await confirmBox('백업 파일로 복원할까요?', `${(d.exported_at || '').slice(0, 10)} 백업 · 일정 ${d.events.length}개, 분류 ${(d.categories || []).length}개\n지금 있는 일정은 지워지지 않고, 백업에 있는 일정이 되살아나거나 백업 때 내용으로 돌아가요.`, '복원하기', '취소'))) return;
  const me = S.user.id, chunk = (a, n = 300) => Array.from({ length: Math.ceil(a.length / n) }, (_, i) => a.slice(i * n, i * n + n));
  const cats = (d.categories || []).map(({ id, name, color, sort }) => ({ id, name, color, sort, owner: me }));
  for (const part of chunk(cats)) { const { error } = await sb.from('cal_categories').upsert(part); if (error) throw error; }
  const catIds = new Set([...cats.map(c => c.id), ...S.cats.map(c => c.id)]);
  const evs = d.events.map(({ id, title, staff_title, memo, day, color, category_id, done, done_by, done_at, created_at, sort }) =>
    ({ id, title, staff_title: staff_title || null, sort: sort ?? null, memo: memo || '', day, color, category_id: catIds.has(category_id) ? category_id : null, done: !!done, done_by, done_at, created_at, owner: me }));
  for (const part of chunk(evs)) { const { error } = await sb.from('cal_events').upsert(part); if (error) throw error; }
  if (d.company && !S.company) await sb.from('cal_settings').upsert({ owner: me, company: d.company });
  await reload(); toast(`복원했어요 (일정 ${evs.length}개)`);
}
/* ---------- 분류(색깔) 관리 (대표) ---------- */
function legendHtml() { return S.cats.map(c => `<span class="lg" style="--c:${c.color}"><i></i>${esc(c.name)}</span>`).join(''); }

async function openCategories() {
  // 편집용 사본: 저장을 눌러야 서버에 반영
  const rows = S.cats.map(c => ({ id: c.id, name: c.name, color: c.color }));
  const removed = [];
  await modal({
    title: '분류 관리',
    text: '색 동그라미를 누르면 원하는 색으로 바꿀 수 있어요. 분류 색을 바꾸면 그 분류 일정의 색도 함께 바뀌어요.',
    html: `<div class="catlist" id="catlist"></div>
      <button type="button" class="btn wide" id="cat_add" style="margin-top:10px">+ 분류 추가</button>`,
    buttons: [{ label: '취소', value: false }, { label: '저장', cls: 'primary', value: true, run: async ov => {
      ov.querySelectorAll('.catrow').forEach((r, i) => { rows[i].name = $('input[type=text]', r).value.trim(); });
      if (rows.some(r => !r.name)) { toast('분류 이름을 입력하세요'); return false; }
      if (removed.length) {
        if (!(await confirmBox('분류를 삭제할까요?', `${removed.length}개 분류를 삭제해요. 그 분류였던 일정은 지워지지 않고 색만 그대로 남아요.`, '삭제하고 저장', '취소', true))) return false;
        const { error } = await sb.from('cal_categories').delete().in('id', removed);
        if (error) { toast('저장 실패: ' + error.message); return false; }
      }
      for (const [i, r] of rows.entries()) {
        const { error } = r.id
          ? await sb.from('cal_categories').update({ name: r.name, color: r.color, sort: i }).eq('id', r.id)
          : await sb.from('cal_categories').insert({ name: r.name, color: r.color, sort: i });
        if (error) { toast('저장 실패: ' + error.message); return false; }
      }
      await reload(); toast('분류를 저장했어요');
    } }],
    onMount: ov => {
      const list = $('#catlist', ov);
      const sync = () => list.querySelectorAll('.catrow').forEach((r, i) => { rows[i].name = $('input[type=text]', r).value; });
      const draw = () => {
        list.innerHTML = rows.map((r, i) => `<div class="catrow">
            <label class="swatch" style="--c:${r.color}"><input type="color" value="${r.color}" data-color="${i}" aria-label="색 선택"></label>
            <input type="text" maxlength="20" value="${esc(r.name)}" placeholder="분류 이름">
            <button type="button" class="btn ghost icon" data-up="${i}" aria-label="위로" ${i ? '' : 'disabled'}>↑</button>
            <button type="button" class="btn ghost icon danger" data-del="${i}" aria-label="삭제">✕</button>
          </div>`).join('') || '<div class="empty">분류가 없어요. 아래에서 추가하세요.</div>';
      };
      draw();
      list.addEventListener('input', ev => {
        const c = ev.target.closest('[data-color]'); if (!c) return;
        rows[+c.dataset.color].color = c.value; c.parentElement.style.setProperty('--c', c.value);
      });
      list.addEventListener('click', ev => {
        const up = ev.target.closest('[data-up]'), del = ev.target.closest('[data-del]');
        if (!up && !del) return;
        sync();
        if (up) { const i = +up.dataset.up; [rows[i - 1], rows[i]] = [rows[i], rows[i - 1]]; }
        if (del) { const [r] = rows.splice(+del.dataset.del, 1); if (r.id) removed.push(r.id); }
        draw();
      });
      $('#cat_add', ov).onclick = () => {
        sync();
        const used = new Set(rows.map(r => r.color));
        rows.push({ name: '', color: (COLORS.find(([c]) => !used.has(c)) || COLORS[0])[0] });
        draw(); list.querySelector('.catrow:last-child input[type=text]').focus();
      };
    },
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
  // 폰: 달력을 옆으로 밀어서 달 넘기기 (왼쪽 → 다음 달, 오른쪽 → 이전 달)
  let sx = 0, sy = 0, swiped = false;
  const cal = $('.cal');
  cal.addEventListener('touchstart', e => { const t = e.touches[0]; sx = t.clientX; sy = t.clientY; swiped = false; }, { passive: true });
  cal.addEventListener('touchend', e => {
    const t = e.changedTouches[0], dx = t.clientX - sx, dy = t.clientY - sy;
    if (Math.abs(dx) < 50 || Math.abs(dx) < Math.abs(dy) * 1.5) return;
    swiped = true; setTimeout(() => { swiped = false; }, 400);
    const dir = dx < 0 ? 1 : -1;
    goMonth(dir);
    const g = $('#grid'); g.classList.remove('slide-l', 'slide-r'); void g.offsetWidth; g.classList.add(dir > 0 ? 'slide-l' : 'slide-r');
  }, { passive: true });
  $('#grid').onclick = e => {
    const c = e.target.closest('[data-day]'); if (!c) return;
    if (swiped) return;
    const k = c.dataset.day, d = parse(k);
    S.sel = k;
    if (d.getMonth() !== S.m || d.getFullYear() !== S.y) { S.y = d.getFullYear(); S.m = d.getMonth(); goMonth(0); } else render();
    if (window.innerWidth < 900) $('.day').scrollIntoView({ behavior: 'smooth', block: 'start' });
  };
  $('#dayList').onclick = e => {
    const c = e.target.closest('[data-check]'); if (c) return toggleDone(c.dataset.check);
    const op = e.target.closest('[data-open]'); if (!op) return;
    if (S.mode === 'owner') return editEvent(op.dataset.open);
    const ev = S.events.find(x => x.id === op.dataset.open); if (!ev) return;
    const cat = catById(ev.category_id);
    modal({ title: ev.title, text: [cat && '분류: ' + cat.name, ev.memo, ev.done && '✓ 완료 ' + [ev.done_by, fmtWhen(ev.done_at)].filter(Boolean).join(' · ')].filter(Boolean).join('\n'), buttons: [{ label: '닫기', cls: 'primary' }] });
  };
  $('#filters').onclick = e => { const b = e.target.closest('[data-f]'); if (!b) return; S.filter = b.dataset.f; render(); };
  $('#btnAdd').onclick = () => editEvent(null);
  $('#btnGroups').onclick = openLinks;
  $('#btnSettings').onclick = openSettings;
  $('#btnSearch').onclick = openSearch;
  setupReorder();
  $('#btnName').onclick = () => askName(false);
  $('#btnOwnerLogin').onclick = showLogin;
  $('#forgotPw').onclick = forgotPassword;
  $('#forgotId').onclick = forgotEmail;
  sb.auth.onAuthStateChange(ev => { if (ev === 'SIGNED_OUT' && S.mode === 'owner') showLogin(); });
}

// 새 버전이 올라오면 폰에서도 바로 바뀌도록: 앱을 열거나 돌아올 때·1분마다 확인 → 바뀌면 자동 새로고침
if ('serviceWorker' in navigator && !/^(localhost|127\.0\.0\.1)$/.test(location.hostname)) {
  const hadController = !!navigator.serviceWorker.controller;
  navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' }).then(reg => {
    const check = () => reg.update().catch(() => {});
    document.addEventListener('visibilitychange', () => { if (!document.hidden) check(); });
    setInterval(check, 60000);
  }).catch(() => {});
  let reloading = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!hadController || reloading) return;   // 처음 설치 때는 새로고침 안 함
    reloading = true;
    // 입력 중인 창이 열려 있으면 닫힌 뒤에 새로고침
    const go = () => (document.querySelector('.ov') ? setTimeout(go, 1500) : location.reload());
    go();
  });
}
boot();
