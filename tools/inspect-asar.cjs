// 检查打包产物 app.asar 内容：用法 node tools/inspect-asar.cjs [release/win-unpacked/resources/app.asar]
const asar = require("@electron/asar");
const p = process.argv[2] || "release/win-unpacked/resources/app.asar";
const list = asar.listPackage(p).map((x) => String(x).replace(/\\/g, "/"));
const norm = (x) => x.replace(/^\//, "");
console.log("总条目:", list.length);
console.log("样例:", JSON.stringify(list.slice(0, 6)));
const has = (s) => list.some((x) => norm(x).includes(s));
console.log("config.mock.json:", has("config.mock.json"));
console.log("dist/main/index.js:", has("dist/main/index.js"));
console.log("dist/preload/index.js:", has("dist/preload/index.js"));
console.log("src/renderer/index.html:", has("src/renderer/index.html"));
console.log("node_modules/@xterm:", has("node_modules/@xterm/"));
console.log("node_modules/mammoth:", has("node_modules/mammoth/"));
console.log("node_modules/xlsx:", has("node_modules/xlsx/"));
console.log("node_modules/node-pty:", has("node_modules/node-pty/"));
const root = list.map(norm).filter((x) => !x.includes("/"));
console.log("根文件:", JSON.stringify(root));
