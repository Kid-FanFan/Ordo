// 状态截图脚手架：加载 src/renderer（stub preload + 剧本事件），截取关键 UI 状态用于视觉回归排查
// 用法：npx electron tools/capture-states.cjs   → 输出 shots/*.png
const { app, BrowserWindow, ipcMain } = require("electron");
const path = require("node:path");
const fs = require("node:fs");
const officeFx = require("./office-fixtures.cjs");

const OUT = path.join(__dirname, "..", "shots");
fs.mkdirSync(OUT, { recursive: true });

// ---- stub preload：与真契约同形的 mock api；prompt 触发主进程剧本事件 ----
const PRELOAD = path.join(app.getPath("temp"), "ordo-capture-preload.cjs");
fs.writeFileSync(
  PRELOAD,
  `const { contextBridge, ipcRenderer } = require("electron");
const wrap = (ch) => (...a) => ipcRenderer.invoke(ch, ...a);
contextBridge.exposeInMainWorld("ordo", {
  onEvent: (cb) => { ipcRenderer.on("cap:ev", (_e, ev) => { try { cb(ev); } catch (err) { ipcRenderer.send("cap:cberr", String((err && err.stack) || err)); } }); ipcRenderer.send("cap:subscribed"); return () => {}; },
  prompt: (t) => ipcRenderer.invoke("cap:prompt", t),
  respondConfirm: wrap("cap:respondConfirm"),
  getWorkspaceInfo: wrap("cap:workspaceInfo"),
  listExperts: wrap("cap:listExperts"),
  switchExpert: wrap("cap:switchExpert"),
  thinkingState: wrap("cap:thinkingState"),
  switchThinking: wrap("cap:switchThinking"),
  listSessions: wrap("cap:listSessions"),
  newSession: wrap("cap:newSession"),
  loadSession: wrap("cap:loadSession"),
  cancel: wrap("cap:cancel"),
  readFilePreview: wrap("cap:readFilePreview"),
  browserState: wrap("cap:browserState"),
  browserConsoleTail: wrap("cap:browserConsoleTail"),
  browserStop: wrap("cap:browserStop"),
  browserOpenUser: wrap("cap:browserOpenUser"),
  termOpen: wrap("cap:termOpen"),
  termWrite: () => true,
  termResize: () => true,
  termClose: () => true,
  termState: () => ({ active: true, cwd: "C:\\Users\\demo\\.ordo\\workspace" }),
  getWorkspaceFiles: wrap("cap:getWorkspaceFiles"),
  listWorkspaces: wrap("cap:listWorkspaces"),
  switchWorkspace: wrap("cap:switchWorkspace"),
  openWorkspaceDir: wrap("cap:openWorkspaceDir"),
  pinSession: wrap("cap:pinSession"),
  renameSession: wrap("cap:renameSession"),
  deleteSession: wrap("cap:deleteSession"),
  listSkills: wrap("cap:listSkills"),
  setResourceEnabled: wrap("cap:setResourceEnabled"),
  listModels: wrap("cap:listModels"),
  switchModel: wrap("cap:switchModel"),
  listKnowledgeBases: wrap("cap:listKnowledgeBases"),
  listConnectors: wrap("cap:listConnectors"),
  listAutomations: wrap("cap:listAutomations"),
});`
);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const errors = [];

