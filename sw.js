// 앱 파일을 수정하면 VERSION 을 올리세요 (node bump.cjs 가 index.html 과 함께 올려줌)
const VERSION = 'tc-v41';
const SHELL = ['./', 'index.html', 'styles.css', 'app.js', 'config.js', 'manifest.webmanifest', 'icon.svg', 'holidays.json', 'vendor/supabase.js'];
self.addEventListener('install', e => {
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(SHELL.map(u => new Request(u, { cache: 'reload' })))).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== VERSION).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
// 빠르게 열기: 폰에 저장된 화면 파일을 바로 쓰고, 뒤에서 조용히 최신으로 받아 둠 (다음에 열 때 반영)
// 새 버전을 올리면 이 sw.js가 바뀌어 저장본을 통째로 새로 받고 화면이 자동 새로고침됨
// 저장본이 없으면 반드시 인터넷에서 받음 (빈 응답을 돌려주면 카톡이 '네트워크 연결 상태가 좋지 않다'를 띄움)
self.addEventListener('fetch', e => {
  const req = e.request, u = new URL(req.url);
  if (req.method !== 'GET' || u.origin !== location.origin) return;
  const nav = req.mode === 'navigate';
  e.respondWith((async () => {
    const cache = await caches.open(VERSION);
    const hit = nav ? (await cache.match('./')) || (await cache.match('index.html')) : await cache.match(req, { ignoreSearch: !u.search.includes('v=') });
    const net = fetch(req, nav ? {} : { cache: 'no-cache' }).then(r => {
      if (r.ok) cache.put(nav ? './' : req, r.clone());
      return r;
    });
    if (hit) { e.waitUntil(net.catch(() => {})); return hit; }
    return net.catch(() => hit || fetch(req));
  })());
});
