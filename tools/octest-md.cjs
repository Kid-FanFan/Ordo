// markdown→docx 元素验证
const { execFileSync } = require("node:child_process");
const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs");
const O = path.join(__dirname, "..", "node_modules", "@officecli", "officecli", "officecli.js");
const run = (args, cwd) => JSON.parse(execFileSync(process.execPath, [O, ...args, "--json"], { cwd, encoding: "utf8", timeout: 60000 }));
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "oc-md-"));
(async () => {
  run(["create", "m.docx"], dir);
  const md = ["# MD标题", "", "正文**加粗**测试 MD-KW", "", "| 列A | 列B |", "| --- | --- |", "| 1 | 2 |", "", "- 要点一", "- 要点二"].join("\n");
  const r = run(["batch", "m.docx", "--commands", JSON.stringify([{ command: "add", parent: "/body", type: "markdown", props: { markdown: md } }])], dir);
  console.log("batch:", JSON.stringify(r.data?.summary ?? r.error ?? r));
  run(["close", "m.docx"], dir);
  const mammoth = require("mammoth");
  const txt = (await mammoth.extractRawText({ path: path.join(dir, "m.docx") })).value;
  console.log("MD→docx 抽回:", JSON.stringify(txt));
  const html = (await mammoth.convertToHtml({ path: path.join(dir, "m.docx") })).value;
  console.log("含表格/加粗:", html.includes("<table>") && html.includes("<strong>"));
})().catch((e) => {
  console.error("FAIL:", e.message);
  process.exit(1);
});
