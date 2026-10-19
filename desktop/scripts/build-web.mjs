// Builds ../web as a Next standalone server and copies it to build/web (what main.js runs).
import { execSync } from "node:child_process";
import { cpSync, existsSync, readdirSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const desktop = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const web = path.join(desktop, "..", "web");
const out = path.join(desktop, "build", "web");

execSync("npm run build", { cwd: web, stdio: "inherit" });

const standalone = path.join(web, ".next", "standalone");
if (!existsSync(path.join(standalone, "server.js"))) throw new Error(`no standalone build in ${standalone}`);

rmSync(out, { recursive: true, force: true });
// dereference: a symlink or Windows junction would keep pointing at this build PC's paths after install.
cpSync(standalone, out, { recursive: true, dereference: true });
cpSync(path.join(web, ".next", "static"), path.join(out, ".next", "static"), { recursive: true });
cpSync(path.join(web, "public"), path.join(out, "public"), { recursive: true });

// Never ship secrets or personal data: .env files (Kakao keys) and a dev database must not end up in the app.
for (const name of readdirSync(out)) {
  if (name.startsWith(".env") || name === "data") {
    rmSync(path.join(out, name), { recursive: true, force: true });
    console.log(`removed ${name} from the app build`);
  }
}
console.log(`web build copied to ${out}`);
