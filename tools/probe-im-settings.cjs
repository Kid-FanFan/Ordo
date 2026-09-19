// 一次性探针：IM 通道设置节渲染诊断（抓控制台错误 + DOM 实况）
const { spawn } = require("node:child_process");
const path = require("node:path");
const http = require("node:http");
const ROOT = path.join(__dirname, "..");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function getJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => { let b = ""; res.on("data", (c) => (b += c)); res.on("end", () => { try { resolve(JSON.parse(b)); } catch (e) { reject(e); } }); }).on("error", reject);
  });
}
async function waitFor(fn, ms, tag) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) { try { const v = await fn(); if (v) return v; } catch {} await sleep(300); }
  throw new Error("等待超时: " + tag);
}
class Cdp {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map(); this.console = [];
    ws.addEventListener("message", (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) { this.pending.get(msg.id)(msg); this.pending.delete(msg.id); return; }
      if (msg.method === "Runtime.consoleAPICalled") {
        const t = (msg.params.args || []).map((a) => (typeof a.value === "string" ? a.value : a.description ?? a.value ?? "")).join(" ");
        this.console.push(`[${msg.params.type}] ${t.slice(0, 500)}`);
      }
      if (msg.method === "Runtime.exceptionThrown") {
        const d = msg.params.exceptionDetails;
        this.console.push("[exception] " + (d.exception?.description || JSON.stringify(d)).slice(0, 600));
      }
    });
  }
  call(method, params = {}) { const id = ++this.id; return new Promise((res) => { this.pending.set(id, res); this.ws.send(JSON.stringify({ id, method, params })); }); }
  async evaluate(expr) {
    const r = await this.call("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.result?.exceptionDetails) throw new Error("页面执行出错: " + JSON.stringify(r.result.exceptionDetails).slice(0, 300));
    return r.result?.result?.value;
  }
}
(async () => {
  const mock = spawn(process.execPath, [path.join(ROOT, "tools/mock-server.mjs")], { stdio: "ignore" });
  await sleep(1200);
  const electronBin = require(path.join(ROOT, "node_modules/electron/index.js"));
  const port = 9341;
  const app = spawn(electronBin, [".", `--remote-debugging-port=${port}`], { cwd: ROOT, env: { ...process.env, ORDO_USE_MOCK: "1", ORDO_MOCK_API_KEY: "spike-key" }, stdio: "ignore" });
  try {
    const targets = await waitFor(async () => { const l = await getJson(`http://127.0.0.1:${port}/json`); return l.find((t) => t.type === "page" && t.url.includes("index.html")); }, 30000, "应用窗口");
    const ws = new WebSocket(targets.webSocketDebuggerUrl);
    await new Promise((r, j) => { ws.addEventListener("open", r); ws.addEventListener("error", j); });
    const cdp = new Cdp(ws);
    await cdp.call("Runtime.enable");
    await sleep(2500);
    console.log('TARGET-URL:', targets.url);
    console.log('BODY-HEAD:', (await cdp.evaluate()).replace(/s+/g,' '));
    console.log('HAS-BTN:', await cdp.evaluate());
    cdp.console.length = 0;
    for (let i = 0; i < 20; i++) {
      await cdp.evaluate(`document.getElementById("open-settings")?.click()`).catch(() => {});
      await sleep(400);
      if (await cdp.evaluate(`!!document.querySelector("#module-page:not(.hidden) .st-nav")`).catch(() => false)) break;
    }
    for (let i = 0; i < 15; i++) {
      const hit = await cdp.evaluate(`(function(){const b=[...document.querySelectorAll(".st-nav-item")].find(x=>x.textContent==="IM 通道"); if(b) b.click(); return !!b;})()`).catch(() => false);
      if (hit) break;
      await sleep(300);
    }
    await sleep(2500);
    const diag = await cdp.evaluate(`(function(){
      const page = document.querySelector("#module-page:not(.hidden)");
      const content = page ? page.querySelector(".st-content") : null;
      return {
        pageOpen: !!page,
        cards: content ? content.querySelectorAll(".m-model-form").length : -1,
        preview: content ? content.textContent.slice(0, 160) : ""
      };
    })()`);
    console.log("DIAG:", JSON.stringify(diag, null, 2));
    console.log("CONSOLE:", cdp.console.filter((c) => c.includes("[IM]") || c.includes("[exception]")).slice(-4).join("\n---\n") || "(无)");
  } catch (e) {
    console.error("PROBE-ERR:", (e && e.message) || e);
  } finally {
    app.kill();
    mock.kill();
    process.exit(0);
  }
})();
