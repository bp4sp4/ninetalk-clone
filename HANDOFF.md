# 인수인계 (2026-10-18 기준)

다른 PC(맥)에서 이어서 작업할 때 먼저 읽을 문서입니다. 자세한 내용은 아래 문서에 있습니다.

| 문서 | 내용 |
|---|---|
| [ANALYSIS.md](ANALYSIS.md) | 원본 나인톡 분석 결과와 재구현 설계 |
| [DAEMON_API.md](DAEMON_API.md) | 웹 ↔ PC 프로그램(데몬) 로컬 API 규격 (`localhost:47301`) |
| [daemon/README.md](daemon/README.md) | 데몬 구조, 카카오톡 조작 방법, 실제 확인 결과, 한계 |
| [web/README.md](web/README.md) | 웹 대시보드 |

## 지금 상태

```
브라우저 (web/, Next.js 16, localhost:3000)
   │  fetch http://localhost:47301  (CORS: localhost:3000만 허용)
   ▼
PC 프로그램 (daemon/, C# .NET 8 트레이 앱, Windows 전용)
   │  Win32 창 메시지 + PrintWindow 캡처 + Windows OCR
   ▼
PC 카카오톡 (Windows 26.8 확인)
```

| 기능 | 상태 |
|---|---|
| 웹: 카카오 로그인, 친구·그룹 관리, 메시지 작성 | 완료 |
| 친구 불러오기 (카카오톡 친구 탭 → OCR) | 동작. 428명 중 405명 읽음, 그중 109명은 "확인 필요"(OCR 불확실), 23행 못 읽음 |
| 발송 (작성 → 발송 내역에서 확인 → 데몬이 1명씩 전송) | 동작. 테스트 친구에게 웹에서 실제 1건 전송 확인 |
| 이미지 발송 | 미구현 (데몬이 이미지 요청을 400으로 거절, 웹은 버튼을 막음) |
| 여러 명 연속 발송 | 코드만 있음. 실제 계정으로 간격·휴식 동작은 확인 안 함 |
| 카카오톡 잠금/로그아웃 판정 | 코드만 있음. 실제로 확인 안 함 |

## 맥에서 시작하기

맥에서는 데몬이 돌지 않으므로 **가짜 데몬(mock)** 으로 웹·일렉트론을 개발하고, 실제 카카오톡 확인은 Windows PC에서 합니다.

```bash
gh auth login                         # 비공개 저장소
gh repo clone bp4sp4/ninetalk-clone
cd ninetalk-clone/web
npm install
cp .env.example .env.local            # 값은 Windows PC의 web/.env.local 에서 옮겨 적기
npm run dev                           # 터미널 1
npm run mock-daemon                   # 터미널 2 (47301, 친구 불러오기·발송 흉내)
```

- Node.js 22.13 이상 필요 (`node:sqlite` 사용). Windows PC는 v24.13.0.
- `.env.local` 에 `DEV_LOGIN=1` 이면 카카오 로그인 없이 테스트 로그인 가능.
- **git에 없는 것**: `web/.env.local`(카카오 키, 세션 비밀값), `web/data/ninetalk.db`(실제 친구 이름 등 개인 데이터). DB는 의도적으로 옮기지 않았습니다.

## 다음 할 일

1. **일렉트론 앱으로 전환** (Vercel 배포 대신)
   - 이유: 웹이 SQLite 파일 DB를 쓰는데 Vercel에서는 파일이 유지되지 않음. 데몬도 어차피 사용자 PC에서 돌아야 함.
   - 방향: 일렉트론 메인 프로세스에서 Next 서버(standalone)를 띄우고 창에 로드, C# 데몬은 자식 프로세스로 실행(`dotnet publish` 결과 exe 포함), DB는 사용자 데이터 폴더로.
   - 주의: 카카오 로그인 Redirect URI가 `http://localhost:3000/auth/kakao/callback` 로 등록돼 있음. 포트를 바꾸면 카카오 디벨로퍼스 콘솔도 바꿔야 함. 로컬 단독 앱이면 카카오 로그인을 빼는 것도 고려.
   - 웹 CORS 허용 Origin이 바뀌면 데몬 환경변수 `NINETALK_ALLOWED_ORIGINS` 도 맞출 것.
2. **이미지 발송** (데몬): 클립보드 붙여넣기 방식 등 조사 필요.
3. **맥용 데몬 조사**: 맥 카카오톡이 손쉬운 사용(Accessibility) API로 친구 이름·입력창을 노출하는지부터 확인. 노출하면 OCR 없이 정확하게 읽을 수 있음. 같은 HTTP API(47301)를 구현하면 웹은 그대로.
4. OCR 정확도 개선 후보: Tesseract `kor`(원본 나인톡이 쓰는 엔진).

## 카카오톡 조작에서 알아낸 것 (Windows)

- 트레이에 숨긴 창은 캡처하면 검은 화면 → 활성화 없이 표시(`SW_SHOWNOACTIVATE`) 후 캡처, 끝나면 다시 숨김.
- 친구 목록은 직접 그리는 컨트롤이라 UI Automation·MSAA·창 텍스트로 이름을 못 읽음 → 캡처 + OCR.
- 입력창에 `WM_SETTEXT` 로 넣으면 글자는 보여도 "전송" 버튼이 비활성 → `EM_REPLACESEL` 로 넣어야 함.
- Enter 키 메시지로는 전송 안 됨 → 노란 "전송" 버튼을 캡처로 찾아 클릭 메시지로 누름.
- 전송 성공 판정은 입력창 글자 수가 아니라 "전송 버튼이 회색으로 돌아갔는지"로 (글자 수로는 실제로 나간 메시지를 실패로 잘못 보고했음).
- 친구 검색에 내 프로필은 안 나옴 → "나와의 채팅"은 친구 검색 경로로 못 엶.

## 실제 계정 테스트 규칙

- 실제 카카오톡 계정이라 진짜로 나갑니다. **실제 전송 전에는 매번 받는 사람과 문구를 사용자에게 보여 주고 허락**받습니다.
- 테스트 친구: "ㅂㅅ진" (사용자 허락). 먼저 dry-run으로 확인:
  `daemon/NineTalkDaemon/bin/SendTest/NineTalkDaemon.exe --send-test "이름" "문구"` (dry-run), `--send` 를 붙이면 실제 전송.
- 웹 발송 내역에 테스트로 만든 "ㅂㅅ진" 대기 요청이 몇 건 남아 있으면, 누르면 실제로 나가니 필요 없으면 취소.
