// 与 App 完全同构的真实网关复现：真实 system prompt + 3 工具 + 带思考历史 + off 档
// 用法：K=1（带工具）K=2（无历史）K=3（纯净：无工具无历史）观察 thinking 是否出现
import { Agent } from "@earendil-works/pi-agent-core";
import { createModels, createProvider, envApiKeyAuth, Type } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import fs from "node:fs";

const MODE = process.env.MODE || "full"; // full | notool | nohist | clean
const cfg = JSON.parse(fs.readFileSync(new URL("../config.mock.json", import.meta.url), "utf-8"));
const m = { ...cfg.model };
if (process.env.BASE_URL_OVERRIDE) m.baseUrl = process.env.BASE_URL_OVERRIDE;

const provider = createProvider({
  id: m.providerId,
  name: m.providerName,
  baseUrl: m.baseUrl,
  auth: {
    apiKey: {
      name: "k",
      resolve: async () => ({ auth: { apiKey: m.apiKey }, source: "config" }),
    },
  },
  api: openAICompletionsApi(),
  models: m.models.map((x) => ({
    id: x.id, name: x.name, api: "openai-completions", provider: m.providerId, baseUrl: m.baseUrl,
    reasoning: true,
    // 兼容参数跟随配置；缺省走 pi 自动探测（如 deepseek.com → thinking:{type}），自定义网关在 config 里显式给 compat
    ...(m.compat ? { compat: m.compat } : {}),
    ...(x.thinkingLevelMap ? { thinkingLevelMap: x.thinkingLevelMap } : {}),
    input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: x.contextWindow, maxTokens: x.maxTokens,
  })),
});
const models = createModels();
models.setProvider(provider);
const model = models.getModel(m.providerId, m.models[0].id);

const fakeTool = (name, level) => ({
  name, label: name, level,
  description: `${name} 工具`,
  parameters: Type.Object({ path: Type.String() }),
  execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} }),
});
const tools = MODE === "notool" || MODE === "clean" ? [] : [fakeTool("read_file", "L1"), fakeTool("write_file", "L2"), fakeTool("list_files", "L1")];

const mkHist = () => [
  { role: "user", content: "读取 data/sales.txt", timestamp: Date.now() },
  {
    role: "assistant",
    content: [
      { type: "thinking", thinking: "用户要读文件，调用 read_file。", thinkingSignature: "reasoning_content" },
      { type: "text", text: "好的，我来读取。" },
      { type: "toolCall", id: "c1", name: "read_file", arguments: { path: "data/sales.txt" } },
    ],
    api: "openai-completions", provider: m.providerId, model: m.models[0].id, stopReason: "toolUse", timestamp: Date.now(),
    usage: { input: 10, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 20, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  },
  { role: "toolResult", toolCallId: "c1", content: [{ type: "text", text: "产品A,100 产品B,200" }], isError: false, timestamp: Date.now() },
  {
    role: "assistant",
    content: [
      { type: "thinking", thinking: "数据已取得，汇报。", thinkingSignature: "reasoning_content" },
      { type: "text", text: "数据包含产品A 100、产品B 200。" },
    ],
    api: "openai-completions", provider: m.providerId, model: m.models[0].id, stopReason: "stop", timestamp: Date.now(),
    usage: { input: 20, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 30, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  },
];
const messages = MODE === "nohist" || MODE === "clean" ? [] : mkHist();

const convertToLlm = (msgs) =>
  msgs
    .filter((x) => x && ["user", "assistant", "toolResult"].includes(x.role))
    .map((x) => (x.role === "assistant" && Array.isArray(x.content))
      ? { ...x, content: x.content.filter((c) => c?.type !== "thinking") }
      : x);

const systemPrompt = MODE === "clean" ? "你是助手" : cfg.basePrompt + "\n\n" + cfg.experts.items[0].rolePrompt;

const agent = new Agent({
  initialState: { systemPrompt, model, tools, thinkingLevel: "off", messages },
  thinkingBudgets: m.thinking.budgets,
  streamFn: models.streamSimple.bind(models),
  convertToLlm,
});

const before = agent.state.messages.length;
await agent.prompt("1+1等于几？只回答数字。");
const after = agent.state.messages;
let sawThinking = false;
for (let i = before; i < after.length; i++) {
  if (after[i].role === "assistant") {
    for (const c of after[i].content ?? []) if (c.type === "thinking") sawThinking = true;
  }
}
console.log(`MODE=${MODE} → off 档出现思考块: ${sawThinking ? "是 ❌" : "否 ✅"}`);
if (sawThinking) {
  const last = after.filter((x) => x.role === "assistant").pop();
  console.log(JSON.stringify(last.content, null, 1).slice(0, 400));
}
