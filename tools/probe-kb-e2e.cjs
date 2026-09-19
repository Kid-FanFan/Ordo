// 交互链路探针 v2：真实应用 + CDP，走真实 UI 点击（kb-btn → 菜单 → 挂载 → 提问）
// 复现两条路径：① 默认专家挂载企业库 → search_knowledge 应被调用；
// ② 图纸核对工程师（kbWhitelist=[]）会话挂企业库 → 工具应不出现（当前实现会静默吞掉，本探针验证该行为）
// 用法：node tools/probe-kb-e2e.cjs
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
    if (r.result?.exceptionDetails) throw new Error("页面执行出错: " + JSON.stringify(r.result.exceptionDetails).slice(0, 200));
    return r.result?.result?.value;
  }
}

(async () => {
  const mock = spawn(process.execPath, [path.join(ROOT, "tools/mock-server.mjs")], { stdio: "ignore" });
  await sleep(1200);
  const electronBin = require(path.join(ROOT, "node_modules/electron/index.js"));
  const app = spawn(electronBin, [".", "--remote-debugging-port=9333"], {
    cwd: ROOT,
    env: { ...process.env, ORDO_USE_MOCK: "1", ORDO_MOCK_API_KEY: "spike-key" },
    stdio: "ignore",
  });
  try {
    const targets = await waitFor(async () => {
      const list = await getJson("http://127.0.0.1:9333/json");
      return list.find((t) => t.type === "page" && t.url.includes("index.html"));
    }, 30000, "应用窗口");
    const ws = new WebSocket(targets.webSocketDebuggerUrl);
    await new Promise((r, j) => { ws.addEventListener("open", r); ws.addEventListener("error", j); });
    const cdp = new Cdp(ws);
    await sleep(2500);

    const out = [];
    const promptAndCollect = async (text) => {
      await cdp.evaluate(`window.__evts = []; window.ordo.onEvent((ev) => window.__evts.push({ t: ev.type, n: ev.name || "" })); true`);
      await cdp.evaluate(`window.ordo.prompt(${JSON.stringify(text)})`);
      await waitFor(async () => (await cdp.evaluate(`window.__evts.some(e => e.t === "run_end")`)), 90000, "回合结束");
      return cdp.evaluate(`window.__evts.filter(e => e.t === "tool_start").map(e => e.n)`);
    };

    // ---- 路径 ①：默认专家（新建会话 → 通用助手），真实 UI 点击挂载企业库 ----
    await cdp.evaluate(`document.getElementById("new-session").click()`);
    await sleep(400);
    const expertName = await cdp.evaluate(`(document.getElementById("expert-btn")||{}).textContent || ""`);
    out.push(["当前专家", expertName.trim().slice(0, 12)]);

    await cdp.evaluate(`document.getElementById("kb-btn").click()`);
    await sleep(600);
    const menuItem = await cdp.evaluate(`(function(){const m=[...document.querySelectorAll('.menu-item')].find(x=>x.textContent.includes('公司制度库')); if(!m) return false; m.click(); return true;})()`);
    out.push(["菜单点击挂载", menuItem]);
    await sleep(600);
    const attached1 = await cdp.evaluate(`window.ordo.listKnowledgeBases().then(l => l.filter(k => k.attached).map(k => k.name).join(","))`);
    out.push(["挂载态(通用助手)", attached1 || "(无)"]);
    const tools1 = await promptAndCollect("出差住宿的报销标准是什么？");
    out.push(["路径① 工具调用", JSON.stringify(tools1)]);
    // 回合结束：过程收进折叠行（收拢态、含工具行），最终回答留在外面可见
    const folded1 = await cdp.evaluate(`(function(){const f=document.querySelector('.turn-fold'); return !!f && !f.classList.contains('open') && f.querySelectorAll('.tool-row').length >= 1;})()`);
    out.push(["过程收进折叠行", folded1 ? "已收拢（可展开）" : "异常"]);
    const answerVisible = await cdp.evaluate(`(function(){const f=document.querySelector('.turn-fold'); const last=[...document.querySelectorAll('.md-text')].pop(); return !!last && !f.contains(last) && last.textContent.trim().length > 0;})()`);
    out.push(["最终回答留外", answerVisible ? "可见" : "异常"]);

    // ---- 路径 ②：图纸核对工程师会话（kbWhitelist=[]），同样 UI 挂载企业库 ----
    await cdp.evaluate(`document.getElementById("new-session").click()`);
    await sleep(400);
    const switched = await cdp.evaluate(`window.ordo.switchExpert("drawing-checker").then(() => "ok").catch(e => String(e.message || e))`);
    out.push(["切到图纸核对", switched]);
    const menuDesc2 = await cdp.evaluate(`(async function(){document.getElementById("kb-btn").click(); await new Promise(r=>setTimeout(r,500)); const m=[...document.querySelectorAll('.menu-item')].find(x=>x.textContent.includes('公司制度库')); return m ? m.textContent : "(菜单未出)";})()`);
    out.push(["菜单标注(图纸核对)", menuDesc2.includes("当前专家不可用") ? "已标注不可用" : menuDesc2.trim().slice(0, 30)]);
    const effRet2 = await cdp.evaluate(`window.ordo.setActiveKnowledgeBases(['kb-hr-policies'])`);
    out.push(["生效集返回(图纸核对)", JSON.stringify(effRet2)]);
    const activeFlag2 = await cdp.evaluate(`window.ordo.listKnowledgeBases().then(l => l.find(k => k.id === 'kb-hr-policies').active)`);
    out.push(["清单active(图纸核对)", String(activeFlag2)]);

    // ---- 路径 ③：徽标随挂载走，新建会话立即归零（真实主进程广播） ----
    await cdp.evaluate(`window.ordo.switchExpert("general").catch(() => {})`);
    await cdp.evaluate(`window.ordo.setActiveKnowledgeBases([])`); // 先归零：菜单点击语义 = 挂载（而非取消）
    await sleep(400);
    await cdp.evaluate(`document.getElementById("kb-btn").click()`);
    await sleep(600);
    await cdp.evaluate(`(function(){const m=[...document.querySelectorAll('.menu-item')].find(x=>x.textContent.includes('公司制度库')); if(!m) return false; m.click(); return true;})()`);
    await sleep(600);
    const badgeOn = await cdp.evaluate(`(function(){const b=document.querySelector('#kb-btn .pill-badge'); return !!b && !b.classList.contains('hidden') && b.textContent === '1';})()`);
    out.push(["挂载后徽标", badgeOn ? "1（显示）" : "异常"]);
    await cdp.evaluate(`document.getElementById("new-session").click()`);
    await sleep(500);
    const badgeOff = await cdp.evaluate(`(function(){const b=document.querySelector('#kb-btn .pill-badge'); return !!b && b.classList.contains('hidden');})()`);
    out.push(["新建会话徽标", badgeOff ? "已归零" : "仍显示（BUG）"]);
    const attachedAfter = await cdp.evaluate(`window.ordo.listKnowledgeBases().then(l => l.filter(k => k.attached).length)`);
    out.push(["主进程挂载数", String(attachedAfter)]);

    for (const [k, v] of out) console.log(`PROBE ${k}: ${v}`);
    const failed = out.filter(([, v]) => v === false || String(v).includes("异常") || String(v).includes("BUG")).map(([k]) => k);
    console.log(failed.length ? `PROBE FAIL: ${failed.join(" / ")}` : "PROBE PASS");
    process.exitCode = failed.length ? 1 : 0;
  } finally {
    app.kill(); mock.kill();
    setTimeout(() => process.exit(process.exitCode ?? 1), 500);
  }
})().catch((e) => { console.error("PROBE FAIL:", e.message); process.exit(1); });
