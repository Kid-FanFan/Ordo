// buildTurn 分支单测：验证续接问答/新任务/被拒路径（直接 import mock-server 的逻辑副本）
import { readFileSync } from "node:fs";

const src = readFileSync(new URL("./mock-server.mjs", import.meta.url), "utf-8");
const m = src.match(/function buildTurn[\s\S]*?\n}\n/);
if (!m) throw new Error("buildTurn 未找到");
const buildTurn = new Function(`${m[0]}; return buildTurn;`)();

const cases = [
  {
    name: "续接问答：哪个文件（content 为多部分数组，pi 实际发送格式）",
    msgs: [
      { role: "user", content: "任务一" },
      { role: "tool", tool_call_id: "call_write_1", content: "操作未执行：白名单拒绝执行 write_file" },
      { role: "assistant", content: "明白，写入被拒绝，周报未生成。任务结束。" },
      { role: "user", content: [{ type: "text", text: "刚才生成的周报写在哪个文件？只回答相对路径。" }] },
    ],
    want: "out/weekly-report.md",
  },
  {
    name: "续接问答：哪个文件（纯字符串 content）",
    msgs: [
      { role: "user", content: "请读取 data/sales.txt，生成周报并写入 out/weekly-report.md" },
      { role: "assistant", content: "" },
      { role: "tool", tool_call_id: "call_write_1", content: "操作未执行：白名单拒绝执行 write_file" },
      { role: "assistant", content: "明白，写入被拒绝，周报未生成。任务结束。" },
      { role: "user", content: "刚才生成的周报写在哪个文件？只回答相对路径。" },
    ],
    want: "out/weekly-report.md",
  },
  {
    name: "新任务（历史有 tool 痕迹）",
    msgs: [
      { role: "user", content: "任务一" },
      { role: "tool", tool_call_id: "call_write_1", content: "已写入" },
      { role: "user", content: "请读取 data/sales.txt，生成周报并写入 out/weekly-report.md" },
    ],
    want: "call_read_1",
  },
  {
    name: "被拒收尾",
    msgs: [
      { role: "user", content: "任务" },
      { role: "tool", tool_call_id: "call_write_1", content: "操作未执行：白名单拒绝" },
    ],
    want: "明白，写入被拒绝",
  },
];

let fail = 0;
for (const c of cases) {
  const t = buildTurn(c.msgs);
  const got = t.toolCall ? t.toolCall.id : t.text;
  const ok = String(got).includes(c.want);
  if (!ok) fail++;
  console.log(ok ? "PASS" : "FAIL", c.name, "→", JSON.stringify(String(got).slice(0, 40)));
}
process.exit(fail ? 1 : 0);
