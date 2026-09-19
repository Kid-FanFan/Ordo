// 自动化交互链路探针：真实应用 + CDP，走真实 UI（自动化页 → 新建表单 → 卡片 → 详情 → 立即运行 → 会话回看 → 删除清场）
// 验证：① 新建表单真实落库（automations.json）② 立即运行走真实后台 AgentHost（mock 模型）并生成 ⏰ 会话
//       ③ automation_run 事件提醒 ④ 运行会话可打开 ⑤ 删除清场且不动已生成会话
// 用法：node tools/probe-automation-e2e.cjs
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
  const port = 9337; // 与 kb 探针（9333）错开
  const app = spawn(electronBin, [".", `--remote-debugging-port=${port}`], {
    cwd: ROOT,
    // mockModel 的密钥走环境变量（缺失时 provider 报错、回合空收束）——与 scripts/selftest.mjs 同口径
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

    const out = [];
    const TASK = `探针自动化-${Date.now().toString(36)}`;

    // ---- 路径 ①：真实 UI 新建任务（表单 → 落库 → 卡片）----
    await cdp.evaluate(`document.getElementById("nav-automations").click()`);
    await sleep(600);
    const bodyEmpty = await cdp.evaluate(`document.querySelector("#mv-body").textContent.includes("还没有自动化任务")`);
    out.push(["自动化页空态", bodyEmpty]);
    out.push(["无企业下发分区", !(await cdp.evaluate(`document.querySelector("#mv-body").textContent.includes("企业下发")`))]);
    await cdp.evaluate(`(function(){const b=[...document.querySelectorAll('.mk-addrow button')].find(x=>x.textContent.includes('新建自动化任务')); if(!b) return false; b.click(); return true;})()`);
    await sleep(500);
    const formOk = await cdp.evaluate(
      `(function(){const i=document.querySelector('.modal .m-form input[type=text]'); const ta=document.querySelector('.modal .m-form textarea'); if(!i||!ta) return false; i.value=${JSON.stringify(TASK)}; ta.value='自动化自测：请直接回复任务已完成。'; const cb=document.querySelector('.modal .m-form input[type=checkbox]'); if(cb) cb.checked=true; return true;})()`
    );
    out.push(["表单填写", formOk]);
    // 工作目录：默认当前工作区（select 预选）；记录当前目录与前台 currentId 供运行后比对
    const fgWsBefore = await cdp.evaluate(`window.ordo.listWorkspaces().then(w => ({ currentId: w.currentId, count: w.items.length }))`);
    const taskWsId = await cdp.evaluate(`(function(){const s=[...document.querySelectorAll('.modal .m-form select')][1]; return s ? s.value : '';})()`);
    out.push(["表单预选目录", String(!!taskWsId), taskWsId]);
    await cdp.evaluate(`(function(){const b=[...document.querySelectorAll('.modal .m-footbar .mini')].find(x=>x.textContent==='创建'); if(!b) return false; b.click(); return true;})()`);
    await sleep(700);
    const cardOk = await cdp.evaluate(
      `(function(){const c=[...document.querySelectorAll('.mk-card .r-name')].find(x=>x.textContent===${JSON.stringify(TASK)}); return !!c;})()`
    );
    out.push(["任务卡片出现", cardOk]);
    const persisted = await cdp.evaluate(
      `window.ordo.listAutomations().then(l => { const t = l.find(x => x.name === ${JSON.stringify(TASK)}); return !!t && t.scheduleText.includes('每天 09:00') && t.preAuthLabels.join(',').includes('写入文件') && t.wsId === ${JSON.stringify(taskWsId)} && (t.wsName || '').length > 0; })`
    );
    out.push(["真实落库(调度+预授权+目录)", persisted]);

    // ---- 路径 ②：详情 → 立即运行（真实后台 AgentHost）→ automation_run 事件 + ⏰ 会话 ----
    await cdp.evaluate(`(function(){const c=[...document.querySelectorAll('.mk-card')].find(x=>x.textContent.includes(${JSON.stringify(TASK)})); if(!c) return false; c.querySelector('.mk-desc').click(); return true;})()`);
    await sleep(500);
    const detailOk = await cdp.evaluate(`document.querySelector('.modal .sk-pre') && [...document.querySelectorAll('.modal .m-sec')].some(x=>x.textContent.includes('运行记录'))`);
    out.push(["详情(指令+运行记录)", !!detailOk]);
    await cdp.evaluate(`window.__evts = []; window.ordo.onEvent((ev) => window.__evts.push(ev)); true`);
    await cdp.evaluate(`(function(){const b=[...document.querySelectorAll('.modal .m-footbar .mini')].find(x=>x.textContent==='立即运行'); if(!b) return false; b.click(); return true;})()`);
    const runEv = await waitFor(async () => cdp.evaluate(`(window.__evts.find(e => e.type === 'automation_run') || {}).ok`), 90000, "automation_run");
    out.push(["无人值守运行成功", String(runEv)]);
    const sessionId = await cdp.evaluate(`(window.__evts.find(e => e.type === 'automation_run') || {}).sessionId || ""`);
    const sessionTitle = await cdp.evaluate(`window.ordo.listSessions().then(l => (l.find(s => s.id === ${JSON.stringify(sessionId)}) || {}).title || "(未找到)")`);
    out.push(["运行会话命名", sessionTitle]);
    // 会话归属任务绑定的工作目录；前台工作区与"上次使用"不受后台运行影响
    const wsRootOk = await cdp.evaluate(
      `window.ordo.listWorkspaces().then(w => { const root = (w.items.find(x => x.id === ${JSON.stringify(taskWsId)}) || {}).root; return window.ordo.listSessions().then(l => { const s = l.find(x => x.id === ${JSON.stringify(sessionId)}); return !!s && !!root && s.wsRoot === root; }); })`
    );
    out.push(["会话锚定任务目录", String(wsRootOk)]);
    const fgAfter = await cdp.evaluate(`window.ordo.listWorkspaces().then(w => w.currentId)`);
    out.push(["前台目录不受影响", String(fgAfter === fgWsBefore.currentId), `${fgWsBefore.currentId} -> ${fgAfter}`]);
    const toastOk = await cdp.evaluate(`(document.getElementById('ordo-toast')||{}).textContent || ""`);
    out.push(["完成提醒", toastOk.includes("已完成") ? "已提醒" : toastOk.slice(0, 30)]);

    // ---- 路径 ③：打开会话 → 回到对话视图回看结果 ----
    await cdp.evaluate(`(function(){const c=[...document.querySelectorAll('.mk-card')].find(x=>x.textContent.includes(${JSON.stringify(TASK)})); if(!c) return false; c.querySelector('.mk-desc').click(); return true;})()`);
    await sleep(500);
    await cdp.evaluate(`(function(){const b=[...document.querySelectorAll('.modal .auto-run-head .mini')].find(x=>x.textContent==='打开会话'); if(!b) return false; b.click(); return true;})()`);
    await sleep(1000); // 留足 session_loaded → renderHistory 的渲染时间（曾因 700ms 偶发抖动）
    const chatBack = await cdp.evaluate(`!document.getElementById('chat-pane').classList.contains('hidden')`);
    const chatText = await cdp.evaluate(`(document.getElementById('chat-pane')||{}).textContent || ""`);
    out.push(["回看运行会话", chatBack && chatText.includes("任务已完成") ? "已回看" : "异常", `pane=${chatBack} text=${String(chatText).slice(0, 40)}`]);

    // ---- 路径 ④：删除清场（会话保留）----
    await cdp.evaluate(`document.getElementById("nav-automations").click()`);
    await sleep(500);
    await cdp.evaluate(`(function(){const c=[...document.querySelectorAll('.mk-card')].find(x=>x.textContent.includes(${JSON.stringify(TASK)})); if(!c) return false; c.querySelector('.mk-ops .del').click(); return true;})()`);
    await sleep(400);
    await cdp.evaluate(`(function(){const b=document.querySelector('.modal .m-footbar .danger'); if(!b) return false; b.click(); return true;})()`);
    await sleep(600);
    const listAfter = await cdp.evaluate(`window.ordo.listAutomations().then(l => l.some(x => x.name === ${JSON.stringify(TASK)}))`);
    out.push(["删除后清场", String(!listAfter)]);
    // 探针产生的会话收进回收站（不留在用户会话列表）
    const del = await cdp.evaluate(`window.ordo.deleteSession(${JSON.stringify(sessionId)}).then(() => 'ok').catch(e => String(e.message || e))`);
    out.push(["探针会话回收", del]);

    const fail = out.filter(([, v]) => v === false || v === "异常" || String(v).startsWith("(未")).map(([k]) => k);
    console.log(out.map(([k, v]) => `${k}: ${v}`).join("\n"));
    console.log(fail.length ? `\nPROBE FAIL: ${fail.join(" / ")}` : "\nPROBE PASS");
    app.kill();
    process.exit(fail.length ? 1 : 0);
  } catch (e) {
    console.error("PROBE ERROR:", e);
    try { app.kill(); } catch {}
    process.exit(1);
  }
})();
