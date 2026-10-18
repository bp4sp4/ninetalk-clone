# 나인톡(NineTalk) 구조 분석 & 재구현 설계서

분석일: 2026-10-18 · 도구: REA(정적 분석 + 브라우저 관찰) · 대상: ninetalk.iif.app 웹 + 설치된 `NineTalk.v2.exe` v2.2.5.0

> 표기: **[관찰]** 실제 파일/화면에서 확인 · **[추정]** 관찰을 근거로 한 추론 · **[미확인]** 보지 못함

---

## 1. 한 줄 요약

나인톡은 **"웹 대시보드 + 내 PC에 설치된 로컬 프로그램(데몬)이 PC 카카오톡을 대신 조작해서 1:1 채팅을 보내는"** 구조입니다.
카카오 공식 API를 쓰지 않습니다. 사람이 PC 카톡에서 친구를 검색하고 채팅방을 열어 붙여넣고 Enter를 누르는 동작을 프로그램이 Win32 API로 흉내 냅니다.

```
┌──────────────────────┐   HTTPS   ┌─────────────────────────┐
│ 웹 (Next.js)          │──────────▶│ 백엔드 prod-api.iif.app │
│ ninetalk.iif.app     │  /v1/...  │ (계정·그룹·결제·예약)     │
└─────────┬────────────┘           └───────────▲─────────────┘
          │ http://localhost:46301              │ /api/reservation 등
          ▼ (브라우저 → 내 PC 직통)               │
┌──────────────────────┐  Win32 메시지/키입력    ┌┴──────────────┐
│ NineTalk.v2.exe       │──────────────────────▶│ PC 카카오톡     │
│ (.NET 4.7 WinForms)   │◀── 화면캡처 + OCR ──────│ (실제 계정)     │
└──────────────────────┘                       └───────────────┘
```

---

## 2. 웹 프론트엔드 [관찰]

- **스택**: Next.js App Router + React, HTTP는 axios, Google Tag Manager/GA
- **로그인**: 카카오 소셜 로그인 → `POST /v1/auth/login/social`, 토큰 갱신 `POST /v1/auth/refresh`, 로그아웃 `POST /v1/auth/logout`
- **API 서버**: `https://prod-api.iif.app/`

### 페이지 (번들에서 찾은 라우트)
| 경로 | 역할 [추정] |
|---|---|
| `/login` | 랜딩 + 카카오 로그인 (`?trial=7days` → 7일 무료체험) |
| `/nine_talk/step1` | **메인 작업 화면**: 데몬 연결 상태, 친구 동기화, 그룹 관리 |
| `/nine_talk/download` · `/update` | 데몬 설치/업데이트 안내 |
| `/nine_talk/integrated_data`, `/integrated_data/send` | 메시지 작성·발송, 미발송 재전송 |
| `/nine_talk/new_friend/send` | 새 친구(새 채팅방) 대상 발송 |
| `/nine_talk/duplicate_friend_list` | 같은 이름 친구 중복 처리 |
| `/nine_talk/reservation` | 예약 발송 |
| `/nine_talk/payment`, `/mobile_card`, `/my_page`, `/customer` | 결제·마이페이지·고객센터 |

### 백엔드 API (번들에서 찾은 엔드포인트)
| 분류 | 엔드포인트 |
|---|---|
| 계정 | `GET /v1/accounts/me`, `GET /v1/accounts/use`, `POST /v1/accounts/coachmark` |
| 친구 | `POST /v1/friends` (`{isInit, names[], newRooms[]}`), `PUT /v1/friends`, `DELETE /v1/friends`, `DELETE /v1/friends/clear` |
| 그룹 | `GET/POST /v1/groups`, `/v1/groups/{id}`, `PATCH /v1/groups/order`, `POST /v1/groups/excel/upload` |
| 발송설정 | `GET/PUT /v1/send-setting` (`speed_rate, file_send_type, send_type, split_send_count, preset`) |
| 결제 | `GET /v1/payments/check`, `/amount`, `/light-plan/status`, `POST /light-plan/upgrade` |
| 기타 | `GET /v1/notice`, `GET /v1/company`, `/v1/company/period`, `GET /v1/daemon/version?env=PROD` |

> 주의: 위 목록은 "번들 안에 있는 호출 코드"이고, 요청/응답 바디 전체 스키마는 확인하지 않았습니다.

---

## 3. 로컬 데몬 `NineTalk.v2.exe` [관찰]

- 위치: `%LOCALAPPDATA%\NineBox\NineTalk\`
- .NET Framework 4.7, WinForms, AnyCPU, 난독화 없음 (단, `Abalone.dll`은 난독화됨 — 아래 참고)
- 의존성: `Abalone.dll`(카톡 조작 엔진), `Tesseract 5`+`kor.traineddata`(한국어 OCR), `AWSSDK.S3`(첨부/로그 업로드), `Newtonsoft.Json`
- **로컬 HTTP 서버**: `HttpListener` → `http://localhost:46301/`
  - CORS: `Access-Control-Allow-Origin: *`, `Access-Control-Allow-Private-Network: true` (공인 사이트 → localhost 접근 허용용)
  - 인증: `Authorization: Bearer {demonToken}` + `?telephone=` 로 사용자 매칭

