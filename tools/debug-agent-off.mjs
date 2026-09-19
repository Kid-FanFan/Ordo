// 复现 App 场景：带历史 thinking 块 + off 档 + convertToLlm 剥离，看真实请求体
import { Agent } from "@earendil-works/pi-agent-core";
import { createModels, createProvider, envApiKeyAuth } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";

const BASE_URL = "http://127.0.0.1:8788/v1";
const provider = createProvider({
  id: "t",
  name: "t",
  baseUrl: BASE_URL,
  auth: { apiKey: envApiKeyAuth("k", ["K"]) },
  api: openAICompletionsApi(),
  models: [
    {
      id: "m",
      name: "m",
      api: "openai-completions",
      provider: "t",
      baseUrl: BASE_URL,
      reasoning: true,
      compat: {
        thinkingFormat: "chat-template",
        chatTemplateKwargs: {
          enable_thinking: { $var: "thinking.enabled" },
          thinking_budget: { $var: "thinking.budget" },
        },
      },
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 131072,
      maxTokens: 8192,
    },
  ],
});
const models = createModels();
models.setProvider(provider);
const model = models.getModel("t", "m");

const convertToLlm = (messages) => {
  const off = true; // 模拟 off 档
  return messages
    .filter((m) => m && (m.role === "user" || m.role === "assistant" || m.role === "toolResult"))
    .map((m) => {
      if (!off || m.role !== "assistant" || !Array.isArray(m.content)) return m;
      return { ...m, content: m.content.filter((c) => c?.type !== "thinking") };
    });
};

const agent = new Agent({
  initialState: {
    systemPrompt: "你是助手",
    model,
    tools: [],
    thinkingLevel: "off",
    messages: [
      { role: "user", content: "hi", timestamp: Date.now() },
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "上一轮的思考内容", thinkingSignature: "reasoning_content" },
          { type: "text", text: "上一轮的回答" },
        ],
        api: "openai-completions",
        provider: "t",
        model: "m",
        stopReason: "stop",
        timestamp: Date.now(),
        usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      },
    ],
  },
  streamFn: models.streamSimple.bind(models),
  convertToLlm,
});

await agent.prompt("1+1？");
console.log("done");
