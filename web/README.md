# 단체톡 관리 — 웹 대시보드

카카오 로그인, 친구·그룹 관리, 카카오톡 친구 불러오기, 메시지 작성(발송 요청 대기열)까지 들어 있는 Next.js 16 앱입니다.
실제 카카오톡 발송과 친구 읽기는 PC 프로그램(데몬)이 맡습니다. 규격은 [`../DAEMON_API.md`](../DAEMON_API.md).

## 실행

```bash
npm install
cp .env.example .env.local   # SESSION_SECRET 을 아무 긴 문자열로 바꾸세요
npm run dev                  # http://localhost:3000
npm run mock-daemon          # (선택) 가짜 PC 프로그램, 친구 불러오기 테스트용
```

데이터는 `data/ninetalk.db`(SQLite, Node 24 내장 `node:sqlite`)와 `data/uploads/`(첨부 이미지)에 저장됩니다.

## 카카오 로그인 설정

1. https://developers.kakao.com → 내 애플리케이션 → 애플리케이션 추가
2. 앱 키 → **REST API 키**를 `.env.local` 의 `KAKAO_REST_API_KEY` 에
3. 제품 설정 → 카카오 로그인 → 활성화 ON, Redirect URI 에 `http://localhost:3000/auth/kakao/callback` 등록
4. 동의항목 → 닉네임·프로필 사진 설정
5. (선택) 보안 → Client Secret 을 켰다면 `KAKAO_CLIENT_SECRET` 에

키를 넣기 전에는 로그인 화면의 "테스트 계정으로 둘러보기"(`DEV_LOGIN=1`, 개발 모드 전용)로 써볼 수 있습니다.

## 화면

| 경로 | 내용 |
|---|---|
| `/` | 카카오 로그인 |
| `/dashboard` | 요약, 시작 가이드 |
| `/friends` | 친구 추가(한 명/붙여넣기/CSV, CP949 자동 인식), 검색·필터, 말투, 그룹 넣기, 삭제, 동명이인 표시 |
| `/friends/import` | PC 프로그램으로 카카오톡 친구 목록 불러오기 → 새 친구만 골라 등록 |
| `/groups` | 그룹 만들기·이름 변경·순서·기본 그룹, 멤버 추가/빼기 |
| `/compose` | 받는 사람(그룹+개별), 존댓말/반말 문구, `{이름}` 치환, 이미지 5장, 속도·나눠 보내기, 채팅 미리보기 → 발송 요청 |
| `/jobs` | 발송 요청 목록, 대기 중 요청 취소 |

## 구조

- `lib/db.ts` SQLite 스키마/연결 · `lib/session.ts` 서명 쿠키 세션 · `lib/auth.ts` 로그인 사용자
- `lib/data.ts` 조회(항상 세션 사용자 기준) · `lib/actions.ts` Server Actions(모든 변경은 소유권 확인)
- `lib/daemon.ts` 브라우저 → PC 프로그램 호출 · `scripts/mock-daemon.mjs` 테스트용 데몬
- Cache Components 사용: 세션을 읽는 부분은 모두 `<Suspense>` 안에서 요청 시점에 렌더링됩니다.
