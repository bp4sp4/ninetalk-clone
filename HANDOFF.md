# 인수인계 (2026-10-19 기준)

다른 PC(맥)에서 이어서 작업할 때 먼저 읽을 문서입니다. 자세한 내용은 아래 문서에 있습니다.

| 문서 | 내용 |
|---|---|
| [ANALYSIS.md](ANALYSIS.md) | 원본 나인톡 분석 결과와 재구현 설계 |
| [DAEMON_API.md](DAEMON_API.md) | 웹 ↔ PC 프로그램(데몬) 로컬 API 규격 (`localhost:47301`) |
| [daemon/README.md](daemon/README.md) | 데몬 구조, 카카오톡 조작 방법, 실제 확인 결과, 한계 |
| [web/README.md](web/README.md) | 웹 대시보드 |
| [desktop/README.md](desktop/README.md) | 일렉트론 데스크톱 앱 (웹 + 데몬을 한 앱으로) |
| [daemon-mac/README.md](daemon-mac/README.md) | 맥용 PC 프로그램 (손쉬운 사용 API, OCR 없음) |

## 지금 상태

```
데스크톱 앱 (desktop/, Electron 44)          ← 실사용
   ├─ Next standalone 서버 127.0.0.1:47300 (로그인 없는 로컬 모드, DB는 사용자 데이터 폴더)
   └─ 창 → 화면이 fetch http://localhost:47301
브라우저 (web/, Next.js 16, localhost:3000)  ← 웹 개발용 (카카오 로그인 그대로)
   │  fetch http://localhost:47301  (CORS: localhost:3000, 127.0.0.1:47300만 허용)
   ▼
PC 프로그램 (daemon/, C# .NET 8 트레이 앱, Windows)    │  PC 프로그램 (daemon-mac/, Node + Swift, 맥)
   │  Win32 창 메시지 + PrintWindow 캡처 + OCR           │     손쉬운 사용(Accessibility) API
   ▼                                                    ▼
PC 카카오톡 (Windows 26.8 확인)                          맥 카카오톡 (26.8.0 확인)
```

| 기능 | 상태 |
|---|---|
| 웹: 카카오 로그인, 친구·그룹 관리, 메시지 작성 | 완료 |
| **맥 카카오톡 친구 읽기·발송** (daemon-mac) | 동작. 친구 428/428명 정확히 읽음(2.7초), 테스트 친구에게 실제 1건 전송·사용자 도착 확인 (2026-10-19). 여러 명 연속 실제 발송은 안 해 봄 |
| 데스크톱 앱 (맥, 가짜 데몬) | 동작. 실행·패키징(`.app`)·사용 흐름·재시작 후 데이터 유지·정상 종료 확인 (2026-10-19) |
| 데스크톱 앱 (Windows, 실제 데몬) | **확인 안 함**. 설치 파일 빌드(`npm run dist:win`)와 데몬 자동 실행·종료(`/shutdown`, `--parent-pid`)는 Windows PC에서 확인 필요 |
| 친구 불러오기 (카카오톡 친구 탭 → OCR) | 동작. 428명 중 405명 읽음, 그중 109명은 "확인 필요"(OCR 불확실), 23행 못 읽음 |
| 발송 (작성 → 발송 내역에서 확인 → 데몬이 1명씩 전송) | 동작. 테스트 친구에게 웹에서 실제 1건 전송 확인 |
| 이미지 발송 | 미구현 (데몬이 이미지 요청을 400으로 거절, 웹은 버튼을 막음) |
| 여러 명 연속 발송 | 코드만 있음. 실제 계정으로 간격·휴식 동작은 확인 안 함 |
| 카카오톡 잠금/로그아웃 판정 | 코드만 있음. 실제로 확인 안 함 |

## 맥에서 시작하기

