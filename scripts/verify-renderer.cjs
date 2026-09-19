// 渲染层加载验证（无窗口）：Electron file:// 下 ES Modules / CSS / boot 全链路
// 用法：npx electron scripts/verify-renderer.cjs   → 输出 JSON { boot, errors }
const { app, BrowserWindow } = require("electron");
const path = require("node:path");
const fs = require("node:fs");

const PRELOAD_STUB = path.join(app.getPath("temp"), "ordo-verify-preload.cjs");
fs.writeFileSync(
  PRELOAD_STUB,
  `const { contextBridge } = require("electron");
contextBridge.exposeInMainWorld("ordo", {
  prompt: async () => true,
  respondConfirm: async () => true,
  getWorkspaceInfo: async () => ({ product: "Ordo", root: "C:\\\\ws", home: "C:\\\\ws" }),
  listExperts: async () => ({ current: { id: "general", name: "通用助手", description: "", toolWhitelist: null }, items: [{ id: "general", name: "通用助手", description: "", toolWhitelist: null }] }),
  switchExpert: async () => true,
  thinkingState: async () => ({ current: { id: "mid", label: "中" }, items: [{ id: "mid", label: "中" }] }),
  switchThinking: async () => true,
  listSessions: async () => [],
  newSession: async () => true,
  loadSession: async () => ({ id: "x", title: "x", messages: [] }),
  onEvent: () => () => {},
});`
);

app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, webPreferences: { preload: PRELOAD_STUB, contextIsolation: true, nodeIntegration: false } });
  const errors = [];
  win.webContents.on("console-message", (_e, level, message) => {
    if (level >= 2) errors.push(String(message));
  });
  win.webContents.on("did-fail-load", (_e, code, desc) => errors.push(`did-fail-load ${code} ${desc}`));
  try {
    await win.loadFile(path.join(__dirname, "../src/renderer/index.html"));
  } catch (e) {
    console.log(JSON.stringify({ boot: false, errors: [`loadFile: ${e}`] }));
    app.exit(1);
    return;
  }
  await new Promise((r) => setTimeout(r, 1000));
  const probe = await win.webContents
    .executeJavaScript(
      `({ empty: !!document.getElementById("empty-state"), composer: !!document.querySelector(".composer"),
         expertBtn: (document.getElementById("expert-btn")||{}).textContent || "",
         suggestionCards: document.querySelectorAll(".suggest-card").length })`
    )
    .catch((e) => ({ execErr: String(e) }));
  console.log(JSON.stringify({ boot: probe.empty === true && probe.composer === true, probe, errors }));
  app.exit(0);
});
