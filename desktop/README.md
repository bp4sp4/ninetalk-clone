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
- **데이터**: 사용자 데이터 폴더의 `data/` (맥 `~/Library/Application Support/한평생톡/data`, Windows `%APPDATA%\한평생톡\data`). 웹 개발용 `web/data` 와 따로입니다.
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
npm run dist:mac           # dist/HanpyeongsaengTok-<버전>-mac-arm64.dmg (안에 HanpyeongsaengTok.app). 서명 안 함
```

**맥 앱 이름**: 맥에서는 앱 파일·실행 파일 이름과 `CFBundleName` 이 한글이면 Electron 이 시작하자마자 죽습니다(2026-10-20 확인, 충돌 보고서상 Electron 시작 단계). 그래서 `dist:mac` 은 `-c.productName=HanpyeongsaengTok` 으로 영문 이름을 쓰고, Dock·메뉴에 보이는 이름만 `CFBundleDisplayName`=한평생톡 으로 둡니다(Finder 파일 이름은 `HanpyeongsaengTok.app`). 데이터 폴더는 Windows 와 같은 `한평생톡`.

화면 작업은 지금처럼 `../web` 에서 `npm run dev` + `npm run mock-daemon` 으로 브라우저에서 하는 게 빠릅니다.
맥에서는 처음 실행할 때 **손쉬운 사용 권한**을 묻습니다(시스템 설정 > 개인정보 보호 및 보안 > 손쉬운 사용). 허용 전에는 사이드바가 "손쉬운 사용 권한 필요". 서명 안 한 앱이라 다시 빌드하면 권한을 다시 줘야 할 수 있습니다. 자세한 것은 [`../daemon-mac/README.md`](../daemon-mac/README.md).

## Windows 설치 파일 만들기 (Windows PC에서)

필요한 것: Node.js 22.13 이상, .NET 8 SDK.

```bash
npm install
npm run dist:win      # build:web + build:daemon + electron-builder --win → dist/HanpyeongsaengTok-0.1.0-win-x64.exe
```

- `build:daemon` 은 `dotnet publish -c Release -r win-x64 --self-contained true` 로 `build/daemon` 에 게시합니다(사용자 PC에 .NET 런타임 설치 불필요).
- **웹 빌드는 반드시 Windows에서 다시** 하세요. standalone 결과에 플랫폼별 바이너리(`sharp` 등)가 들어가서, 맥에서 만든 `build/web` 은 Windows에서 쓸 수 없습니다. `dist:win` 은 매번 새로 빌드합니다.
- 서명하지 않은 설치 파일이라 Windows SmartScreen 경고가 뜹니다.

## GitHub Actions로 빌드·릴리즈 (`.github/workflows/desktop-release.yml`)

GitHub 빌드 서버에서 맥(Apple Silicon `.dmg`)과 Windows(`.exe` 설치 파일)를 함께 만듭니다. Windows PC가 없어도 Windows 설치 파일이 나옵니다(실제 동작 확인은 Windows PC에서).

- **시험 빌드**: GitHub > Actions > desktop-release > Run workflow. 설치 파일은 그 실행의 Artifacts(14일 보관)에만 남고 릴리즈는 안 만듭니다.
- **릴리즈**: `desktop/package.json` 의 `version` 을 올리고(윈도 데몬 `daemon/NineTalkDaemon/NineTalkDaemon.csproj` 의 `<Version>`, 맥 데몬 `daemon-mac/server.mjs` 의 `VERSION` 도 같이) 커밋한 뒤 같은 번호로 태그를 push 합니다. 두 설치 파일이 시험판(pre-release)으로 올라갑니다. 태그와 `version` 이 다르면 빌드가 멈춥니다.
  ```bash
  git tag v0.1.1 && git push origin v0.1.1
  ```
- 비공개 저장소라 Actions 사용 시간이 무료 한도(월 2,000분)에서 빠집니다. 맥은 10배, Windows는 2배로 계산되어 한 번에 대략 70~100분 정도입니다.
- 지금은 서명 없이 빌드합니다. 서명하려면 저장소 Secrets에 `CSC_LINK`·`CSC_KEY_PASSWORD`(인증서), 맥 공증용 `APPLE_ID`·`APPLE_APP_SPECIFIC_PASSWORD`·`APPLE_TEAM_ID` 를 넣고, 워크플로의 `CSC_IDENTITY_AUTO_DISCOVERY: "false"` 를 빼면 됩니다(Apple 개발자 등록 연 $99, Windows 코드 서명 인증서 별도).

## 파일

| 파일 | 내용 |
|---|---|
| `main.js` | 서버·데몬 시작, 창, 단일 인스턴스, 종료 시 자식 정리 |
| `scripts/build-web.mjs` | `../web` 빌드 → `build/web` 복사. `.env*`·`data` 는 지워서 카카오 키·개인 데이터가 앱에 들어가지 않게 함 |
| `scripts/build-daemon.mjs` | 데몬 게시 → `build/daemon` (Windows 전용) |
| `scripts/build-daemon-mac.mjs` | 맥용 PC 프로그램 빌드 → `build/daemon-mac` (맥 전용) |
| `scripts/after-pack.cjs` | 패키징 직후 `build/web`(·Windows `build/daemon`·맥 `build/daemon-mac`)을 앱 resources 로 복사. electron-builder 의 `extraResources` 는 `node_modules` 폴더를 빼 버려서 이렇게 함 |