맥에서도 **맥용 PC 프로그램(daemon-mac)** 으로 맥 카카오톡을 직접 조작할 수 있습니다(손쉬운 사용 권한 필요). 윈도 카카오톡 확인은 Windows PC에서 합니다.
일렉트론 앱은 `cd desktop && npm install && npm run build:web && npm run build:daemon-mac && npm start`. 실제로 안 보내고 시험하려면 `NINETALK_MAC_DRY_RUN=1 npm start`, 카카오톡 없이 하려면 `NINETALK_MOCK_DAEMON=1 npm start`. 자세한 것은 [desktop/README.md](desktop/README.md), [daemon-mac/README.md](daemon-mac/README.md).

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

1. **Windows PC에서 데스크톱 앱 확인** (일렉트론 전환은 맥에서 끝냄)
   - `cd desktop && npm install && npm run dist:win` → `dist/HanpyeongsaengTok-0.1.0-win-x64.exe` 설치·실행. 웹 빌드는 Windows에서 새로 해야 합니다(`sharp` 등 플랫폼별 파일).
   - 데몬 C# 변경(`POST /shutdown`, `--parent-pid`, 기본 허용 Origin에 `http://127.0.0.1:47300`)은 맥에 .NET SDK가 없어 **컴파일도 안 해 봤습니다**. 먼저 `dotnet build` 확인.
   - 확인할 것: 앱 실행 시 트레이에 데몬이 뜨는지, 앱을 끄면 트레이 아이콘이 사라지는지, 작업 관리자로 앱을 죽였을 때 2초 안에 데몬도 꺼지는지, `dotnet run` 으로 데몬을 먼저 띄워 두면 앱이 그걸 그대로 쓰는지, 친구 불러오기·1건 발송(테스트 친구, 매번 허락 받고).
   - 카카오 로그인은 데스크톱 앱에서 뺐습니다(사용자 결정, 로컬 사용자 1명). 웹 단독(`web/`, `npm run dev`)에는 그대로 있습니다. 기존 `web/data/ninetalk.db` 의 데이터는 앱 데이터 폴더(`%APPDATA%\한평생톡\data`)로 자동으로 옮겨지지 않고, 사용자도 카카오 사용자 → 로컬 사용자로 바뀌어 있어서, 옮기려면 별도 작업이 필요합니다.
2. **이미지 발송** (데몬): 클립보드 붙여넣기 방식 등 조사 필요.
3. ~~맥용 데몬 조사~~ → `daemon-mac/` 로 구현(2026-10-19). 남은 것:
   - **리뷰 반영 후 실제 카카오톡 dry-run 다시**: 카카오톡에 열린 채팅창·쓰던 글이 없을 때 `desktop/build/daemon-mac/kakao-mac send "ㅂㅅ진" "문구"`(--send 없이) → `dry_run_ok`. 안 되면 `focus_failed:front|window|element` 로 원인이 나옴. ㅂㅅ진 입력창에 QA 시험 글이 남아 있을 수 있으니 먼저 비우기.
   - 여러 명 연속 실제 발송(간격·휴식), 잠금·로그아웃 화면 판정, 패키징 앱(.app)에서 손쉬운 사용 권한 받고 실제 발송.
   - 화면이 잠기지 않은 상태에서: 발송 중 종료 → 확인창 "보내던 사람까지 보내고 종료" → 창이 앞으로 나오고 발송 내역에 마지막 결과까지 기록되는지(가짜 데몬으로 확인 가능, `NINETALK_MOCK_DAEMON=1 npm start`). 창이 가려진 채로 계속 기록되는 것, 확인창이 한 번만 뜨는 것, 다른 화면에서 종료해도 기록되는 것은 확인됨.
   - 윈도 데몬(C#)은 마지막 발송 결과를 파일로 남기지 않음 — 맥처럼 `last-send.json` 을 넣으면 도중에 꺼져도 중복 발송을 막을 수 있음.
4. OCR 정확도 개선 후보: Tesseract `kor`(원본 나인톡이 쓰는 엔진).
5. (선택) 로컬 모드 서버(127.0.0.1:47300)는 인증이 없어서 같은 PC의 다른 프로그램은 접근할 수 있습니다. 1인용 PC 앱이라 지금은 그대로 두었습니다. 막으려면 일렉트론이 임시 토큰을 만들어 창에 쿠키로 심고 `proxy.ts` 에서 검사.

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
