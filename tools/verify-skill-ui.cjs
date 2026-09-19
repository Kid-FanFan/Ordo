// 技能市场 UI 冒烟（无窗口）：stub preload 内存实现新契约 → DOM 级断言
// 覆盖：三页签（企业市场/已安装/我的技能）、安装→已安装记录→卸载、我的技能仅上传入口（无表单创建）、
//       详情含提交审核、提交后状态徽标、删除二次确认、导入、$ 符号菜单引用插入、界面无 L1/L2 字眼
// 用法：npx electron tools/verify-skill-ui.cjs   → 输出 JSON { pass, results, errors }
const { app, BrowserWindow, ipcMain } = require("electron");
const path = require("node:path");
const fs = require("node:fs");

// ---- stub preload：与真契约同形；技能操作直接改内存清单 ----
// Office 预览夹具（最小可用 docx/xlsx/pptx），随 stub 注入 readFilePreview
const officeFx = require("./office-fixtures.cjs");
const DOCX_B64 = officeFx.makeDocx().toString("base64");
const XLSX_B64 = officeFx.makeXlsx().toString("base64");
const PPTX_B64 = officeFx.makePptx().toString("base64");
const PRELOAD = path.join(app.getPath("temp"), "ordo-skill-ui-preload.cjs");
fs.writeFileSync(
  PRELOAD,
  `const { contextBridge, ipcRenderer } = require("electron");
const wrap = (ch) => (...a) => ipcRenderer.invoke(ch, ...a);
contextBridge.exposeInMainWorld("ordo", {
  onEvent: (cb) => { ipcRenderer.on("cap:ev", (_e, ev) => { try { cb(ev); } catch {} }); return () => {}; },
  prompt: async () => true,
  respondConfirm: async () => true,
  getWorkspaceInfo: async () => ({ product: "Ordo", root: "C:\\\\ws", home: "C:\\\\ws" }),
  listExperts: async () => ({
    current: { id: "general", name: "通用助手", description: "", skillWhitelist: null, mcpWhitelist: null, kbWhitelist: null },
    items: [
      { id: "general", name: "通用助手", description: "通用业务助手，全量资源可用", skillWhitelist: null, mcpWhitelist: null, kbWhitelist: null },
      { id: "drawing-checker", name: "图纸核对工程师", description: "核对图纸与清单的一致性，只读输出核对表", skillWhitelist: [], mcpWhitelist: [], kbWhitelist: [] },
    ],
  }),
  switchExpert: wrap("cap:switchExpert"),
  thinkingState: async () => ({ current: { id: "mid", label: "中" }, items: [{ id: "mid", label: "中" }] }),
  switchThinking: async () => true,
  listSessions: async () => [{ id: "sess-hist", title: "历史回归会话", updatedAt: "2026-09-13T10:00:00.000Z", expert: "general", messageCount: 2, pinned: false }],
  newSession: wrap("cap:newSession"),
  loadSession: async (id) => id === "sess-hist"
      ? {
          id: "sess-hist", title: "历史回归会话", createdAt: "2026-09-13T10:00:00.000Z", updatedAt: "2026-09-13T10:00:00.000Z", expert: "general",
          messages: [
            { role: "user", content: "帮我生成周报" },
            { role: "assistant", content: [
              { type: "toolCall", name: "write_file", arguments: { path: "out/r.md", content: "x" }, level: "L2" },
              { type: "text", text: "# 周报已完成\\n这是历史会话的最终回答。" },
            ] },
          ],
        }
      : { id: "x", title: "x", messages: [] },
  getWorkspaceFiles: async () => [{ path: "data/sales.txt", size: 2048 }],
  readFilePreview: async (p) => {
    if (p === "preview/demo.html") return { kind: "html", content: "<h1>你好</h1><p>效果预览</p><script>setInterval(function(){window.parent.postMessage('ordo-sandbox-script-ran','*')},250)</script>" };
    if (p === "preview/logo.png") return { kind: "image", mime: "image/png", dataUrl: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", bytes: 95 };
    if (p === "preview/doc.pdf") return { kind: "pdf", dataUrl: "data:application/pdf;base64,JVBERi0xLjQ=", bytes: 12 };
    if (p === "preview/office.docx") return { kind: "office", format: "docx", dataUrl: "data:application/vnd.openxmlformats-officedocument.wordprocessingml.document;base64," + "${DOCX_B64}", bytes: ${DOCX_B64.length} };
    if (p === "preview/sheet.xlsx") return { kind: "office", format: "xlsx", dataUrl: "data:application/vnd.openxmlformats-officedocument.spreadsheetml.sheet;base64," + "${XLSX_B64}", bytes: ${XLSX_B64.length} };
    if (p === "preview/deck.pptx") return { kind: "office", format: "pptx", dataUrl: "data:application/vnd.openxmlformats-officedocument.presentationml.presentation;base64," + "${PPTX_B64}", bytes: ${PPTX_B64.length} };
    // OfficeCLI 保真主路径：html 字段随 office 结果下发（渲染端无脚本沙箱直渲染）
    if (p === "preview/fidelity.docx") return { kind: "office", format: "docx", dataUrl: "data:application/vnd.openxmlformats-officedocument.wordprocessingml.document;base64," + "${DOCX_B64}", bytes: ${DOCX_B64.length}, html: "<!doctype html><html><head><style>.page{font-size:14pt}</style></head><body><div class=\\"page\\"><h1>ORDO-FIDELITY-HTML</h1><p>保真预览</p><script>alert(1)</script></div></body></html>" };
    if (p === "preview/old.doc") return null;
    if (p === "out/report.md") return { kind: "text", content: "# 标题\\n\\n正文" };
    return null;
  },
  saveFileEdit: wrap("cap:saveFileEdit"),
  imList: wrap("cap:imList"),
  imSave: wrap("cap:imSave"),
  imUnbind: wrap("cap:imUnbind"),
  imNewBindCode: wrap("cap:imNewBindCode"),
  browserState: wrap("cap:browserState"),
  browserConsoleTail: wrap("cap:browserConsoleTail"),
  browserStop: wrap("cap:browserStop"),
  browserOpenUser: wrap("cap:browserOpenUser"),
  browserAttach: wrap("cap:browserAttach"),
  termOpen: wrap("cap:termOpen"),
  termWrite: wrap("cap:termWrite"),
  termResize: wrap("cap:termResize"),
  termClose: wrap("cap:termClose"),
  termState: wrap("cap:termState"),
  // 人为延迟：测符号菜单的异步竞态防护（列表晚到时不应再弹过期菜单）
  listSkills: async () => {
    await new Promise((r) => setTimeout(r, 250));
    return ipcRenderer.invoke("cap:listSkills");
  },
  setResourceEnabled: wrap("cap:setResourceEnabled"),
  readSkill: wrap("cap:readSkill"),
  updateSkill: wrap("cap:updateSkill"),
  deleteSkill: wrap("cap:deleteSkill"),
  importSkill: wrap("cap:importSkill"),
  pickSkillFolder: wrap("cap:pickSkillFolder"),
  openSkillDir: wrap("cap:openSkillDir"),
  skillMarket: wrap("cap:skillMarket"),
  skillInstalled: wrap("cap:skillInstalled"),
  installSkill: wrap("cap:installSkill"),
  uninstallSkill: wrap("cap:uninstallSkill"),
  submitSkill: wrap("cap:submitSkill"),
  skillSubmissions: wrap("cap:skillSubmissions"),
  syncSkills: wrap("cap:syncSkills"),
  listConnectors: wrap("cap:listConnectors"),
  setActiveConnectors: wrap("cap:setActiveConnectors"),
  listModels: async () => ({ currentId: "m1", items: [{ id: "m1", name: "Mock 模型", desc: "d" }] }),
  switchModel: async () => ({ id: "m1" }),
  listKnowledgeBases: wrap("cap:listKnowledgeBases"),
  setActiveKnowledgeBases: wrap("cap:setActiveKnowledgeBases"),
  createKb: wrap("cap:createKb"),
  deleteKb: wrap("cap:deleteKb"),
  listKbDocs: wrap("cap:listKbDocs"),
  addKbDocs: wrap("cap:addKbDocs"),
  removeKbDoc: wrap("cap:removeKbDoc"),
  pickKbFiles: wrap("cap:pickKbFiles"),
  listAutomations: wrap("cap:listAutomations"),
  listWorkspaces: async () => ({ currentId: "default", items: [{ id: "default", label: "默认工作区", root: "C:\\\\ws" }, { id: "ws-2", label: "项目B", root: "D:\\\\proj-b" }] }),
  automationCatalog: async () => [{ id: "write_file", label: "写入文件" }, { id: "save_skill", label: "保存技能" }],
  createAutomation: wrap("cap:createAutomation"),
  updateAutomation: wrap("cap:updateAutomation"),
  deleteAutomation: wrap("cap:deleteAutomation"),
  runAutomation: wrap("cap:runAutomation"),
  automationRuns: wrap("cap:automationRuns"),
  listTemplates: wrap("cap:listTemplates"),
  createTemplate: wrap("cap:createTemplate"),
  updateTemplate: wrap("cap:updateTemplate"),
  deleteTemplate: wrap("cap:deleteTemplate"),
  recycleStats: wrap("cap:recycleStats"),
  clearRecycle: wrap("cap:clearRecycle"),
});`
);

// ---- 主进程侧内存态（模拟个人区 + mock 管理端目录/提交）----
const NAME_RE = /^[a-z0-9][a-z0-9-]*$/;
const personal = [
  { name: "weekly-report", desc: "生成销售周报时使用：规定周报结构与数据口径", enabled: true },
  { name: "meeting-minutes", desc: "整理会议纪要时使用：三段式输出", enabled: true },
];
const registry = [{ name: "erp-inventory-query", version: "1.0.0", description: "查询 ERP 库存数据（只读）" }];
const installed = {}; // name -> record
const submissions = []; // 提交后 push
const connectors = [{ name: "erp", displayName: "ERP 连接器", desc: "查询 ERP 库存与物料主数据（只读）", endpoint: "https://erp-gw.corp.local/mcp", enabled: true, tools: ["查 ERP 库存", "查物料主数据"], attached: false }];
let activeConnectors = [];
const kbPersonal = [];
let activeKBs = [];
// 自动化（本地型）：内存态 + 调用记录
const autos = [];
const autoCalls = [];
const expertCalls = [];
// 常用任务模板（/ 命令）
const tplList = [
  { id: "tpl-1", name: "周报", description: "读取销售数据生成本周周报", text: "请读取 data/sales.txt，生成本周销售周报，并写入 out/weekly-report.md", builtin: true },
  { id: "tpl-2", name: "核对", description: "对数据文件做一致性核对", text: "请读取工作区的数据文件，对数字做一致性核对，输出核对表和发现的差异。", builtin: true },
];
const tplCalls = [];
const clearCalls = [];
const editCalls = [];
let browserStubOpen = true;
const browserStopCalls = [];
const browserOpenUserCalls = [];
const termCloseCalls = [];
let termActive = false;
const termWrites = [];
  const termResizes = [];

