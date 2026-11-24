# NineTalk 데몬 (PC 프로그램 PoC)

웹 대시보드(`../web`)가 `http://localhost:47301/` 로 호출하는 PC 프로그램입니다. 규격은 [`../DAEMON_API.md`](../DAEMON_API.md).
C# .NET 8 WinForms 트레이 앱이고, PC 카카오톡 창을 찾아 상태를 판정하고 **친구 탭의 이름을 화면 캡처 + OCR로 읽습니다.**
발송(`POST /send`)도 됩니다: 실제 카카오톡에서 테스트 친구에게 1건 전송 확인(아래 "발송"). 웹 **발송 내역** 화면의 "PC 프로그램으로 발송" 버튼이 이 API를 씁니다.

## 실행

필요한 것: Windows 10/11, .NET 8 SDK, PC 카카오톡(로그인 상태), Windows 한국어 OCR(설정 > 시간 및 언어 > 언어에 한국어가 있으면 이미 있음).

```bash
cd daemon/NineTalkDaemon
dotnet run
```

트레이에 아이콘이 생기고 `http://localhost:47301/` 이 열립니다. 우클릭 메뉴에 상태, 마지막 작업, "친구 읽기 중단", "종료"가 있습니다.

- `web` 의 `npm run mock-daemon` 과 포트가 같습니다. **가짜 데몬은 끄고** 실행하세요(안 끄면 "포트를 열지 못했습니다" 창이 뜹니다).
- 웹(`npm run dev`)에서 **친구 관리 > 카카오톡 친구 불러오기**(`/friends/import`)로 확인합니다.
- 배포용 exe: `dotnet publish -c Release -r win-x64 --self-contained false` → `bin/Release/net8.0-windows10.0.19041.0/win-x64/publish/NineTalkDaemon.exe`
- 허용 Origin 기본값은 `http://localhost:3000`(웹 개발 서버)과 `http://127.0.0.1:47300`(데스크톱 앱). 바꾸려면 환경변수 `NINETALK_ALLOWED_ORIGINS=http://localhost:3000,...`. 데스크톱 앱이 데몬을 직접 띄울 때는 앱 주소만 넣어 실행합니다.
- 데스크톱 앱에 넣을 때는 `desktop` 에서 `npm run build:daemon`(self-contained 게시 → `desktop/build/daemon`). 자세한 것은 [`../desktop/README.md`](../desktop/README.md).

## API 구현 상태

| 엔드포인트 | 상태 |
|---|---|
| `GET /status` | `Ready` / `GetKaoFriends` / `NotRunning` / `Locked` / `LoggedOut`. `last_error` 필드 추가(마지막 동기화 실패 사유) |
| `POST /friends/synchronize` `Start-all` | 실제 카카오톡에서 동작 확인 |
| `POST /friends/synchronize` `Start-search` | 전체를 읽은 뒤 이름에 키워드가 들어간 친구만 남김(아래 "안전" 참고) |
| `POST /friends/synchronize` `Stop` | 동작 확인. 중단해도 카카오톡 창은 원래 상태로 복원 |
| `GET /friends` | 규격 + 추가 필드: `friend_list[].ocr_uncertain`, `kakao_friend_count`(카톡의 "친구 N"), `unreadable_count` |
| `POST /send` | 구현. 실제 전송 1건 확인(CLI). 이미지(`images`, `image_first`)는 2026-11-24 코드만 작성, **Windows에서 빌드·실행 확인 안 함**(아래 "이미지 발송") |
| `GET /send/result`, `POST /send/stop` | 구현. 웹에서 실제 데몬으로 1건 전송 확인, 중단은 mock-daemon으로 확인 |
| `POST /shutdown`, 인자 `--parent-pid` | 데스크톱 앱용 정상 종료 경로. **Windows에서 빌드·실행 확인 안 함**(맥에서 작성, .NET SDK 없음). mock-daemon 쪽 `/shutdown` 은 확인 |

