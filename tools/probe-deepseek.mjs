// DeepSeek 真实 API 复现：与 agent-host.ts 同构的 provider 构建（compat 缺省走 pi 自动探测）
// 验证：① 思考档 + 工具回合（reasoning_content 回传不 400）② 同会话历史回传 ③ off 档思考关闭
import { Agent } from "@earendil-works/pi-agent-core";
import { createModels, createProvider, Type } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import fs from "node:fs";

const cfg = JSON.parse(fs.readFileSync(new URL("../config.mock.json", import.meta.url), "utf-8"));
const m = cfg.model;
const thinking = m.thinking;

const provider = createProvider({
  id: m.providerId,
  name: m.providerName,
  baseUrl: m.baseUrl,
  auth: { apiKey: { name: "k", resolve: async () => ({ auth: { apiKey: m.apiKey }, source: "config" }) } },
  api: openAICompletionsApi(),
  models: m.models.map((x) => ({
    id: x.id, name: x.name, api: "openai-completions", provider: m.providerId, baseUrl: m.baseUrl,
    reasoning: !!thinking,
    ...(m.compat ? { compat: m.compat } : {}),
    ...(x.thinkingLevelMap ? { thinkingLevelMap: x.thinkingLevelMap } : {}),
    input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: x.contextWindow, maxTokens: x.maxTokens,
  })),
});
const models = createModels();
models.setProvider(provider);
const model = models.getModel(m.providerId, m.models[0].id);
if (!model) throw new Error("模型注册失败");

const readFile = {
  name: "read_file", label: "read_file", level: "L1",
  description: "读取工作区文件内容",
  parameters: Type.Object({ path: Type.String() }),
  execute: async () => ({ content: [{ type: "text", text: "产品A,100 产品B,200" }], details: {} }),
};

const agent = new Agent({
  initialState: { systemPrompt: "你是测试助手。", model, tools: [readFile], thinkingLevel: thinking.defaultId },
  thinkingBudgets: thinking.budgets,
  streamFn: models.streamSimple.bind(models),
  convertToLlm: (msgs) =>
    msgs
      .filter((x) => x && ["user", "assistant", "toolResult"].includes(x.role))
      .map((x) =>
        x.role === "assistant" && Array.isArray(x.content) && String(agent.state.thinkingLevel ?? "off") === "off"
          ? { ...x, content: x.content.filter((c) => c?.type !== "thinking") }
          : x,
      ),
});

const sawThinking = (from) => {
  for (let i = from; i < agent.state.messages.length; i++) {
    const msg = agent.state.messages[i];
    if (msg.role === "assistant") for (const c of msg.content ?? []) if (c.type === "thinking") return true;
  }
  return false;
};
const lastText = () => {
  const a = agent.state.messages.filter((x) => x.role === "assistant").pop();
  return (a?.content ?? []).filter((c) => c.type === "text").map((c) => c.text).join("") || "(无文本)";
};

let mark = agent.state.messages.length;
await agent.prompt("用 read_file 读取 data/sales.txt，然后告诉我产品A的数量。");
console.log(`[1] 思考档(${thinking.defaultId})+工具回合 完成 | 思考块: ${sawThinking(mark) ? "有 ✅" : "无"} | 回复: ${lastText().slice(0, 60)}`);

mark = agent.state.messages.length;
await agent.prompt("产品B呢？");
console.log(`[2] 历史回传回合 完成 | 回复: ${lastText().slice(0, 60)}`);

agent.state.thinkingLevel = "off";
mark = agent.state.messages.length;
await agent.prompt("再读一次 data/sales.txt，只报产品A的数量。");
console.log(`[3] off 档回合 完成 | 新思考块: ${sawThinking(mark) ? "有 ❌" : "无 ✅"} | 回复: ${lastText().slice(0, 60)}`);
console.log("PROBE_DONE");
