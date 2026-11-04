import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");

test("release name and version agree across application metadata", () => {
  const pkg = JSON.parse(read("../package.json"));
  const config = JSON.parse(read("../src-tauri/tauri.conf.json"));
  const cargoPackage = read("../src-tauri/Cargo.toml").split("[lib]")[0];
  assert.equal(pkg.version, "1.0.0");
  assert.equal(config.version, pkg.version);
  assert.match(cargoPackage, /^version = "1\.0\.0"$/m);
  assert.equal(config.productName, "SSAI 长截图工具");
  assert.equal(config.app.windows[0].title, config.productName);
  assert.ok(read("../index.html").includes(`<title>${config.productName}</title>`));
  assert.equal(pkg.license, "MIT");
  assert.equal(config.identifier, "com.sansheng.picsewdesktop.preview");
});
