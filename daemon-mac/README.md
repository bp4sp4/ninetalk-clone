# NineTalk 맥용 PC 프로그램 (daemon-mac)

윈도 데몬(`../daemon`)과 **같은 로컬 HTTP API**(`../DAEMON_API.md`, `http://localhost:47301`)를 맥에서 엽니다. 웹·데스크톱 앱은 그대로 씁니다.
맥 카카오톡을 **손쉬운 사용(Accessibility) API**로 조작합니다. 화면 캡처나 OCR은 쓰지 않습니다.

| 파일 | 내용 |
|---|---|
| `KakaoMac/main.swift` | `kakao-mac` 바이너리. `status` / `friends` / `send <이름> <문구> [--send]`. 한 번 실행에 한 작업, JSON 한 줄 출력 |
| `server.mjs` | HTTP 서버(Node). 친구 동기화, 발송 순서·간격·중단, `/shutdown`. 카카오톡 조작은 매번 `kakao-mac` 실행 |

## 실행

```bash
swiftc -O KakaoMac/main.swift -o build/kakao-mac     # Xcode 명령행 도구 필요
NINETALK_MAC_DRY_RUN=1 node server.mjs               # dry-run: 채팅방을 열고 문구를 넣었다 지우고 닫음, 보내지 않음
node server.mjs                                      # 실제 발송
```

- 데스크톱 앱(`../desktop`)은 맥에서 이걸 자동으로 띄웁니다(`npm run build:daemon-mac` → `desktop/build/daemon-mac`). 개발 중 가짜 데몬을 쓰려면 `NINETALK_MOCK_DAEMON=1 npm start`.
- **손쉬운 사용 권한**: 시스템 설정 > 개인정보 보호 및 보안 > 손쉬운 사용에서 실행하는 앱을 허용해야 합니다. 터미널에서 돌리면 터미널, 데스크톱 앱이면 NineTalkClone(개발 실행이면 Electron). 권한이 없으면 `/status` 가 `NoAccessibility`.
- 테스트용 다른 포트: `NINETALK_MAC_PORT=47391` (대시보드는 항상 47301을 부르므로 테스트용).
- 마지막 발송 작업은 `NINETALK_MAC_STATE_DIR/last-send.json`(기본 `~/Library/Application Support/NineTalkMacDaemon`, 데스크톱 앱은 앱 데이터 폴더의 `daemon-mac`)에 결과마다 저장됩니다. 도중에 꺼져도 다시 켜면 `/send/result` 가 그 결과를 돌려줘서, 발송 내역 화면이 이미 받은 사람을 기록합니다(두 번 보내지 않게).
- `kakao-mac` 이 없으면 `/status` 가 `DaemonBroken`(웹: "PC 프로그램 설치 문제").
- 단독 확인: `./build/kakao-mac friends`, `./build/kakao-mac send "이름" "문구"` (dry-run). **`--send` 를 붙이면 진짜로 나갑니다.**

## 맥 카카오톡에서 알아낸 것 (26.8.0, 2026-10-19)

- 메인 창 `AXIdentifier = "Main Window"`, 탭 버튼 `friends` / `chatrooms` / `more`(누르기 동작 됨). 메인 창을 닫으면 메뉴 막대로 들어가고 창이 없어집니다 → `open -b com.kakao.KakaoTalkMac` 으로 다시 엶.
- 친구 탭은 `AXOutline`. 친구 행마다 `AXIdentifier = "Display Name"` 인 글자 칸에 이름이 **글자 그대로** 있고, 화면 밖 행까지 전부 노출됩니다(450행). 구간 제목 행: 내 기본프로필 / 업데이트한 친구 / 생일인 친구 / 즐겨찾는 친구 / 채널 / **친구 428**. "친구" 구간만 친구로 셉니다.
- 친구 행을 선택(`AXSelectedRows`)하고 목록에 포커스를 준 뒤 Return 키 → 채팅창이 새 창으로 열리고 창 제목이 이름과 정확히 같습니다.
- 채팅창: 메시지 목록 `AXTable`(메시지 글자도 읽힘), 입력창 `AXTextArea`, "전송" 버튼(입력창이 비면 비활성, 글을 넣으면 활성), 닫기 버튼.

## 한 명 보내는 순서 (`kakao-mac send`)

1. 메인 창이 닫혀 있으면 엶. 원래 탭·창 상태·앞에 있던 앱을 기억.
2. 친구 탭 "친구" 구간에서 이름이 **정확히 같은** 행을 셈(유니코드 정규화 후 비교). 0명 `not_found`, 2명 이상 `duplicate_name`.
   윈도의 검색(부분 일치)과 달리 정확히 같은 이름만 찾으므로 "김준"을 찾을 때 "김준수"가 걸리지 않습니다.