보안: 허용 목록에 없는 `Origin` 요청은 CORS 헤더만 빼는 게 아니라 **403으로 거절**합니다(다른 사이트가 `text/plain` 같은 단순 요청으로 동기화를 시작하는 것 차단). POST는 `Content-Type: application/json` 만 받습니다(415). `localhost` 프리픽스라 다른 Host 헤더(DNS 리바인딩)는 http.sys가 거절합니다. 프리플라이트에 `Access-Control-Allow-Private-Network: true` 포함.

## 카카오톡 상태 판정 (`/status`)

카카오톡(26.8.2 확인)은 자체 UI 툴킷(EVA)을 쓰고, 자식 창 이름이 `뷰이름_0x핸들` 형태라 구조를 읽을 수 있습니다.

```
EVA_Window_Dblclk "카카오톡"                ← 메인 창 (트레이로 내리면 숨김 상태)
├─ OnlineMainView_…     (EVA_ChildWindow)   ← 로그인 상태 화면
│  ├─ ContactListView_… → ContactListCtrl_… (EVA_VH_ListControl_Dblclk)  ← 친구 탭 목록
│  ├─ ChatRoomListView_… → ChatRoomListCtrl_…                            ← 채팅 탭
│  └─ MoreView_…
└─ LockModeView_…       (EVA_ChildWindow_Dblclk, 비밀번호 Edit 4개)       ← 잠금 화면
```

- `KakaoTalk.exe` 프로세스 없음 → `NotRunning`
- `LockModeView` 의 WS_VISIBLE → `Locked`, `OnlineMainView` 의 WS_VISIBLE → `Ready`, 둘 다 아니거나 이 창이 없으면 → `LoggedOut`
- 창을 트레이로 숨겨도 자식 창의 WS_VISIBLE 비트는 유지돼서, 창을 건드리지 않고 판정합니다.
- **실제로 확인한 것**: `Ready`(창 표시·숨김 두 경우 모두). **확인 못 한 것**: `NotRunning`, `Locked`, `LoggedOut`. 사용자 카카오톡을 끄거나 잠그거나 로그아웃하지 않았기 때문입니다. `NotRunning` 은 프로세스 유무만 보는 단순한 분기이고, `Locked`/`LoggedOut` 은 창 구조에서 추정한 판정입니다.

## 친구 이름 읽기: 어떤 방식이 되나 (조사 결과)

| 방식 | 결과 | 근거 |
|---|---|---|
| UI Automation (FlaUI가 쓰는 것과 같은 UIA) | ❌ | `ContactListCtrl` 이 Pane 하나로만 보이고 자식(행)이 0개 |
| MSAA (IAccessible) | ❌ | 자식이 스크롤바·자식 창(role=window)뿐, 이름 없음 |
| Win32 (EnumChildWindows / GetWindowText) | ❌ | 창 텍스트는 `ContactListCtrl_0x…` 뿐. 목록은 직접 그리는(owner-drawn) 컨트롤 |
| PrintWindow 캡처 + Windows.Media.Ocr(한국어) | △ 405/428명, 109명 불확실 | 처음 구현. 작은 굵은 한글(특히 `김`)에 약함 |
| **PrintWindow 캡처 + PaddleOCR 한국어 인식 모델** | ⭕ 428/428명, 6명 불확실 | 지금 기본값. 아래 |

그래서 FlaUI 패키지는 넣지 않았습니다. 원본 나인톡도 Tesseract(kor) OCR을 같이 쓰는 이유가 이것으로 보입니다.

### 이름 인식 엔진 (`PaddleRec.cs`)

