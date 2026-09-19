// OfficeCLI 集成前实测：三格式写入→本地库读回验证（mammoth/xlsx）+ officecli 自读
const { execFileSync } = require("node:child_process");
const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs");

const O = path.join(__dirname, "..", "node_modules", "@officecli", "officecli", "officecli.js");
const run = (args, cwd) => JSON.parse(execFileSync(process.execPath, [O, ...args, "--json"], { cwd, encoding: "utf8", timeout: 60000 }));
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "oc-verify-"));

(async () => {
  // docx
  run(["create", "d.docx"], dir);
  run(
    [
      "batch",
      "d.docx",
      "--commands",
      JSON.stringify([
        { command: "add", parent: "/body", type: "paragraph", props: { style: "Heading1", text: "SD 标题一" } },
        { command: "add", parent: "/body", type: "paragraph", props: { text: "正文 ORDO-PARA-MARK" } },
        { command: "add", parent: "/body", type: "paragraph", props: { listStyle: "bullet", text: "要点甲" } },
      ]),
    ],
    dir
  );
  run(["close", "d.docx"], dir);
  const mammoth = require("mammoth");
  const txt = (await mammoth.extractRawText({ path: path.join(dir, "d.docx") })).value;
  console.log("docx 抽回:", JSON.stringify(txt));

  // xlsx（含公式计算）
  run(["create", "s.xlsx"], dir);
  run(
    [
      "batch",
      "s.xlsx",
      "--commands",
      JSON.stringify([
        { command: "add", parent: "/", type: "sheet", props: { name: "台账" } },
        { command: "set", path: "/台账/A1", props: { value: "物料" } },
        { command: "set", path: "/台账/B2", props: { value: 140 } },
        { command: "set", path: "/台账/B3", props: { value: 60 } },
        { command: "set", path: "/台账/B4", props: { formula: "SUM(B2:B3)" } },
      ]),
    ],
    dir
  );
  const cell = run(["get", "s.xlsx", "/台账/B4"], dir);
  console.log("xlsx 公式读回:", JSON.stringify(cell));
  run(["close", "s.xlsx"], dir);
  const XLSX = require("xlsx");
  const wb = XLSX.readFile(path.join(dir, "s.xlsx"));
  console.log("xlsx SheetJS 读回:", JSON.stringify(XLSX.utils.sheet_to_csv(wb.Sheets["台账"])));

  // pptx：建两页 + 改第二页标题 + 删第一页
  run(["create", "p.pptx"], dir);
  run(
    [
      "batch",
      "p.pptx",
      "--commands",
      JSON.stringify([
        { command: "add", parent: "/", type: "slide", props: { layout: "Title and Content", title: "旧首页", text: "将被删除" } },
        { command: "add", parent: "/", type: "slide", props: { layout: "Title and Content", title: "ORDO-SLIDE-TITLE", text: "正文页" } },
        { command: "set", path: "/slide[2]/shape[@phType=title]", props: { text: "ORDO-SLIDE-EDITED" } },
        { command: "remove", path: "/slide[1]" },
      ]),
    ],
    dir
  );
  run(["close", "p.pptx"], dir);
  const ppt = run(["get", "p.pptx", "/"], dir);
  console.log("pptx 结构:", JSON.stringify(ppt).slice(0, 400));
})().catch((e) => {
  console.error("FAIL:", e.message);
  process.exit(1);
});
