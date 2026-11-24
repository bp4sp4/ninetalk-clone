# PC 프로그램(데몬) 로컬 API 규격

웹 대시보드(`web/`)가 브라우저에서 직접 호출하는 API입니다. PC 프로그램은 이 규격대로 `http://localhost:47301/` 에서 HTTP 서버를 열면 됩니다.
(설치된 나인톡이 46301을 쓰므로 충돌을 피하려고 47301로 정했습니다. 웹 쪽은 `NEXT_PUBLIC_DAEMON_URL`로 바꿀 수 있습니다.)

개발 중에는 `npm run mock-daemon` (web 폴더)으로 가짜 데몬을 띄워 웹을 테스트할 수 있습니다.

## 공통

- 응답은 모두 `application/json; charset=utf-8`
- **CORS**: `Access-Control-Allow-Origin` 은 `*` 대신 웹 대시보드 주소만 허용하세요 (기본값: 웹 개발 서버 `http://localhost:3000`, 데스크톱 앱 `http://127.0.0.1:47300`).
  아무 사이트에서나 내 PC 카카오톡을 조작하지 못하게 막는 가장 중요한 장치입니다.
- `OPTIONS` 프리플라이트에 `Access-Control-Allow-Methods: GET, POST, OPTIONS`, `Access-Control-Allow-Headers: Content-Type` 응답
- 웹을 공개 도메인(https)에 배포하면 크롬의 Private Network Access 때문에 프리플라이트에 `Access-Control-Allow-Private-Network: true` 도 넣어야 합니다.

## GET /status

```json
{ "status": "Ready", "version": "0.1.0", "current_sync_cnt": 0, "last_error": null }
```

- `last_error` (선택, `string | null`): 마지막 친구 동기화가 오류로 끝났을 때의 사유. 동기화가 실패해도 `status` 는 `Ready` 로 돌아오므로, 웹은 동기화 후 이 값이 있으면 오류로 알립니다. 새 동기화를 시작하면 `null` 로 초기화되고, 읽는 중(`GetKaoFriends`)에는 항상 `null` 입니다. 중단(`Stop`)은 오류가 아닙니다.

| status | 의미 |
|---|---|
| `Ready` | 카카오톡 로그인됨, 작업 없음 |
| `GetKaoFriends` | 친구 목록 읽는 중 (`current_sync_cnt` = 지금까지 읽은 수) |
| `SendMessage` | 발송 중 |
| `NotRunning` | PC 카카오톡이 실행되지 않음 |
| `LoggedOut` | PC 카카오톡 로그아웃 상태 |
| `Locked` | PC 카카오톡 잠금 모드 |
| `NoAccessibility` | (맥) PC 프로그램에 손쉬운 사용 권한이 없음 |
| `DaemonBroken` | (맥) PC 프로그램의 카카오톡 조작 도구(`kakao-mac`)가 없거나 실행할 수 없음 |
| `ShuttingDown` | PC 프로그램이 종료하는 중. 새 작업은 409 `{ "status": "ShuttingDown" }` |

- `images` (선택, `bool`): 이 PC 프로그램이 이미지 발송을 지원하면 `true`(맥, Windows 둘 다. Windows 는 PNG·JPG·GIF·BMP 만, WebP·HEIC 는 `400 unsupported image type`). 웹은 이 값이 `true` 일 때만 이미지가 있는 요청의 발송 버튼을 엽니다. 지원하지 않는 PC 프로그램은 이미지가 있는 `/send` 를 `400 images_not_supported` 로 거절합니다.
- `files` (선택, `bool`): 이미지가 아닌 파일(PDF·한글·엑셀·zip 등) 발송을 지원하면 `true`(Windows 0.1.6 부터, 맥은 아직). 웹은 파일이 있는 요청은 이 값이 `true` 일 때만 보냅니다. 지원하지 않는 PC 프로그램은 `400 files_not_supported`.

## POST /friends/synchronize

PC 카카오톡 친구 탭에서 친구 이름을 읽기 시작합니다. 바로 응답하고, 실제 작업은 백그라운드에서 진행합니다.

```json
{ "mode": "Start-all" }                      // 친구 전체
{ "mode": "Start-search", "option": "김" }   // 친구 검색창에 키워드를 넣고 나온 결과만
{ "mode": "Stop" }                           // 진행 중인 작업 중단
```

- 응답: `202 { "ok": true }`
- 카카오톡이 준비되지 않았으면 `409 { "ok": false, "status": "NotRunning" }`
- 시작하면 `/status` 가 `GetKaoFriends` 가 되고, 끝나거나 중단되면 `Ready` 로 돌아옵니다.

