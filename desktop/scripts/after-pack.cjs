// electron-builder afterPack hook: copies build/web (and build/daemon on Windows, build/daemon-mac on Mac) into the app's
// resources folder. Done here instead of "extraResources" because that option always drops
// node_modules folders, and the Next standalone server needs its node_modules.
const fs = require("node:fs");
const path = require("node:path");

exports.default = async function afterPack(context) {
  const { appOutDir, electronPlatformName, packager } = context;
  const resources =
    electronPlatformName === "darwin"
      ? path.join(appOutDir, `${packager.appInfo.productFilename}.app`, "Contents", "Resources")
      : path.join(appOutDir, "resources");
  const build = path.join(__dirname, "..", "build");

  const copy = (name) => {
    const from = path.join(build, name);
    if (!fs.existsSync(from)) throw new Error(`${from} 가 없습니다. npm run build:${name} 를 먼저 실행하세요.`);
    fs.cpSync(from, path.join(resources, name), { recursive: true, dereference: true });
    console.log(`  • copied build/${name} -> ${path.relative(appOutDir, path.join(resources, name))}`);
  };

  copy("web");
  if (electronPlatformName === "win32") copy("daemon");
  if (electronPlatformName === "darwin") copy("daemon-mac");
};
