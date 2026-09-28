// 대한민국 공휴일 목록 만들기 → holidays.json
// 출처: 구글 캘린더 "대한민국의 휴일" (설날·추석·대체공휴일·선거일 등 포함). 기념일(어버이날 등)은 제외하고 "공휴일"만.
// 사용: node tools/holidays.cjs   (GitHub Actions가 매주 자동 실행)
const fs = require('fs'), path = require('path'), https = require('https');
const URL = 'https://calendar.google.com/calendar/ical/ko.south_korea%23holiday%40group.v.calendar.google.com/public/basic.ics';
const OUT = path.join(__dirname, '..', 'holidays.json');

function get(url, n = 0) {
  return new Promise((ok, fail) => https.get(url, res => {
    if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && n < 5) return ok(get(res.headers.location, n + 1));
    if (res.statusCode !== 200) return fail(new Error('HTTP ' + res.statusCode));
    let d = ''; res.setEncoding('utf8'); res.on('data', c => (d += c)); res.on('end', () => ok(d));
  }).on('error', fail));
}

(async () => {
  const ics = (await get(URL)).replace(/\r?\n[ \t]/g, '');
  const days = {};
  for (const b of ics.split('BEGIN:VEVENT').slice(1)) {
    const d = (b.match(/DTSTART;VALUE=DATE:(\d{8})/) || [])[1];
    let name = ((b.match(/\nSUMMARY:(.*)/) || [])[1] || '').trim();
    const desc = ((b.match(/\nDESCRIPTION:(.*)/) || [])[1] || '').trim();
    if (!d || !name || !desc.startsWith('공휴일')) continue;          // 기념일 제외
    name = name.replace(/^쉬는 날\s*(.+)$/, '대체공휴일($1)');           // "쉬는 날 삼일절" → "대체공휴일(삼일절)"
    const key = `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`;
    days[key] = days[key] ? days[key] + ', ' + name : name;
  }
  const n = Object.keys(days).length;
  if (n < 50) throw new Error('공휴일이 너무 적게 읽혔어요 (' + n + '개) — 기존 파일 유지');
  const sorted = Object.fromEntries(Object.keys(days).sort().map(k => [k, days[k]]));
  const prev = fs.existsSync(OUT) ? JSON.parse(fs.readFileSync(OUT, 'utf8')).days : null;
  if (prev && JSON.stringify(prev) === JSON.stringify(sorted)) return console.log('변경 없음 (' + n + '일)');
  fs.writeFileSync(OUT, JSON.stringify({ source: 'Google 캘린더 대한민국의 휴일 (공휴일만)', updated: new Date().toISOString().slice(0, 10), days: sorted }, null, 1) + '\n');
  console.log('holidays.json 갱신: ' + n + '일');
})().catch(e => { console.error(e.message); process.exit(1); });