## GET /friends

마지막 동기화 결과입니다.

```json
{
  "friend_list": [{ "name": "홍길동", "ocr_uncertain": false }, { "name": "김철수", "ocr_uncertain": true }],
  "duplicate_friend_list": ["홍길동"],
  "kakao_friend_count": 428,
  "unreadable_count": 23
}
```

- `friend_list`: 친구 탭에 보이는 이름 그대로 (내 프로필, 즐겨찾기 헤더, 생일 섹션 등은 제외)
- `duplicate_friend_list`: 같은 표시 이름이 2명 이상인 이름. 이름 검색으로 채팅방을 열면 엉뚱한 사람에게 갈 수 있어서 웹에서 경고를 보여줍니다.

선택 필드 (화면 OCR로 이름을 읽는 데몬이 판독 품질을 알려 주려고 넣습니다. 없으면 웹은 표시만 생략합니다):

- `friend_list[].ocr_uncertain` (`bool`): OCR 배율별 판독이 서로 달라 이름이 틀렸을 수 있음. 웹은 "확인 필요"로 표시하고 기본 선택하지 않습니다.
- `kakao_friend_count` (`number | null`): 카카오톡 친구 탭 헤더의 "친구 N" 숫자. 헤더를 못 읽었거나 동기화가 중단·실패해 끝까지 읽지 못했으면 `null`. `Start-search` 에서도 걸러지기 전 전체 친구 수입니다.
- `unreadable_count` (`number`): 친구 행은 찾았지만 이름을 못 읽어 `friend_list` 에서 빠진 행 수(전체 기준). 끝까지 읽지 못했으면 `0`.

## 발송

웹 브라우저가 중간에서 이어 줍니다. 웹 서버에서 발송 요청을 읽어 데몬에 `POST /send` 로 넘기고, `/send/result` 를 폴링해서 결과를 다시 웹 서버에 기록합니다.
그래서 데몬은 웹 서버 주소나 로그인 토큰을 몰라도 됩니다. 대신 **발송하는 동안 발송 내역 화면을 열어 두어야** 합니다. 예약 발송은 나중에 정합니다.

### POST /send

```json
{
  "job_id": 12,
  "recipients": [
    { "id": 301, "name": "홍길동", "text": "홍길동님 안녕하세요! ..." },
    { "id": 302, "name": "김철수", "text": "철수야 잘 지내? ..." }
  ],
  "images": [{ "name": "poster.jpg", "mime": "image/jpeg", "data_base64": "..." }],
  "files": [{ "name": "안내문.pdf", "mime": "application/pdf", "data_base64": "..." }],
  "image_first": false,
  "interval_ms": 800,
  "split_send_count": 50,
  "send_mode": "restart",
  "speed_rate": 3
}
```

- `id` 는 웹의 수신자 행 id 입니다. 결과를 돌려줄 때 그대로 씁니다.
- `text` 는 웹에서 이미 이름·말투가 반영된 최종 문구입니다. 비어 있으면 이미지만 보냅니다.
- `images` 는 0~5장, 수신자마다 같은 이미지를 보냅니다. `image_first` 가 `true` 면 이미지(와 파일)를 먼저 보냅니다.
- `files` 는 이미지가 아닌 첨부 파일, 이미지 다음에 보냅니다. `name` 이 받는 사람에게 보이는 파일 이름입니다. 이미지와 합쳐 5개, 파일마다 20MB 까지(웹은 합쳐서 25MB). 실행 파일(.exe 등)·폴더가 든 이름은 `400 file name not allowed`, 너무 크거나 빈 파일은 `400 file too large or empty`, 5개 초과는 `400 at most 5 attachments`.
- 파일은 카카오톡이 전송 창 없이 바로 보낼 수도 있어, 창이 뜨지 않았는데 보냈는지 알 수 없으면 `unknown_result` 로 돌려줍니다(다시 보내지 않게).
- 발송 속도 (웹 작성 화면의 느리게 / 보통 / 빠르게 / 사용자화):

  | 설정 | `interval_ms` | `split_send_count` | `send_mode` |
  |---|---|---|---|
  | 느리게 | 1200 | 30 | `restart` |
  | 보통 (추천) | 800 | 50 | `restart` |
  | 빠르게 | 400 | 100 | `restart` |
  | 사용자화 | 200~2000 (100 단위) | 1~999 | `restart` 또는 `normal` |

