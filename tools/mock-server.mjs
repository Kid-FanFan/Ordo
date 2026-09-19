// mock 企业服务 + 剧本模型（M6-B 自测夹具）：
//   /v1/chat/completions —— OpenAI 兼容剧本模型（P0 旅程 3：读 sales.txt → 写周报 → 汇报；连接器/知识库/沉淀分支）
//   /api/v1/*            —— 管理端联机链路（登录/目录/平台配置/上报/检索/强更），目录状态可经 /__test/mutate 变更
// config.mock.json 退役为测试夹具：仅本服务与 selftest 读取，客户端运行时不再读它。
import http from "node:http";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PORT = process.env.MOCK_PORT || 8787;

function sse(res, obj) {
  res.write(`data: ${JSON.stringify(obj)}\n\n`);
}

function chunk(delta, finish = null) {
  return {
    id: "chatcmpl-mock",
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model: "ordo-mock-llm",
    choices: [{ index: 0, delta, finish_reason: finish }],
  };
}

const REPORT = [
  "# 周报（Ordo 自动生成）",
  "",
  "## 本周销售概况",
  "- 产品A：100",
  "- 产品B：200",
  "- 产品C：150",
  "- 合计：450",
  "",
  "## 说明",
  "本报告由 mock 模型依据 data/sales.txt 生成，用于 P0 旅程 3 的端到端验证。",
].join("\n");

function buildTurn(messages) {
  // 分支只看本轮（最后一条 user 之后）的 tool 消息：历史轮次的 tool 痕迹不影响新任务的剧本走向
  let lastUserIdx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "user") {
      lastUserIdx = i;
      break;
    }
  }
  const round = messages.slice(lastUserIdx + 1);
  const lastTool = [...round].reverse().find((m) => m.role === "tool");
  if (!lastTool) {
    // 问答型（续接/上下文验证）：直接回答，不走工具
    // pi 经 OpenAI 兼容端点发送的 user content 可能为多部分数组，需拼出文本再匹配
    const raw = messages[lastUserIdx]?.content;
    const q = String(
      typeof raw === "string" ? raw : Array.isArray(raw) ? raw.map((x) => x?.text ?? "").join("") : raw ?? ""
    ).slice(0, 80);
    if (/等于几/.test(q)) return { text: "2", toolCall: null, finish: "stop" };
    // 运行中消息（steer 消费后的注入 turn）：回显确认，供自测断言上下文已收到
    if (/插入指令/.test(q)) return { text: "已收到插入指令：改为生成双语版周报。", toolCall: null, finish: "stop" };
    // 慢速任务：先读文件再答（拉长回合），给运行中入队留窗口
    if (/慢速任务/.test(q)) {
      return { text: "好的，慢速处理中，先读取数据。", toolCall: { id: "call_slow_1", name: "read_file", arguments: { path: "data/sales.txt" } }, finish: "tool_calls" };
    }
    if (/哪个文件|什么文件/.test(q)) return { text: "out/weekly-report.md", toolCall: null, finish: "stop" };
    // 自动化无人值守（PRD 3.7 本地型定时任务）：直接产出结果，不走工具（预授权围栏另有剧本）
    if (/自动化自测/.test(q)) {
      return { text: "自测自动化任务已完成：本次为无人值守运行，结果已生成会话，可随时点开回看。", toolCall: null, finish: "stop" };
    }
    // ERP 连接器：挂载后问库存 → 调 mcp__erp__query_inventory（L1 托管只读）
    if (/库存/.test(q) && !/写入|周报/.test(q)) {
      return {
        text: "好的，通过 ERP 连接器查询物料A 的库存。",
        toolCall: { id: "call_mcp_1", name: "mcp__erp__query_inventory", arguments: { keyword: "物料A" } },
        finish: "tool_calls",
      };
    }
    // 知识库：挂载后问制度类问题 → 调 search_knowledge（L1 检索，回答引用来源）
    if (/报销|住宿标准|考勤|制度|按时/.test(q)) {
      return {
        text: "我先检索一下已挂载的知识库。",
        toolCall: { id: "call_kb_1", name: "search_knowledge", arguments: { query: "差旅报销 住宿标准" } },
        finish: "tool_calls",
      };
    }
    // 流程沉淀：用户要求把流程做成技能 → 调 save_skill（多文件包：SKILL.md + 核对清单模板）
    if (/做成技能|沉淀|保存为技能/.test(q)) {
      return {
        text: "好的，我把这套流程整理为个人技能 meeting-minutes（含核对清单模板），请确认保存。",
        toolCall: {
          id: "call_save_1",
          name: "save_skill",
          arguments: {
            name: "meeting-minutes",
            description: "整理会议纪要时使用：按结论、待办、风险三段输出，待办注明负责人与截止日",
            files: [
              { path: "SKILL.md", content: "# 会议纪要规范\n\n1. 先列一句话结论；\n2. 待办按「事项 / 负责人 / 截止日」表格输出；\n3. 风险与异议单独成段，不与结论混排。" },
              { path: "checklist.md", content: "- [ ] 结论一句话\n- [ ] 待办三要素齐全\n- [ ] 风险单独成段" },
            ],
          },
        },
        finish: "tool_calls",
      };
    }
    return {
      text: "好的，我先读取本周销售数据 data/sales.txt。",
      toolCall: { id: "call_read_1", name: "read_file", arguments: { path: "data/sales.txt" } },
      finish: "tool_calls",
    };
  }
  if (lastTool.tool_call_id === "call_slow_1") {
    return { text: "慢速任务完成。", toolCall: null, finish: "stop" };
  }
  if (lastTool.tool_call_id === "call_read_1") {
    return {
      text: "数据已读取。现在生成周报并写入 out/weekly-report.md（写入前会请你确认）。",
      toolCall: { id: "call_write_1", name: "write_file", arguments: { path: "out/weekly-report.md", content: REPORT } },
      finish: "tool_calls",
    };
  }
  if (lastTool.tool_call_id === "call_save_1") {
    return {
      text: "已保存为个人技能 meeting-minutes（含 SKILL.md 与 checklist.md），本会话即生效，可用 $meeting-minutes 指定调用。",
      toolCall: null,
      finish: "stop",
    };
  }
  if (lastTool.tool_call_id === "call_mcp_1") {
    return {
      text: "ERP 库存已查询：物料A 现存量合计 140 件（上海一仓 100 + 苏州二仓 40），可用量 135。数据来源已在结果中标注。任务完成。",
      toolCall: null,
      finish: "stop",
    };
  }
  if (lastTool.tool_call_id === "call_kb_1") {
    return {
      text: "根据知识库检索结果：一线城市住宿每晚上限 600 元，其他城市 400 元，报销须在返回后 15 个工作日内提交（来源：公司制度库/差旅报销制度.md）。",
      toolCall: null,
      finish: "stop",
    };
  }
  const denied = String(lastTool.content || "").includes("拒绝");
  return {
    text: denied ? "明白，写入被拒绝，周报未生成。任务结束。" : "周报已生成：out/weekly-report.md（含三个产品销量与合计）。任务完成。",
    toolCall: null,
    finish: "stop",
  };
}