app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  const handlers = {
    "cap:listSkills": () => [
      ...personal.map((s) => ({ id: s.name, name: s.name, desc: s.desc, scope: "个人", mine: true, enabled: s.enabled, active: s.enabled })),
      ...Object.keys(installed).map((n) => ({ id: n, name: n, desc: registry.find((r) => r.name === n)?.description ?? "", scope: "企业", mine: false, enabled: true, active: true })),
    ],
    "cap:setResourceEnabled": (_e, module, id, enabled) => {
      const s = personal.find((x) => x.name === id);
      if (s) s.enabled = !!enabled;
      const conn = connectors.find((x) => x.name === id);
      if (String(module) === "connector" && conn) conn.enabled = !!enabled;
      if (String(module) === "automation") {
        const t = autos.find((x) => x.id === id);
        if (t) {
          t.enabled = !!enabled;
          t.nextRunAt = t.enabled ? new Date(Date.now() + 3600e3).toISOString() : null;
        }
      }
      return true;
    },
    "cap:readSkill": (_e, name) => {
      if (personal.some((s) => s.name === name)) {
        return { name, description: personal.find((s) => s.name === name).desc, content: "# 内容\n\n规范正文。", filePath: `C:\\ws\\skills\\personal\\${name}\\SKILL.md`, scope: "个人", mine: true, enabled: true };
      }
      if (installed[name]) return { name, description: registry.find((r) => r.name === name)?.description ?? "", content: "# 企业技能\n", filePath: `C:\\ws\\skills\\enterprise\\${name}\\SKILL.md`, scope: "企业", mine: false, enabled: true };
      throw new Error(`未知技能: ${name}`);
    },
    "cap:updateSkill": (_e, name, input) => {
      const s = personal.find((x) => x.name === name);
      if (input?.description !== undefined) s.desc = input.description;
      return true;
    },
    "cap:deleteSkill": (_e, name) => {
      const i = personal.findIndex((s) => s.name === name);
      if (i >= 0) personal.splice(i, 1);
      return true;
    },
    "cap:importSkill": (_e, src) => {
      const name = path.basename(String(src)).toLowerCase();
      if (!NAME_RE.test(name)) throw new Error("名称仅允许小写字母、数字与连字符");
      personal.push({ name, desc: "导入演示技能", enabled: true });
      return { name, description: "导入演示技能", scope: "个人", mine: true };
    },
    "cap:pickSkillFolder": () => "D:\\downloads\\imported-demo",
    "cap:openSkillDir": () => true,
    "cap:skillMarket": () => registry.map((r) => ({ ...r, installed: !!installed[r.name], localVersion: installed[r.name]?.version })),
    "cap:skillInstalled": () => Object.entries(installed).map(([name, r]) => ({ name, version: r.version, state: r.state, lastSyncedAt: r.lastSyncedAt })),
    "cap:installSkill": (_e, name) => {
      installed[name] = { version: registry.find((r) => r.name === name)?.version ?? "1.0.0", state: "current", lastSyncedAt: new Date().toISOString() };
      return true;
    },
    "cap:uninstallSkill": (_e, name) => {
      delete installed[name];
      return true;
    },
    "cap:submitSkill": (_e, name) => {
      if (submissions.some((s) => s.name === name && (s.status === "submitted" || s.status === "reviewing"))) {
        throw new Error(`「${name}」已有进行中的审核（已提交），请等待结果`);
      }
      submissions.push({ id: `sub-${submissions.length + 1}`, name, version: "0.1.0", status: "submitted", submittedAt: new Date().toISOString() });
      return true;
    },
    "cap:skillSubmissions": () => submissions,
    "cap:syncSkills": () => ({ updated: [], removed: [] }),
    "cap:listKnowledgeBases": () => [
      { id: "kb-hr-policies", name: "公司制度库", desc: "人事与行政制度", scope: "企业", mine: false, enabled: true, attached: activeKBs.includes("kb-hr-policies"), docCount: 2 },
      ...kbPersonal.map((k) => ({ id: k.id, name: k.name, desc: "本地个人库 · 仅本机可用", scope: "个人", mine: true, enabled: true, attached: activeKBs.includes(k.id), docCount: k.docCount })),
    ],
    "cap:setActiveKnowledgeBases": (_e, ids) => {
      activeKBs = Array.isArray(ids) ? ids.map(String) : [];
      return activeKBs;
    },
    "cap:createKb": (_e, name) => {
      const clean = String(name ?? "").trim();
      if (!clean) throw new Error("知识库名称不能为空");
      if (kbPersonal.some((k) => k.name === clean)) throw new Error("已存在同名个人知识库");
      const kb = { id: "kb-p1", name: clean, docCount: 0 };
      kbPersonal.push(kb);
      return kb;
    },
    "cap:deleteKb": (_e, id) => {
      const i = kbPersonal.findIndex((k) => k.id === id);
      if (i >= 0) kbPersonal.splice(i, 1);
      return true;
    },
    "cap:listKbDocs": (_e, id) => (kbPersonal.find((k) => k.id === id)?.docs ?? [{ name: "规范.md", size: 420 }]),
    "cap:addKbDocs": (_e, id) => {
      const kb = kbPersonal.find((k) => k.id === id);
      if (kb) kb.docCount = 1;
      return { added: ["规范.md"], skipped: [] };
    },
    "cap:removeKbDoc": () => true,
    "cap:pickKbFiles": () => ["D:\docs\规范.md"],
    "cap:listConnectors": () => connectors.map((c) => ({ ...c, attached: activeConnectors.includes(c.name) })),
    "cap:newSession": () => {
      activeConnectors = [];
      activeKBs = [];
      win0.webContents.send("cap:ev", { type: "mounts_changed", connectors: [], kbs: [] });
      return true;
    },
    "cap:setActiveConnectors": (_e, names) => {
      activeConnectors = Array.isArray(names) ? names.map(String) : [];
      return activeConnectors;
    },
    "cap:listAutomations": () => autos,
    "cap:createAutomation": (_e, input) => {
      const sch = input?.schedule ?? {};
      const t = {
        id: `auto-${autos.length + 1}`,
        name: String(input?.name ?? ""),
        prompt: String(input?.prompt ?? ""),
        expertId: String(input?.expertId ?? "general"),
        wsId: String(input?.wsId || "default"),
        wsName: input?.wsId === "ws-2" ? "项目B" : "默认工作区",
        schedule: sch,
        preAuth: Array.isArray(input?.preAuth) ? input.preAuth : [],
        enabled: true,
        scheduleText: sch.kind === "daily" ? `每天 ${sch.time}` : sch.kind === "weekly" ? `每周一 ${sch.time}` : `每 ${sch.everyMinutes} 分钟`,
        nextRunAt: new Date(Date.now() + 3600e3).toISOString(),
        expertName: "通用助手",
        preAuthLabels: (input?.preAuth ?? []).map((p) => (p === "write_file" ? "写入文件" : p)),
        runCount: 0,
        lastRunAt: null,
      };
      autos.push(t);
      autoCalls.push(["create", t.name, sch.kind, t.wsId]);
      return t;
    },
    "cap:updateAutomation": (_e, id, patch) => {
      Object.assign(autos.find((t) => t.id === id) ?? {}, patch ?? {});
      autoCalls.push(["update", id]);
      return true;
    },
    "cap:deleteAutomation": (_e, id) => {
      const i = autos.findIndex((t) => t.id === id);
      if (i >= 0) autos.splice(i, 1);
      autoCalls.push(["delete", id]);
      return true;
    },
    "cap:runAutomation": (_e, id) => {
      autoCalls.push(["run", id]);
      win0.webContents.send("cap:ev", {
        type: "automation_run",
        id,
        name: autos.find((t) => t.id === id)?.name ?? "",
        ok: true,
        summary: "日报已生成并写入 out/daily.md",
        sessionId: "s-auto-1",
      });
      return { id: "r1", taskId: id, ok: true, summary: "日报已生成并写入 out/daily.md", sessionId: "s-auto-1" };
    },
    "cap:automationRuns": (_e, id) => [
      {
        id: "r1",
        taskId: id,
        taskName: autos.find((t) => t.id === id)?.name ?? "",
        trigger: "manual",
        startedAt: new Date().toISOString(),
        durationMs: 4200,
        ok: true,
        summary: "日报已生成并写入 out/daily.md",
        sessionId: "s-auto-1",
      },
    ],
    "cap:switchExpert": (_e, id) => {
      expertCalls.push(String(id));
      return true;
    },
    "cap:listTemplates": () => tplList,
    "cap:createTemplate": (_e, input) => {
      const t = { id: `tpl-new-${tplList.length + 1}`, name: String(input?.name ?? ""), description: String(input?.description ?? ""), text: String(input?.text ?? "") };
      tplList.push(t);
      tplCalls.push(["create", t.name]);
      return t;
    },
    "cap:updateTemplate": (_e, id, patch) => {
      Object.assign(tplList.find((t) => t.id === id) ?? {}, patch ?? {});
      tplCalls.push(["update", id]);
      return true;
    },
    "cap:deleteTemplate": (_e, id) => {
      const i = tplList.findIndex((t) => t.id === id);
      if (i >= 0) tplList.splice(i, 1);
      tplCalls.push(["delete", id]);
      return true;
    },
    "cap:recycleStats": () => ({ count: 250, bytes: 3145728 }),
    "cap:clearRecycle": () => {
      clearCalls.push(1);
      return 250;
    },
    "cap:imList": () => [
      { id: "dingtalk", label: "钉钉", enabled: false, configured: false, hasSecret: false, clientId: "", autoApprove: false, bindCode: "111111", conn: "off" },
      { id: "feishu", label: "飞书", enabled: true, configured: true, hasSecret: true, clientId: "cli_x", secretValue: "sec-abc", autoApprove: true, boundUser: "ou_u1", boundName: "测试", bindCode: "222222", conn: "online" },
    ],
    "cap:imSave": () => [],
    "cap:imUnbind": () => [],
    "cap:imNewBindCode": () => [],
    "cap:saveFileEdit": (_e, p, payload) => {
      editCalls.push({ p, payload });
      return { bytes: 99 };
    },
    "cap:browserState": () => ({ open: browserStubOpen, url: "https://intranet.example.com/report", origin: "https://intranet.example.com", consoleCount: 2, lastScreenshot: "" }),
    "cap:browserConsoleTail": () => [
      { seq: 1, kind: "log", text: "page-ready", at: "2026-09-01T10:00:00.000Z" },
      { seq: 2, kind: "error", text: "Uncaught TypeError: x is not a function", at: "2026-09-01T10:00:05.000Z" },
    ],
    "cap:termOpen": () => {
      termActive = true;
      return { id: "term", cols: 80, rows: 24, reused: false };
    },
    "cap:termWrite": (_e, data) => {
      termWrites.push(String(data));
      return true;
    },
    "cap:termResize": (_e, cols, rows) => {
      termResizes.push([cols, rows]);
      return true;
    },
    "cap:termClose": () => {
      termCloseCalls.push(1);
      termActive = false;
      return true;
    },
    "cap:termState": () => ({ active: termActive, cwd: "C:\\ws\\demo" }),
    "cap:browserOpenUser": (_e, url) => {
      browserOpenUserCalls.push(String(url));
      return true;
    },
    "cap:browserAttach": () => true,
    "cap:browserStop": () => {
      browserStopCalls.push(1);
      browserStubOpen = false;
      return true;
    },
  };
  for (const [ch, fn] of Object.entries(handlers)) ipcMain.handle(ch, fn);

  let win0 = null;
  const win = new BrowserWindow({ show: false, webPreferences: { preload: PRELOAD, contextIsolation: true, nodeIntegration: false, webviewTag: true } });
  win0 = win;
  const errors = [];
  win.webContents.on("console-message", (_e, level, message, lineNo, sourceId) => {
    // "Blocked script execution in 'about:srcdoc'" 是 HTML 预览沙箱按设计拦截脚本的证据，不算错误
    if (level >= 2 && !message.includes("Security Warning") && !message.includes("Blocked script execution in 'about:srcdoc'") && !message.includes("ResizeObserver loop")) errors.push(String(message) + " @" + (sourceId||"") + ":" + (lineNo||""));
  });
  await win.loadFile(path.join(__dirname, "../src/renderer/index.html"));
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  await sleep(900);

  const results = [];
  const check = (name, ok, detail = "") => results.push(`${ok ? "PASS" : "FAIL"} ${name}${detail ? `（${detail}）` : ""}`);
  // 轮询等待 DOM 条件成立（隐藏窗口过渡/布局会被节流，固定 sleep 不可靠）
  const waitFor = async (jsExpr, timeout = 6000) => {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      if (await win.webContents.executeJavaScript(jsExpr)) return true;
      await sleep(150);
    }
    return false;
  };
  // 注意：executeJavaScript 返回 DOM 节点会被序列化为 {}，断言一律在页面内取文本/布尔
  const exists = async (sel) => win.webContents.executeJavaScript(`!!document.querySelector(${JSON.stringify(sel)})`);
  const texts = async (sel) => win.webContents.executeJavaScript(`[...document.querySelectorAll(${JSON.stringify(sel)})].map(x => x.textContent || "")`);
  const click = async (sel) => win.webContents.executeJavaScript(`(document.querySelector(${JSON.stringify(sel)})||{click(){}}).click()`);

  try {
    // ① 打开技能市场：默认企业市场页签；三页签齐全；市场卡片 + 安装按钮；界面无 L1/L2 分级字眼
    await click("#nav-skills");
    await sleep(300);
    check("技能市场可打开", await exists("#module-page:not(.hidden)"));
    check("三页签齐全", (await texts(".mk-tab")).length === 3, (await texts(".mk-tab")).join("/"));
    check("默认展示企业市场", (await texts(".mk-section"))[0]?.includes("企业市场"));
    check("市场卡片可见", (await texts(".mk-card .r-name")).includes("erp-inventory-query"));
    check("未安装显示安装按钮", (await texts(".mk-card .install-btn")).includes("安装"));
    const lvText = await win.webContents.executeJavaScript(`document.body.textContent.match(/\\bL[12]\\b/g)?.join(",") ?? ""`);
    check("界面无 L1/L2 字眼", lvText === "", lvText);

    // ② 安装 → 卡片转已安装 → 已安装页签出现记录
    await win.webContents.executeJavaScript(`(function(){const b=[...document.querySelectorAll('.mk-card .install-btn')].find(x=>x.textContent==='安装'); if(!b) return false; b.click(); return true;})()`);
    await sleep(300);
    check("安装后显示已安装", (await texts(".mk-card .install-btn")).includes("已安装"));
    await win.webContents.executeJavaScript(`(function(){const t=[...document.querySelectorAll('.mk-tab')].find(x=>x.textContent.includes('已安装')); if(!t) return false; t.click(); return true;})()`);
    await sleep(300);
    check("已安装页签有记录", (await texts(".mk-card .r-name")).includes("erp-inventory-query"), (await texts(".mk-card .mk-desc"))[0]?.slice(0, 30));

    // ③ 卸载：垃圾桶图标 → 二次确认 → 记录消失
    await win.webContents.executeJavaScript(`(function(){const c=[...document.querySelectorAll('.mk-card')].find(x=>x.textContent.includes('erp-inventory-query')); if(!c) return false; c.querySelector('.mk-ops .del').click(); return true;})()`);
    await sleep(200);
    check("卸载需二次确认", await exists(".modal .m-footbar .danger"));
    await win.webContents.executeJavaScript(`(function(){const b=document.querySelector('.modal .m-footbar .danger'); if(!b) return false; b.click(); return true;})()`);
    await sleep(300);
    check("卸载后记录消失", !(await texts(".mk-card .r-name")).includes("erp-inventory-query"));

    // ④ 我的技能：卡片 + 仅「上传技能包」入口（表单创建已移除）
    await win.webContents.executeJavaScript(`(function(){const t=[...document.querySelectorAll('.mk-tab')].find(x=>x.textContent.includes('我的技能')); if(!t) return false; t.click(); return true;})()`);
    await sleep(300);
    check("我的技能卡片可见", (await texts(".mk-card .r-name")).includes("weekly-report"));
    check("仅保留上传入口", (await texts(".mk-addrow button")).join(",") === "上传技能包", (await texts(".mk-addrow button")).join(","));

    // ⑤ 详情：个人技能含 提交审核上架；提交后卡片带审核徽标；重复提交被拒
    await win.webContents.executeJavaScript(`(function(){const c=[...document.querySelectorAll('.mk-card')].find(x=>x.textContent.includes('meeting-minutes')); if(!c) return false; c.querySelector('.mk-desc').click(); return true;})()`);
    await sleep(300);
    check("详情弹窗打开", await exists(".modal .sk-pre"));
    check("详情含上架审核行", (await texts(".modal .m-row")).some((t) => t.includes("上架审核") && t.includes("未提交")));
    check("详情含提交审核按钮", (await texts(".modal .m-footbar .mini")).includes("提交审核上架"));
    await win.webContents.executeJavaScript(`(function(){const b=[...document.querySelectorAll('.modal .m-footbar .mini')].find(x=>x.textContent==='提交审核上架'); if(!b) return false; b.click(); return true;})()`);
    await sleep(300);
    check("提交后卡片带审核徽标", (await texts(".mk-card .mk-desc")).some((t) => t.includes("已提交审核")), (await texts(".mk-card .mk-desc")).find((t) => t.includes("meeting"))?.slice(-20));
    await win.webContents.executeJavaScript(`(function(){const c=[...document.querySelectorAll('.mk-card')].find(x=>x.textContent.includes('meeting-minutes')); if(!c) return false; c.querySelector('.mk-desc').click(); return true;})()`);
    await sleep(300);
    await win.webContents.executeJavaScript(`(function(){const b=[...document.querySelectorAll('.modal .m-footbar .mini')].find(x=>x.textContent==='提交审核上架'); if(!b) return false; b.click(); return true;})()`);
    await sleep(300);
    check("重复提交被拒(弹窗保留)", await exists(".modal"), "按钮报错 toast，弹窗不关闭");

    // ⑥ 删除个人技能：二次确认后卡片消失
    await win.webContents.executeJavaScript(`(function(){const b=[...document.querySelectorAll('.modal .m-footbar .mini')].find(x=>x.textContent==='删除'); if(!b) return false; b.click(); return true;})()`);
    await sleep(200);
    await win.webContents.executeJavaScript(`(function(){const b=document.querySelector('.modal .m-footbar .danger'); if(!b) return false; b.click(); return true;})()`);
    await sleep(300);
    check("删除后卡片消失", !(await texts(".mk-card .r-name")).includes("meeting-minutes"));

    // ⑦ 上传技能包：目录选择 → 导入 → 卡片出现
    await win.webContents.executeJavaScript(`(function(){const b=[...document.querySelectorAll('.mk-addrow button')].find(x=>x.textContent.includes('上传技能包')); if(!b) return false; b.click(); return true;})()`);
    await sleep(300);
    check("技能包导入后出现卡片", (await texts(".mk-card .r-name")).includes("imported-demo"));

    // ⑨ 连接器模块：导航入口 → 卡片与端点/工具信息；市场停用即时反映
    await click("#nav-connectors");
    await sleep(300);
    check("连接器模块可打开", await exists("#module-page:not(.hidden)"));
    check("连接器卡片可见", (await texts(".mk-card .r-name")).includes("ERP 连接器"));
    check("卡片含端点与工具", (await texts(".mk-card .mk-desc")).some((t) => t.includes("erp-gw.corp.local") && t.includes("查 ERP 库存")));
    await win.webContents.executeJavaScript(`(function(){const c=[...document.querySelectorAll('.mk-card')].find(x=>x.textContent.includes('ERP 连接器')); if(!c) return false; c.querySelector('.switch').click(); return true;})()`);
    await sleep(300);
    check("停用后卡片置灰", (await win.webContents.executeJavaScript(`!!document.querySelector('.mk-card.off')`)));
    await win.webContents.executeJavaScript(`(function(){document.querySelector('.mk-card.off .switch').click(); return true;})()`);
    await sleep(300);
    check("启用后卡片恢复", !(await win.webContents.executeJavaScript(`!!document.querySelector('.mk-card.off')`)));

    // ⑩ composer 挂载连接器：多选菜单勾选 → 徽标出现 → 主进程收到挂载集合
    await win.webContents.executeJavaScript(`(function(){const b=document.getElementById('conn-btn'); if(!b) return false; b.click(); return true;})()`);
    await sleep(350);
    const connMenuOk = await win.webContents.executeJavaScript(`(function(){const m=[...document.querySelectorAll('.menu-item')].find(x=>x.textContent.includes('ERP 连接器')); if(!m) return false; m.click(); return true;})()`);
    check("连接器菜单可选", connMenuOk);
    await sleep(250);
    const badgeShown = await win.webContents.executeJavaScript(`(function(){const b=document.querySelector('#conn-btn .pill-badge'); return !!b && !b.classList.contains('hidden') && b.textContent === '1';})()`);
    check("挂载徽标显示", badgeShown, "勾选后 badge=1");
    check("挂载集已上报", activeConnectors.join(",") === "erp", activeConnectors.join(","));

    // ⑪ 知识库模块：企业库卡片 + 新建个人库 → 详情（上传/删除）→ 挂载
    await click("#nav-kb");
    await sleep(300);
    check("知识库模块可打开", await exists("#module-page:not(.hidden)"));
    check("企业库卡片可见", (await texts(".mk-card .r-name")).includes("公司制度库"));
    check("个人库空态提示", (await texts(".drawer-empty")).some((t) => t.includes("还没有个人知识库")));
    await win.webContents.executeJavaScript(`(function(){const b=[...document.querySelectorAll('.mk-addrow button')].find(x=>x.textContent.includes('新建个人知识库')); if(!b) return false; b.click(); return true;})()`);
    await sleep(200);
    check("建库弹窗打开", await exists(".modal .m-form"));
    await win.webContents.executeJavaScript(`(function(){const i=document.querySelector('.modal .m-form input'); i.value='项目文档库'; i.dispatchEvent(new Event('input',{bubbles:true})); return true;})()`);
    await win.webContents.executeJavaScript(`(function(){const b=[...document.querySelectorAll('.modal .m-footbar .mini')].find(x=>x.textContent==='创建'); if(!b) return false; b.click(); return true;})()`);
    await sleep(300);
    check("个人库卡片出现", (await texts(".mk-card .r-name")).includes("项目文档库"));
    await win.webContents.executeJavaScript(`(function(){const c=[...document.querySelectorAll('.mk-card')].find(x=>x.textContent.includes('项目文档库')); if(!c) return false; c.querySelector('.mk-desc').click(); return true;})()`);
    await sleep(300);
    check("库详情含上传与删除", (await texts(".modal .m-footbar .mini")).filter((t) => t.includes("上传文档") || t.includes("删除知识库")).length === 2);
    await win.webContents.executeJavaScript(`(function(){const b=[...document.querySelectorAll('.modal .m-footbar .mini')].find(x=>x.textContent.includes('上传文档')); if(!b) return false; b.click(); return true;})()`);
    await sleep(300);
    check("文档入库后卡片计数", (await texts(".mk-card .mk-desc")).some((t) => t.includes("1 篇文档")), (await texts(".mk-card .mk-desc")).find((t) => t.includes("篇文档")) || "");

    // ⑫ kb-btn 挂载：多选勾选 → 徽标 → 上报挂载集合
    await win.webContents.executeJavaScript(`(function(){const b=document.getElementById('kb-btn'); if(!b) return false; b.click(); return true;})()`);
    await sleep(350);
    const kbMenuOk = await win.webContents.executeJavaScript(`(function(){const m=[...document.querySelectorAll('.menu-item')].find(x=>x.textContent.includes('公司制度库')); if(!m) return false; m.click(); return true;})()`);
    check("知识库菜单可选", kbMenuOk);
    await sleep(250);
    const kbBadge = await win.webContents.executeJavaScript(`(function(){const b=document.querySelector('#kb-btn .pill-badge'); return !!b && !b.classList.contains('hidden') && b.textContent === '1';})()`);
    check("知识库挂载徽标", kbBadge);
    check("知识库挂载已上报", activeKBs.join(",") === "kb-hr-policies", activeKBs.join(","));

    // ⑬ 新建会话：挂载徽标随主进程广播立即归零（不留“看着挂了其实没有”的假状态）
    const badgeBefore = await win.webContents.executeJavaScript(`(function(){const b=document.querySelector('#kb-btn .pill-badge'); return !!b && !b.classList.contains('hidden') && b.textContent === '1';})()`);
    check("会话中挂载徽标显示", badgeBefore);
    await click("#new-session");
    await sleep(300);
    const badgeAfter = await win.webContents.executeJavaScript(`(function(){const b=document.querySelector('#kb-btn .pill-badge'); return !!b && b.classList.contains('hidden');})()`);
    check("新建会话徽标归零", badgeAfter);

    // ⑭ $ 符号菜单：输入 $ 触发，选择后保留 $ 前缀（供主进程展开）
    await win.webContents.executeJavaScript(`(function(){const i=document.getElementById("input"); i.value='$'; i.dispatchEvent(new Event("input",{bubbles:true})); return true;})()`);
    await sleep(350);
    const menuOk = await win.webContents.executeJavaScript(`(function(){const m=document.querySelector('.symbol-menu .menu-item'); if(!m) return false; m.dispatchEvent(new MouseEvent('mousedown',{bubbles:true})); return true;})()`);
    check("$ 菜单可选技能", menuOk);
    const inputVal = await win.webContents.executeJavaScript(`document.getElementById("input").value`);
    check("$ 引用保留前缀", inputVal.includes("$weekly-report"), inputVal);

    // ⑮ 自动化模块：仅个人任务（管理端编排不展示）；空态提示
    await click("#nav-automations");
    await sleep(300);
    check("自动化模块可打开", await exists("#module-page:not(.hidden)"));
    const autoBody1 = await win.webContents.executeJavaScript(`document.querySelector("#mv-body").textContent`);
    check("不出现企业下发分区", !autoBody1.includes("企业下发"));
    check("个人任务空态提示", autoBody1.includes("还没有自动化任务"));

    // ⑯ 新建任务：表单（指令/专家/调度/预授权）→ 卡片（调度文本 + 下次时间）
    await win.webContents.executeJavaScript(`(function(){const b=[...document.querySelectorAll('.mk-addrow button')].find(x=>x.textContent.includes('新建自动化任务')); if(!b) return false; b.click(); return true;})()`);
    await sleep(300);
    check(
      "新建表单字段齐全",
      (await texts(".modal .f-label")).some((t) => t.includes("任务指令")) &&
        (await texts(".modal .f-label")).some((t) => t.includes("预授权")) &&
        (await exists(".modal .m-form select"))
    );
    await win.webContents.executeJavaScript(
      `(function(){const i=document.querySelector('.modal .m-form input[type=text]'); i.value='每日晨报'; const ta=document.querySelector('.modal .m-form textarea'); ta.value='汇总 data 目录生成晨报写入 out/daily.md'; const cb=document.querySelector('.modal .m-form input[type=checkbox]'); if(cb) cb.checked=true; const sels=document.querySelectorAll('.modal .m-form select'); if(sels[1]) sels[1].value='ws-2'; return true;})()`
    );
    await win.webContents.executeJavaScript(`(function(){const b=[...document.querySelectorAll('.modal .m-footbar .mini')].find(x=>x.textContent==='创建'); if(!b) return false; b.click(); return true;})()`);
    await sleep(300);
    check("任务卡片出现", (await texts(".mk-card .r-name")).includes("每日晨报"));
    check("创建携带工作目录", autoCalls.some((c) => c[0] === "create" && c[3] === "ws-2"), autoCalls.map((c) => c.join("/")).join(","));
    check("卡片显示绑定目录", (await texts(".mk-card .mk-desc")).some((t) => t.includes("目录 项目B")));
    check("仅个人任务分区", (await texts(".mk-section")).some((t) => t.includes("我的自动化")) && !(await texts("#mv-body")).some((t) => t.includes("企业下发")));
    check(
      "卡片含调度与下次时间",
      (await texts(".mk-card .mk-desc")).some((t) => t.includes("每天 09:00") && t.includes("下次")),
      (await texts(".mk-card .mk-desc")).find((t) => t.includes("每天")) ?? ""
    );

    // ⑰ 启停开关走资源开关（module=automation），停用去掉下次时间
    await win.webContents.executeJavaScript(`(function(){const c=[...document.querySelectorAll('.mk-card')].find(x=>x.textContent.includes('每日晨报')); if(!c) return false; c.querySelector('.switch').click(); return true;})()`);
    await sleep(300);
    check("停用后卡片置灰", await win.webContents.executeJavaScript(`!!document.querySelector('.mk-card.off')`));
    check("停用去掉下次时间", !(await texts(".mk-card .mk-desc")).some((t) => t.includes("下次")));
    await win.webContents.executeJavaScript(`(function(){document.querySelector('.mk-card.off .switch').click(); return true;})()`);
    await sleep(300);
    check("启用后卡片恢复", !(await win.webContents.executeJavaScript(`!!document.querySelector('.mk-card.off')`)));

    // ⑱ 详情：任务指令 + 预授权范围 + 运行记录（可打开会话）+ 立即运行（完成提醒）
    await win.webContents.executeJavaScript(`(function(){const c=[...document.querySelectorAll('.mk-card')].find(x=>x.textContent.includes('每日晨报')); if(!c) return false; c.querySelector('.mk-desc').click(); return true;})()`);
    await sleep(300);
    check("详情含任务指令", (await texts(".modal .sk-pre")).some((t) => t.includes("汇总 data 目录")));
    check("详情含工作目录", (await texts(".modal .f-label")).some((t) => t.includes("工作目录：项目B")));
    check("详情含预授权范围", (await texts(".modal .f-label")).some((t) => t.includes("预授权：写入文件")));
    check("详情含运行记录", (await texts(".modal .m-sec")).some((t) => t.includes("运行记录")));
    check("记录行可打开会话", (await texts(".modal .auto-run-head .mini")).includes("打开会话"));
    await win.webContents.executeJavaScript(`(function(){const b=[...document.querySelectorAll('.modal .m-footbar .mini')].find(x=>x.textContent==='立即运行'); if(!b) return false; b.click(); return true;})()`);
    await sleep(400);
    check("立即运行已触发", autoCalls.some((c) => c[0] === "run"), autoCalls.map((c) => c[0]).join(","));
    check("运行完成提示", (await texts("#ordo-toast span")).some((t) => t.includes("本次运行完成")), (await texts("#ordo-toast span")).join(""));
    win.webContents.send("cap:ev", { type: "automation_run", id: "auto-1", name: "每日晨报", ok: true, summary: "日报已生成", sessionId: "s-auto-1" });
    await sleep(250);
    check("定时触发完成提醒", (await texts("#ordo-toast span")).some((t) => t.includes("自动化") && t.includes("已完成")), (await texts("#ordo-toast span")).join(""));

    // ⑲ 删除：二次确认 → 卡片消失
    await win.webContents.executeJavaScript(`(function(){const c=[...document.querySelectorAll('.mk-card')].find(x=>x.textContent.includes('每日晨报')); if(!c) return false; c.querySelector('.mk-ops .del').click(); return true;})()`);
    await sleep(250);
    check("删除需二次确认", await exists(".modal .m-footbar .danger"));
    await win.webContents.executeJavaScript(`(function(){const b=document.querySelector('.modal .m-footbar .danger'); if(!b) return false; b.click(); return true;})()`);
    await sleep(300);
    check("删除后卡片消失", !(await texts(".mk-card .r-name")).includes("每日晨报"));

    // ⑳ 专家页：真实契约字段（description/白名单）、卡片无启停开关、详情（人设+资源范围）、新建会话使用；页脚无假申请按钮
    await click("#nav-experts");
    await sleep(300);
    check("专家页可打开", await exists("#module-page:not(.hidden)"));
    check("页脚无申请按钮", !(await exists("#mv-foot button")));
    check("专家卡片描述可见", (await texts(".mk-card .mk-desc")).some((t) => t.includes("核对图纸")));
    check(
      "卡片资源范围行",
      (await texts(".mk-card .mk-perms")).some((t) => t.includes("资源范围：") && t.includes("技能 不挂") && t.includes("知识库 不挂")),
      (await texts(".mk-card .mk-perms")).join(" | ")
    );
    check("专家卡片无启停开关", !(await exists(".mk-card .switch")));
    await win.webContents.executeJavaScript(`(function(){const c=[...document.querySelectorAll('.mk-card')].find(x=>x.textContent.includes('图纸核对工程师')); if(!c) return false; c.querySelector('.mk-desc').click(); return true;})()`);
    await sleep(300);
    check("专家详情人设", (await texts(".modal .sk-pre")).some((t) => t.includes("一致性")));
    check("详情白名单解析", (await texts(".modal .f-label")).some((t) => t.includes("知识库：不挂")));
    check("详情含使用按钮", (await texts(".modal .m-footbar .mini")).includes("新建会话并使用"));
    await win.webContents.executeJavaScript(`(function(){const b=[...document.querySelectorAll('.modal .m-footbar .mini')].find(x=>x.textContent==='新建会话并使用'); if(!b) return false; b.click(); return true;})()`);
    await sleep(300);
    check("使用专家走新建会话", expertCalls.includes("drawing-checker"), expertCalls.join(","));

    // ㉑ / 常用任务模板 + 符号菜单竞态防护
    const setInput = (v) =>
      win.webContents.executeJavaScript(
        `(function(){const i=document.getElementById("input"); i.value=${JSON.stringify(v)}; i.dispatchEvent(new Event("input",{bubbles:true})); return true;})()`
      );
    // 竞态防护：敲 $ 后立刻清空（技能列表 250ms 后才到），过期的菜单不应再弹出
    await setInput("$");
    await setInput("");
    await sleep(700);
    check("过期菜单不再弹出", !(await exists(".symbol-menu")));
    // / 模板菜单：真实契约数据 + 管理入口
    await setInput("/");
    await sleep(300);
    check("/ 菜单列模板", (await texts(".symbol-menu .mi-name")).some((t) => t === "/周报"), (await texts(".symbol-menu .mi-name")).join(","));
    check("/ 菜单含管理入口", (await texts(".symbol-menu .mi-name")).includes("管理模板…"));
    await win.webContents.executeJavaScript(
      `(function(){const m=[...document.querySelectorAll('.symbol-menu .menu-item')].find(x=>x.textContent.includes('/周报')); if(!m) return false; m.dispatchEvent(new MouseEvent('mousedown',{bubbles:true})); return true;})()`
    );
    await sleep(200);
    const tplInput = await win.webContents.executeJavaScript(`document.getElementById("input").value`);
    check("选中插入模板正文", tplInput.includes("请读取 data/sales.txt") && !tplInput.includes("/周报"), tplInput.slice(0, 30));
    // Esc 收起 + @ 菜单出现（退格/空格由竞态防护覆盖）
    await setInput("@");
    await sleep(150);
    check("@ 菜单出现", await exists(".symbol-menu"));
    await win.webContents.executeJavaScript(`document.dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true}))`);
    await sleep(150);
    check("Esc 收起符号菜单", !(await exists(".symbol-menu")));
    // 快捷命令模块页：/ 菜单的「管理模板」跳模块页（侧栏入口）；卡片 + 新建 → 编辑器 → 回页面
    await setInput("/");
    await sleep(300);
    await win.webContents.executeJavaScript(
      `(function(){const m=[...document.querySelectorAll('.symbol-menu .menu-item')].find(x=>x.textContent.includes('管理模板')); if(!m) return false; m.dispatchEvent(new MouseEvent('mousedown',{bubbles:true})); return true;})()`
    );
    await sleep(300);
    check("管理入口跳模块页", (await win.webContents.executeJavaScript(`document.querySelector("#mv-title")?.textContent || ""`)) === "快捷命令");
    check("模板卡片可见", (await texts(".mk-card .r-name")).some((t) => t === "/周报"));
    check("卡片无启停开关", !(await exists(".mk-card .switch")));
    await win.webContents.executeJavaScript(
      `(function(){const b=[...document.querySelectorAll('.mk-addrow button')].find(x=>x.textContent.includes('新建模板')); if(!b) return false; b.click(); return true;})()`
    );
    await sleep(250);
    await win.webContents.executeJavaScript(
      `(function(){const ins=[...document.querySelectorAll('.modal .m-form input[type=text]')]; ins[0].value='自建模板'; ins[1].value='说明'; const ta=document.querySelector('.modal .m-form textarea'); ta.value='测试正文'; return true;})()`
    );
    await win.webContents.executeJavaScript(`(function(){const b=[...document.querySelectorAll('.modal .m-footbar .mini')].find(x=>x.textContent==='创建'); if(!b) return false; b.click(); return true;})()`);
    await sleep(300);
    check("新建模板回页面", (await texts(".mk-card .r-name")).some((t) => t === "/自建模板"), (await texts(".mk-card .r-name")).join(","));
    // 侧栏导航直达（先切去别的模块再点回来，避免"再点同模块=返回对话"的开关语义）+ 删除清场
    await win.webContents.executeJavaScript(`document.getElementById("nav-experts").click()`);
    await sleep(300);
    await win.webContents.executeJavaScript(`document.getElementById("nav-commands").click()`);
    await sleep(300);
    check("侧栏快捷命令入口", await exists("#module-page:not(.hidden)"));
    await win.webContents.executeJavaScript(`(function(){const c=[...document.querySelectorAll('.mk-card')].find(x=>x.textContent.includes('/自建模板')); if(!c) return false; c.querySelector('.mk-ops .del').click(); return true;})()`);
    await sleep(250);
    await win.webContents.executeJavaScript(`(function(){const b=document.querySelector('.modal .m-footbar .danger'); if(!b) return false; b.click(); return true;})()`);
    await sleep(300);
    check("删除后卡片消失", !(await texts(".mk-card .r-name")).includes("/自建模板"));

    // ㉒ 设置（一级页面）：落盘位置为真实路径（非演示常量）+ 回收站行（统计 + 清空二次确认）
    await click("#open-settings");
    await sleep(400);
    check("设置页打开", await exists("#module-page:not(.hidden) .settings-page"));
    await win.webContents.executeJavaScript(`(function(){const b=[...document.querySelectorAll('.st-nav-item')].find(x=>x.textContent==='存储'); if(b) b.click(); return !!b;})()`);
    await sleep(200);
    const dirText = await win.webContents.executeJavaScript(
      `(function(){const r=[...document.querySelectorAll('.settings-page .m-row')].find(x=>x.textContent.includes('默认工作区目录')); return r ? r.querySelector('.m-mono').textContent : '';})()`
    );
    check("落盘位置为真实路径", dirText.includes("ws") && !dirText.includes("demo"), dirText);
    const recycleText = await win.webContents.executeJavaScript(
      `(function(){const r=[...document.querySelectorAll('.settings-page .m-row')].find(x=>x.querySelector('.mini.danger') && x.textContent.includes('回收站')); return r ? r.textContent : '';})()`
    );
    check("回收站统计显示", recycleText.includes("250 项"), recycleText.slice(0, 50));
    await win.webContents.executeJavaScript(
      `(function(){const r=[...document.querySelectorAll('.settings-page .m-row')].find(x=>x.querySelector('.mini.danger') && x.textContent.includes('回收站')); if(!r) return false; r.querySelector('.mini.danger').click(); return true;})()`
    );
    await sleep(250);
    check("清空需二次确认", await exists(".modal .m-footbar .danger"));
    await win.webContents.executeJavaScript(`(function(){const b=document.querySelector('.modal .m-footbar .danger'); if(!b) return false; b.click(); return true;})()`);
    await sleep(300);
    check("确认后执行清空", clearCalls.length === 1, String(clearCalls.length));

    // ㉒c 历史会话操作条回归：离开对话（设置页开着）→ 侧栏点开历史会话 → 最终回答必须挂操作条（复制/重新生成）
    await win.webContents.executeJavaScript(`(function(){const b=[...document.querySelectorAll('.session-item')].find(x=>x.textContent.includes('历史回归会话')); if(b) b.click(); return !!b;})()`);
    await sleep(500);
    const histAct = await win.webContents.executeJavaScript(`(function(){
      const bar = document.querySelector('#thread .msg-actions');
      if (!bar) return { found: false };
      return { found: true, hasCopy: !!bar.querySelector('[title="复制回答"]'), hasRegen: !!bar.querySelector('[title="重新生成"]'), hasFeedback: !!bar.querySelector('[title="有用"]') };
    })()`);
    check("历史会话最终回答挂操作条", histAct.found === true && histAct.hasCopy && histAct.hasRegen && histAct.hasFeedback, JSON.stringify(histAct));
    await win.webContents.executeJavaScript(`(function(){const b=[...document.querySelectorAll('.session-item')].find(x=>!x.textContent.includes('历史回归会话')); if(b) b.click(); return true;})()`);
    await sleep(300);

    // ㉒b IM 通道节：双卡渲染 + Secret 预填与眼睛切换
    await win.webContents.executeJavaScript(`(function(){const b=[...document.querySelectorAll('.st-nav-item')].find(x=>x.textContent==='IM 通道'); if(b) b.click(); return !!b;})()`);
    await sleep(300);
    const imCards = await win.webContents.executeJavaScript(`document.querySelectorAll('.settings-page .m-model-form').length`);
    check("IM 通道双卡渲染", imCards === 2, String(imCards));
    const imDiag = await win.webContents.executeJavaScript(`(function(){
      const card = [...document.querySelectorAll('.settings-page .m-model-form')].find(x=>x.dataset.im==='feishu');
      if (!card) return { found: false };
      const input = card.querySelector('[data-k="secret"]');
      const eye = card.querySelector('.secret-eye');
      const before = input ? input.type : '';
      if (eye) eye.click();
      return { found: true, val: input ? input.value : '', before, after: input ? input.type : '', bound: (card.querySelector('[data-role=bound]')||{}).textContent || '' };
    })()`);
    check("IM Secret 预填+眼睛切换", imDiag.found === true && imDiag.val === "sec-abc" && imDiag.before === "password" && imDiag.after === "text", JSON.stringify(imDiag));
    check("IM 绑定状态显示", imDiag.found === true && String(imDiag.bound).includes("已绑定"), JSON.stringify(imDiag));

    // ㉓ 工作台预览：真实交付链路（写入确认→交付卡→工作台）覆盖 HTML 沙箱/图片/PDF/不支持/文本
    await win.webContents.executeJavaScript(`(function(){document.getElementById("mv-back").click(); return true;})()`); // 设置页返回工作区
    await sleep(200);
    await win.webContents.executeJavaScript(`document.getElementById("nav-commands").click()`); // 模块页切回对话
    await sleep(200);
    const deliver = async (p) => {
      win.webContents.send("cap:ev", { type: "run_start" });
      win.webContents.send("cap:ev", { type: "tool_start", name: "write_file", args: { path: p, content: "x" } });
      win.webContents.send("cap:ev", { type: "confirm_request", id: "pv-" + p, tool: "write_file", args: { path: p, content: "x" } });
      await sleep(200);
      await win.webContents.executeJavaScript(
        `(function(){const b=[...document.querySelectorAll('.confirm-card.pending .btn-ink')].pop(); if(!b) return false; b.click(); return true;})()`
      );
      await sleep(150);
      win.webContents.send("cap:ev", { type: "tool_end" });
      win.webContents.send("cap:ev", { type: "assistant_done" });
      win.webContents.send("cap:ev", { type: "run_end" });
      await sleep(250);
    };
    // 面板去工作台化（D4）：交付物入口在浮标浮层，openPreview 经浮层打开
    const openPreview = async (p) => {
      await win.webContents.executeJavaScript(
        `(function(){const bub=document.getElementById("progress-bubble"); if(!bub) return "no-bubble"; bub.click(); const pop=document.querySelector(".pb-pop"); if(!pop) return "no-pop"; const it=[...pop.querySelectorAll(".pb-file")].find(x=>x.querySelector(".f-path").textContent===${JSON.stringify(p)}); if(!it) return "no-file"; it.click(); return true;})()`
      );
      await sleep(350);
    };
    await deliver("preview/demo.html");
    check("首个交付不再自动开面板（D4）", await win.webContents.executeJavaScript(`!document.getElementById("workbench").classList.contains("open")`));
    // B 方案拍平：回合折叠行内工具步骤行同层直排，无组外壳；头部报总耗时
    const foldState = await win.webContents.executeJavaScript(
      `(function(){const f=document.querySelector(".turn-fold"); if(!f) return null; const list=f.querySelector(".group-list"); return { head: f.querySelector(".g-label") ? f.querySelector(".g-label").textContent : "", rows: list ? list.querySelectorAll(":scope > .tool-row").length : -1, nestedGroups: list ? list.querySelectorAll(":scope > .group").length : -1, confirms: list ? list.querySelectorAll(":scope > .confirm-card").length : -1 };})()`
    );
    check(
      "回合折叠拍平（步骤行同层，无组外壳）",
      !!foldState && foldState.rows >= 1 && foldState.nestedGroups === 0 && foldState.confirms >= 1,
      JSON.stringify(foldState)
    );
    check("折叠头部报总耗时（执行过程 · Ns）", !!foldState && /^执行过程 · [\d.]+(s|m)/.test(foldState.head), foldState ? foldState.head : "无折叠行");
    await win.webContents.executeJavaScript(`document.getElementById("progress-bubble").click()`);
    await sleep(200);
    check("交付物进入浮层清单", (await texts(".pb-pop .pb-file .f-path")).includes("preview/demo.html"));
    await win.webContents.executeJavaScript(`document.getElementById("progress-bubble").click()`);
    await sleep(150);
    await openPreview("preview/demo.html");
    check("HTML 预览出沙箱框架", await exists(".wb-preview-frame"));
    check("在浏览器打开入口（完整渲染升级路径）", (await texts(".wb-preview-tab")).some((t) => t.includes("在浏览器打开")));
    check(
      "沙箱交互渲染（allow-scripts 且无 same-origin）",
      (await win.webContents.executeJavaScript(`(function(){const f=document.querySelector(".wb-preview-frame"); if(!f) return "missing"; const s=f.getAttribute("sandbox")||""; return s.includes("allow-scripts") && !s.includes("allow-same-origin") ? "ok" : s;})()`)) === "ok"
    );
    // 脚本真在跑：iframe 内联脚本 postMessage 出证据（opaque 源沙箱内无法直接读，经消息通道验证）
    {
      const scriptRan = await win.webContents.executeJavaScript(`(async () => {
        let got = false;
        const h = (e) => { if (e.data === "ordo-sandbox-script-ran") got = true; };
        window.addEventListener("message", h);
        try {
          for (let i = 0; i < 20 && !got; i++) await new Promise((r) => setTimeout(r, 150));
        } finally { window.removeEventListener("message", h); }
        return got;
      })()`);
      check("沙箱内联脚本已放行（交互渲染生效）", scriptRan === true);
    }
    check(
      "srcdoc 注入页面内容",
      (await win.webContents.executeJavaScript(`(function(){const f=document.querySelector(".wb-preview-frame"); return f ? f.srcdoc : "";})()`)).includes("<h1>你好</h1>")
    );
    check(
      "HTML 预览注入 CSP 掐断外联",
      (await win.webContents.executeJavaScript(`(function(){const f=document.querySelector(".wb-preview-frame"); return f ? f.srcdoc : "";})()`)).includes("Content-Security-Policy") &&
        (await win.webContents.executeJavaScript(`(function(){const f=document.querySelector(".wb-preview-frame"); return f ? f.srcdoc : "";})()`)).includes("default-src 'none'")
    );
    await win.webContents.executeJavaScript(
      `(function(){const b=[...document.querySelectorAll('.wb-preview-tab')].find(x=>x.textContent==='源码'); if(!b) return false; b.click(); return true;})()`
    );
    await sleep(150);
    check(
      "源码模式转义显示",
      (await win.webContents.executeJavaScript(`(function(){const s=document.querySelector(".wb-preview-src"); return s && !s.classList.contains("hidden") ? s.textContent : "";})()`)).includes("<h1>你好</h1>")
    );
    check(
      "源码模式隐藏框架",
      await win.webContents.executeJavaScript(`(function(){const w=document.querySelector(".wb-res-wrap"); return w ? w.classList.contains("hidden") : false;})()`)
    );
    await win.webContents.executeJavaScript(
      `(function(){const b=[...document.querySelectorAll('.wb-preview-tab')].find(x=>x.textContent==='效果'); if(!b) return false; b.click(); return true;})()`
    );
    await sleep(150);
    check(
      "切回效果模式",
      await win.webContents.executeJavaScript(`(function(){const w=document.querySelector(".wb-res-wrap"); return w ? !w.classList.contains("hidden") : false;})()`)
    );

    // ㉓c 预览面板分辨率预设（方案 §4 v1）：iframe 真实宽度 + 等比缩放塞入面板
    check(
      "分辨率预设条齐全（375/768/1280/1920/自适应/自定义）",
      (await texts(".wb-res-btn")).includes("375") &&
        (await texts(".wb-res-btn")).includes("1920") &&
        (await texts(".wb-res-btn")).includes("自适应") &&
        !!(await win.webContents.executeJavaScript(`!!document.querySelector(".wb-res-input")`))
    );
    // 隐藏窗口过渡被节流：先等缩放容器拿到真实布局尺寸，再点预设（否则 scale 为负值）
    await waitFor(`(function(){const w=document.querySelector(".wb-res-wrap"); return w && !w.classList.contains("hidden") && w.clientWidth > 50;})()`, 5000);
    await win.webContents.executeJavaScript(`(function(){const b=[...document.querySelectorAll('.wb-res-btn')].find(x=>x.textContent==='375'); if(!b) return false; b.click(); return true;})()`);
    await waitFor(`(function(){const s=document.querySelector(".wb-res-scaler"); return s && s.style.transform && !s.style.transform.includes("-");})()`, 4000);
    const resState = await win.webContents.executeJavaScript(
      `(function(){const s=document.querySelector(".wb-res-scaler"); const f=document.querySelector(".wb-res-wrap .wb-preview-frame"); return s && f ? { w: s.style.width, transform: s.style.transform, frameH: f.style.height } : null;})()`
    );
    check("375 预设：真实宽度+缩放生效", resState && resState.w === "375px" && resState.transform.includes("scale") && Number(resState.transform.replace(/^.*scale\(/, "").replace(/\).*$/, "")) > 0 && resState.frameH.endsWith("px"), JSON.stringify(resState));
    await win.webContents.executeJavaScript(
      `(function(){const b=[...document.querySelectorAll('.wb-res-btn')].find(x=>x.textContent==='自适应'); if(!b) return false; b.click(); return true;})()`
    );
    await sleep(150);
    check(
      "自适应还原面板宽",
      await win.webContents.executeJavaScript(`(function(){const s=document.querySelector(".wb-res-scaler"); return s ? !s.style.transform : false;})()`)
    );
    // 拖宽：pointer 事件拖 resizer，宽度落 localStorage（轮询等过渡收尾）
    await win.webContents.executeJavaScript(
      `(function(){const r=document.getElementById("wb-resizer"); const x0=window.innerWidth; const target=520; r.dispatchEvent(new PointerEvent("pointerdown",{pointerId:1,bubbles:true})); r.dispatchEvent(new PointerEvent("pointermove",{pointerId:1,bubbles:true,clientX:x0-target})); r.dispatchEvent(new PointerEvent("pointerup",{pointerId:1,bubbles:true})); return true;})()`
    );
    check(
      "面板可拖宽并持久化（280~50% 窗宽）",
      await waitFor(
        `(function(){const w=document.getElementById("workbench").getBoundingClientRect().width; const saved=Number(localStorage.getItem("sd.preview.width")); return w>=280 && w<=Math.round(window.innerWidth*0.5) && saved>=280;})()`,
        4000
      )
    );

    // ㉓a 状态中心合并（顶栏就绪组件退场 + 面板真关闭回归；圆盘断言在归零处验）
    check("顶栏状态徽标已移除（并入浮标）", await win.webContents.executeJavaScript(`!document.getElementById("status-badge")`));
    check("顶栏文件夹按钮已移除", await win.webContents.executeJavaScript(`!document.getElementById("open-ws-dir")`));
    await win.webContents.executeJavaScript(`document.getElementById("wb-toggle").click()`);
    await sleep(300);
    await win.webContents.executeJavaScript(`document.getElementById("wb-collapse").click()`);
    // 隐藏窗口过渡时钟会被节流：轮询等收起完成而非固定 sleep
    check(
      "面板关闭真实收起（内联宽度已清）",
      await waitFor(`(function(){const w=document.getElementById("workbench"); return !w.classList.contains("open") && w.getBoundingClientRect().width < 2;})()`, 4000)
    );
    await win.webContents.executeJavaScript(`document.getElementById("wb-toggle").click()`);
    await sleep(300);

    // ㉓b 悬浮进度浮标（方案 §3）：泛化完成态 → 计划运行态 → 待确认呼吸 → 完成 → 浮层清单/交付物 → 出错态
    check(
      "浮标无计划任务显已完成",
      (await win.webContents.executeJavaScript(`(function(){const b=document.getElementById("progress-bubble"); return { cls: b.className, label: b.querySelector(".pb-label").textContent };})()`)).label === "已完成"
    );
    await win.webContents.send("cap:ev", { type: "run_start" });
    await sleep(120);
    await win.webContents.send("cap:ev", {
      type: "plan_update",
      steps: [
        { text: "读取数据", status: "done" },
        { text: "生成周报", status: "running" },
        { text: "写入文件", status: "pending" },
      ],
    });
    await sleep(200);
    const bubRun = await win.webContents.executeJavaScript(`(function(){const b=document.getElementById("progress-bubble"); return { cls: b.className, label: b.querySelector(".pb-label").textContent };})()`);
    check("浮标计划运行态（done/total · 当前项）", bubRun.cls.includes("running") && bubRun.label.includes("计划 1/3") && bubRun.label.includes("生成周报"), bubRun.label);
    await win.webContents.send("cap:ev", { type: "tool_start", name: "write_file" });
    win.webContents.send("cap:ev", { type: "confirm_request", id: "pb-c1", tool: "write_file", args: { path: "out/x.md", content: "x" } });
    await sleep(200);
    check(
      "待确认时浮标呼吸高亮",
      await win.webContents.executeJavaScript(`(function(){return document.getElementById("progress-bubble").classList.contains("confirm");})()`)
    );
    await win.webContents.executeJavaScript(`(function(){const b=[...document.querySelectorAll('.confirm-card.pending .btn-ink')].pop(); if(!b) return false; b.click(); return true;})()`);
    await sleep(200);
    check(
      "确认后呼吸解除",
      await win.webContents.executeJavaScript(`(function(){return !document.getElementById("progress-bubble").classList.contains("confirm");})()`)
    );
    await win.webContents.send("cap:ev", { type: "tool_end", name: "write_file" });
    await win.webContents.send("cap:ev", { type: "assistant_done" });
    await win.webContents.send("cap:ev", {
      type: "plan_update",
      steps: [
        { text: "读取数据", status: "done" },
        { text: "生成周报", status: "done" },
        { text: "写入文件", status: "done" },
      ],
    });
    await sleep(150);
    await win.webContents.send("cap:ev", { type: "run_end" });
    await sleep(200);
    const bubDone = await win.webContents.executeJavaScript(`(function(){const b=document.getElementById("progress-bubble"); return { cls: b.className, label: b.querySelector(".pb-label").textContent };})()`);
    check("浮标计划完成态（3/3）", bubDone.cls.includes("done") && bubDone.label.includes("计划 3/3"), bubDone.label);
    await win.webContents.executeJavaScript(`document.getElementById("progress-bubble").click()`);
    await sleep(150);
    check("浮层展开：计划清单 + 交付物", await exists(".pb-pop") && (await win.webContents.executeJavaScript(`document.querySelectorAll(".pb-pop .pb-step").length`)) === 3 && (await win.webContents.executeJavaScript(`document.querySelectorAll(".pb-pop .pb-file").length`)) >= 1);
    await win.webContents.executeJavaScript(`(function(){const f=document.querySelector(".pb-pop .pb-file"); if(f) f.click(); return !!f;})()`);
    await sleep(400);
    check("浮层交付物点击进预览", await exists(".wb-preview-body"));
    check("浮层随选择关闭", await win.webContents.executeJavaScript(`!document.querySelector(".pb-pop")`));
    await win.webContents.send("cap:ev", { type: "notice", text: "模型服务调用失败（本轮无输出）：请检查网络或模型配置后重试" });
    await sleep(150);
    check(
      "浮标出错态",
      (await win.webContents.executeJavaScript(`(function(){const b=document.getElementById("progress-bubble"); return { cls: b.className, label: b.querySelector(".pb-label").textContent };})()`)).cls.includes("error")
    );
    await win.webContents.send("cap:ev", { type: "session_loaded", id: "s-reset", title: "重置", expert: "general", messages: [] });
    await sleep(250);
    check(
      "会话重载后浮标归零为就绪胶囊（小绿点+文字，与其他状态同构）",
      await win.webContents.executeJavaScript(
        `(function(){const b=document.getElementById("progress-bubble"); const lbl=b.querySelector(".pb-label"); const cs=getComputedStyle(lbl); return b.className === "idle" && lbl.textContent === "就绪" && cs.display !== "none" && getComputedStyle(b.querySelector(".pb-dot")).width === "7px";})()`
      ),
      await win.webContents.executeJavaScript(`(function(){const b=document.getElementById("progress-bubble"); return b.className + "|" + b.querySelector(".pb-label").textContent;})()`)
    );

    // ㉓b2 方案 C：run_command 的 L2 确认卡完整展示命令原文
    await win.webContents.send("cap:ev", { type: "confirm_request", id: "cmd-c1", tool: "run_command", args: { command: "Remove-Item out/old-report.md -Recurse" } });
    await sleep(250);
    check(
      "run_command 确认卡显示完整命令",
      (await win.webContents.executeJavaScript(`(function(){const p=[...document.querySelectorAll(".confirm-card .c-preview")].pop(); return p ? p.textContent : "";})()`)).includes("Remove-Item out/old-report.md -Recurse")
    );
    await win.webContents.executeJavaScript(`(function(){const c=[...document.querySelectorAll(".confirm-card.pending")].pop(); if(!c) return false; const b=[...c.querySelectorAll("button")].find(x=>x.textContent==="拒绝"); if(b){b.click(); return true;} return false;})()`);
    await sleep(250);
    await deliver("preview/logo.png");
    await deliver("preview/doc.pdf");
    await deliver("preview/office.docx");
    await deliver("preview/sheet.xlsx");
    await deliver("preview/deck.pptx");
    await deliver("preview/old.doc");
    await deliver("out/report.md");
    await openPreview("preview/logo.png");
    check(
      "图片预览 dataURL",
      (await win.webContents.executeJavaScript(`(function(){const i=document.querySelector(".wb-preview-img"); return i ? i.src : "";})()`)).startsWith("data:image/png;base64,")
    );
    await openPreview("preview/doc.pdf");
    check(
      "PDF 内嵌查看器",
      (await win.webContents.executeJavaScript(`(function(){const f=document.querySelector(".wb-preview-frame"); return f ? f.src : "";})()`)).startsWith("data:application/pdf;base64,")
    );
    await openPreview("preview/office.docx");
    check("docx 预览出沙箱框架", await exists(".wb-office-frame"));
    check(
      "docx 沙箱禁脚本（仅 allow-same-origin）",
      (await win.webContents.executeJavaScript(`(function(){const f=document.querySelector(".wb-office-frame"); if(!f) return "missing"; const s=f.getAttribute("sandbox")||""; return s === "allow-same-origin" ? "ok" : s;})()`)) === "ok"
    );
    check(
      "docx 沙箱内 CSP 就位",
      (await win.webContents.executeJavaScript(`(function(){const f=document.querySelector(".wb-office-frame"); return f ? f.srcdoc : "";})()`)).includes("default-src 'none'")
    );
    check(
      "docx 保真渲染出正文",
      await waitFor(
        `(function(){const f=document.querySelector(".wb-office-frame"); if(!f||!f.contentDocument||!f.contentDocument.body) return false; const t=f.contentDocument.body.textContent||""; return t.includes("自测周报") && t.includes("合计 300");})()`
      )
    );
    await openPreview("preview/sheet.xlsx");
    check(
      "xlsx 工作表页签",
      (await texts(".wb-sheet-tab")).includes("销售") && (await texts(".wb-sheet-tab")).includes("汇总")
    );
    check(
      "xlsx 值网格渲染",
      await waitFor(
        `(function(){const g=document.querySelector(".wb-sheet-grid"); if(!g) return false; const t=g.textContent||""; return t.includes("物料") && t.includes("产品A") && t.includes("200");})()`
      )
    );
    await win.webContents.executeJavaScript(`(function(){const b=[...document.querySelectorAll('.wb-sheet-tab')].find(x=>x.textContent==='汇总'); if(!b) return false; b.click(); return true;})()`);
    await sleep(150);
    check(
      "xlsx 切页签换数据",
      (await win.webContents.executeJavaScript(`(function(){const g=document.querySelector(".wb-sheet-grid"); return g ? g.textContent : "";})()`)).includes("合计") &&
        !(await win.webContents.executeJavaScript(`(function(){const g=document.querySelector(".wb-sheet-grid"); return g ? g.textContent : "";})()`)).includes("物料")
    );
    await openPreview("preview/deck.pptx");
    check("pptx 预览出沙箱框架", await exists(".wb-office-frame"));
    check(
      "pptx 渲染出幻灯片",
      await waitFor(
        `(function(){const f=document.querySelector(".wb-office-frame"); if(!f||!f.contentDocument||!f.contentDocument.body) return false; return !!f.contentDocument.body.querySelector(".wb-pptx-slide");})()`
      )
    );
    await openPreview("preview/old.doc");
    check(
      "老格式提示转存新格式",
      (await win.webContents.executeJavaScript(`(function(){const t=document.querySelector(".wb-preview-body .md-text"); return t ? t.textContent : "";})()`)).includes("转存为新格式")
    );
    await openPreview("out/report.md");
    check(
      "文本预览走 Markdown",
      (await win.webContents.executeJavaScript(`(function(){const t=document.querySelector(".wb-preview-body .md-text"); return t ? t.innerHTML : "";})()`)).includes("<h1>")
    );

    // ㉔ 用户侧编辑（方案 §2.3 第一层）：md 编辑器 + xlsx 值回写（stub saveFileEdit 捕获）
    check(
      "md 可编辑且编辑钮可用",
      await win.webContents.executeJavaScript(`(function(){const b=document.querySelector(".wb-edit-btn"); return b ? !b.disabled : false;})()`)
    );
    await win.webContents.executeJavaScript(`(function(){const b=document.querySelector(".wb-edit-btn"); if(!b) return false; b.click(); return true;})()`);
    await sleep(200);
    check("md 编辑器打开", await exists(".wb-edit-area"));
    await win.webContents.executeJavaScript(`(function(){const t=document.querySelector(".wb-edit-area"); if(!t) return false; t.value="# 编辑后\\n\\n用户改的内容"; t.dispatchEvent(new Event("input",{bubbles:true})); return true;})()`);
    await win.webContents.executeJavaScript(`(function(){const b=[...document.querySelectorAll(".wb-edit-btn.primary")].find(x=>x.textContent.includes("保存")); if(!b) return false; b.click(); return true;})()`);
    await sleep(300);
    const lastEdit = editCalls[editCalls.length - 1];
    check(
      "编辑保存走 saveFileEdit（文本）",
      !!lastEdit && lastEdit.p === "out/report.md" && !!(lastEdit.payload && lastEdit.payload.text && lastEdit.payload.text.includes("用户改的内容"))
    );
    check(
      "保存后回显 Markdown",
      (await win.webContents.executeJavaScript(`(function(){const t=document.querySelector(".wb-preview-body .md-text"); return t ? t.innerHTML : "";})()`)).includes("<h1>")
    );
    await openPreview("preview/sheet.xlsx");
    check("xlsx 网格就绪（降级链只读）", await waitFor(`(function(){return !!document.querySelector(".wb-sheet-grid td");})()`));
    await win.webContents.executeJavaScript(`(function(){const t=[...document.querySelectorAll(".wb-sheet-grid td")].find(x=>x.textContent==="100"); if(!t) return false; t.dispatchEvent(new MouseEvent("dblclick",{bubbles:true})); return true;})()`);
    await sleep(200);
    check("xlsx 只读（双击不出输入框）", !(await exists(".wb-cell-input")));
    check("xlsx 只读（无保存回写按钮）", !(await win.webContents.executeJavaScript(`(function(){return [...document.querySelectorAll(".wb-edit-btn.primary")].some(x=>x.textContent.includes("保存回写"));})()`)));

    // ㉔b OfficeCLI 保真预览主路径：readFilePreview 携带 html 字段 → 无脚本沙箱直渲染
    check(
      "fidelity 桩返回 html 字段",
      await win.webContents.executeJavaScript(`window.ordo.readFilePreview("preview/fidelity.docx").then(r => !!(r && r.html && r.html.includes("ORDO-FIDELITY-HTML")))`)
    );
    await deliver("preview/fidelity.docx");
    await openPreview("preview/fidelity.docx");
    await sleep(400);
    check(
      "office html 主路径进沙箱（保真渲染产物直渲染）",
      await win.webContents.executeJavaScript(
        `(function(){const f=document.querySelector(".wb-office-frame"); if(!f) return "NO_FRAME"; const d=f.contentDocument; if(!d) return "NO_DOC:"+(f.srcdoc||"").slice(0,60); if(!d.body) return "NO_BODY"; return d.body.textContent.includes("ORDO-FIDELITY-HTML") && f.getAttribute("sandbox") === "allow-same-origin" ? true : "MARKER_MISS:"+d.body.textContent.slice(0,60);})()`
      ) === true,
      await win.webContents.executeJavaScript(
        `(function(){const f=document.querySelector(".wb-office-frame"); return f ? {sandbox:f.getAttribute("sandbox"), srcdoc:(f.srcdoc||"").slice(0,100), text:f.contentDocument? (f.contentDocument.body? f.contentDocument.body.textContent.slice(0,60):"nobody"):"nodoc"} : "noframe";})()`
      )
    );

    // ㉕ 浏览器标签（方案 §5 内嵌 webview）：导航事件建标签 + 工具条 + 控制台 + 急停关标签 + 截图进浮层
    await win.webContents.executeJavaScript(`document.getElementById("wb-collapse").click()`);
    await sleep(150);
    await win.webContents.send("cap:ev", { type: "browser_navigate", url: "https://intranet.example.com/report/weekly" });
    await sleep(500);
    check("浏览器标签自动开面板", await exists("#workbench.open .wb-webview-holder"));
    check("webview 内嵌已创建", await exists(".wb-webview"));
    check(
      "浏览器标签页签出现",
      (await texts(".wb-tabchip .wb-tabchip-label")).some((t) => t.includes("intranet.example.com") || t === "浏览器")
    );
    check(
      "受控地址如实显示（工具条）",
      (await win.webContents.executeJavaScript(`(function(){const u=document.querySelector("#workbench .wb-tabbar-path"); return u ? u.textContent : "";})()`)).includes("intranet.example.com")
    );
    check(
      "控制台子面板含错误行",
      (await win.webContents.executeJavaScript(`document.querySelectorAll(".wb-console-row").length`)) >= 2 && (await exists(".wb-console-row.error"))
    );
    await win.webContents.executeJavaScript(`(function(){const b=[...document.querySelectorAll(".wb-icon-btn.danger")].find(x=>x.title.includes("急停")); if(!b) return false; b.click(); return true;})()`);
    await sleep(200);
    check("急停走 browserStop（审计侧）", browserStopCalls.length === 1);
    await win.webContents.send("cap:ev", { type: "browser_stop" }); // 主进程急停广播 → 渲染端撤标签
    await sleep(300);
    check("急停后浏览器标签撤销", !(await exists(".wb-webview")) && !(await exists('.wb-tabchip.active[title*="intranet"]')));
    await win.webContents.send("cap:ev", { type: "artifact_added", path: "browser-shots/shot-demo.png" });
    await sleep(200);
    await win.webContents.executeJavaScript(`document.getElementById("progress-bubble").click()`);
    await sleep(200);
    check("截图存证进浮层交付物", (await texts(".pb-pop .pb-file .f-path")).includes("browser-shots/shot-demo.png"));
    await win.webContents.executeJavaScript(`document.getElementById("progress-bubble").click()`);
    await win.webContents.executeJavaScript(`document.getElementById("wb-collapse").click()`);
    await sleep(150);

    // ㉖ 用户侧终端（方案 §6）：＋新标签页入口 → xterm 挂载 → 输出回放 → 尺寸同步 → 与文件标签共存切换 → 关标签
    // （空态入口卡只随空态渲染存在，不再常驻 DOM——收起状态下点不到旧卡片，改走 ＋ 路径）
    await win.webContents.executeJavaScript(`document.getElementById("wb-toggle").click()`);
    await sleep(300);
    await win.webContents.executeJavaScript(`(() => { document.getElementById("wb-plus").click(); return true; })()`);
    await sleep(250);
    await win.webContents.executeJavaScript(`(() => { const c=[...document.querySelectorAll(".wb-newtab .wb-entry-card")].find(x=>x.textContent.includes("终端")); if(!c) return false; c.click(); return true; })()`);
    await waitFor(`!!document.querySelector(".term-mount .xterm")`, 6000); // 懒加载 xterm ESM + 挂载（轮询）
    check("终端 xterm 挂载", await exists(".term-mount .xterm"));
    await win.webContents.send("cap:ev", { type: "term_data", data: "PS C:\\ws\\demo> ordo-term-hello\r\n" });
    check(
      "终端输出回放",
      await waitFor(
        `(function(){const m=document.querySelector(".term-mount"); return m && m.textContent.includes("ordo-term-hello");})()`,
        4000
      )
    );
    check("挂载后尺寸同步 termResize", termResizes.length >= 1);
    check(
      "终端高度受面板约束（fit 不再正反馈加长）",
      await win.webContents.executeJavaScript(
        `(function(){const m=document.querySelector(".term-mount"); const b=document.getElementById("wb-body"); return !!(m && b) && m.getBoundingClientRect().height <= b.clientHeight + 1;})()`
      )
    );
    // 标签共存：切到文件标签再切回，xterm 不丢（常驻 pane）
    await openPreview("out/report.md");
    await sleep(400);
    check("文件与终端标签共存", (await texts(".wb-tabchip .wb-tabchip-label")).includes("report.md") && (await texts(".wb-tabchip .wb-tabchip-label")).includes("终端"));
    check("切到文件标签时终端隐藏", await exists("#workbench .wb-pane.hidden .term-mount"));
    await win.webContents.executeJavaScript(`(() => { const c=[...document.querySelectorAll(".wb-tabchip")].find(x=>x.textContent.includes("终端")); if(!c) return false; c.click(); return true; })()`);
    await sleep(300);
    check("切回终端标签 xterm 仍在", await exists(".term-mount .xterm") && (await win.webContents.executeJavaScript(`!!document.querySelector(".wb-pane:not(.hidden) .term-mount .xterm")`)));
    await win.webContents.executeJavaScript(`(() => { const c=[...document.querySelectorAll(".wb-tabchip")].find(x=>x.textContent.includes("终端")); if(!c) return false; c.querySelector(".wb-tabchip-x").click(); return true; })()`);
    await sleep(400);
    check("关闭终端标签（termClose 审计侧）", termCloseCalls.length === 1 && !(await exists(".term-mount")));

    // ㉗ ＋ 新标签页：入口卡片 → 文件选择（搜索）→ Esc 丢弃 → 网址输入（browserOpenUser）
    await win.webContents.executeJavaScript(`(() => { document.getElementById("wb-plus").click(); return true; })()`);
    await sleep(300);
    check(
      "＋开新标签页（入口卡片）",
      (await texts(".wb-tabchip .wb-tabchip-label")).includes("新标签页") &&
        (await texts(".wb-newtab .wb-entry-card .we-title")).includes("终端") &&
        (await texts(".wb-newtab .wb-entry-card .we-title")).includes("浏览器")
    );
    await win.webContents.executeJavaScript(`(() => { const c=[...document.querySelectorAll(".wb-newtab .wb-entry-card")].find(x=>x.textContent.includes("文件")); if(!c) return false; c.click(); return true; })()`);
    await sleep(400);
    check("文件选择页（工作区清单）", (await texts(".wb-file-item")).some((t) => t.includes("sales.txt")));
    await win.webContents.executeJavaScript(`(() => { const s=document.querySelector(".wb-nt-search"); if(!s) return false; s.value="sales"; s.dispatchEvent(new Event("input", { bubbles: true })); return true; })()`);
    await sleep(150);
    check(
      "文件搜索过滤",
      await win.webContents.executeJavaScript(
        `(function(){const vis=[...document.querySelectorAll(".wb-file-item")].filter(i=>i.offsetParent); return vis.length===1 && vis[0].dataset.path==="data/sales.txt";})()`
      )
    );
    await win.webContents.executeJavaScript(`(() => { document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); return true; })()`);
    await sleep(150);
    check("Esc 返回入口页", (await exists(".wb-newtab .wb-entry-card")) && !(await exists(".wb-filepick")));
    await win.webContents.executeJavaScript(`(() => { document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); return true; })()`);
    await sleep(150);
    check("Esc 丢弃新标签页", !(await exists(".wb-newtab")) && !(await texts(".wb-tabchip .wb-tabchip-label")).includes("新标签页"));
    await win.webContents.executeJavaScript(`(() => { document.getElementById("wb-plus").click(); return true; })()`);
    await sleep(250);
    await win.webContents.executeJavaScript(`(() => { const c=[...document.querySelectorAll(".wb-newtab .wb-entry-card")].find(x=>x.textContent.includes("浏览器")); if(!c) return false; c.click(); return true; })()`);
    await sleep(250);
    await win.webContents.executeJavaScript(`(() => { const i=document.querySelector(".wb-nt-url"); if(!i) return false; i.value="https://oa.corp.local/"; document.querySelector(".wb-nt-urlbox .wb-edit-btn").click(); return true; })()`);
    await sleep(300);
    check("新标签页 URL 走 browserOpenUser（用户显式动作）", browserOpenUserCalls.length === 1 && browserOpenUserCalls[0] === "https://oa.corp.local/");
    await win.webContents.send("cap:ev", { type: "browser_navigate", url: "https://oa.corp.local/" });
    await sleep(400);
    check("用户开页建浏览器标签", await exists(".wb-webview"));
    // 最近访问快捷项：重开网址页应出现刚访问的域名
    await win.webContents.executeJavaScript(`(() => { document.getElementById("wb-plus").click(); return true; })()`);
    await sleep(250);
    await win.webContents.executeJavaScript(`(() => { const c=[...document.querySelectorAll(".wb-newtab .wb-entry-card")].find(x=>x.textContent.includes("浏览器")); if(!c) return false; c.click(); return true; })()`);
    await sleep(250);
    check("网址页最近访问快捷项", (await texts(".wb-nt-chip")).some((t) => t.includes("oa.corp.local")));
    await win.webContents.executeJavaScript(`(() => { const i=document.querySelector(".wb-nt-url"); if(!i) return false; i.value="www.baidu.com"; document.querySelector(".wb-nt-urlbox .wb-edit-btn").click(); return true; })()`);
    await sleep(300);
    check("无协议网址渲染端补全 https 提交", browserOpenUserCalls.length === 2 && browserOpenUserCalls[1] === "https://www.baidu.com");
    await win.webContents.executeJavaScript(`(() => { document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); return true; })()`);
    await sleep(120);
    await win.webContents.executeJavaScript(`(() => { document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); return true; })()`);
    await sleep(120);
    await win.webContents.executeJavaScript(`document.getElementById("wb-collapse").click()`);
    await sleep(150);

    // ㉘ 回归：空态入口卡不得堆叠（入口页下方再开/关后再现/终端面板加长的共同根源）+ 终端重复渲染不叠工具条
    await win.webContents.executeJavaScript(`document.getElementById("wb-toggle").click()`);
    await sleep(300);
    await win.webContents.executeJavaScript(`(() => { const b=[...document.querySelectorAll(".wb-tabchip-x")].find(x=>x.title.includes("浏览器")); if(b) b.click(); return true; })()`);
    await win.webContents.send("cap:ev", { type: "browser_stop" });
    await sleep(300);
    await win.webContents.executeJavaScript(`(() => { const xs=document.querySelectorAll(".wb-tabchip-x"); if(xs.length) xs[0].click(); return true; })()`);
    await sleep(300);
    check("空态只有一份（无堆叠）", await win.webContents.executeJavaScript(`document.querySelectorAll("#wb-body .wb-empty").length === 1`));
    await win.webContents.executeJavaScript(`(() => { document.getElementById("wb-plus").click(); return true; })()`);
    await sleep(250);
    await win.webContents.executeJavaScript(`(() => { const c=[...document.querySelectorAll(".wb-newtab .wb-entry-card")].find(x=>x.textContent.includes("文件")); if(!c) return false; c.click(); return true; })()`);
    await sleep(400);
    check("空态选文件后入口页清空（不挂在下方）", await win.webContents.executeJavaScript(`document.querySelectorAll("#wb-body .wb-empty").length === 0`));
    await win.webContents.executeJavaScript(`(() => { document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); return true; })()`);
    await sleep(120);
    await win.webContents.executeJavaScript(`(() => { document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); return true; })()`);
    await sleep(150);
    check("丢弃新标签页后空态仍只有一份", await win.webContents.executeJavaScript(`document.querySelectorAll("#wb-body .wb-empty").length === 1`));
    await win.webContents.executeJavaScript(`(() => { const c=[...document.querySelectorAll(".wb-empty .wb-entry-card")].find(x=>x.textContent.includes("终端")); if(c) c.click(); return !!c; })()`);
    await sleep(600);
    for (let i = 0; i < 6; i++) {
      await win.webContents.executeJavaScript(`(() => { const c=document.querySelector(".wb-tabchip"); if(c) c.click(); return true; })()`);
    }
    await sleep(400);
    check(
      "终端重复渲染仍单一工具条/挂载点",
      await win.webContents.executeJavaScript(
        `(function(){const p=[...document.querySelectorAll(".wb-pane")].find(x=>x.querySelector(".term-mount")); return !!p && p.querySelectorAll(".wb-tabbar").length===1 && p.querySelectorAll(".term-mount").length===1 && !!p.querySelector(".term-mount .xterm");})()`
      )
    );
    await win.webContents.executeJavaScript(`(() => { const x=document.querySelector(".wb-tabchip-x"); if(x) x.click(); return true; })()`);
    await sleep(300);
    await win.webContents.executeJavaScript(`document.getElementById("wb-collapse").click()`);
    await sleep(150);
  } catch (e) {
    results.push(`FAIL 异常: ${e}`);
  }

  const pass = results.every((r) => r.startsWith("PASS"));
  console.log(JSON.stringify({ pass, results, errors }, null, 2));
  app.exit(pass && !errors.length ? 0 : 1);
});