- `interval_ms`: 한 명 보내고 다음 사람까지 쉬는 시간(ms). 한 명 보내는 동작 자체(검색·채팅방 열기·전송·닫기)에 걸리는 몇 초는 따로입니다.
- `send_mode`: `restart`(재시작 발송)면 `split_send_count` 명마다 PC 카카오톡을 껐다 켭니다(카카오톡 자동 로그인 필요). 다시 로그인 상태가 되지 않으면 작업은 `failed` 로 끝나고 남은 사람은 보내지 않습니다. `normal`(일반 발송)이면 재시작 없이 계속 보냅니다.
- `split_send_count` (`number | null`): 재시작 주기(명). `normal` 에서는 쓰지 않습니다.
- `speed_rate` 1~5: 예전 형식. `interval_ms` 를 모르는 데몬을 위해 같이 보냅니다(1=2000, 2=1200, 3=800, 4=400, 5=200ms에 해당). 데몬은 `interval_ms` 가 있으면 그것을 씁니다.
- 맥 PC 프로그램은 아직 카카오톡 재시작을 하지 않습니다(`restart` 여도 재시작 없이 계속).
- 응답: `202 { "ok": true }`. 다른 작업 중이거나 카카오톡이 준비되지 않았으면 `409 { "ok": false, "status": "<현재 status>" }`.
- 시작하면 `/status` 가 `SendMessage` 가 되고, `current_sent_order`(지금까지 처리한 수)를 넣어 줍니다. 끝나거나 중단되면 `Ready`.

**한 명 보낼 때 반드시 지킬 것**

1. 친구 검색으로 채팅방을 연 뒤, **채팅방 제목이 `name` 과 정확히 같은지 확인**하고 다를 때는 보내지 말고 `failed` (`room_mismatch`) 처리합니다.
2. 검색 결과가 0명이면 `failed` (`not_found`), 2명 이상이면 `failed` (`duplicate_name`) 처리하고 보내지 않습니다.
3. 입력창에 넣은 뒤 전송하고, 연 채팅방은 닫습니다.

### GET /send/result

```json
{
  "job_id": 12,
  "state": "running",
  "results": [
    { "id": 301, "status": "sent" },
    { "id": 302, "status": "failed", "error": "duplicate_name" }
  ]
}
```

- `state`: `running` | `done` | `stopped` | `failed`(작업 전체가 중단된 오류, 예: 카카오톡 꺼짐) 
- `results`: 지금까지 처리한 수신자만, 처리한 순서대로. 아직 안 한 사람은 없습니다.
- `error` 코드: `not_found`, `duplicate_name`, `room_mismatch`, `send_failed`, `kakao_not_ready`, `input_not_empty`(채팅방 입력창에 쓰던 글이 있어 손대지 않음), `partial_sent`(문구·이미지 중 일부만 나감 — 다시 보내면 중복되니 채팅방에서 확인), `unknown_result`(보냈는지 알 수 없음 — 조작 도중 끊김, 닫히지 않은 카카오톡 창 등. 채팅방에서 확인), `dry_run`(시험 실행이라 안 보냄, 맥 `NINETALK_MAC_DRY_RUN=1`)
- 마지막 작업 결과는 다음 `POST /send` 전까지 남아 있어야 합니다(웹 탭을 새로 고쳐도 결과를 받을 수 있게).

### POST /send/stop

`202 { "ok": true }`. 지금 보내던 한 명까지만 마치고 멈춥니다. `state` 는 `stopped`.

## 데스크톱 앱이 쓰는 것

### POST /shutdown

`202 { "ok": true }` 후 데몬이 정상 종료합니다(친구 읽기·발송 중단, 카카오톡 창 복원, 트레이 아이콘 제거). `Content-Type: application/json` 만 받습니다(415). 데스크톱 앱(`desktop/main.js`)이 종료할 때 부르고, 3초 안에 안 끝나면 프로세스를 강제 종료합니다.

### 실행 인자 `--parent-pid <pid>`

데스크톱 앱이 데몬을 띄울 때 자기 PID를 넘깁니다. 데몬은 2초마다 그 프로세스가 살아 있는지 보고, 없으면(앱 비정상 종료) 스스로 정상 종료합니다.

### 데몬이 이미 떠 있을 때

앱은 시작할 때 `GET /status` 로 47301을 확인합니다. 응답에 `status` 가 있으면 이미 떠 있는 데몬을 그대로 쓰고(앱을 꺼도 그 데몬은 안 끔), 연결 거부면 새로 띄우고, 다른 프로그램이 응답하면 안내 창을 띄웁니다.