process.on("unhandledRejection", (e) => console.log("[unhandled]", String(e && e.message ? e.message : e).slice(0, 100)));
app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    show: false,
    paintWhenInitiallyHidden: true,
    webPreferences: { preload: PRELOAD, contextIsolation: true, nodeIntegration: false },
  });
  const send = (ev) => win.webContents.send("cap:ev", ev);
  win.webContents.on("console-message", (_e, level, message) => {
    if (level >= 2 && !message.includes("Security Warning")) errors.push(String(message));
  });

  // ---- mock 数据（与真实主进程同形）----
  const SESSION = {
    id: "s1",
    title: "销售周报生成",
    expert: "general",
    messages: [
      { role: "user", content: "请读取 data/sales.txt，生成周报并写入 out/weekly-report.md" },
      {
        role: "assistant",
        content: [
          { type: "toolCall", name: "read_file", arguments: { path: "data/sales.txt" } },
          { type: "text", text: "已读取数据，开始生成周报。" },
          { type: "toolCall", name: "write_file", arguments: { path: "out/weekly-report.md", content: "# 周报\n..." } },
        ],
      },
      { role: "toolResult", content: [{ type: "text", text: "已写入 out/weekly-report.md" }] },
    ],
  };
  const handlers = {
    "cap:workspaceInfo": () => ({ product: "Ordo", root: "C:\\Users\\demo\\.ordo\\workspace", home: "C:\\Users\\demo\\.ordo" }),
    "cap:listExperts": () => ({
      current: { id: "general", name: "通用助手", description: "", toolWhitelist: null },
      items: [
        { id: "general", name: "通用助手", description: "日常问答与办公任务（默认，不收窄工具）", toolWhitelist: null },
        { id: "drawing-checker", name: "图纸核对工程师", description: "只读核对专家", toolWhitelist: ["read_file", "list_files"] },
      ],
    }),
    "cap:switchExpert": () => true,
    "cap:thinkingState": () => ({
      current: { id: "medium", label: "中" },
      items: [
        { id: "off", label: "关闭" }, { id: "low", label: "低" },
        { id: "medium", label: "中" }, { id: "high", label: "高" },
      ],
    }),
    "cap:switchThinking": () => true,
    "cap:listSessions": () => [
      { id: "s1", title: "销售周报生成", updatedAt: new Date().toISOString(), expert: "general", messageCount: 4, wsId: "default", pinned: false },
    ],
    "cap:newSession": () => true,
    "cap:loadSession": () => SESSION,
    "cap:cancel": () => true,
    "cap:readFilePreview": (_e, p) => {
      if (String(p).endsWith("demo.html"))
        return {
          kind: "html",
          content:
            '<!doctype html><html><head><meta charset="utf-8"><style>body{font-family:sans-serif;background:#fff;margin:0;padding:24px;color:#222}h1{color:#178351;font-size:20px}table{border-collapse:collapse}td,th{border:1px solid #ccc;padding:6px 14px}th{background:#f2f2f2}</style></head><body><h1>库存报表（HTML 预览效果）</h1><table><tr><th>物料</th><th>现存量</th></tr><tr><td>标准件A</td><td>140</td></tr><tr><td>标准件B</td><td>80</td></tr></table><p>沙箱内静态渲染，脚本已禁用。</p></body></html>',
        };
      if (String(p).endsWith("logo.png")) {
        const svg =
          '<svg xmlns="http://www.w3.org/2000/svg" width="480" height="200"><rect width="480" height="200" fill="#e8f4ec"/><circle cx="90" cy="100" r="46" fill="#178351"/><rect x="180" y="40" width="250" height="18" rx="9" fill="#5f5b52"/><rect x="180" y="80" width="180" height="12" rx="6" fill="#9a958a"/><rect x="180" y="106" width="220" height="12" rx="6" fill="#9a958a"/><text x="180" y="160" font-family="sans-serif" font-size="16" fill="#178351">图片预览样例 480x200</text></svg>';
        return { kind: "image", mime: "image/svg+xml", dataUrl: "data:image/svg+xml;base64," + Buffer.from(svg, "utf-8").toString("base64"), bytes: Buffer.byteLength(svg) };
      }
      if (String(p).endsWith("office.docx")) {
        const b = officeFx.makeDocx();
        return { kind: "office", format: "docx", dataUrl: "data:application/vnd.openxmlformats-officedocument.wordprocessingml.document;base64," + b.toString("base64"), bytes: b.length };
      }
      if (String(p).endsWith("sheet.xlsx")) {
        const b = officeFx.makeXlsx();
        return { kind: "office", format: "xlsx", dataUrl: "data:application/vnd.openxmlformats-officedocument.spreadsheetml.sheet;base64," + b.toString("base64"), bytes: b.length };
      }
      if (String(p).endsWith("deck.pptx")) {
        const b = officeFx.makePptx();
        return { kind: "office", format: "pptx", dataUrl: "data:application/vnd.openxmlformats-officedocument.presentationml.presentation;base64," + b.toString("base64"), bytes: b.length };
      }
      return { kind: "text", content: "# 周报\n\n## 本周销售概况\n\n产品A 100、产品B 200、产品C 150，合计 450。" };
    },
    "cap:getWorkspaceFiles": () => [
      { path: "data/sales.txt", size: 512 },
      { path: "out/weekly-report.md", size: 4096 },
    ],
    // 面板标签相关：stub 暴露了方法就必须有应答，否则 openTerminalTab 等静默失败、截图全废
    "cap:termOpen": () => ({ ok: true }),
    "cap:browserState": () => ({ open: false, url: "", origin: "", consoleCount: 0 }),
    "cap:browserConsoleTail": () => [
      { t: Date.now(), level: "error", text: "[demo] Uncaught TypeError: chart.render is not a function" },
    ],
    "cap:browserStop": () => ({ ok: true }),
    "cap:browserOpenUser": () => ({ ok: true }),
    "cap:listWorkspaces": () => ({
      currentId: "default",
      items: [{ id: "default", label: "默认工作区", root: "C:\\Users\\demo\\.ordo\\workspace", tag: "默认" }],
    }),
    "cap:switchWorkspace": () => true,
    "cap:openWorkspaceDir": () => true,
    "cap:pinSession": () => true,
    "cap:renameSession": () => true,
    "cap:deleteSession": () => true,
    "cap:listSkills": () => [
      { id: "weekly-report", name: "weekly-report", desc: "生成销售周报时使用：规定周报结构与数据口径", scope: "个人", mine: true, enabled: true },
    ],
    "cap:setResourceEnabled": () => true,
    "cap:listModels": () => ({
      currentId: "Qwen3.6-35B-A3B",
      items: [{ id: "Qwen3.6-35B-A3B", name: "Qwen3.6-35B-A3B", desc: "128K 上下文 · Qwen 内网模型" }],
    }),
    "cap:switchModel": () => true,
    "cap:listKnowledgeBases": () => [],
    "cap:listConnectors": () => [],
    "cap:listAutomations": () => [],
  };
  for (const [ch, fn] of Object.entries(handlers)) ipcMain.handle(ch, fn);

  // 剧本：完整一轮任务（L1 读 → 文本 → L2 写 → 完成）
  ipcMain.handle("cap:prompt", async (_e, text) => {
    const steps = [
      { type: "run_start" },
      { type: "notice", text: "[L1] read_file 自动执行（已记审计）" },
      { type: "tool_start", name: "read_file" },
      { type: "tool_end", name: "read_file" },
      { type: "text_delta", text: "已读取 data/sales.txt，" },
      { type: "text_delta", text: "按周报规范生成如下：\n\n# 周报\n\n## 本周销售概况\n\n产品A 100、产品B 200、产品C 150，合计 450。" },
      { type: "assistant_done" },
      { type: "tool_start", name: "write_file" },
      { type: "tool_end", name: "write_file" },
      { type: "text_delta", text: "周报已写入 out/weekly-report.md。" },
      { type: "assistant_done" },
      { type: "run_end" },
      { type: "session_saved", id: "s-new", title: text.slice(0, 20) },
    ];
    (async () => {
      for (const ev of steps) {
        await sleep(120);
        send(ev);
      }
    })();
    return true;
  });

  const shot = async (name) => {
    await sleep(260); // 等过渡动画/渲染
    try {
      const img = await win.webContents.capturePage();
      fs.writeFileSync(path.join(OUT, name), img.toPNG());
      console.log("[capture]", name);
    } catch (e) {
      console.log("[capture-failed]", name, String(e && e.message ? e.message : e).slice(0, 100));
    }
  };
  const exec = (js) => win.webContents.executeJavaScript(js).catch((e) => { console.log("[exec-failed]", String(e && e.message ? e.message : e).slice(0, 90)); return null; });

  // 状态 0：启动恢复竞态复现——renderer 订阅事件的瞬间注入 session_loaded（真实主进程行为），
  // 验证 boot() 尾部的 ensureEmptyState 是否把问候语空态叠加在恢复的历史会话下方。
  // 注意：订阅信号可能在 loadFile resolve 之前就发出，监听必须先于 loadFile 注册。
  let subscribed = false;
  ipcMain.on("cap:subscribed", () => {
    subscribed = true;
    send({ type: "session_loaded", id: "s1", title: "销售周报生成", expert: "general", messages: SESSION.messages });
  });
  ipcMain.on("cap:cberr", (_e, stack) => console.error("[capture] renderer 回调异常:", stack));

  await win.loadFile(path.join(__dirname, "..", "src", "renderer", "index.html"));
  await sleep(1200);
  const probe0 = await win.webContents
    .executeJavaScript(`({
      turns: document.querySelectorAll('#thread .turn').length,
      empty: !!document.getElementById('empty-state'),
      threadChildren: [...document.getElementById('thread').children].map(n => n.id || n.className.split(' ')[0]),
      composerIn: document.getElementById('composer-stack').parentElement.id || document.getElementById('composer-stack').parentElement.className,
    })`)
    .catch((e) => ({ execErr: String(e) }));
  console.log("[probe] 注入后 DOM:", JSON.stringify(probe0), "subscribed:", subscribed);
  await shot("0-restore-race.png");

  // 状态 1：新会话空态（问候语 + 快捷选项 + 输入区）——先新建会话回到未锁定空态
  await exec(`document.getElementById("new-session").click()`);
  await sleep(900);
  const probeEmpty = await exec(`({
    rowVisible: !document.getElementById("ws-option-row").classList.contains("hidden"),
    expertInRow: document.getElementById("ws-option-row").contains(document.getElementById("expert-btn")),
    expertText: document.getElementById("expert-btn").textContent.trim(),
    wsText: document.getElementById("ws-btn").textContent.trim(),
  })`);
  console.log("[probe] 空态会话设置行:", JSON.stringify(probeEmpty));
  await shot("1-empty.png");

  // 状态 2：发送消息（真实键盘路径）→ 剧本事件流结束
  await exec(`(() => {
    const i = document.getElementById("input");
    i.value = "请读取 data/sales.txt，生成周报并写入 out/weekly-report.md";
    i.dispatchEvent(new Event("input", { bubbles: true }));
    i.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    return true;
  })()`);
  await sleep(260);
  await shot("2-after-send-mid.png"); // 流式中：验证问候语是否已消失
  await sleep(1600);
  await shot("3-after-send-done.png"); // 完成态：含 L2 交付卡
  const probeLocked = await exec(`({
    rowHidden: document.getElementById("ws-option-row").classList.contains("hidden"),
    expertVisible: document.getElementById("expert-btn").offsetParent !== null,
  })`);
  console.log("[probe] 发送后锁定:", JSON.stringify(probeLocked));

  // 状态 3：打开预览面板（D4 去工作台化：空态提示）
  await exec(`(() => { document.getElementById("wb-toggle").click(); return true; })()`);
  await sleep(500);
  await shot("4-panel-empty.png");

  // 状态 3b：预览视觉验证（Markdown / HTML 沙箱渲染 / 图片），经正文路径提取注册交付物
  const deliverExtra = async (p) => {
    send({ type: "run_start" });
    send({ type: "tool_start", name: "write_file", args: { path: p, content: "x" } });
    send({ type: "tool_end" });
    send({ type: "text_delta", text: `已写入 \`${p}\`` });
    send({ type: "assistant_done" });
    send({ type: "run_end" });
    await sleep(220);
  };
  // 交付物入口在浮标浮层（D4）
  const openFile = async (p) => {
    await exec(`(() => { const bub=document.getElementById("progress-bubble"); if(!bub) return "no-bubble"; bub.click(); const pop=document.querySelector(".pb-pop"); if(!pop) return "no-pop"; const it=[...pop.querySelectorAll(".pb-file")].find(x=>x.querySelector(".f-path").textContent==="${p}"); if(!it) return "no-file"; it.click(); return true; })()`);
    await sleep(500);
  };
  await deliverExtra("preview/demo.html");
  await deliverExtra("preview/logo.png");
  await deliverExtra("out/weekly-report.md");
  // Office 三路预览截图（方案 §2.1：docx/xlsx/pptx）
  await deliverExtra("preview/office.docx");
  await deliverExtra("preview/sheet.xlsx");
  await deliverExtra("preview/deck.pptx");
  await openFile("out/weekly-report.md");
  await sleep(500);
  await shot("9-preview-md.png");
  await openFile("preview/demo.html");
  await sleep(600);
  await shot("10-preview-html.png");
  const probeHtml = await exec(`(() => {
    const f = document.querySelector(".wb-preview-frame");
    return f
      ? {
          rect: Math.round(f.getBoundingClientRect().width) + "x" + Math.round(f.getBoundingClientRect().height),
          srcdocLen: (f.srcdoc || "").length,
          sandboxAttr: f.getAttribute("sandbox"),
          complete: (() => { try { return f.contentDocument && f.contentDocument.body ? f.contentDocument.body.innerHTML.slice(0, 60) : "no-body-access"; } catch (e) { return "threw:" + e.name; } })(),
        }
      : null;
  })()`);
  console.log("[probe] HTML 预览 iframe:", JSON.stringify(probeHtml));
  await exec(`(() => { const b=[...document.querySelectorAll('.wb-preview-tab')].find(x=>x.textContent==='源码'); if(b) b.click(); return !!b; })()`);
  await sleep(400);
  await shot("11-preview-html-src.png");
    await openFile("preview/logo.png");
  await sleep(500);
  await shot("12-preview-image.png");
  const probeImg = await exec(`(() => {
    const body = document.querySelector(".wb-preview-body");
    return {
      children: body ? [...body.children].map((c) => c.className + "|" + c.tagName + "|" + Math.round(c.getBoundingClientRect().width) + "x" + Math.round(c.getBoundingClientRect().height)) : null,
      imgSrc: (i => (i ? i.src.slice(0, 30) : null))(document.querySelector(".wb-preview-img")),
      frameCount: document.querySelectorAll(".wb-preview-frame").length,
    };
  })()`);
  console.log("[probe] 图片预览 DOM:", JSON.stringify(probeImg));

  // Office 预览截图：docx（沙箱保真渲染）/ xlsx（页签+值网格）/ pptx（沙箱逐页）
  const openAndShotOffice = async (file, name, probeJs) => {
    await openFile(`${file}`);
    await sleep(1500); // 懒加载脚本 + 解析渲染
    await shot(name);
    if (probeJs) console.log("[probe]", name, JSON.stringify(await exec(probeJs)));
  };
  await openAndShotOffice(
    "preview/office.docx",
    "13-preview-docx.png",
    `(() => {
      const f=document.querySelector(".wb-office-frame");
      if (!f || !f.contentDocument) return null;
      const b=f.contentDocument.body;
      const w=b.firstElementChild;
      const cs=w?w.ownerDocument.defaultView.getComputedStyle(w):null;
      return {
        text:(b.textContent||"").slice(0,40), nodes:b.childElementCount,
        frameRect: Math.round(f.getBoundingClientRect().width)+"x"+Math.round(f.getBoundingClientRect().height),
        wrapperClass: w?w.className:null,
        wrapperStyle: cs?{display:cs.display,visibility:cs.visibility,color:cs.color,background:cs.background.slice(0,40),width:cs.width,height:cs.height,overflow:cs.overflow,transform:cs.transform,position:cs.position}:null,
        bodyStyle: (()=>{const s=b.ownerDocument.defaultView.getComputedStyle(b);return {color:s.color,background:s.background.slice(0,30),height:s.height,overflow:s.overflow};})(),
        html: b.innerHTML.slice(0,300)
      };
    })()`
  );
  await openAndShotOffice(
    "preview/sheet.xlsx",
    "14-preview-xlsx.png",
    `(() => { const g=document.querySelector(".wb-sheet-grid"); return g ? { tabs: [...document.querySelectorAll(".wb-sheet-tab")].map(b=>b.textContent), text: (g.textContent||"").slice(0,60) } : null; })()`
  );
  await openAndShotOffice(
    "preview/deck.pptx",
    "15-preview-pptx.png",
    `(() => { const f=document.querySelector(".wb-office-frame"); return f && f.contentDocument ? { slides: f.contentDocument.body.querySelectorAll(".wb-pptx-slide").length, text: (f.contentDocument.body.textContent||"").slice(0,40) } : null; })()`
  );

  // 编辑态截图（方案 §2.3：md 编辑器 + xlsx 单元格编辑）
    await openFile("out/weekly-report.md");
  await sleep(500);
  await exec(`(() => { const b=document.querySelector(".wb-edit-btn"); if(b) b.click(); return !!b; })()`);
  await sleep(300);
  await shot("16-edit-text.png");
    await openFile("preview/sheet.xlsx");
  await sleep(1500); // 懒加载 SheetJS + 解析
  await shot("17-xlsx-readonly.png");

  // 悬浮进度浮标（方案 §3）：运行态 + 展开浮层
  await sleep(250);
  send({ type: "run_start" });
  await sleep(120);
  send({
    type: "plan_update",
    steps: [
      { text: "读取 data/sales.txt", status: "done" },
      { text: "生成周报正文", status: "running" },
      { text: "写入 out/weekly-report.md", status: "pending" },
    ],
  });
  await sleep(300);
  await shot("18-bubble-running.png");
  await exec(`document.getElementById("progress-bubble").click()`);
  await sleep(250);
  await shot("19-bubble-popover.png");

  // 浏览器桥面板（方案 §5）：状态条 + 急停 + 控制台子面板
  await exec(`(() => { document.getElementById("wb-collapse")?.click(); return true; })()`);
  await sleep(200);
  send({ type: "browser_navigate", url: "data:text/html,<html><head><meta charset='utf-8'></head><body style='font-family:sans-serif;padding:24px'><h2>ERP 周报系统</h2><table border='1' cellpadding='6'><tr><th>物料</th><th>数量</th></tr><tr><td>标准件A</td><td>140</td></tr></table><p>内嵌 webview 演示页</p></body></html>" });
  await sleep(500);
  await shot("20-browser-panel.png");

  // 用户侧终端（方案 §6）：xterm 挂载 + PowerShell 输出样子
  // 用户侧终端（方案 §6）：经 ＋新标签页 入口打开（空态卡不再常驻 DOM，收起后点不到旧节点）
  await exec(`(() => { document.getElementById("wb-collapse")?.click(); return true; })()`);
  await sleep(200);
  await exec(`(() => { document.getElementById("wb-plus").click(); return true; })()`);
  await sleep(300);
  await exec(`(() => { const c=[...document.querySelectorAll(".wb-newtab .wb-entry-card")].find(x=>x.textContent.includes("终端")); if(c) c.click(); return !!c; })()`);
  await sleep(1500);
  send({ type: "term_data", data: "PS C:\\Users\\demo\\.ordo\\workspace> dir\r\n\r\n    目录: C:\\Users\\demo\\.ordo\\workspace\r\n\r\nMode                 LastWriteTime         Length Name\r\n----                 -------------         ------ ----\r\nd-----    2026/9/1     10:00                data\r\nd-----    2026/9/1     10:00                out\r\n-a----    2026/9/1     10:00           1024 report.md\r\n\r\nPS C:\\Users\\demo\\.ordo\\workspace> _" });
  await sleep(600);
  await shot("21-terminal.png");

  // 状态 3d：＋新标签页（入口 → 文件选择 → 网址输入），替代旧浮层菜单
  await exec(`(() => { document.getElementById("wb-plus").click(); return true; })()`);
  await sleep(300);
  await shot("22-newtab-home.png");
  await exec(`(() => { const c=[...document.querySelectorAll(".wb-newtab .wb-entry-card")].find(x=>x.textContent.includes("文件")); if(c) c.click(); return !!c; })()`);
  await sleep(400);
  await shot("23-newtab-file.png");
  await exec(`(() => { const s=document.querySelector(".wb-nt-search"); if(s){ s.value="report"; s.dispatchEvent(new Event("input", { bubbles: true })); } return !!s; })()`);
  await sleep(200);
  await shot("24-newtab-file-search.png");
  await exec(`(() => { const b=document.querySelector(".wb-nt-back"); if(b) b.click(); return !!b; })()`);
  await sleep(150);
  await exec(`(() => { const c=[...document.querySelectorAll(".wb-newtab .wb-entry-card")].find(x=>x.textContent.includes("浏览器")); if(c) c.click(); return !!c; })()`);
  await sleep(200);
  await shot("25-newtab-url.png");
  for (let i = 0; i < 2; i++) {
    await exec(`(() => { document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); return true; })()`);
    await sleep(120);
  }

  // 状态 4：载入历史会话（write_file 交付卡）+ 工作台打开
  await exec(`window.__sdOpen ? window.__sdOpen("s1") : false`).catch(() => {});
  await exec(`(() => {
    const items = document.querySelectorAll(".session-item");
    if (items.length) items[0].click();
    return items.length;
  })()`);
  await sleep(500);
  await shot("5-history-workbench.png");

  // 状态 5：工作台打开下回到空态（最窄场景：输入区是否溢出）
  await exec(`document.getElementById("new-session").click()`);
  await sleep(600);
  await shot("6-empty-workbench-open.png");

  // 状态 6：窄窗口（模拟笔记本 DPI 缩放后的逻辑宽度）+ 工作台展开 → 容器查询自适应验证
  win.setContentSize(940, 700);
  await sleep(700);
  await shot("7-narrow-workbench.png");
  const probeNarrow = await exec(`({
    overflow: document.getElementById("composer").scrollWidth > document.getElementById("composer").clientWidth + 1,
    barW: document.querySelector(".composer-bar").scrollWidth,
    boxW: document.getElementById("composer").clientWidth,
    kbVisible: !!document.getElementById("kb-btn") && getComputedStyle(document.getElementById("kb-btn")).display !== "none",
    suggestDir: getComputedStyle(document.querySelector(".suggest")).flexDirection,
  })`);
  console.log("[probe] 窄容器:", JSON.stringify(probeNarrow));

  // 状态 7：极窄极限（940 窗口 + 空态 + 工作台展开 → chat-pane ≈ 276px）
  await exec(`document.getElementById("wb-toggle").click()`);
  await sleep(600);
  await shot("8-narrow-workbench-open.png");
  const probeExtreme = await exec(`({
    overflow: document.getElementById("composer").scrollWidth > document.getElementById("composer").clientWidth + 1,
    paneW: document.getElementById("chat-pane").clientWidth,
    barW: document.querySelector(".composer-bar").scrollWidth,
    boxW: document.getElementById("composer").clientWidth,
    suggestW: document.querySelector(".suggest").scrollWidth,
    paneScrollW: document.getElementById("scroller").scrollWidth,
    paneClientW: document.getElementById("scroller").clientWidth,
  })`);
  console.log("[probe] 极窄极限:", JSON.stringify(probeExtreme));

  console.log(JSON.stringify({ errors }));
  app.exit(0);
});
