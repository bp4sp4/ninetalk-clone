# 단체톡 관리 — 데스크톱 앱 (Electron)

웹 대시보드(`../web`)와 PC 프로그램(`../daemon`)을 한 앱으로 묶습니다. Vercel 배포 대신 이 앱을 씁니다.

```
일렉트론 메인 프로세스 (main.js)
├─ Next standalone 서버  (utilityProcess, http://127.0.0.1:47300, 로그인 없는 로컬 모드)
├─ PC 프로그램 (http://localhost:47301)
│    ├─ Windows: NineTalkDaemon.exe (../daemon, 자식 프로세스)
│    ├─ 맥: ../daemon-mac (server.mjs + kakao-mac, utilityProcess) — 손쉬운 사용 API로 맥 카카오톡 조작
│    └─ NINETALK_MOCK_DAEMON=1 이면 가짜 데몬(../web/scripts/mock-daemon.mjs)
└─ 창: http://127.0.0.1:47300/dashboard
```

- **로그인 없음**: 내 PC에서 혼자 쓰는 앱이라 카카오 로그인을 뺐습니다. 웹 서버를 `NINETALK_LOCAL_MODE=1` 로 띄우면 모든 데이터가 로컬 사용자 1명 것이 됩니다(`../web/README.md`). 웹 단독 실행(`npm run dev`)의 카카오 로그인은 그대로 있습니다.
- **데이터**: 사용자 데이터 폴더의 `data/` (맥 `~/Library/Application Support/NineTalkClone/data`, Windows `%APPDATA%\NineTalkClone\data`). 웹 개발용 `web/data` 와 따로입니다.
- **포트**: 앱 47300(고정, 127.0.0.1에만 열림), 데몬 47301. 47300을 다른 프로그램이 쓰면 오류 창을 띄우고 종료합니다. 앱은 하나만 실행됩니다(두 번째 실행은 기존 창을 앞으로).
- **데몬**: 시작할 때 `GET http://localhost:47301/status` 로 확인합니다. 이미 떠 있으면(손으로 `dotnet run` 한 데몬, mock-daemon) 새로 띄우지 않고 그대로 씁니다(그 데몬의 기본 허용 Origin에 `http://127.0.0.1:47300` 이 들어 있음). 다른 프로그램이 47301을 쓰면 안내 창을 띄우고 데몬 없이 계속합니다.
- **종료**: 앱이 띄운 데몬은 앱을 끌 때 `POST /shutdown` 으로 정상 종료시키고(트레이 아이콘 제거, 카카오톡 창 복원), 3초 안에 안 꺼지면 강제 종료합니다. 앱이 비정상 종료되면 데몬이 `--parent-pid` 로 알아채고 스스로 꺼집니다.
- 창 안에서는 대시보드 주소만 열리고, 다른 링크는 기본 브라우저로 엽니다.

## 맥에서 개발

```bash
npm install
npm run build:web          # ../web 을 next build → build/web 으로 복사 (웹 코드를 바꿀 때마다)
npm run build:daemon-mac   # ../daemon-mac → build/daemon-mac (swiftc 필요)
npm start                  # 앱 실행 + 맥용 PC 프로그램 → 실제 카카오톡으로 보낼 수 있음
NINETALK_MAC_DRY_RUN=1 npm start   # 발송이 전부 dry-run (채팅방에 넣었다 지우고 닫음, 안 보냄)
NINETALK_MOCK_DAEMON=1 npm start   # 카카오톡 대신 가짜 데몬
npm run dist:mac           # (선택) dist/mac-arm64/NineTalkClone.app 로 패키징. 서명 안 함
```

화면 작업은 지금처럼 `../web` 에서 `npm run dev` + `npm run mock-daemon` 으로 브라우저에서 하는 게 빠릅니다.
맥에서는 처음 실행할 때 **손쉬운 사용 권한**을 묻습니다(시스템 설정 > 개인정보 보호 및 보안 > 손쉬운 사용). 허용 전에는 사이드바가 "손쉬운 사용 권한 필요". 서명 안 한 앱이라 다시 빌드하면 권한을 다시 줘야 할 수 있습니다. 자세한 것은 [`../daemon-mac/README.md`](../daemon-mac/README.md).

## Windows 설치 파일 만들기 (Windows PC에서)

필요한 것: Node.js 22.13 이상, .NET 8 SDK.

```bash
npm install
npm run dist:win      # build:web + build:daemon + electron-builder --win → dist/NineTalkClone Setup 0.1.0.exe
```

- `build:daemon` 은 `dotnet publish -c Release -r win-x64 --self-contained true` 로 `build/daemon` 에 게시합니다(사용자 PC에 .NET 런타임 설치 불필요).
- **웹 빌드는 반드시 Windows에서 다시** 하세요. standalone 결과에 플랫폼별 바이너리(`sharp` 등)가 들어가서, 맥에서 만든 `build/web` 은 Windows에서 쓸 수 없습니다. `dist:win` 은 매번 새로 빌드합니다.
- 서명하지 않은 설치 파일이라 Windows SmartScreen 경고가 뜹니다.

## 파일

| 파일 | 내용 |
|---|---|
| `main.js` | 서버·데몬 시작, 창, 단일 인스턴스, 종료 시 자식 정리 |
| `scripts/build-web.mjs` | `../web` 빌드 → `build/web` 복사. `.env*`·`data` 는 지워서 카카오 키·개인 데이터가 앱에 들어가지 않게 함 |
| `scripts/build-daemon.mjs` | 데몬 게시 → `build/daemon` (Windows 전용) |
| `scripts/build-daemon-mac.mjs` | 맥용 PC 프로그램 빌드 → `build/daemon-mac` (맥 전용) |
| `scripts/after-pack.cjs` | 패키징 직후 `build/web`(·Windows `build/daemon`·맥 `build/daemon-mac`)을 앱 resources 로 복사. electron-builder 의 `extraResources` 는 `node_modules` 폴더를 빼 버려서 이렇게 함 |