3. 그 친구 채팅창이 이미 열려 있으면 그걸 씀(끝나도 닫지 않음). 아니면 카카오톡을 앞으로 가져와 행 선택 + Return → 새로 생긴 창의 제목이 이름과 다르면 `room_mismatch`(입력 안 하고 닫음).
4. **입력창에 쓰던 글이 있으면 아무것도 안 하고 `input_not_empty`**(남이 쓰던 글을 덮어쓰거나 같이 보내지 않음).
5. 문구를 입력창에 넣음(`AXSelectedText`, 안 되면 `AXValue`) → 전송 버튼이 켜지는지 확인 → "전송" 누름.
6. 입력창이 비면 `sent`. 마지막 메시지 3개에 문구가 있으면 `confirmed: true`. 5초 안에 안 비면 문구를 지우고 `send_failed`.
7. 연 채팅창을 닫고 탭·창·앞에 있던 앱을 되돌림.

간격: `interval_ms`(200~2000ms, 웹의 느리게 1200 / 보통 800 / 빠르게 400 / 사용자화) 만큼 한 명마다 쉽니다. `interval_ms` 가 없는 예전 요청은 `speed_rate` 1~5 → 2000/1200/800/400/200ms.
카카오톡 재시작(`send_mode: "restart"`)은 윈도에만 있습니다. 맥에서는 로그만 남기고 재시작 없이 계속 보냅니다(맥에서는 확인하지 않은 변경).

`server.mjs` 쪽 안전장치:
- 카카오톡 조작(상태 확인 포함)은 한 번에 하나씩만(`kakao-mac` 을 줄 세워 실행). 발송·친구 읽기가 동시에 시작되지 않음.
- 같은 원인으로 3번 연속 실패하면 작업을 멈춤(못 찾음·동명이인·쓰던 글 있음은 사람마다 다른 사정이라 제외). `kakao-mac` 이 시간 초과·비정상 종료하면 카카오톡 상태를 알 수 없으므로 바로 멈춤.
- `/send/stop`·`/shutdown`: 쉬는 중이면 바로, 보내는 중이면 그 사람 결과를 기록한 뒤 멈춤. 종료 중에는 새 작업을 받지 않음.
- 오류 기록에 받는 사람 이름·문구를 넣지 않음.
- dry-run 결과는 `failed`/`dry_run` 으로 돌려줘서 "보냄"으로 기록되지 않음. `/status` 의 버전에 "(dry-run: 실제로 안 보냄)" 표시.

## 실제 확인 결과 (사용자 맥, 2026-10-19)

| 항목 | 결과 |
|---|---|
| 친구 읽기 | ⭕ 428 / 428명, 못 읽은 행 0, 2.7초 (윈도 OCR: 405명 중 109명 확인 필요, 48초) |
| dry-run (테스트 친구 ㅂㅅ진) | ⭕ 채팅방 열기·제목 확인·입력·전송 버튼 활성·지우기·닫기·복원 |
| **실제 1건 전송** | ⭕ `sent`, `confirmed: true`. 사용자가 채팅방에서 1건 도착 확인 |
| HTTP dry-run (`/send`, 2명) | ⭕ ㅂㅅ진 성공, 없는 이름 `not_found` |
| 리뷰 반영 후 dry-run | ⚠️ 끝까지 못 함. 1회 `focus_failed`(다른 채팅창에 사용자가 쓰던 글이 있던 때 — 안전하게 멈춤), 2회 `input_not_empty`(ㅂㅅ진 입력창에 글이 남아 있었음 — 안전하게 멈춤). 카카오톡이 빈 상태에서 다시 확인 필요 |
| `server.mjs` (가짜 `kakao-mac`) | ⭕ 동시 시작 거절, 연속 실패 중단, 즉시 멈춤, 종료, 재시작 후 결과 복구, 잘못된 JSON 400 |

## 한계·주의

- 보내는 동안 카카오톡이 **앞으로 나옵니다**(Return 키를 받으려면 활성 창이어야 함). 한 명 보낼 때마다 원래 앞에 있던 앱으로 돌려놓습니다. 보내는 중에는 키보드·마우스를 쓰지 않는 게 안전합니다.
- 이미지 발송 미구현(`images` 가 있으면 400 `images_not_supported`, 윈도와 같음).
- 카카오톡 잠금 모드·로그아웃 화면은 확인하지 않았습니다(메인 창에 친구 탭 버튼이 없으면 `LoggedOut`).
- 여러 명 연속 실제 발송은 아직 해 보지 않았습니다.
- 카카오톡 업데이트로 `Display Name`, 탭 ID, "전송" 버튼 이름이 바뀌면 동작하지 않습니다.
