// Publishes the Windows PC program (../daemon) to build/daemon. Windows only (needs the .NET 8 SDK).
// Self-contained, so users do not have to install the .NET runtime.
import { execSync } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const desktop = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const project = path.join(desktop, "..", "daemon", "NineTalkDaemon");
const out = path.join(desktop, "build", "daemon");

if (process.platform !== "win32") {
  console.error("PC 프로그램(daemon)은 Windows에서만 빌드합니다. 맥에서는 build:web 과 npm start(가짜 데몬)를 쓰세요.");
  process.exit(1);
}

rmSync(out, { recursive: true, force: true });
execSync(`dotnet publish -c Release -r win-x64 --self-contained true -o "${out}"`, { cwd: project, stdio: "inherit" });
if (!existsSync(path.join(out, "NineTalkDaemon.exe"))) throw new Error(`NineTalkDaemon.exe not found in ${out}`);
console.log(`PC program published to ${out}`);
