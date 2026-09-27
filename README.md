# 팀 캘린더

대표가 일정을 만들고, 직원(정규직/주말 알바 등 그룹별)에게 링크로 공유. 직원은 보기 + 완료 체크만 가능. Supabase Realtime으로 모든 기기에 즉시 반영.

## 처음 한 번
1. Supabase 대시보드 > SQL Editor 에 `supabase.sql` 전체 붙여넣고 Run
2. Authentication > Sign In / Providers > "Allow new users to sign up" 켜기 (대표가 사이트에서 계정 만들 때 필요)
   - 메일 인증 없이 바로 쓰려면 같은 화면의 "Confirm email" 끄기
3. GitHub 저장소에 이 폴더를 올리고 Settings > Pages 에서 main / root 로 배포

## 수정 시
파일 수정 후 `sw.js` 의 VERSION 을 올리고 push.

로컬 확인: `node .serve.cjs` → http://localhost:5179
