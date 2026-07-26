const jso = require("javascript-obfuscator");
const fs = require("fs");

const BASE = {
  compact: true,
  controlFlowFlattening: false,
  identifierNamesGenerator: "mangled",
  renameGlobals: false,
  stringArray: true,
  stringArrayEncoding: ["base64"],
  rotateStringArray: false,
  stringArrayThreshold: 0.7,
  disableConsoleOutput: true,
  transformObjectKeys: false,
};

for (const { src, opts } of [
  { src: "out/extension.js", opts: { target: "node" } },
  { src: "media/vue/assets/index.js", opts: { target: "browser-no-eval", sourceMap: false } },
]) {
  const code = fs.readFileSync(src, "utf8");
  const result = jso.obfuscate(code, { ...BASE, ...opts });
  fs.writeFileSync(src, result.getObfuscatedCode());
}
