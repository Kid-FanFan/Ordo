// 直调 officecli.exe（与主进程 office-cli.ts 同路径）复现 edit_xlsx 失败
const { spawnSync } = require("node:child_process");
const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs");
const exe = path.join(__dirname, "..", "node_modules", "@officecli", "officecli", "vendor", "officecli.exe");
console.log("exe 存在:", fs.existsSync(exe));
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "oc-exe-"));
const run = (args) => {
  const r = spawnSync(exe, [...args, "--json"], { cwd: dir, encoding: "utf8", timeout: 90000, env: { ...process.env, OFFICECLI_SKIP_UPDATE: "1" } });
  console.log(`\n$ officecli ${args.join(" ").slice(0, 80)}`);
  console.log("exit:", r.status);
  console.log("stdout:", (r.stdout || "").slice(0, 500));
  if (r.stderr) console.log("stderr:", r.stderr.slice(0, 300));
  return r;
};
const abs = path.join(dir, "s.xlsx");
run(["create", abs]);
run(["query", abs, "sheet"]);
run([
  "batch",
  abs,
  "--commands",
  JSON.stringify([
    { command: "add", parent: "/", type: "sheet", props: { name: "台账" } },
    { command: "set", path: "/台账/A1", props: { value: "物料" } },
    { command: "set", path: "/台账/B2", props: { value: "140" } },
    { command: "set", path: "/台账/B4", props: { formula: "SUM(B2:B3)" } },
  ]),
]);
run(["close", abs]);
