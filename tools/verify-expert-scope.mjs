// 手动验证：专家差异化语义（基础工具一致 + 技能白名单收窄）
// 用法：node tools/verify-expert-scope.mjs（需先 npm run build；走 config.mock.json 真实模型）
// 断言式观察：drawing-checker 的系统提示词不含技能块；写文件照常可用（走 L2）
import { createRequire } from "node:module";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const { AgentHost } = require(path.join(root, "dist/main/agent-host.js"));
const { Workspace } = require(path.join(root, "dist/main/workspace.js"));
const { Audit } = require(path.join(root, "dist/main/audit.js"));
const { SessionStore } = require(path.join(root, "dist/main/sessions.js"));

const cfg = JSON.parse(readFileSync(path.join(root, "config.mock.json"), "utf-8"));

// 隔离环境：临时 home，避免污染真实 ~/.ordo
const home = mkdtempSync(path.join(tmpdir(), "ordo-verify-"));
const ws = new Workspace(home);
for (const d of Object.values(ws.dirs)) mkdirSync(d, { recursive: true });
mkdirSync(path.join(ws.root, "data"), { recursive: true });
writeFileSync(path.join(ws.root, "data", "sales.txt"), "产品A,100\n产品B,200\n产品C,150\n", "utf-8");
// 播种示例技能（Workspace.init 的冷启动种子只在真实 home 生效，临时环境需手动补）
const skillDir = path.join(ws.dirs.skillsPersonal, "weekly-report");
mkdirSync(skillDir, { recursive: true });
writeFileSync(
  path.join(skillDir, "SKILL.md"),
  ["---", "name: weekly-report", "description: 生成销售周报时使用：规定周报结构与数据口径", "---", "", "# 周报生成规范", ""].join("\n"),
  "utf-8"
);

const host = new AgentHost(cfg, {
  workspace: ws,
  audit: new Audit(ws.dirs.audit),
  sessions: new SessionStore(ws.dirs.sessions),
  emit: (ev) => {
    if (ev.type === "notice") console.log("[事件]", ev.text);
  },
  confirm: async () => true,
  selfTest: false,
});

await host.init();

console.log("=== 通用助手（全量技能）===");
console.log("提示词含 weekly-report 技能:", host.systemPromptText().includes("weekly-report"));
console.log("工具:", host.activeToolNames().join(","));

host.switchExpert("drawing-checker");
console.log("\n=== 图纸核对工程师（技能白名单 []）===");
console.log("提示词含 weekly-report 技能:", host.systemPromptText().includes("weekly-report"), "（应为 false）");
console.log("工具:", host.activeToolNames().join(","), "（应与通用一致）");
console.log("角色层生效:", host.systemPromptText().includes("图纸核对工程师"));

console.log("\n=== 下发写任务（基础能力一致，写走 L2 确认）===");
await host.prompt("请读取 data/sales.txt，把三个数字的合计写入 out/sum.txt");
console.log("模型回复:", host.lastAssistantText().slice(0, 200));
let wrote = null;
try {
  wrote = readFileSync(path.join(ws.root, "out", "sum.txt"), "utf-8");
} catch {
  wrote = null;
}
console.log("out/sum.txt 已写入:", wrote !== null, wrote ? `（内容: ${wrote.slice(0, 40)}）` : "");

rmSync(home, { recursive: true, force: true });
process.exit(0);
