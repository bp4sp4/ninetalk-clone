# PC 프로그램(데몬) 로컬 API 규격

웹 대시보드(`web/`)가 브라우저에서 직접 호출하는 API입니다. PC 프로그램은 이 규격대로 `http://localhost:47301/` 에서 HTTP 서버를 열면 됩니다.
(설치된 나인톡이 46301을 쓰므로 충돌을 피하려고 47301로 정했습니다. 웹 쪽은 `NEXT_PUBLIC_DAEMON_URL`로 바꿀 수 있습니다.)

개발 중에는 `npm run mock-daemon` (web 폴더)으로 가짜 데몬을 띄워 웹을 테스트할 수 있습니다.

## 공통

- 응답은 모두 `application/json; charset=utf-8`
- **CORS**: `Access-Control-Allow-Origin` 은 `*` 대신 웹 대시보드 주소만 허용하세요 (예: `http://localhost:3000`, 배포 주소).
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
  "image_first": false,
  "speed_rate": 3,
  "split_send_count": 50
}
```

- `id` 는 웹의 수신자 행 id 입니다. 결과를 돌려줄 때 그대로 씁니다.
- `text` 는 웹에서 이미 이름·말투가 반영된 최종 문구입니다. 비어 있으면 이미지만 보냅니다.
- `images` 는 0~5장, 수신자마다 같은 이미지를 보냅니다. `image_first` 가 `true` 면 이미지를 먼저 보냅니다.
- `speed_rate` 1(아주 느리게) ~ 5(아주 빠르게): 한 명 보내고 다음 사람까지 쉬는 간격. 값별 실제 간격은 데몬이 정하고, 빠르게라도 사람이 보내는 속도보다 빠르지 않게 하세요.
- `split_send_count` (`number | null`): N명마다 더 길게 쉽니다(데몬이 정한 휴식 시간).
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
- `error` 코드: `not_found`, `duplicate_name`, `room_mismatch`, `send_failed`, `kakao_not_ready`
- 마지막 작업 결과는 다음 `POST /send` 전까지 남아 있어야 합니다(웹 탭을 새로 고쳐도 결과를 받을 수 있게).

### POST /send/stop

`202 { "ok": true }`. 지금 보내던 한 명까지만 마치고 멈춥니다. `state` 는 `stopped`.
