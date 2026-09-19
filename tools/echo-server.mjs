// 回显服务器：记录请求体到 bodies.jsonl，返回最小合法 SSE
import http from "node:http";
import fs from "node:fs";

http
  .createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      fs.appendFileSync("bodies.jsonl", body + "\n");
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      const chunk = (delta, finish = null) =>
        res.write(
          `data: ${JSON.stringify({
            id: "x",
            object: "chat.completion.chunk",
            created: 0,
            model: "echo",
            choices: [{ index: 0, delta, finish_reason: finish }],
          })}\n\n`
        );
      chunk({ role: "assistant", content: "" });
      chunk({ content: "ok" });
      chunk({}, "stop");
      // 模拟真实网关的最终 usage 块（空 choices + usage）
      res.write(
        `data: ${JSON.stringify({
          id: "x",
          object: "chat.completion.chunk",
          created: 0,
          model: "echo",
          choices: [],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        })}\n\n`
      );
      res.write("data: [DONE]\n\n");
      res.end();
    });
  })
  .listen(8788, () => console.log("[echo] :8788"));
