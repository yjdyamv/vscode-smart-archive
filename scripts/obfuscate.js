const jso = require("javascript-obfuscator");
const fs = require("fs");

const EXT_SOURCE = "out/extension.js";
const WEBVIEW_SRC = "media/vue/assets/index.js";

const extResult = jso.obfuscate(fs.readFileSync(EXT_SOURCE, "utf8"), {
  compact: true,
  controlFlowFlattening: false,
  identifierNamesGenerator: "mangled",
  renameGlobals: false,
  stringArray: true,
  stringArrayEncoding: ["base64"],
  rotateStringArray: true,
  stringArrayThreshold: 0.5,
  target: "node",
});
fs.writeFileSync(EXT_SOURCE, extResult.getObfuscatedCode());

const wvResult = jso.obfuscate(fs.readFileSync(WEBVIEW_SRC, "utf8"), {
  compact: true,
  controlFlowFlattening: false,
  identifierNamesGenerator: "mangled",
  renameGlobals: false,
  stringArray: true,
  stringArrayEncoding: ["base64"],
  rotateStringArray: true,
  stringArrayThreshold: 0.5,
  target: "browser-no-eval",
  sourceMap: false,
});
fs.writeFileSync(WEBVIEW_SRC, wvResult.getObfuscatedCode());