// ================= M6-B：mock 企业服务（数据源 = config.mock.json 夹具） =================
const ROOT = path.dirname(fileURLToPath(import.meta.url));
const MOCK = JSON.parse(fs.readFileSync(path.join(ROOT, "..", "config.mock.json"), "utf-8"));
const clone = (x) => JSON.parse(JSON.stringify(x));
let skillRegistry = clone(MOCK.skillRegistry ?? []);
let skillSubmissions = clone(MOCK.skillSubmissions ?? []);

const checksumOf = (files) =>
  `sha256:${crypto
    .createHash("sha256")
    .update(
      [...files].sort((a, b) => a.path.localeCompare(b.path)).map((f) => `${f.path}\u0000${f.content}`).join("\u0001"),
      "utf-8"
    )
    .digest("hex")}`;

const platformConfig = () => ({
  model: {
    providerId: "ordo-intranet",
    providerName: "Ordo 内网模型",
    baseUrl: `http://127.0.0.1:${PORT}/v1`,
    apiKey: "mock-key",
    models: clone(MOCK.mockModel.models),
    thinking: clone(MOCK.model.thinking),
  },
  compaction: clone(MOCK.compaction),
  basePrompt: MOCK.basePrompt,
  shell: clone(MOCK.shell),
  browser: clone(MOCK.browser),
});

const json200 = (res, obj) => {
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify(obj));
};
const readBody = (req) =>
  new Promise((resolve) => {
    let b = "";
    req.on("data", (c) => (b += c));
    req.on("end", () => {
      try {
        resolve(JSON.parse(b || "{}"));
      } catch {
        resolve({});
      }
    });
  });