- 모델: PaddleOCR `korean_PP-OCRv5_mobile_rec` 의 ONNX 변환본(`Models/korean/rec.onnx` 13MB + `dict.txt`, Apache 2.0, 출처 [huggingface.co/monkt/paddleocr-onnx](https://huggingface.co/monkt/paddleocr-onnx) `languages/korean`). 실행은 NuGet `Microsoft.ML.OnnxRuntime`.
- 글자 **인식 모델만** 씁니다. 이름 줄의 위치는 데몬이 이미 픽셀로 찾으므로(진한 글씨 줄 + 오른쪽 빈칸 잘라냄) PaddleOCR의 글자 영역 검출 모델은 필요 없습니다.
- 입력: 이름 줄을 높이 48로 늘려 BGR, `[-1, 1]` 정규화. 출력은 CTC 탐욕 디코딩(0 = blank, 사전 + 공백). 글자 평균 확신도가 0.85 미만이면 `ocr_uncertain`.
- `Models/korean` 이 없거나 모델을 못 읽으면 예전 Windows OCR 경로로 돌아갑니다. 강제로 쓰려면 `NINETALK_OCR=windows`, 두 엔진을 같이 돌려 로그에 나란히 남기려면 `NINETALK_OCR_COMPARE=1`.
- "친구 N" 헤더 찾기는 계속 Windows OCR을 씁니다(헤더 글자는 잘 읽힘).

### 동작 순서 (`FriendListReader.cs`)

1. 창이 숨겨져(트레이) 있으면 `ShowWindow(SW_SHOWNOACTIVATE)` 로 **활성화 없이** 표시합니다. 숨긴 창은 PrintWindow가 검은 화면만 줍니다(확인함).
2. 친구 탭이 아니면 왼쪽 탭 줄의 사람 아이콘(OnlineMainView 기준 32,27)에 클릭 메시지를 보냅니다.
3. 친구 목록에 `WM_MOUSEWHEEL` 을 보내 맨 위로 올린 뒤, 4칸(약 360px)씩 내리며 `PrintWindow` 로 목록을 캡처합니다(다른 창에 가려져도 캡처됨).
4. 연속 캡처 두 장의 픽셀 행을 비교해 **실제로 스크롤된 픽셀 수**를 구하고, 목록 좌표를 누적합니다. 마우스가 올라간 행의 hover 배경은 무시합니다.
5. 전체 페이지 OCR로 `친구 428` 같은 헤더를 찾아 그 아래부터 56px 간격으로 행을 셉니다. 내 프로필, 업데이트한 친구, 생일인 친구, 즐겨찾기 구간은 건너뜁니다. 헤더의 숫자는 기대 인원으로 씁니다. 다만 이 숫자도 OCR이라 잘못 읽을 수 있어(433 → 43), 숫자에 닿아도 멈추지 않고 빈 행·다음 구간 제목·목록 끝이 나올 때까지 읽습니다(2026-11-24, 예전에는 숫자에서 멈춰 뒤쪽 친구가 조용히 빠질 수 있었음). 웹은 읽은 수가 표시 수보다 적으면 "N명 적게 읽었습니다"를 띄웁니다.
6. 각 행에서 진한 글씨(이름) 줄만 잘라 PaddleOCR 한국어 모델로 읽습니다. 회색 상태메시지는 들어가지 않습니다. 프로필 사진이 너무 밝아 사진 감지가 안 돼도 이름 글자가 있으면 읽습니다. (Windows OCR 경로일 때는 행별·세로로 쌓은 두 방식을 4개 배율로 돌려 투표합니다.)
7. 끝나면(중단·오류 포함) 원래 탭과 숨김·최소화 상태로 되돌립니다.

같은 이름의 두 친구는 위치가 달라서 둘 다 남고, `duplicate_friend_list` 에 들어갑니다(실제 계정에서 동명이인 3쌍 확인).

### 실제 계정 측정 결과 (친구 428명)

| 항목 | Windows OCR (2026-10-18) | **PaddleOCR (2026-10-19)** |
|---|---|---|
| 걸린 시간 | 약 48초 | 약 51초 (비교용으로 Windows OCR도 같이 돌린 시간) |
| 이름을 읽음 | 405명 | **428명** |
| 판독 불확실(`ocr_uncertain`) | 109명 | **6명** |
| 이름을 못 읽음 | 23행 | **0행** |
| 예 | `김민성`→`기미 서`, `김수현`→`기”• 혀`, `명선이`→`영선이`, `ㅂㅅ진`→`人 진` | 모두 맞게 읽음 |

PaddleOCR에서 불확실로 남은 6명은 자모나 기호뿐인 특이한 이름입니다(`ㅂㅅ진`, `ㅈㅇ`, `oo`, `Hào`, `.` 등. 그중 `ㅂㅅ진`, `Hào`, `.` 는 맞게 읽었고 확신도만 낮음). `Nguyễn` 은 `Nguyén` 으로 성조 하나가 다릅니다.

**한계:** 그래도 OCR이라 틀릴 수 있습니다. 발송은 친구 검색 결과가 정확히 1명이고 채팅방 제목이 이름과 같을 때만 보내므로, 이름이 틀리면 엉뚱한 사람에게 가지 않고 `not_found` / `room_mismatch` 로 실패합니다.

### 안전 (실제 계정에서 동작하므로)

- 목록 안은 **클릭하지 않습니다**. 더블클릭·Enter·키 입력을 보내지 않아서 채팅방이 열릴 수 없습니다. 보내는 메시지는 ① 창 표시(활성화 없음) ② 탭 아이콘 클릭 ③ 친구 목록 마우스 휠, 세 가지뿐입니다.
- `Start-search` 는 카카오톡 검색창에 글자를 넣지 않고 전체 결과를 거르는 방식입니다. 검색창에 포커스가 있을 때 Enter가 들어가면 채팅방이 열리기 때문입니다.
- 읽는 도중 잠금이 걸리거나 사용자가 탭을 바꾸면 즉시 멈춥니다.
- 원본 나인톡(`%LOCALAPPDATA%\NineBox\NineTalk`, 46301)의 코드나 `Abalone.dll` 은 쓰지 않습니다.

## 발송 (`KakaoSender.cs`, `SendService.cs`)

한 명 보내는 순서 (모두 창 메시지, 전역 키보드·마우스 입력 없음):

1. 친구 탭 검색창(`ContactListView` 안의 `Edit`)에 이름을 `WM_SETTEXT` → 검색 결과 목록(`SearchListCtrl`)을 캡처해 프로필 사진 수로 결과 수를 셉니다. 0명 `not_found`, 2명 이상 `duplicate_name`(아무것도 열지 않음).
2. 검색창에 Enter → 결과 1명과의 채팅방이 새 창(`EVA_Window_Dblclk`)으로 열림.
3. 채팅창 제목(`GetWindowText`)이 이름과 정확히 같아야 진행, 아니면 `room_mismatch`.
4. 입력창(`RICHEDIT50W`)에 `EM_REPLACESEL` 로 문구 → 노란 "전송" 버튼을 캡처로 찾아 클릭 → 버튼이 회색으로 돌아가면 `sent`, 5초 안에 안 돌아가면 문구를 지우고 `send_failed`. (입력창 글자 수로 판정하던 때는 실제로 나간 메시지를 `send_failed` 로 잘못 보고했음)
5. 연 채팅창 `WM_CLOSE`, 검색창 비우고 닫기, 원래 탭·숨김 상태 복원.

간격과 재시작 (웹 작성 화면 "4. 발송 설정", 규격은 `DAEMON_API.md`):

| 설정 | 간격 | 카카오톡 재시작 |
|---|---|---|
| 느리게 | 1200ms | 30명마다 |
| 보통 (추천) | 800ms | 50명마다 |
| 빠르게 | 400ms | 100명마다 |
| 사용자화 | 200~2000ms | 1~999명마다(재시작 발송) 또는 없음(일반 발송) |

- 간격은 한 명 끝난 뒤 쉬는 시간입니다. 한 명 보내는 동작에 3초 정도가 따로 걸립니다.
- 재시작(`KakaoRestart.cs`): 카카오톡 프로세스를 끄고 같은 경로로 다시 실행한 뒤, 로그인된 메인 창이 뜰 때까지 최대 90초 기다립니다. **카카오톡 자동 로그인이 켜져 있어야** 합니다. 로그인 상태가 되지 않으면 작업을 `failed` 로 끝내고 남은 사람은 보내지 않습니다(웹에서 대기 중으로 돌아감). 재시작 뒤 창이 트레이로 숨어 있으면 다시 띄웁니다.
- 카카오톡이 관리자 권한으로 실행 중이고 이 프로그램은 아니면 카카오톡을 끄지 못해 실패합니다.
- 재시작만 따로 시험: `NineTalkDaemon.exe --restart-test` (메시지는 보내지 않음, 로그 `%LOCALAPPDATA%\NineTalkDaemon\restart-test.log`). 2026-10-19 실제 PC 카카오톡(자동 로그인 켜짐)에서 시험: 끄고 다시 켜서 **9초 만에 로그인 상태**로 돌아옴. 다시 켜진 카카오톡은 데몬과 별개 프로세스라 데몬·앱을 닫아도 계속 실행됩니다.
- 친구 읽기와 발송은 동시에 돌지 않습니다.

### 실제 확인 결과 (테스트 친구 "ㅂㅅ진", 2026-10-18)

| 단계 | 결과 |
|---|---|
| 검색 결과 수 | ⭕ 1명으로 셈 (내 이름은 0명: 친구 검색에 내 프로필은 안 나와서 "나와의 채팅"은 이 경로로 못 엶) |
| 채팅방 열기 · 제목 확인 · 입력창 찾기 · 문구 넣기 | ⭕ dry-run 2회 성공, 닫기와 탭 복원 확인 |
| **Enter로 전송** | ❌ 2회 시도 모두 입력창이 비지 않아 `send_failed`. `WM_KEYDOWN` 만(1차), 스캔코드+`WM_CHAR` 포함(2차) 둘 다 안 먹힘. 사용자가 채팅방에서 실제로 0건 나간 것을 확인함 |
| 입력창에 넣는 방식 | `WM_SETTEXT` 로 넣으면 글자는 보이지만 "전송" 버튼이 회색(비활성) → 카카오톡이 입력으로 인식 안 함. `EM_REPLACESEL`(붙여넣기와 같은 경로)로 바꾸니 버튼이 노랗게 활성화됨 |
| **전송 버튼 클릭** (3차) | ⭕ `EM_REPLACESEL` + 노란 버튼 위치를 캡처로 찾아 클릭 메시지(`WM_LBUTTONDOWN/UP`) → **실제로 전송됨**(사용자가 채팅방에서 확인). 다만 당시 판정(입력창 글자 수)이 `send_failed` 로 잘못 보고 → 버튼 색 판정으로 바꿈(바꾼 판정은 실제 전송으로 아직 재확인 안 함) |
| 창 숨김 복원 | 1차 dry-run에서 채팅창을 닫은 뒤 카카오톡이 메인 창을 다시 띄움 → 숨김을 몇 번 다시 하도록 고침(재확인은 안 함) |

| **웹 → 실제 데몬** (4차) | ⭕ 발송 내역 "PC 프로그램으로 발송" → ㅂㅅ진 1건, 데몬 `sent`(버튼 색 판정) → 웹 DB `sent`, 요청 "완료". 사용자가 채팅방에서 정확히 1건 도착 확인. 카카오톡은 숨김·채팅 탭·검색 닫힘으로 복원 |

남은 것:
- 여러 명 발송 중의 간격·재시작(실제 발송과 섞인 흐름)은 실제 계정으로 돌려 보지 않음. 재시작 단독은 확인함.
- 이미지 보내기는 코드만 있고 실제 카카오톡에서 확인하지 않음(아래 "이미지 발송").
- 검색이 부분 일치라 "김준"을 찾으면 "김준수"도 나와 `duplicate_name` 이 됩니다(보내지 않는 쪽으로 안전).

### 웹 연결 (web/)

- `app/(app)/jobs/jobs-list.tsx`: 대기 중 요청에 "PC 프로그램으로 발송" 버튼. 확인 창 → `/status` 가 Ready인지 → `getSendPayload`(서버) → `POST /send` → 1.5초마다 `/send/result` 를 읽어 새 결과만 `recordSendResults` 로 기록 → 끝나면 완료(남은 사람 있으면 대기 중으로). "중단" 버튼, 실패자 목록(사유 표시), 탭을 다시 열면 진행 중인 발송 결과를 이어 받음, 연결이 끊긴 "발송 중" 요청은 "대기로 되돌리기".
- 이미지가 있는 요청은 `/status` 의 `images: true` 일 때만 버튼이 열립니다(이 데몬은 이제 `true`).
- `scripts/mock-daemon.mjs`: `/send`, `/send/result`, `/send/stop` 흉내(7번째마다 `not_found`, 이미지면 400).
- `lib/data.ts`: 실패자 목록 행을 일반 객체로 바꿔 넘김(node:sqlite 행은 null prototype이라 클라이언트 컴포넌트로 못 넘겨 화면 오류가 났음).

### dry-run / 1건 테스트

```bash
dotnet build -c Debug -o bin/SendTest
./bin/SendTest/NineTalkDaemon.exe --send-test "친구이름" "문구"          # dry-run: 입력창에 넣고 지운 뒤 닫음
./bin/SendTest/NineTalkDaemon.exe --send-test "친구이름" "문구" --send   # 실제 전송 (진짜로 나갑니다)
```

로그: `%LOCALAPPDATA%\NineTalkDaemon\send-test.log` (트레이 데몬이 떠 있어도 HTTP를 안 쓰므로 함께 돌려도 됩니다).

## 이미지 발송 (2026-11-24, 맥에서 작성 — Windows에서 빌드·실행 확인 안 함)

맥 PC 프로그램과 같은 흐름입니다(`KakaoSender.SendImageAsync`, `ClipboardImage.cs`).

1. 채팅방을 연 뒤 입력창에 쓰던 글이 있으면 아무것도 안 하고 `input_not_empty`(맥과 같음. 예전에는 쓰던 글을 덮어썼음). 글자 수(`WM_GETTEXTLENGTH`)가 0이면 빈 것, 0보다 크면 지난번 보낸 글이 남은 값일 수 있어 노란 "전송" 버튼을 1초쯤 지켜보고 판단합니다(v0.1.1 은 글자 수만 봐서 채팅창을 열자마자 닫는 일이 있었음). 캡처가 안 되면 보내지 않습니다. 입력창을 비울 때는 카카오톡이 알아채는 `EM_REPLACESEL` 로 비웁니다.
2. 문구와 이미지를 순서대로(`image_first` 면 이미지 먼저). 일부만 나간 뒤 실패하면 `partial_sent`.
3. 이미지: 원래 클립보드를 저장 → 이미지를 클립보드에 → **채팅 입력창에만** Ctrl+V(`Native.PostCtrlKey`: 카카오톡 스레드의 키 상태에 잠깐 Ctrl 을 눌린 것으로 두고 V 키 메시지를 그 창에 보낸 뒤 되돌림). 전역 키 입력은 쓰지 않습니다(사용자가 다른 프로그램에서 타이핑 중이면 엉뚱한 곳에 붙여넣어질 수 있어서). 2026-11-24 실제 PC 기록: `WM_PASTE` 만으로는 카카오톡이 아무 창도 띄우지 않았음(v0.1.1~0.1.3).
4. 붙여넣은 뒤 8초 안에 새로 뜬 카카오톡 창 중 이 채팅창이 소유한 창 하나, 그런 창이 없으면 새 창이 하나뿐이고 채팅창 위에 떠 있으며 미리보기 크기(200x150 이상)일 때만 이미지 전송 창으로 봅니다(같은 때 뜬 알림 창을 누르지 않게). 아래쪽의 꽉 찬 노란 "전송" 버튼을 캡처로 찾아 클릭 → 창이 닫히면 보냄. dry-run 이면 창을 닫아 취소. Ctrl+V 가 글자 `v` 로 들어갔으면(전송 버튼이 켜짐) 지웁니다.
5. 못 알아본 경우: 붙여넣은 뒤 뜬 창을 모두 닫고(로그에 클래스·크기·소유 창을 남김) `send_failed`. 그 창이 안 닫히면 `unknown_result`(보냈는지 알 수 없음 — 웹이 다시 보내지 않음).
6. 업로드 진행을 읽을 수 없어 크기에 비례해 기다립니다(3초 + 약 150KB/초, 최대 1분).
7. 채팅창을 닫을 때 다른 창(업로드 중 "닫으면 안 보내짐" 확인 등)이 뜨면 **그 창은 건드리지 않고 채팅창을 열어 둡니다.** 잘못 답하면 이미지가 빠질 수 있어서입니다.
8. 끝나면 클립보드를 되돌립니다(그사이 사용자가 다른 걸 복사했으면 건드리지 않음). 문구나 이미지가 일부 나간 뒤 오류가 나면 `partial_sent`.

GDI+ 로 열리는 형식만(PNG·JPG·GIF·BMP) 받습니다. WebP·HEIC 는 `400 unsupported image type`(웹이 "Windows 는 PNG·JPG·GIF 만" 이라고 안내). GIF 는 첫 장면만 보내질 수 있습니다.

앱에서 보낸 발송은 작업마다 `%LOCALAPPDATA%\NineTalkDaemon\last-send.log` 에 남습니다(친구 이름·문구 없이 받는 사람 번호와 단계만, 다음 작업 때 덮어씀).

**Windows PC에서 먼저 확인할 것** (테스트 친구로, 로그 `%LOCALAPPDATA%\NineTalkDaemon\send-test.log`):

```bash
dotnet build -c Debug -o bin/SendTest
./bin/SendTest/NineTalkDaemon.exe --send-test "친구이름" "문구" --image C:\temp\a.png            # dry-run: 이미지 창을 띄웠다 닫음
./bin/SendTest/NineTalkDaemon.exe --send-test "친구이름" "문구" --image C:\temp\a.png --send     # 실제 전송
```

로그의 `이미지 창 0x… 클래스 '제목' 크기`, `붙여넣은 뒤 뜬 창 … 소유 창 …`, `이미지 전송 버튼 x,y`, `채팅창을 닫으려 하자 창이 뜸` 줄로 어디까지 됐는지 알 수 있습니다. 가정이 틀린 곳(WM_PASTE 로는 이미지 창이 안 뜸, 이미지 창이 채팅창 소유가 아님, 전송 버튼 색이 다름 등)은 이 로그로 고칩니다. 틀리면 보내지 않는 쪽(`send_failed`)으로 멈추게 했습니다.

## 진단 도구

```bash
# 읽기 전용: 카카오톡 창 구조·상태 출력, 친구 탭이 열려 있으면 캡처+OCR (채팅 탭이면 캡처를 저장하지 않음)
NineTalkDaemon.exe --probe 출력폴더

# 동기화할 때 페이지 캡처를 저장 (환경변수를 켜고 데몬 실행)
set NINETALK_DEBUG_DIR=C:\temp\pages
# 저장된 캡처로 카카오톡 없이 읽기 로직만 다시 실행 → 폴더\replay.txt
NineTalkDaemon.exe --replay C:\temp\pages
```

동기화 로그(행마다 읽은 이름과 배율별 판독)는 매번 `%LOCALAPPDATA%\NineTalkDaemon\last-sync.log` 에 덮어씁니다. 친구 이름이 들어 있으니 공유하지 마세요.

## 레이아웃 가정 (카카오톡 업데이트에 취약한 부분)

`FriendListReader.cs` 맨 위 상수에 모여 있습니다. 카카오톡 26.8, 100% 배율 기준이고 창 DPI에 맞춰 곱합니다. 탭 아이콘 위치, 행 간격 56px, 프로필 40px(x 20~56), 이름 시작 x 64, 이름 글자 밝기 90 미만이 들어 있습니다. 다크 모드는 확인하지 않았습니다(이름 밝기 판정이 반대라 동작하지 않을 것).

## 파일

| 파일 | 내용 |
|---|---|
| `Program.cs` | 진입점 (트레이 / `--probe` / `--replay` / `--send-test`) |
| `TrayContext.cs` | 트레이 아이콘·메뉴, HTTP 서버 시작 |
| `HttpServer.cs` | HttpListener, CORS, 라우팅 |
| `FriendSync.cs` | 동기화 작업 1개 관리(시작·중단·결과·로그) |
| `KakaoWindow.cs` | 카카오톡 창 찾기·상태 판정 |
| `FriendListReader.cs` | 친구 탭 스크롤·캡처·행 추적·이름 OCR |
| `Capture.cs`, `Ocr.cs`, `Native.cs` | PrintWindow, Windows.Media.Ocr, Win32 선언 |
| `PaddleRec.cs`, `Models/korean/` | PaddleOCR 한국어 인식 모델(ONNX) 실행 |
| `Probe.cs` | `--probe` 진단 |
| `KakaoSender.cs` | 한 명 발송: 검색·결과 수·채팅방 제목 확인·입력·전송·닫기 |
| `SendService.cs` | 발송 작업 1개 관리(간격, 중단, 결과 보관) |
