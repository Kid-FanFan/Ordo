// 透明代理：记录 pi 的真实请求体 → 转发到真实网关 → 回传响应
import http from "node:http";
import fs from "node:fs";

const TARGET = "http://ai-network-qwen.top";
const PORT = Number(process.env.PROXY_PORT || 8799);

http
  .createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", async () => {
      fs.writeFileSync("pi-request.json", body);
      console.log("[proxy] 已记录请求体 → pi-request.json");
      const url = new URL(req.url, TARGET);
      try {
        const resp = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: req.headers.authorization ?? "" },
          body,
        });
        res.writeHead(resp.status, {
          "Content-Type": resp.headers.get("content-type") ?? "text/event-stream",
          "Cache-Control": "no-cache",
        });
        if (!resp.body) return res.end();
        const reader = resp.body.getReader();
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          res.write(Buffer.from(value));
        }
        res.end();
      } catch (e) {
        console.error("[proxy] 转发失败:", e.message);
        res.writeHead(502).end();
      }
    });
  })
  .listen(PORT, () => console.log(`[proxy] :${PORT} → ${TARGET}`));
