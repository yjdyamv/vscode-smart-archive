const obfuscator = require("javascript-obfuscator");
const fs = require("fs");
const path = require("path");

const BASE = {
  compact: true,
  controlFlowFlattening: false,
  identifierNamesGenerator: "mangled",
  renameGlobals: true,
  reservedNames: ["^activate$", "^deactivate$"],
  stringArray: true,
  stringArrayEncoding: ["base64"],
  rotateStringArray: false,
  stringArrayThreshold: 0.7,
  disableConsoleOutput: false,
  transformObjectKeys: false,
};

const TARGETS = [
  { dir: "out", opts: { target: "node" } },
  { dir: "media/vue/assets", opts: { target: "browser-no-eval", sourceMap: false } },
];

let count = 0;
for (const { dir, opts } of TARGETS) {
  if (!fs.existsSync(dir)) continue;
  for (const entry of fs.readdirSync(dir, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const full = path.join(entry.parentPath, entry.name);
    if (entry.name.endsWith(".map"))
      throw new Error(`[obfuscate] 拒绝打包 sourcemap: ${full}`);
    if (!entry.name.endsWith(".js")) continue;
    const code = fs.readFileSync(full, "utf8");
    if (code.includes("sourceMappingURL"))
      throw new Error(`[obfuscate] 发现内联 sourceMappingURL: ${full}`);
    fs.writeFileSync(full, obfuscator.obfuscate(code, { ...BASE, ...opts }).getObfuscatedCode());
    console.log(`[obfuscate] ${full}`);
    count++;
  }
}
if (count === 0) throw new Error("[obfuscate] 没有任何文件被混淆——构建产物缺失？");