### 로컬 API (데몬이 여는 엔드포인트)
| 메서드·경로 | 역할 |
|---|---|
| `GET /status?telephone=` | 상태: `Ready / GetKaoFriends / SendMessage / NotRunning / LoggedOut / Locked / Abend` + 진행 카운트 + 버전 |
| `GET /specification` | PC 사양 체크(OS/CPU/RAM/디스크, 권장 여부) |
| `POST /friends/synchronize` | 카톡 친구목록 긁어오기. `mode: Start-all / Start-part / Start-search / Start-order / Stop`, `check_new_room`, `option`, `settings` |
| `GET /friends` | 동기화 결과 `friend_list[{name,is_new_room}]`, `duplicate_friend_list` |
| `POST /send` | 발송 시작 (아래 SendMessage 구조) |
| `POST /send/stop`, `GET /send/result` | 중단 / 결과(success, fail, 목록) |
| `GET /abend?request=` | 비정상 종료 후 미발송분 복구(resend/sent/fail) |
| `GET /logs` | 진단 로그·캡처를 S3로 업로드 |
| `POST /update` | 자동 업데이트 |
| `GET /room/activity` | 채팅방 상태 OCR 판정 (새 방인지 등) |

실측: 지금 이 PC에서 `GET /status` → `{"status":"Ready","version":"2.2.5.0",...}` 응답 확인.

### 발송 데이터 구조 (`NineTalk.Json.*`)
```
SendMessage {
  PastMessageId?: int, GroupID: int, GroupName: string,
  Messages: Message[], AttatchedFiles: AttatchedFile[],
  Honorific: string, Talkdown: string,       // 존댓말/반말 버전 문구
  IsFirstImage, IsImageBundle, IsSlowMessage: bool,
  Settings: { SpeedRate?, FileSendType, SendType, SplitSendCount? }
}
Message      { Name, SentMessage, SenderType("Honorific"|"TalkDown"), DoNotSendImage, DoNotSendText }
AttatchedFile{ Name, Data(base64 data URL), Type }
KakaoFriend  { Name, Duplication:int, IsNewRoom?:bool, Result:bool }
Reservation  { id, PastMessagesId, Datasets, SendDateTime, SentCount, isDeleted, 5분/15분 전 알림 플래그 }
ResumeData   { Messages, ReSend, Sent, Fail, SendTime, ... }   // 중단 후 이어보내기
```

### 내부 구성 (클래스)
- `KakaoService` — HTTP 요청 처리, 친구동기화·발송·첨부 준비의 중심
- `Http.HttpServer` — localhost:46301 리스너 + 워커
- `Processing.ReservationProcess` — 서버(`/api/reservation`)에서 예약을 받아 큐 실행 → 결과 `/api/reservation/results`
- `Processing.RoomActivityDetector` — 채팅창을 캡처해 Tesseract로 읽고 "대화를 시작 / 이모티콘으로 대화 / 시작해보세요" 같은 문구로 **빈 새 채팅방인지** 판정
- `Processing.StatusReportProcess`, `Service.NineTalkAPI` — 데몬 상태/발송 로그를 백엔드로 보고
- `View.MainContainer / UpdateContainer / ReservationContainer` — 트레이용 작은 WinForms 창

### 카톡 조작 엔진 `Abalone.dll` [관찰 + 추정]
- **난독화 + 메서드 본문 암호화**(VirtualProtect 기반 안티탬퍼)되어 있어 로직 자체는 읽지 않았습니다. 해제 시도도 하지 않았습니다.
- 대신 선언된 Win32 함수 목록으로 방식은 충분히 추정됩니다:
  - 창 찾기: `FindWindow / FindWindowEx / EnumWindows / EnumChildWindows / GetClassName / GetWindowText`
  - 입력: `SendMessage(W) / PostMessage / SendInput / keybd_event / SetForegroundWindow / SetFocus`
  - 화면: `PrintWindow / GetWindowRect / DwmGetWindowAttribute / DPI 함수들`
  - 권한: `OpenProcessToken / GetTokenInformation` (카톡·데몬 관리자 권한 일치 확인 — 다르면 메시지가 안 먹음)
- **[추정] 발송 1건의 흐름**: 카톡 메인창 찾기 → 친구 탭 검색창에 이름 입력 → Enter로 채팅방 열기 → (OCR로 새 방/정상 방 확인) → 입력창에 텍스트 붙여넣기/이미지 첨부 → Enter → 창 닫기 → 속도 설정만큼 대기 → 다음 친구

