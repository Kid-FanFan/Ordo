// docx 预览路径探针：真实应用 + CDP——判定走 docx-preview 还是 mammoth 降级 + 面板占满情况
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
    this.ws = ws; this.id = 0; this.pending = new Map();
    ws.addEventListener("message", (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) { this.pending.get(msg.id)(msg); this.pending.delete(msg.id); }
    });
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
  const port = 9341;
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
    // 经 ＋ → 文件选择页打开真实 docx
    await cdp.evaluate(`document.getElementById("wb-toggle").click()`);
    await sleep(400);
    await cdp.evaluate(`document.getElementById("wb-plus").click()`);
    await sleep(300);
    await cdp.evaluate(`(function(){const c=[...document.querySelectorAll(".wb-newtab .wb-entry-card")].find(x=>x.textContent.includes("文件")); if(!c) return false; c.click(); return true;})()`);
    await sleep(700);
    await cdp.evaluate(`(function(){const it=[...document.querySelectorAll(".wb-file-item")].find(i=>i.dataset.path.endsWith(".docx")); if(!it) return false; it.click(); return true;})()`);
    await sleep(4000);
    const r = await cdp.evaluate(`(function(){
      const pane=[...document.querySelectorAll(".wb-pane")].find(p=>!p.classList.contains("hidden"));
      const frame=pane && pane.querySelector(".wb-office-frame");
      const doc=frame && frame.contentDocument;
      return {
        paneH: pane ? Math.round(pane.getBoundingClientRect().height) : -1,
        frameH: frame ? Math.round(frame.getBoundingClientRect().height) : -1,
        pageEls: doc ? doc.querySelectorAll(".page").length : -1,
        hasStyle: doc ? !!doc.querySelector("style") : null,
        sandbox: frame ? frame.getAttribute("sandbox") : null,
        scripts: doc ? doc.querySelectorAll("script").length : -1,
        textSample: doc ? (doc.body.textContent||"").slice(0,30) : null,
      };
    })()`);
    console.log(JSON.stringify(r, null, 1));
    // @ 符号菜单：不应出现 [object
    const at = await cdp.evaluate(`(function(){
      const i=document.getElementById("composer-input")||document.querySelector("textarea,input[type=text]");
      if(!i) return "no-input";
      i.focus(); i.value="@"; i.dispatchEvent(new Event("input",{bubbles:true}));
      return new Promise(res=>setTimeout(()=>{const m=document.querySelector(".menu, .symbol-menu, [class*=symbol]"); const items=m? [...m.querySelectorAll("button,.menu-item")].map(b=>b.textContent.trim().slice(0,30)) : null; res(JSON.stringify({open:!!m, items:(items||[]).slice(0,6), object:(items||[]).some(t=>t.includes("[object"))}));},500));
    })()`);
    console.log("@ 菜单:", at);
    // 截图存证：真实应用 + 真实文件 + 保真引擎
    try {
      const page = await cdp.call("Page.captureScreenshot", { format: "png" });
      require("node:fs").writeFileSync(path.join(ROOT, "shots", "26-docx-fidelity.png"), Buffer.from(page.result?.data ?? page.data, "base64"));
      console.log("截图: shots/26-docx-fidelity.png");
    } catch (e) {
      console.log("截图失败:", String(e.message).slice(0, 60));
    }
  } finally {
    app.kill();
    process.exit(0);
  }
})().catch((e) => {
  console.error("PROBE FAIL:", e.message);
  process.exit(1);
});
