// 新标签页文件选择探针：真实应用 + CDP（不打桩），验证 getWorkspaceFiles 真实链路与选择页渲染
// 用法：node tools/probe-picker.cjs
const { spawn } = require("node:child_process");
const path = require("node:path");
const http = require("node:http");

const ROOT = path.join(__dirname, "..");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function getJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let b = "";
      res.on("data", (c) => (b += c));
      res.on("end", () => { try { resolve(JSON.parse(b)); } catch (e) { reject(e); } });
    }).on("error", reject);
  });
}
async function waitFor(fn, ms, tag) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    try { const v = await fn(); if (v) return v; } catch {}
    await sleep(300);
  }
  throw new Error("等待超时: " + tag);
}
class Cdp {
  constructor(ws) {
    this.ws = this.ws; this.id = 0; this.pending = new Map();
    ws.addEventListener("message", (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) { this.pending.get(msg.id)(msg); this.pending.delete(msg.id); }
    });
    this.ws = ws;
  }
  call(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve) => { this.pending.set(id, resolve); this.ws.send(JSON.stringify({ id, method, params })); });
  }
  async evaluate(expr) {
    const r = await this.call("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true });
    return r.result?.result?.value;
  }
}

(async () => {
  const electronBin = require(path.join(ROOT, "node_modules/electron/index.js"));
  const port = 9339;
  const app = spawn(electronBin, [".", `--remote-debugging-port=${port}`], {
    cwd: ROOT,
    env: { ...process.env, ORDO_USE_MOCK: "1", ORDO_MOCK_API_KEY: "spike-key" },
    stdio: "ignore",
  });
  try {
    const targets = await waitFor(async () => {
      const list = await getJson(`http://127.0.0.1:${port}/json`);
      return list.find((t) => t.type === "page" && t.url.includes("index.html"));
    }, 30000, "应用窗口");
    const ws = new WebSocket(targets.webSocketDebuggerUrl);
    await new Promise((r, j) => { ws.addEventListener("open", r); ws.addEventListener("error", j); });
    const cdp = new Cdp(ws);
    await sleep(2500);

    // ① 直查真实 IPC 返回 + 应用认定的 workspace root
    const info = await cdp.evaluate(`window.ordo.getWorkspaceInfo().then(r => JSON.stringify(r))`);
    console.log("① workspaceInfo:", info);
    const raw = await cdp.evaluate(`window.ordo.getWorkspaceFiles().then(r => JSON.stringify({n: (r||[]).length, head: (r||[]).slice(0,3), type: typeof (r||[])[0]}))`);
    console.log("② IPC 原始返回:", raw);

    // ② 走真实 UI：＋ → 文件卡片 → 选择页列表
    await cdp.evaluate(`document.getElementById("wb-toggle").click()`);
    await sleep(400);
    await cdp.evaluate(`document.getElementById("wb-plus").click()`);
    await sleep(300);
    const cardOk = await cdp.evaluate(`(function(){const c=[...document.querySelectorAll(".wb-newtab .wb-entry-card")].find(x=>x.textContent.includes("文件")); if(!c) return false; c.click(); return true;})()`);
    await sleep(800);
    const ui = await cdp.evaluate(`(function(){const items=[...document.querySelectorAll(".wb-file-item")].map(i=>i.dataset.path); return {cardOk: ${JSON.stringify(cardOk)}, count: items.length, head: items.slice(0,5), empty: document.querySelector(".wb-filepick") ? document.querySelector(".wb-filepick").textContent.slice(0,30) : null};})()`);
    console.log("② 选择页渲染:", JSON.stringify(ui, null, 1));
  } finally {
    app.kill();
    process.exit(0);
  }
})().catch((e) => {
  console.error("PROBE FAIL:", e.message);
  process.exit(1);
});