---

## 4. 재구현 설계 (내가 만든다면)

### 권장 스택
| 레이어 | 권장 | 이유 |
|---|---|---|
| 웹 | Next.js + Supabase(Auth·DB) | 카카오 로그인·그룹/친구/예약 CRUD를 빠르게 |
| 데몬 | **C# .NET 8 (WinForms 트레이 앱)** | Win32 P/Invoke가 제일 쉬움, 원본과 같은 계열 |
| 카톡 조작 | **FlaUI(UI Automation)** 먼저 시도 → 안 되면 Win32 메시지/SendInput | 카톡 PC는 커스텀 컨트롤이 많아 둘 다 섞어야 할 가능성 높음 |
| 상태 판정 | Windows 내장 OCR(`Windows.Media.Ocr`, 한국어 팩) 또는 Tesseract | 원본은 Tesseract kor |
| 웹↔데몬 | `localhost` HTTP + CORS + Private Network Access 헤더 + 토큰 | 원본과 동일 구조, 검증된 방식 |

### MVP 순서
1. **데몬 뼈대**: 트레이 앱 + `HttpListener(http://localhost:46301/)` + `/status`
2. **카톡 창 제어 PoC**: 카톡 창 찾기 → 친구 검색 → 채팅방 열기 → 텍스트 1건 보내기 (내 계정, 나에게 보내기로 테스트)
3. **친구 목록 동기화**: 친구 탭 스크롤하며 이름 수집 → `/friends`
4. **일괄 발송**: 큐 + 속도 조절 + 실패 재시도 + 중단/이어보내기(ResumeData)
5. **웹 대시보드**: 로그인, 그룹(엑셀 업로드), 문구 작성(존댓말/반말, `{이름}` 치환), 발송 버튼 → localhost 호출
6. **예약 발송**: 서버에 예약 저장 → 데몬이 주기적으로 가져와 실행
7. 결제/체험판/업데이트는 마지막

---

## 5. 꼭 알아둘 리스크

- **카카오 운영정책**: 비공식 자동화로 대량 발송하면 카카오 계정 이용 제한 위험이 있습니다. 원본도 속도 조절(`speed_rate`, 나눠보내기)을 둔 이유가 이것으로 보입니다.
- **정보통신망법 제50조**: 광고성 메시지는 수신자의 사전 동의, `(광고)` 표기, 수신거부 방법 안내가 필요합니다. "단체문자 대신"이라도 법은 똑같이 적용됩니다.
- **카톡 UI 업데이트에 취약**: 카톡이 화면을 바꾸면 조작 로직이 깨집니다. 원본이 카톡 설치 파일(v25.7.7)을 직접 배포하고 데몬 버전을 강제 업데이트하는 이유입니다.
- **보안 관찰**: 원본 exe 안에 S3 접근용으로 보이는 인코딩된 키 문자열이 박혀 있습니다(값은 이 문서에 옮기지 않음). 직접 만들 때는 클라이언트에 클라우드 키를 넣지 말고 서버에서 presigned URL을 발급하세요.
- 원본 코드·리소스·`Abalone.dll`은 복사해서 쓰면 안 됩니다. 이 문서는 구조와 동작 방식만 참고용입니다.

---

## 6. 확인 못 한 것

- `/send` 실제 요청 바디 예시와 발송 화면(`/integrated_data/send`) 번들 — 아직 열지 않음
- 백엔드 API의 응답 스키마 전체
- `Abalone.dll`의 실제 카톡 조작 순서(암호화돼 있음) — 위 4번 흐름은 추정
- 실제 발송 동작(메시지를 보내면 실제로 나가므로 실행하지 않음)

## 근거 (REA Evidence ID)
- 웹 번들(로그인 후 step1): `ev_190dd210f782d64ff2b5689ced7a5235b579bcefeb25be41e8eba593dbfa282d`
- 웹 번들(로그인 전): `ev_f18b49d3be64cfd159bc1196b7d88966ce47ee7bb6c4edd24332f6ea089394e3`
- exe 메타데이터: `ev_8e7b063bcc930c42f02ef2a346011023e2875ceea0df6dd148af395b094c43fb`
- exe 클래스/문자열: `ev_766b91dec4d62bf13fdb3f36a2b8c3c5c8d059bf1e9e15e39aa54727fb410488`, `ev_da9d0a685baf338e8d9c23aa9f13ffc2923771392d618701cc19770fc2e9b645`
- exe 데이터 구조: `ev_9f8e513bfd488f314a9461d3a45ba172e3040921000f0073303fb1bac3420345`
- exe Win32 경계: `ev_febf65142f292e4e9c2f00265bde32c23cb114aa54d37a233a2763a442bb8de6`
- Abalone.dll Win32 경계: `ev_8cb178f40cb9346751f06becc45d0b1f6bb6500bfee861d6e48024bfd278158d`
