// 앱 파일을 수정하면 VERSION 을 올리세요 (node bump.cjs 가 index.html 과 함께 올려줌)
const VERSION = 'tc-v34';
const SHELL = ['./', 'index.html', 'styles.css', 'app.js', 'config.js', 'manifest.webmanifest', 'icon.svg', 'holidays.json', 'vendor/supabase.js'];
self.addEventListener('install', e => {
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(SHELL.map(u => new Request(u, { cache: 'reload' })))).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== VERSION).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
// 페이지 열기(카톡·네이버 앱 안 브라우저 포함): 브라우저 기본 방식 그대로 불러옴 → 실패할 때만 저장본, 저장본도 없으면 다시 인터넷 시도
// (예전엔 저장본이 없을 때 빈 응답을 돌려줘서 카톡이 '네트워크 연결 상태가 좋지 않다'를 띄울 수 있었음)
self.addEventListener('fetch', e => {
  const req = e.request, u = new URL(req.url);
  if (req.method !== 'GET' || u.origin !== location.origin) return;
  if (req.mode === 'navigate') {
    e.respondWith(fetch(req).catch(() => caches.match('./').then(r => r || caches.match('index.html')).then(r => r || fetch(req))));
    return;
  }
  // 그 밖의 파일: 항상 서버에 최신인지 확인(no-cache) → 오프라인이면 저장본
  e.respondWith(fetch(req, { cache: 'no-cache' })
    .then(r => { if (r.ok) { const copy = r.clone(); caches.open(VERSION).then(c => c.put(req, copy)); } return r; })
    .catch(() => caches.match(req, { ignoreSearch: true }).then(r => r || fetch(req))));
});
