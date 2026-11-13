# 음식한눈 공통 계정·보관소

2026-11-13 · 웹 로그인은 Cloudflare Workers + D1 계정으로 전환했습니다.

| 항목 | 운영 방식 |
| --- | --- |
| 계정 | Cloudflare Worker의 Google/카카오/네이버 SNS 로그인 및 신규 가입 동의 |
| 진입 | 홈 상단 사용자 아이콘 → 로그인/회원가입, 로그인 후 사진 또는 첫 글자 |
| 로그인 세션 | 브라우저 sessionStorage의 앱 전용 토큰, 최대 1시간 |
| 레시피 즐겨찾기·장보기·최근 검색·메모 | 변경 없이 기기 localStorage, 서버 자동 업로드 없음 |
| 이전 Firestore 백업 | 삭제하거나 자동 병합하지 않으며, 홈의 ?legacyAccount=1로 명시적으로만 조회 |
| Android | 웹 앱과 별개로 외부 브라우저 OAuth 반환 구현·검증 필요 |
| 개인정보 | privacy.html 및 공통 계정 개인정보 안내 참조 |

Cloudflare 계정 페이지: https://softm-hannun-account.softm.workers.dev/account

**중요:** 로그인 기능을 붙였다고 기기의 저장한 레시피와 장보기 목록이 계정에 자동 동기화되는 것은 아닙니다. 별도 암호화·충돌처리·마이그레이션을 설계하기 전에는 기존 Firebase 백업이나 로컬 자료를 덮어쓰지 않습니다.