const empOf = (req) => {
  const h = String(req.headers.authorization ?? "");
  return h.startsWith("Bearer mock-token-") ? h.slice("Bearer mock-token-".length) : null;
};

/** mock 企业路由：命中返回 true（lenient 鉴权——有 token 即认，不验签） */
async function enterpriseRoutes(req, res, pathname, query) {
  // ---- 登录（任意工号密码可登；自测账号由 selftest 注入 env） ----
  if (req.method === "POST" && pathname === "/api/v1/auth/login") {
    const b = await readBody(req);
    const empNo = String(b.empNo ?? "mock-emp");
    json200(res, { token: `mock-token-${empNo}`, user: { empNo, name: `员工${empNo}`, role: "user", dept: "信息部" } });
    return true;
  }
  if (req.method === "GET" && pathname === "/api/v1/auth/me") {
    const empNo = empOf(req);
    if (!empNo) {
      res.writeHead(401, { "Content-Type": "application/json" }).end(JSON.stringify({ error: "未登录" }));
      return true;
    }
    json200(res, { empNo, name: `员工${empNo}`, role: "user", dept: "信息部" });
    return true;
  }
  // ---- 目录 ----
  if (req.method === "GET" && pathname === "/api/v1/catalog/skills") {
    json200(res, skillRegistry.map((s) => ({ ...clone(s), checksum: checksumOf(s.files) })));
    return true;
  }
  if (req.method === "GET" && pathname === "/api/v1/catalog/mcp") {
    json200(res, clone(MOCK.mcpRegistry ?? []));
    return true;
  }
  if (req.method === "GET" && pathname === "/api/v1/catalog/kb") {
    json200(res, clone(MOCK.kbRegistry ?? []));
    return true;
  }
  if (req.method === "GET" && pathname === "/api/v1/catalog/experts") {
    json200(res, clone(MOCK.experts ?? { defaultId: "general", items: [] }));
    return true;
  }
  if (req.method === "GET" && pathname === "/api/v1/catalog/skill-submissions") {
    json200(res, clone(skillSubmissions));
    return true;
  }
  if (req.method === "POST" && pathname === "/api/v1/submissions/skills") {
    const sub = await readBody(req);
    skillSubmissions = [...skillSubmissions.filter((s) => s.name !== sub.name), sub];
    res.writeHead(201, { "Content-Type": "application/json" }).end("{}");
    return true;
  }
  if (req.method === "GET" && pathname === "/api/v1/catalog/plugin-packs") {
    json200(res, []);
    return true;
  }
  // ---- 平台配置：版本恒 999（压过宿主机上真实运行残留的缓存，保证自测拿到 mock 配置；since 语义对齐真服务） ----
  if (req.method === "GET" && pathname === "/api/v1/config/platform") {
    const since = Number(query.get("since") ?? 0);
    if (Number.isFinite(since) && since >= 999) json200(res, { version: 999, unchanged: true });
    else json200(res, { version: 999, config: platformConfig() });
    return true;
  }
  // ---- 上报 ----
  if (req.method === "POST" && pathname === "/api/v1/report/audit") {
    const b = await readBody(req);
    json200(res, { stored: Array.isArray(b.rows) ? b.rows.length : 0, duplicated: 0 });
    return true;
  }
  if (req.method === "POST" && pathname === "/api/v1/report/usage") {
    json200(res, { ok: true });
    return true;
  }
  // ---- 知识库检索（关键词包含；真服务是向量+FTS 混合，mock 只需命中夹具文本） ----
  if (req.method === "GET" && pathname === "/api/v1/kb/search") {
    const q = String(query.get("q") ?? "").trim();
    const k = Math.min(20, Math.max(1, Number(query.get("k")) || 8));
    const kbWanted = query.get("kb");
    const hits = [];
    if (q) {
      for (const entry of MOCK.kbRegistry ?? []) {
        if (kbWanted && entry.id !== kbWanted) continue;
        for (const doc of entry.docs ?? []) {
          for (const ch of doc.chunks ?? []) {
            if ((ch.text ?? "").includes(q)) {
              hits.push({ kb: entry.name, doc: doc.name, section: ch.section, snippet: String(ch.text).slice(0, 160), score: 1 });
            }
          }
        }
      }
    }
    json200(res, hits.slice(0, k));
    return true;
  }
  // ---- 强更（无版本下发） ----
  if (req.method === "GET" && pathname === "/api/v1/client/version") {
    json200(res, { latest: "", minVersion: "", sha256: "", notes: "" });
    return true;
  }
  // ---- 自测控制：目录状态变更（客户端阶段 8 的审批/版本热更/下架，替代原直改 config.mock.json） ----
  if (req.method === "POST" && pathname === "/__test/mutate") {
    const b = await readBody(req);
    if (b.op === "approve-submission") {
      const row = skillSubmissions.find((s) => s.name === b.name);
      if (row) row.status = "approved";
    } else if (b.op === "patch-skill") {
      const row = skillRegistry.find((s) => s.name === b.name);
      if (row) {
        row.version = b.version ?? row.version;
        if (b.find && b.replaceWith && row.files?.[0]?.content?.includes(b.find)) {
          row.files[0].content = row.files[0].content.replace(b.find, b.replaceWith);
        }
      }
    } else if (b.op === "remove-skill") {
      skillRegistry = skillRegistry.filter((s) => s.name !== b.name);
    } else if (b.op === "restore") {
      skillRegistry = clone(MOCK.skillRegistry ?? []);
      skillSubmissions = clone(MOCK.skillSubmissions ?? []);
    } else {
      res.writeHead(400, { "Content-Type": "application/json" }).end(JSON.stringify({ error: `未知 op: ${b.op}` }));
      return true;
    }
    json200(res, { ok: true });
    return true;
  }
  return false;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  const pathname = url.pathname;
  // mock 企业服务（M6-B）：管理端联机链路全部路由
  if (pathname.startsWith("/api/") || pathname.startsWith("/__test/")) {
    if (await enterpriseRoutes(req, res, pathname, url.searchParams)) return;
    res.writeHead(404, { "Content-Type": "application/json" }).end(JSON.stringify({ error: "mock: 接口不存在" }));
    return;
  }
  if (req.method === "GET" && pathname === "/v1/models") {
    json200(res, { object: "list", data: MOCK.mockModel.models.map((m) => ({ id: m.id, object: "model", owned_by: "mock" })) });
    return;
  }
  if (req.method !== "POST" || !pathname.includes("/chat/completions")) {
    res.writeHead(404).end();
    return;
  }
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", async () => {
    const { messages, stream } = JSON.parse(body);
    // 慢速剧本：延迟响应，为「运行中入队」自测留窗口
    const flat = JSON.stringify(messages ?? []);
    if (flat.includes("慢速任务")) await new Promise((r) => setTimeout(r, 1200));
    if (process.env.MOCK_DEBUG) {
      console.error("[mock] 收到消息:", JSON.stringify(messages.map((m) => ({ role: m.role, c: String(m.content ?? "").slice(0, 40) }))));
    }
    const turn = buildTurn(messages);
    if (!stream) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          id: "chatcmpl-mock",
          object: "chat.completion",
          created: Math.floor(Date.now() / 1000),
          model: "ordo-mock-llm",
          choices: [
            {
              index: 0,
              message: {
                role: "assistant",
                content: turn.text,
                tool_calls: turn.toolCall
                  ? [
                      {
                        id: turn.toolCall.id,
                        type: "function",
                        function: { name: turn.toolCall.name, arguments: JSON.stringify(turn.toolCall.arguments) },
                      },
                    ]
                  : undefined,
              },
              finish_reason: turn.finish,
            },
          ],
        })
      );
      return;
    }
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
    sse(res, chunk({ role: "assistant", content: "" }));
    for (const ch of turn.text) sse(res, chunk({ content: ch }));
    if (turn.toolCall) {
      const args = JSON.stringify(turn.toolCall.arguments);
      const half = Math.ceil(args.length / 2);
      sse(
        res,
        chunk({
          tool_calls: [
            {
              index: 0,
              id: turn.toolCall.id,
              type: "function",
              function: { name: turn.toolCall.name, arguments: args.slice(0, half) },
            },
          ],
        })
      );
      sse(res, chunk({ tool_calls: [{ index: 0, function: { arguments: args.slice(half) } }] }));
    }
    sse(res, chunk({}, turn.finish));
    res.write("data: [DONE]\n\n");
    res.end();
  });
});

server.listen(PORT, () => console.log(`[mock] 企业服务+剧本模型已启动: http://127.0.0.1:${PORT}（/api/v1/* + /v1/*）`));
