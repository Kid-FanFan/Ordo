// 复现 agent-host 的 provider/model 构造，向回显服务器发两档请求，检查 chat_template_kwargs
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

const ctx = { systemPrompt: "s", messages: [{ role: "user", content: "hi", timestamp: Date.now() }], tools: [] };
for (const reasoning of [undefined, "medium", "high"]) {
  const stream = models.streamSimple(model, ctx, { reasoning });
  for await (const _ of stream) {
    /* drain */
  }
}
console.log("done");
