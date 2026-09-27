# 팀 캘린더

대표가 일정을 만들고, 직원에게 링크로 공유(전체 / 요일별 / 날짜 선택). 직원은 보기 + 완료 체크만 가능. 모든 기기에 실시간 반영.

- 사이트: https://v282vhr5sm-stack.github.io/team-calendar/  (GitHub Pages, 이 저장소 main 브랜치 루트)
- 데이터: Supabase 프로젝트 `team-calendar` (조직 "공유캘린더", 서울). 연결 정보는 `config.js` (공개용 publishable 키만)
- 사용·관리 안내: 사이트의 `help.html` (설정 화면 → 관리 안내서)

## 구조
- `index.html`, `styles.css`, `app.js` — 화면 전부 (빌드 없음, 순수 HTML/JS, supabase-js CDN)
- `supabase.sql` — 표·권한·함수 전체. SQL Editor에 통째로 다시 실행해도 안전
- `sw.js` — 오프라인·자동 업데이트. 파일 수정 후 `node bump.cjs`로 버전 올리기
- `.github/workflows/keepalive.yml` — 3일마다 Supabase 깨우기(무료 서버 멈춤 방지), 매달 `.keepalive` 갱신

## 수정·배포
1. 파일 수정 → `node bump.cjs` → commit → `git pull --rebase` (자동 작업이 커밋을 남기므로) → `git push`
2. 1~2분 뒤 사이트 반영, 폰은 다시 열면 자동 새로고침

로컬 확인: `node .serve.cjs` → http://localhost:5179
