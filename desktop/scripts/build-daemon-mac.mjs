// Builds the Mac PC program (../daemon-mac) into build/daemon-mac: the kakao-mac binary (Swift,
// Accessibility API) and server.mjs (the local HTTP API, run by main.js in a utility process).
// Mac only; needs the Xcode command line tools (swiftc).
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const desktop = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const source = path.join(desktop, "..", "daemon-mac");
const out = path.join(desktop, "build", "daemon-mac");

if (process.platform !== "darwin") {
  console.error("맥용 PC 프로그램(daemon-mac)은 맥에서만 빌드합니다.");
  process.exit(1);
}

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
execFileSync("swiftc", ["-O", path.join(source, "KakaoMac", "main.swift"), "-o", path.join(out, "kakao-mac")], { stdio: "inherit" });
copyFileSync(path.join(source, "server.mjs"), path.join(out, "server.mjs"));
console.log(`Mac PC program built to ${out}`);
