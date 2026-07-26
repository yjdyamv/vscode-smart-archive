const jso = require("javascript-obfuscator");
const fs = require("fs");

const source = fs.readFileSync("out/extension.js", "utf8");
const result = jso.obfuscate(source, {
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

fs.writeFileSync("out/extension.js", result.getObfuscatedCode());
