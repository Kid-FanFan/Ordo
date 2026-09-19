// 复现 7.3g write_docx：直接走与 agent-host 相同的 office-cli 封装路径（编译后 dist）
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const { execFileSync } = require("node:child_process");
const O = path.join(__dirname, "..", "node_modules", "@officecli", "officecli", "officecli.js");
const run = (args, cwd) => JSON.parse(execFileSync(process.execPath, [O, ...args, "--json"], { cwd, encoding: "utf8", timeout: 90000 }));
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "oc-tool-"));
const abs = path.join(dir, "r.docx");
(async () => {
  run(["create", abs], dir);
  const md = ["# SD 周报", "", "本季 ORDO-DOCX-MARK 数据如下", "", "| 物料 | 数量 |", "| --- | --- |", "| 标准件A | 140 |", "", "- 要点一", "- 要点二"].join("\n\n");
  const r = run(["batch", abs, "--commands", JSON.stringify([{ command: "add", parent: "/body", type: "markdown", props: { markdown: md } }])], dir);
  console.log("batch summary:", JSON.stringify(r.data?.summary ?? r.error ?? r));
  run(["close", abs], dir);
  const mammoth = require("mammoth");
  const t = (await mammoth.extractRawText({ path: abs })).value;
  const h = (await mammoth.convertToHtml({ path: abs })).value;
  console.log("抽回:", JSON.stringify(t));
  console.log("含表格:", h.includes("<table>"));
})().catch((e) => {
  console.error("FAIL:", e.message);
  process.exit(1);
});
