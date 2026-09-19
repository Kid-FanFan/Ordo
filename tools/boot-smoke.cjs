// 打包产物启动冒烟：CWD 脱离项目目录拉起 exe + --enable-logging 捕获 stderr——
// 进程存活且无主进程未捕获异常（"Object has been destroyed"那类错误框挂着进程也活着，仅看存活会漏检）
// 用法：node tools/boot-smoke.cjs [release/win-unpacked/Ordo.exe]
const { spawn, execSync } = require("node:child_process");
const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs");

const exe = path.resolve(process.argv[2] || "release/win-unpacked/Ordo.exe"); // 绝对路径：子进程 CWD 在临时目录
const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "ordo-smoke-"));
let err = "";
const p = spawn(exe, ["--enable-logging"], { cwd, stdio: ["ignore", "ignore", "pipe"] });
p.on("error", (e) => {
  console.log("boot smoke: 启动失败", String(e.message).slice(0, 80));
  process.exit(1);
});
p.stderr.on("data", (d) => {
  err += d.toString();
});
p.on("exit", (code) => {
  console.log("boot smoke: 启动即退出 EXIT=", code);
  console.log(err.slice(0, 800));
  process.exit(1);
});
setTimeout(() => {
  try {
    const out = execSync('tasklist /FI "IMAGENAME eq Ordo.exe" /FO CSV').toString();
    const alive = out.includes("Ordo.exe");
    const bad = /Uncaught Exception|Cannot find module|SyntaxError|TypeError:|ReferenceError:/.exec(err);
    console.log("boot smoke:", alive ? "ALIVE" : "DEAD", bad ? `主进程异常: ${bad[0]}` : "stderr 干净");
    if (bad) console.log(err.slice(0, 800));
    execSync("taskkill /IM Ordo.exe /F", { stdio: "ignore" });
    process.exit(alive && !bad ? 0 : 1);
  } catch (e) {
    console.log("boot smoke: ERR", String(e.message).slice(0, 80));
    process.exit(1);
  }
}, 7000);
