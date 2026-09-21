// Ordo 客户端主进程入口：窗口 + IPC + AgentHost 装配
// IPC 面 = 基线契约（锁定）+ 契约扩展（文件预览/多工作区/会话管理/技能市场/模型/停止/资源清单）
import { app, BrowserWindow, ipcMain, shell, dialog, Menu, Notification } from "electron";
import * as path from "node:path";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import { Workspace } from "./workspace";
import { Audit } from "./audit";
import { AgentHost, ConfirmRequest } from "./agent-host";
import { PiSessionStore, type StoredSession } from "./pi-sessions";
import { readFilePreview } from "./preview";
import { saveUserEdit } from "./edit";
import { BrowserBridge, createTestPageWindow, safeUrl } from "./browser-bridge";
import { officeQuery, officeRun } from "./office-cli";
import { TerminalHost } from "./terminal";
import { SkillMarketService, HttpRegistryProvider, EmptySkillRegistryProvider } from "./skill-market";
import { ConnectorHost, HttpMcpRegistryProvider, EmptyMcpProvider } from "./connectors";
import { HttpKnowledgeProvider, EmptyKnowledgeProvider, PersonalKbStore, type KnowledgeProvider } from "./knowledge";
import { AutomationService, type AutomationDef, type AutomationRunnerResult } from "./automations";
import { TemplateStore } from "./templates";
import { RecycleService } from "./recycle";
import {
  AdminConfigSync,
  adminFetchJson,
  adminLogin,
  adminToken,
  adminUser,
  adminVerifyToken,
  authModeOf,
  authState,
  clearAdminAuth,
  envAutoLogin,
  initAdminAuth,
  savedBaseUrl,
  setAuthExpiredHandler,
  setStandaloneMode,
} from "./admin-link";
import {
  DEFAULT_BASE_PROMPT,
  DEFAULT_COMPACTATION,
  DEFAULT_SHELL,
  DEFAULT_BROWSER,
  DEFAULT_EXPERTS,
  EMPTY_MODEL,
  loadLocalModel,
  localModelToConfig,
  saveLocalModel,
  validateLocalModel,
  type LocalModelInput,
} from "./defaults";
import { AdminPushClient, type PushEvent } from "./admin-ws";
import { AdminReporter, countSessionsToday } from "./reporter";
import { PluginPackService } from "./plugin-packs";
import { LocalMcpHost } from "./mcp-local";
import { McpHttpHost } from "./mcp-http";
import { PersonalMcpStore } from "./personal-mcp";
import { ImBridge, type ImHostLike } from "./im-bridge";
import { checkClientUpdate } from "./update-checker";
import { officeBuiltinVersion } from "./office-cli";
import { attachmentBlock, safeAttachmentName, saveAttachments } from "./attachments";
import { AppSettingsStore, type AppSettings, type ConfirmMode, normalizeConfirmMode } from "./app-settings";
import type { UiEvent } from "../shared/protocol";

const SELFTEST = process.env.ORDO_SELFTEST === "1";

// M6-B：config.mock.json 退役为测试夹具（mock-server/自测读取），客户端运行时一律内置默认 + 管理端下发/本地配置覆盖
const cfg: any = {
  basePrompt: DEFAULT_BASE_PROMPT,
  compaction: { ...DEFAULT_COMPACTATION },
  shell: { ...DEFAULT_SHELL, readOnlyCommands: [...DEFAULT_SHELL.readOnlyCommands] },
  browser: { urlWhitelist: [...DEFAULT_BROWSER.urlWhitelist] },
  experts: JSON.parse(JSON.stringify(DEFAULT_EXPERTS)),
  model: JSON.parse(JSON.stringify(EMPTY_MODEL)),
};
// 管理端地址与模式（M6-B）：env ORDO_ADMIN_BASE（自测/e2e 桥）优先，否则 auth.json 的 online 地址；
// standalone = 无管理端。ADMIN_BASE 在 bootstrap 内解析后生效（登录/锁定态见 authState）。
let ADMIN_BASE = "";

let win: BrowserWindow | null = null;
let browserBridge: BrowserBridge;
let terminalHost: TerminalHost;
let host: AgentHost | null = null;
let workspace: Workspace | null = null;
let sessions: PiSessionStore | null = null;
let skillMarket: SkillMarketService | null = null;
let personalKb: PersonalKbStore | null = null;
let auditRef: Audit | null = null;

// 主进程韧性守卫（桌面可用性优先）：worker/子组件冒泡的未捕获异常记日志不弹崩溃框不退出。
// 背景：tesseract worker 线程的语言数据异常曾以「A JavaScript error occurred in the main process」弹窗炸前台
process.on("uncaughtException", (e) => {
  console.error("[MAIN] uncaughtException:", (e as Error)?.stack || String(e));
  try {
    auditRef?.append({ event: "main_uncaught", error: String((e as Error)?.message ?? e).slice(0, 200) });
  } catch {}
});
process.on("unhandledRejection", (e) => {
  console.error("[MAIN] unhandledRejection:", String(e).slice(0, 300));
});

let connectorHost: ConnectorHost | null = null;
let imBridge: ImBridge | null = null;
let knowledgeProvider: KnowledgeProvider | null = null;
let pluginPacks: PluginPackService | null = null;
let localMcp: LocalMcpHost | null = null;
let mcpHttpHost: McpHttpHost | null = null;
let personalMcp: PersonalMcpStore | null = null;
let automations: AutomationService | null = null;
let templates: TemplateStore | null = null;
let recycle: RecycleService | null = null;
let appSettings: AppSettings | null = null;
let settingsStore: AppSettingsStore | null = null;
// 企业链路实例（M6-D 热接：登录拉起 / 退出停掉；启动路径复用同一组函数）
let adminSyncRef: AdminConfigSync | null = null;
let reporterRef: AdminReporter | null = null;
let pushRef: AdminPushClient | null = null;
const pendingConfirms = new Map<string, (approved: boolean) => void>();

// 桌面通知（PRD 3.6 一期主通道）：L2 待确认必达；任务完成在窗口失焦时提醒
function notify(title: string, body: string): void {
  if (SELFTEST || appSettings?.desktopNotify === false || !Notification.isSupported()) return;
  const n = new Notification({ title, body });
  n.on("click", () => {
    win?.show();
    win?.focus();
  });
  n.show();
}

function confirmViaUi(req: ConfirmRequest): Promise<boolean> {
  return new Promise((resolve) => {
    pendingConfirms.set(req.id, resolve);
    sendUi({
      type: "confirm_request",
      id: req.id,
      tool: req.tool,
      args: req.args,
    } satisfies UiEvent);
    notify("Ordo · 等待确认", `操作待确认：${req.tool} ${req.args?.path ?? req.args?.name ?? ""}（点击查看）`);
  });
}

/** 统一安全转发：主窗口可能已销毁（退出竞态），此时静默丢弃，避免 "Object has been destroyed" 崩主进程 */
function sendUi(ev: UiEvent | Record<string, unknown>): void {
  if (win && !win.isDestroyed()) win.webContents.send("ordo:event", ev);
}

// ---------- L2 确认模式（三档，前台交互会话专用） ----------
// 生效口径：会话开始时锁定——首次 L2 到来时按当时的 settings 快照锁定本会话模式；
// 中途切换只改设置，自下个新会话生效（与 composer 按钮的提示一致）。
// 自动化后台（预授权模型）与 IM（回复确认）有自己的 confirm 语义，不在此模式管辖内。
const AUTO_EDIT_TOOLS = new Set(["write_file", "write_docx", "write_pptx", "edit_docx", "edit_pptx", "edit_xlsx"]);
let confirmLockSession: string | null = null;
let confirmLockedMode: ConfirmMode = "ask";

function fgConfirm(req: ConfirmRequest): Promise<boolean> {
  const sid = host?.currentSessionId ?? null;
  if (sid !== confirmLockSession) {
    confirmLockSession = sid;
    confirmLockedMode = normalizeConfirmMode(appSettings?.confirmMode);
  }
  if (confirmLockedMode === "auto" || (confirmLockedMode === "autoEdit" && AUTO_EDIT_TOOLS.has(req.tool))) {
    req.autoBy = `mode:${confirmLockedMode}`; // l2_confirm 审计记 auto-approved(mode:...)，与手点同意区分
    return Promise.resolve(true);
  }
  return confirmViaUi(req);
}

function emit(ev: UiEvent): void {
  sendUi(ev);
  if (ev.type === "run_end" && win && !win.isDestroyed() && !win.isFocused()) {
    notify("Ordo · 任务完成", "当前任务已结束，点击查看结果");
  }
}

// ---------- 自动化无人值守运行（PRD 3.7 本地型）：独立后台 AgentHost，不进对话流 ----------
// 后台事件不转发到渲染层（那会污染用户正在看的会话：text_delta 会落进聊天、session_saved 会抢当前会话标题）；
// 运行结果只取两样：末段文本做摘要（bgBuf）、session_saved 抓会话 id（bgSessionId）；技能集变化例外（市场页需刷新）。
let bgHost: AgentHost | null = null;
// 后台专用工作区实例：与前台同 home（技能/会话/审计目录一致），但按任务锚定根目录；
// 锚定走 persist=false——不写注册表 currentId、不落盘，前台"上次使用"与正在进行的会话不受影响
let bgWorkspace: Workspace | null = null;
let bgBuf = "";
let bgSessionId: string | undefined;
let bgPreAuth = new Set<string>();
let bgTaskName = "";
// 无人值守敏感操作判定留痕（自测断言用；审计另有 automation_l2/l2_confirm 两条）
const bgDecisions: Array<{ tool: string; preAuthorized: boolean; task: string }> = [];

function bgEmit(ev: UiEvent): void {
  if (ev.type === "text_delta") {
    bgBuf += ev.text;
  } else if (ev.type === "session_saved") {
    bgSessionId = ev.id;
  } else if (ev.type === "skills_changed") {
    emit(ev);
  }
}

// 无人值守确认语义：预授权范围内的操作自动放行（审计留痕），范围外拒绝并审计——绝不弹确认框
function bgConfirm(req: ConfirmRequest): Promise<boolean> {
  const allowed = bgPreAuth.has(req.tool);
  bgDecisions.push({ tool: req.tool, preAuthorized: allowed, task: bgTaskName });
  auditRef?.append({ event: "automation_l2", task: bgTaskName, tool: req.tool, preAuthorized: allowed });
  return Promise.resolve(allowed);
}

const AUTOMATION_RUN_TIMEOUT_MS = 600_000; // 无人值守兜底：10 分钟无进展即中止（防止挂死后续调度）

async function runAutomation(task: AutomationDef, _trigger: "timer" | "manual"): Promise<AutomationRunnerResult> {
  // 任务绑定的工作目录（PRD 3.8）：读写围栏、产物与会话归属都锚定到该目录；目录被移除 = 如实失败
  const wsEntry = workspace!.registry.byId(task.wsId || "default");
  if (!wsEntry) {
    return { ok: false, summary: "", error: `任务绑定的工作目录已不存在（${task.wsId}），请编辑任务重新选择` };
  }
  if (!bgHost) {
    bgWorkspace = new Workspace(workspace!.dirs.home);
    bgWorkspace.registry.load(); // 只读加载：byRoot/byId 可查即可，绝不 setCurrent/save
    bgHost = new AgentHost(cfg, {
      workspace: bgWorkspace,
      audit: auditRef!,
      sessions: sessions!,
      emit: bgEmit,
      confirm: bgConfirm,
      selfTest: SELFTEST,
      connectors: connectorHost!,
      knowledge: knowledgeProvider!,
      personalKb: personalKb!,
    });
    await bgHost.init();
  }
  // 重读注册表（只读）：前台可能在后台实例创建后新增/删除了目录，锚定要拿到最新 wsId
  bgWorkspace!.registry.load();
  bgWorkspace!.switchRoot(wsEntry.root, false);
  bgBuf = "";
  bgSessionId = undefined;
  bgPreAuth = new Set(task.preAuth ?? []);
  bgTaskName = task.name;
  // 每次运行独立会话：结果在侧栏可点开回看（PRD 旅程 5）；专家按任务创建时锁定的重锚定。
  // newSession 内部会异步切回默认专家（fire-and-forget），这里无条件 await 到任务专家：
  // 挂载已随 newSession 清空，两次工具重建产物相同（仅基础工具），不会留下中间态。
  bgHost.newSession();
  await bgHost.switchExpert(task.expertId);
  let timedOut = false;
  let watchdog: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      bgHost.prompt(task.prompt),
      new Promise((_r, rej) => {
        watchdog = setTimeout(() => {
          timedOut = true;
          bgHost!.cancel();
          rej(new Error("timeout"));
        }, AUTOMATION_RUN_TIMEOUT_MS);
      }),
    ]);
  } catch (e) {
    if (timedOut) {
      return { ok: false, summary: bgBuf.trim().slice(0, 500), error: "运行超时（10 分钟），已自动中止" };
    }
    return { ok: false, summary: bgBuf.trim().slice(0, 500), error: String((e as any)?.message ?? e) };
  } finally {
    if (watchdog) clearTimeout(watchdog);
  }
  // pi 在模型调用失败时以 stopReason="error" 空内容收束（不抛异常）：无人值守必须如实记失败，不产假成功
  if (bgHost.lastAssistantStop === "error") {
    return { ok: false, summary: bgBuf.trim().slice(0, 500), error: "模型服务调用失败（本轮无输出），任务未执行" };
  }
  const summary = bgBuf.trim().slice(0, 500);
  // 会话标题改为任务名（首条用户消息=任务指令，可读性差）；改动只落盘，不抢前台会话
  if (bgSessionId) await sessions!.mutate(bgSessionId, { title: `⏰ ${task.name}`.slice(0, 40) }).catch(() => {});
  return { ok: true, summary, sessionId: bgSessionId };
}

/** 联机配置应用（幂等，启动与登录热接共用）：平台配置（模型/四键）+ 专家目录 + 数据源切换 + host 重建。
 *  启动路径在 host 构造前调用（仅落数据进 cfg，host 相关步骤自动跳过）；登录热接在 host 存活时调用。 */
async function applyOnlineConfig(): Promise<void> {
  if (!adminSyncRef) {
    adminSyncRef = new AdminConfigSync({
      base: ADMIN_BASE,
      cacheFile: path.join(workspace!.dirs.home, "platform-config.json"),
      apply: (c) => {
        // 真实模式自测的模型注入优先于管理端下发；其余四键逐项应用（AgentHost 均为惰性现读）
        if (!process.env.ORDO_TEST_MODEL_JSON && c.model) cfg.model = c.model;
        if (c.compaction) cfg.compaction = c.compaction;
        if (c.basePrompt) cfg.basePrompt = c.basePrompt;
        if (c.shell) cfg.shell = c.shell;
        if (c.browser) {
          cfg.browser = c.browser;
          browserBridge?.setWhitelist(c.browser.urlWhitelist ?? []);
        }
        host?.refreshPrompt();
      },
      onSync: (msg) => {
        console.log(`[ADMIN-SYNC] ${msg}`);
        auditRef?.append({ event: "admin_config_sync", detail: msg });
      },
    });
    await adminSyncRef.start(); // 缓存恢复 + 首次拉取（失败静默：占位模型，聊天时引导）
  } else {
    await adminSyncRef.poke();
  }
  // 专家目录：联机下发（失败降级内置助手）；host 存活时热换注册表
  let expertsDoc: { defaultId: string; items: unknown[] } | null = null;
  try {
    const doc = await adminFetchJson<{ defaultId: string; items: unknown[] }>(ADMIN_BASE, "/api/v1/catalog/experts");
    if (doc && Array.isArray(doc.items) && doc.items.length) expertsDoc = doc;
  } catch {
    console.log("[ADMIN] experts 拉取失败，降级内置助手（4.6）");
  }
  if (expertsDoc) {
    cfg.experts = expertsDoc;
    host?.rebuildExperts(expertsDoc as never);
  }
  // 数据源切换与模型重建（host 存活时；启动路径由构造/init 吃 cfg）
  if (host) {
    skillMarket?.setProvider(new HttpRegistryProvider(ADMIN_BASE));
    connectorHost?.setProvider(new HttpMcpRegistryProvider(ADMIN_BASE));
    knowledgeProvider = new HttpKnowledgeProvider(ADMIN_BASE);
    await host.rebuildModel();
  }
}

/** 联机链路拉起（幂等）：目录日志（e2e 标记）→ 审计上报 → 插件包 → WS 推送 → 强更检查 */
async function enterOnlineLinks(): Promise<void> {
  console.log(`[ADMIN] 管理端已接入: ${ADMIN_BASE}（登录身份 ${adminUser()?.empNo ?? "未登录"}）`);
  try {
    const [s, m, k] = await Promise.all([
      adminFetchJson<unknown[]>(ADMIN_BASE, "/api/v1/catalog/skills"),
      adminFetchJson<unknown[]>(ADMIN_BASE, "/api/v1/catalog/mcp"),
      adminFetchJson<unknown[]>(ADMIN_BASE, "/api/v1/catalog/kb"),
    ]);
    console.log(`[ADMIN-CATALOG] skills=${s.length} mcp=${m.length} kb=${k.length}`);
  } catch {
    console.log("[ADMIN-CATALOG] 目录拉取失败（沿用本地缓存，4.6 降级）");
  }
  if (!reporterRef) {
    reporterRef = new AdminReporter({
      base: ADMIN_BASE,
      auditDir: workspace!.dirs.audit,
      stateFile: path.join(workspace!.dirs.config, "report-state.json"),
      sessionsToday: () => countSessionsToday(workspace!.dirs.sessions),
    });
    await reporterRef.start();
  }
  if (!pluginPacks) {
    pluginPacks = new PluginPackService({
      base: ADMIN_BASE,
      workspace: workspace!,
      audit: auditRef!,
      onChanged: async () => {
        await host?.reloadSkills("plugin_pack");
        await reporterRef?.flushAudit(); // 安装/卸载的审计行即时补传（对账不漏行）
      },
      mcpSmoke: (name) => localMcp!.ensure(name).then((p) => p.tools.size),
      mcpStop: (name) => localMcp?.stop(name),
    });
  }
  await pluginPacks.cleanupLegacy(); // 遗留 officecli 插件包启动即清（内置定性；旧服务端库里可能仍有）
  await pluginPacks.syncRequired();
  if (!pushRef) {
    const syncRef = adminSyncRef;
    pushRef = new AdminPushClient({
      base: ADMIN_BASE,
      token: adminToken,
      onEvent: (ev: PushEvent) => {
        if (ev.type === "config_changed") void syncRef?.poke();
        if (ev.type === "catalog_changed" && ev.resource === "skills")
          void skillMarket
            ?.syncNow()
            .then(() => reporterRef?.flushAudit()) // WS 触发的同步也落审计行：即时补传保对账
            .catch(() => {});
        if (ev.type === "packs_changed") void pluginPacks?.syncRequired().catch(() => {});
        if (ev.type === "client_version_changed") void checkClientUpdate(ADMIN_BASE, win).catch(() => {});
      },
    });
    pushRef.start();
  }
  // 强更检查（R3-4）：启动即查 + WS 推送触发（上方 onEvent）
  await checkClientUpdate(ADMIN_BASE, win).catch(() => {});
}

/** 登录热接入口（M6-D 无重启）：applyOnlineConfig + enterOnlineLinks；调用前 token 已就位 */
async function enterOnline(): Promise<void> {
  await applyOnlineConfig();
  await enterOnlineLinks();
}

/** 退出登录/切单机热接（M6-D 无重启）：停企业链路（企业下发资源保留），回落内置默认与空目录 */
async function enterStandalone(): Promise<void> {
  pushRef?.stop();
  pushRef = null;
  adminSyncRef?.stop();
  adminSyncRef = null;
  reporterRef?.stop();
  reporterRef = null;
  // pluginPacks 实例保留：managed 技能 overlay 与已装 CLI 继续可用（退出不清企业资源，用户定案）
  ADMIN_BASE = "";
  cfg.basePrompt = DEFAULT_BASE_PROMPT;
  cfg.compaction = { ...DEFAULT_COMPACTATION };
  cfg.shell = { ...DEFAULT_SHELL, readOnlyCommands: [...DEFAULT_SHELL.readOnlyCommands] };
  cfg.browser = { urlWhitelist: [...DEFAULT_BROWSER.urlWhitelist] };
  browserBridge?.setWhitelist([]);
  cfg.experts = JSON.parse(JSON.stringify(DEFAULT_EXPERTS));
  host?.rebuildExperts(JSON.parse(JSON.stringify(DEFAULT_EXPERTS)));
  // 模型回落：env 注入（自测）→ 本地自配 → 占位
  const envModel = process.env.ORDO_TEST_MODEL_JSON;
  if (envModel) {
    try {
      cfg.model = JSON.parse(envModel);
    } catch {
      /* 非法注入忽略 */
    }
  } else {
    const local = workspace ? await loadLocalModel(workspace.dirs.home) : null;
    cfg.model = local ? localModelToConfig(local) : JSON.parse(JSON.stringify(EMPTY_MODEL));
  }
  await host?.rebuildModel();
  skillMarket?.setProvider(new EmptySkillRegistryProvider());
  connectorHost?.setProvider(new EmptyMcpProvider());
  knowledgeProvider = new EmptyKnowledgeProvider();
  console.log("[ADMIN] 已退出联机（单机运行）：企业目录清空，企业下发资源保留");
}

async function bootstrap(): Promise<void> {
  workspace = Workspace.init();
  // 内置 Office 引擎健康标记（e2e 探针断言）：officecli 定性内置，随安装包分发、随发版更新
  const officeVer = officeBuiltinVersion();
  console.log(officeVer ? `[OFFICE] builtin v${officeVer}` : "[OFFICE] builtin 二进制缺失（Office 工具/预览将不可用）");
  // 本机设置（M6-C）：通用组三项持久化；开机自启启动时对齐系统注册
  settingsStore = new AppSettingsStore(path.join(workspace.dirs.config, "settings.json"));
  appSettings = settingsStore.get();
  if (!SELFTEST) {
    try {
      app.setLoginItemSettings({ openAtLogin: appSettings.autoStart, args: ["--hidden"] });
    } catch {
      /* 部分环境无注册权限：不自阻启动 */
    }
  }
  // M6-B 模式状态机：auth.json（mode/baseUrl/token）+ env 桥（ORDO_ADMIN_BASE 自测/e2e 直连）。
  //   online + token = 联机（企业链路全开）；online 无 token = 锁定（渲染层登录 gate，企业链路不启动）；
  //   standalone = 单机（无管理端：企业目录空 + 自配模型）；未配置 = 欢迎页。
  initAdminAuth(path.join(workspace.dirs.home, "auth.json"));
  setAuthExpiredHandler(() => win?.webContents.send("ordo:event", { type: "auth_expired" }));
  const envBase = (process.env.ORDO_ADMIN_BASE ?? "").trim().replace(/\/+$/, "");
  const savedMode = authModeOf();
  ADMIN_BASE = envBase || (savedMode === "online" ? savedBaseUrl() : "");
  if (ADMIN_BASE) {
    if (adminToken()) await adminVerifyToken(ADMIN_BASE); // 存量 token 失效即清（网络不可达不判死）
    if (!adminToken()) await envAutoLogin(ADMIN_BASE); // e2e/CI 桥；交互模式锁定态由渲染层登录
  }
  const ONLINE = !!ADMIN_BASE && !!adminToken();
  // 单机模型：env 注入（真实模式自测）优先于联机下发与 config.local.json——先注入，
  // applyOnlineConfig 的下发回调对 env 让位（否则联机路径两边都不落模型）；都无 = 未配置占位（聊天引导）
  const envModel = process.env.ORDO_TEST_MODEL_JSON;
  if (envModel) {
    try {
      cfg.model = JSON.parse(envModel);
    } catch {
      /* 非法注入忽略 */
    }
  }
  if (!ONLINE && !envModel) {
    const local = await loadLocalModel(workspace.dirs.home);
    if (local) cfg.model = localModelToConfig(local);
  }
  // 联机：平台配置（模型/四键）+ 专家目录须先于 host.init 就位（host 未建，仅落数据进 cfg）
  if (ONLINE) await applyOnlineConfig();
  const audit = (auditRef = new Audit(workspace.dirs.audit));
  // pi 会话存储（P1）：正文 JsonlSessionRepo + sidecar 索引；init 内完成旧 session-*.json 一次性迁移
  sessions = new PiSessionStore(workspace.dirs.sessions, workspace.dirs.recycle, () => workspace!.root);
  await sessions.init();
  localMcp = new LocalMcpHost({ audit, root: workspace.dirs.managed });
  // 数据源：联机 = HTTP；单机/锁定/未配置 = 空目录（个人能力不受影响；Mock Providers 已随 config.mock.json 退役）
  // 远端 MCP 传输池 + 个人连接器（跨模式持久，个人配置不出本机）
  mcpHttpHost ??= new McpHttpHost();
  if (!personalMcp) {
    personalMcp = new PersonalMcpStore({ file: path.join(workspace!.dirs.config, "personal-connectors.json"), http: mcpHttpHost, local: localMcp, audit });
    void personalMcp.syncSpecs(); // stdio 型个人连接器回登记（进程在首次工具调用时拉起）
  }
  connectorHost = new ConnectorHost(ONLINE ? new HttpMcpRegistryProvider(ADMIN_BASE) : new EmptyMcpProvider(), {
    audit,
    local: localMcp,
    remoteHttp: mcpHttpHost,
    personal: { list: () => personalMcp!.list() },
  });
  knowledgeProvider = ONLINE ? new HttpKnowledgeProvider(ADMIN_BASE) : new EmptyKnowledgeProvider();
  host = new AgentHost(cfg, {
    workspace,
    managedSkillDirs: () => pluginPacks?.managedSkillDirs() ?? [],
    audit,
    sessions,
    emit,
    confirm: SELFTEST
      ? async (req) => {
          console.log(`[SELFTEST] 自动同意 L2 操作: ${req.tool} ${req.args?.path ?? ""}`);
          return true;
        }
      : fgConfirm,
    selfTest: SELFTEST,
    connectors: connectorHost,
    knowledge: knowledgeProvider,
    personalKb: (personalKb = new PersonalKbStore({ workspace, audit })),
    browser: (browserBridge = new BrowserBridge({
      audit,
      // 预留管理端下发的 URL 白名单（方案 §5 安全）；空 = 不限制
      whitelist: ((cfg as { browser?: { urlWhitelist?: string[] } }).browser?.urlWhitelist ?? []),
      onEvent: (ev) => sendUi(ev),
    })),
  });
  // 用户侧终端（方案 §6）：独立宿主（不进 AgentHost——agent shell 工具后续单独立项）
  terminalHost = new TerminalHost({ audit, onEvent: (ev) => win?.webContents.send("ordo:event", ev) });
  // IM 通道（一期：钉钉/飞书长连接直连）：手机消息 → 绑定校验 → 独立后台 AgentHost 会话 → 回复推回。
  // 每通道独立 Workspace+AgentHost（同自动化 bgHost 模式：事件不进对话流、锚定默认工作区 persist=false）
  if (!imBridge) {
    const auditL = audit;
    const sessL = sessions!;
    const connL = connectorHost!;
    const kbL = knowledgeProvider!;
    imBridge = new ImBridge({
      file: path.join(workspace.dirs.config, "im-channels.json"),
      audit,
      emit: (ev) => emit(ev),
      resolveImRoot: () => {
        const e = workspace!.registry.byId("default");
        return e?.root ?? workspace!.dirs.workspace;
      },
      createHost: async (_channelId, hooks) => {
        const ws = new Workspace(workspace!.dirs.home);
        ws.registry.load(); // 只读加载（同 bgWorkspace）：IM 会话统一锚定默认工作区
        const entry = ws.registry.byId("default");
        ws.switchRoot(entry?.root ?? workspace!.dirs.workspace, false);
        const h = new AgentHost(cfg, {
          workspace: ws,
          audit: auditL,
          sessions: sessL,
          emit: hooks.emit,
          confirm: async (req) => hooks.confirm(req),
          selfTest: SELFTEST,
          connectors: connL,
          knowledge: kbL,
          personalKb: personalKb ?? new PersonalKbStore({ workspace: ws, audit: auditL }),
        });
        await h.init();
        return h;
      },
    });
    void imBridge.apply(); // 自连已启用通道（凭证不全/未启用为无害空转）
  }
  await host.init();

  // 企业技能市场（PRD 4.2/4.3）：后台同步对用户无感；数据源按模式切换（HTTP / 空目录）
  skillMarket = new SkillMarketService(ONLINE ? new HttpRegistryProvider(ADMIN_BASE) : new EmptySkillRegistryProvider(), {
    workspace,
    audit,
    reload: (reason) => host!.reloadSkills(reason),
    isBusy: () => host!.isRunning(),
  });
  await skillMarket.init({ autoSync: !SELFTEST }); // 自测手动驱动 syncNow，交互模式启动后 30s + 每 30min

  // 联机企业链路（锁定/单机不启动）；登录热接（enterOnline）与启动共用同一装配函数
  if (ADMIN_BASE && !ONLINE) {
    console.log(`[ADMIN] 管理端 ${ADMIN_BASE} 待登录（锁定态）：企业链路未启动，登录后热接入`);
  }
  if (ONLINE) await enterOnlineLinks();

  // 自动化（PRD 3.7 本地型）：仅用户自建、仅本机运行；管理端编排的服务端交互型不进客户端
  automations = new AutomationService({
    home: workspace.dirs.home,
    audit,
    expertExists: (id) => host!.listExperts().some((e) => e.id === id),
    workspaceOf: (id) => workspace!.registry.byId(id) ?? null,
    run: runAutomation,
    selfTest: SELFTEST,
    onRun: (task, rec) => {
      emit({
        type: "automation_run",
        id: task.id,
        name: task.name,
        ok: rec.ok,
        summary: rec.summary || rec.error || "",
        sessionId: rec.sessionId,
      });
      notify("Ordo · 自动化任务", `「${task.name}」${rec.ok ? "已完成，可在会话列表回看结果" : `运行失败：${rec.error || "见运行记录"}`}`);
    },
  });
  await automations.init();

  // 常用任务模板（/ 命令，对齐 Cursor /commands 与 Claude 自定义命令）：内置种子 + 用户自建
  templates = new TemplateStore({ home: workspace.dirs.home, audit });
  await templates.init();

  // 回收站：启动时清掉超过保留期（30 天）的条目，不阻塞启动
  recycle = new RecycleService({ dir: workspace.dirs.recycle, audit });
  void recycle.purgeExpired().catch(() => {});
}

// pi 会话正文文件计数（sessions/pi/<cwd 桶>/*.jsonl；自测「单文件更新」断言用）
function countPiSessionFiles(sessionsDir: string): number {
  try {
    const root = path.join(sessionsDir, "pi");
    let n = 0;
    for (const d of fs.readdirSync(root, { withFileTypes: true })) {
      if (!d.isDirectory()) continue;
      n += fs.readdirSync(path.join(root, d.name)).filter((f) => f.endsWith(".jsonl")).length;
    }
    return n;
  } catch {
    return 0;
  }
}

async function runSelftest(): Promise<void> {
  const fsp = await import("node:fs/promises");
  const selftestT0 = new Date().toISOString(); // 自测起点：清场只收本窗内创建的会话（用户同标题旧会话不误伤）
  const timer = setTimeout(() => {
    console.error("[SELFTEST] FAIL: 600s 超时");
    app.exit(1);
  }, 600000);
  const results: string[] = [];
  // 阶段 8 会临时改写 mock 管理端配置（版本/审核状态/下架），失败路径也要还原
  // 阶段 8 会经 mock 管理端 __test/mutate 变更目录（审批/版本/下架），失败路径 finally 里 restore 兜底
  const check = (name: string, ok: boolean, detail = "") => {
    results.push(`${ok ? "PASS" : "FAIL"} ${name}${detail ? `（${detail}）` : ""}`);
    if (!ok) throw new Error(name);
  };

  try {
    // ---- 阶段 0：干净起点 + 会话文件基线 ----
    host!.newSession();
    const sessionFilesBefore = countPiSessionFiles(workspace!.dirs.sessions);

    // ---- 阶段 0.7：M6 登录态与模型（联机 mock 企业服务：env 自动登录 → auth.json 落盘；模型经下发/env 注入就位）----
    {
      const authSnap = JSON.parse(fs.readFileSync(path.join(workspace!.dirs.home, "auth.json"), "utf-8"));
      check(
        "M6 登录态落盘（online）",
        authSnap.mode === "online" && authSnap.user?.empNo === "mock-emp" && !!(authSnap.tokenEnc || authSnap.token),
        JSON.stringify({ mode: authSnap.mode, emp: authSnap.user?.empNo })
      );
      check("M6 模型就位（下发或注入）", (cfg.model?.models?.length ?? 0) > 0, `${cfg.model?.providerName ?? "?"}/${cfg.model?.models?.[0]?.id ?? "?"}`);
    }

    // ---- 阶段 0.9：存储目录覆盖（设置页「存储」）：settings.json 覆盖默认工作区/rag 目录（重启生效语义）----
    {
      const altWs = path.join(workspace!.dirs.home, "selftest-ws-override");
      const altRag = path.join(workspace!.dirs.home, "selftest-rag-override");
      await settingsStore!.apply({ workspaceDir: altWs, ragDir: altRag });
      const altSpace = new Workspace(workspace!.dirs.home); // 模拟重启后的 init：构造时读 settings 覆盖
      check(
        "存储目录覆盖（workspace/rag 指向自定义位置）",
        altSpace.dirs.workspace === altWs && altSpace.dirs.rag === altRag,
        `${altSpace.dirs.workspace} | ${altSpace.dirs.rag}`
      );
      await settingsStore!.apply({ workspaceDir: "", ragDir: "" }); // 清覆盖 = 回默认（还原自测环境）
      const defSpace = new Workspace(workspace!.dirs.home);
      check(
        "存储目录清除覆盖回默认",
        defSpace.dirs.workspace === path.join(workspace!.dirs.home, "workspace") && defSpace.dirs.rag === path.join(workspace!.dirs.home, "rag"),
        `${defSpace.dirs.workspace} | ${defSpace.dirs.rag}`
      );
      await fsp.rm(altWs, { force: true, recursive: true }).catch(() => {});
      await fsp.rm(altRag, { force: true, recursive: true }).catch(() => {});
    }

    // ---- 阶段 0.8：单机未配置模型容错（EMPTY_MODEL：init 不崩、prompt 如实报错，交互模式首启路径）----
    {
      const bareHost = new AgentHost({ ...cfg, model: JSON.parse(JSON.stringify(EMPTY_MODEL)) }, {
        workspace: workspace!,
        audit: auditRef!,
        sessions: sessions!,
        emit,
        confirm: async () => true,
        selfTest: true,
        connectors: connectorHost!,
        knowledge: knowledgeProvider!,
        personalKb: personalKb!,
        browser: browserBridge,
      });
      let initOk = true;
      try {
        await bareHost.init();
      } catch (e) {
        initOk = false;
        console.log("[SELFTEST] EMPTY_MODEL init 异常:", String((e as Error).message ?? e));
      }
      const promptErr = String(await bareHost.prompt("你好").catch((e) => (e instanceof Error ? e.message : String(e))));
      check("M6 单机未配模型容错（init 不崩 + prompt 如实报错）", initOk && promptErr.includes("模型未配置"), `init=${initOk} err=${promptErr.slice(0, 40)}`);
    }

    // ---- 阶段 0.9：单机模型配置映射（高级参数 + 思考开关两态）----
    {
      const base = localModelToConfig({ baseUrl: "http://x/v1", apiKey: "k", modelId: "m1", modelName: "M1" });
      check("单机模型默认参数（128K/16K，思考关）", base.models[0].contextWindow === 131072 && base.models[0].maxTokens === 16384 && base.thinking.levels.length === 1, JSON.stringify(base.thinking.levels));
      const adv = localModelToConfig({ baseUrl: "http://x/v1", apiKey: "k", modelId: "m2", modelName: "M2", contextWindow: 65536, maxTokens: 4096, thinking: true, thinkingDefault: "high" });
      check("单机模型高级参数 + 思考开（四档/默认 high）", adv.models[0].contextWindow === 65536 && adv.models[0].maxTokens === 4096 && adv.thinking.levels.length === 4 && adv.thinking.defaultId === "high", `${adv.thinking.levels.length} 档 default=${adv.thinking.defaultId}`);
      const vis = localModelToConfig({ baseUrl: "http://x/v1", apiKey: "k", modelId: "m3", modelName: "M3", vision: true });
      check("视觉模型声明（input 含 image，支撑多模态直传）", JSON.stringify(vis.models[0].input) === '["text","image"]' && JSON.stringify(base.models[0].input) === '["text"]', JSON.stringify(vis.models[0].input));
      check("纯文本模型不支持视觉（supportsVision 默认关闭）", host!.supportsVision() === false);
      const { ocrLangPath } = await import("./ocr");
      check("OCR 语言数据随包内置（离线可用）", !!ocrLangPath(), ocrLangPath() ?? "未找到 tessdata（将回落 CDN）");
      // 多模态模型不注册 ocr_image（能直接看图，OCR 冗余）；还原后非视觉模型恢复注册
      {
        const m0 = cfg.model.models[0] as { input?: string[] };
        const origInput = m0.input;
        m0.input = ["text", "image"];
        await host!.rebuildModel();
        const visionTools = host!.activeToolNames();
        m0.input = origInput ?? ["text"];
        await host!.rebuildModel();
        check("视觉模型隐藏 ocr_image（多模态直接看图）", !visionTools.includes("ocr_image") && host!.activeToolNames().includes("ocr_image"), `视觉态工具数 ${visionTools.length}`);
      }
    }

    // ---- 阶段 0.5：SKILL 加载断言 ----
    check("SKILL 加载", host!.skillsCount() >= 1, `已加载 ${host!.skillsCount()} 个`);
    check("SKILL 注入系统提示词", host!.systemPromptText().includes("weekly-report"));

    // ---- 阶段 1：P0 旅程 3（默认专家，L2 自动同意）----
    const fsp2 = await import("node:fs/promises");
    await fsp2.rm(path.join(workspace!.root, "out"), { recursive: true, force: true }).catch(() => {});
    await host!.prompt("请读取 data/sales.txt，生成周报并写入 out/weekly-report.md");
    // 模型层失败（网关 4xx/5xx/断网）pi 不抛异常而是空回合收束：在这里就给出真实原因并终止，
    // 避免后续一堆文件级断言报 ENOENT 掩盖根因（如"402 余额不足"）
    if ((host as any).lastAssistantStop === "error") {
      check("真实模型可用", false, String((host as any).prettyModelError?.() ?? (host as any).lastModelError ?? "").slice(0, 120));
      throw new Error("真实模型调用失败，自测终止（检查网关连通/余额/模型配置）");
    }
    const report = path.join(workspace!.root, "out", "weekly-report.md");
    const stat = await fsp.stat(report);
    const content = await fsp.readFile(report, "utf-8");
    check("旅程3 报告生成", stat.size > 0 && content.includes("周报"), `${stat.size} 字节`);
    check("默认专家全量工具", host!.activeToolNames().length === 20, host!.activeToolNames().join(","));
    check("计划工具已注册（update_plan，浮标数据源）", host!.activeToolNames().includes("update_plan"));

    // ---- 阶段 2：切换专家（人设 + 技能白名单，PRD 3.10：基础工具不收窄）----
    await host!.switchExpert("drawing-checker");
    check("专家不收窄基础工具", host!.activeToolNames().length === 20, host!.activeToolNames().join(","));
    check("专家角色层生效", host!.systemPromptText().includes("图纸核对工程师"));
    check("基座层不被覆盖", host!.systemPromptText().includes("基座层规范"));
    check("技能白名单收窄生效", !host!.systemPromptText().includes("weekly-report"), "drawing-checker 不挂技能");
    await fsp.rm(path.join(workspace!.root, "out"), { recursive: true, force: true }).catch(() => {});
    await host!.prompt("请读取 data/sales.txt，生成周报并写入 out/weekly-report.md");
    const report2 = await fsp.stat(report).then(() => true).catch(() => false);
    check("专家基础能力一致（仍可写）", report2, "无工具约束，写走 L2 确认");

    // ---- 阶段 3：新建会话（清上下文 + 回默认专家），验证后回到会话 A 继续 ----
    const sidA = host!.currentSessionId;
    check("会话已保存", !!sidA);
    const countA = host!.messageCount();
    host!.newSession();
    check("新建会话清空上下文", host!.messageCount() === 0);
    check("新建会话回默认专家", host!.currentExpert.id === "general", "角色不带入新会话");
    check("默认专家技能恢复", host!.systemPromptText().includes("weekly-report"), "白名单 null = 全量技能");
    await host!.loadSession(sidA!); // 回到会话 A：后续轮次仍归档同一文件

    // ---- 阶段 4：思考强度开关（PRD 3.4；mock 模型无此配置自动跳过）----
    if (host!.thinkingConfigured()) {
      const idx = host!.messageCount();
      host!.switchThinking("off");
      check("思考强度切到关闭", host!.currentThinking().id === "off");
      await host!.prompt("1+1等于几？只回答数字。");
      check("关闭档无思考内容块", !host!.hasThinkingBlockSince(idx));
      host!.switchThinking("high");
      check("思考强度切到高档", host!.currentThinking().id === "high");
      host!.switchThinking("medium");
    }

    // ---- 阶段 5：会话持久化与续接（PRD 3.3）：newSession 清空 → load 恢复 → 续接问答 ----
    const countBefore = host!.messageCount();
    host!.newSession();
    check("续接前上下文已清空", host!.messageCount() === 0);
    const loaded = await host!.loadSession(sidA!);
    check("续接恢复消息数", host!.messageCount() === countBefore && loaded.messages.length === countBefore);
    check("续接恢复所用专家", loaded.expert === host!.currentExpert.id);
    await host!.prompt("刚才生成的周报写在哪个文件？只回答相对路径。");
    const reply = host!.lastAssistantText();
    check("续接后模型记得上下文", reply.includes("weekly-report"), reply.slice(0, 40));
    const sessionFilesAfter = countPiSessionFiles(workspace!.dirs.sessions);
    check("同会话单文件更新（pi 逐条追加）", sessionFilesAfter - sessionFilesBefore === 1, `新增 ${sessionFilesAfter - sessionFilesBefore} 个文件`);

    // ---- 阶段 6：上下文压缩（PRD 3.3；自测用小保留预算强制触发，自动档在接近窗口时触发）----
    const before6 = host!.messageCount();
    // keepRecentTokens 需小于旅程历史总量（mock 剧本 ~160t）才能切出压缩区间，又要保住末轮 → 取 100t
    const comp = await host!.compactNow({ reserveTokens: 4000, keepRecentTokens: 100 });
    check("压缩执行成功", comp.ok === true, comp.reason ?? `${comp.messagesBefore}→${comp.messagesAfter} 条`);
    check("压缩后消息数下降", host!.messageCount() < before6);
    check("摘要消息置顶", host!.headMessageRole() === "compactionSummary");
    check("近期尾部保留", host!.messageCount() >= 2);
    await host!.prompt("我们这次对话生成了什么文件？只回答文件路径。");
    const reply6 = host!.lastAssistantText();
    // 真实模型偶发答"周报文件"而不带完整路径：关键信息保住即视为压缩后连贯
    check("压缩后上下文仍连贯", reply6.includes("weekly-report") || reply6.includes("周报"), reply6.slice(0, 40));
    // pi 会话层闭环：压缩以 sd_compaction entry 追加落盘（append-only），重开会话重放须折叠为「摘要+尾部」
    {
      const sid6 = host!.currentSessionId!;
      const re6 = await sessions!.load(sid6!);
      check(
        "pi 压缩落盘重放折叠",
        re6?.messages?.[0]?.role === "compactionSummary" && re6!.messages.length >= 2,
        `${re6?.messages?.length ?? 0} 条，首条 ${re6?.messages?.[0]?.role ?? "无"}`
      );
    }
    // pi 迁移通道：旧 session-*.json 一次性迁入（pi JSONL + sidecar 索引 + 原件 .migrated 保留）
    {
      const tmpDir = path.join(workspace!.dirs.home, "selftest-pi-migrate");
      fs.mkdirSync(tmpDir, { recursive: true });
      fs.writeFileSync(
        path.join(tmpDir, "session-legacy-1.json"),
        JSON.stringify({
          id: "legacy-1",
          title: "旧格式会话",
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-02T00:00:00.000Z",
          expert: "general",
          messages: [
            { role: "user", content: "旧问题" },
            { role: "assistant", content: [{ type: "text", text: "旧回答" }] },
            { role: "compactionSummary", summary: "旧摘要", tokensBefore: 100, timestamp: 1 },
            { role: "user", content: "压缩后问题" },
          ],
        })
      );
      const mig = new PiSessionStore(tmpDir, path.join(tmpDir, "recycle"), () => workspace!.root);
      await mig.init();
      const l = await mig.list();
      check("pi 迁移:列表含旧会话", l.some((x) => x.id === "legacy-1" && x.title === "旧格式会话"), JSON.stringify(l.map((x) => x.id)));
      const ld = await mig.load("legacy-1");
      check(
        "pi 迁移:压缩折叠重放",
        ld?.messages?.[0]?.role === "compactionSummary" && ld!.messages.length === 2,
        JSON.stringify(ld?.messages?.map((m: any) => m.role))
      );
      check("pi 迁移:原件保留 .migrated", fs.existsSync(path.join(tmpDir, "session-legacy-1.json.migrated")));
      const rm = await mig.remove("legacy-1");
      check("pi 迁移:删除入回收站", rm === true && !(await mig.list()).some((x) => x.id === "legacy-1"));
      await mig.close();
      await fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    }

    // ---- 阶段 6c：运行中消息——发送即默认排队，可切引导，可撤回/删除 ----
    {
      const p6c = host!.prompt("慢速任务：读取 data/sales.txt 后总结");
      // 锚定首轮响应已落再入队（与真实「任务进行中插话」一致；入队早于首条 prompt 时
      // pi 会把消息挂在 prompt 之前的位置，语义变为前置上下文而非中途引导）
      let sawFirst = false;
      for (let i = 0; i < 120; i++) {
        await new Promise((r) => setTimeout(r, 50));
        if (JSON.stringify(host!.messages()).includes("慢速处理中")) { sawFirst = true; break; }
      }
      check("慢速任务首轮已响应", sawFirst === true);
      // ① 发送即默认排队
      let qId = "";
      try {
        qId = await host!.queueFollowUp("插入指令：改为生成双语版周报");
      } catch (e) {
        check("默认排队入队", false, String(e));
      }
      check("默认排队入队", !!qId);
      check("队列态为排队", host!.queueSnapshot().every((x: any) => x.kind === "followUp"));
      // ② 再排一条并撤回（回撤编辑/删除共用通道）
      const tmpId = await host!.queueFollowUp("排队任务：1+1等于几？");
      check("第二条排队入队", !!tmpId && host!.queueSnapshot().length === 2);
      check("撤回排队消息", (await host!.cancelQueued(tmpId!)) === true && host!.queueSnapshot().length === 1);
      // ③ 切换到引导（撤旧入新）
      const swId = await host!.switchQueued(qId!, "steer");
      check("切到引导（换发新条目）", !!swId && swId !== qId && host!.queueSnapshot().every((x: any) => x.kind === "steer"));
      // ④ UI 侧：排队区（输入框右上方）渲染条目，含切换/撤回/删除
      const qDom = await win!.webContents.executeJavaScript(`(() => {
        const area = document.getElementById("queue-area");
        return {
          visible: !!area && !area.classList.contains("hidden"),
          items: document.querySelectorAll("#queue-items .queue-item").length,
          hasSwitch: !!document.querySelector("#queue-items .qsw"),
          hasEdit: !!document.querySelector("#queue-items .qedit"),
          hasDel: !!document.querySelector("#queue-items .qdel"),
          label: (document.querySelector("#queue-items .qk") || {}).textContent ?? "",
          noModeRow: !document.getElementById("queue-mode-row"),
        };
      })()`);
      check("排队区渲染（发送即排队，可切/撤/删，无模式条）", qDom.visible === true && qDom.items === 1 && qDom.hasSwitch && qDom.hasEdit && qDom.hasDel && qDom.label.includes("已插入") && qDom.noModeRow === true, JSON.stringify(qDom));
      await p6c;
      await new Promise((r) => setTimeout(r, 150)); // 等引导消费回合与镜像刷新
      const flat6c = JSON.stringify(host!.messages());
      check("引导消息已注入上下文", flat6c.includes("双语版"), flat6c.slice(0, 60));
      check("引导指令得到响应", host!.lastAssistantText().includes("已收到插入指令"), host!.lastAssistantText().slice(0, 40));
      check("撤回的排队消息未执行", !flat6c.includes("排队任务"));
      check("队列已清空", host!.queueSnapshot().length === 0);
    }

    // ---- 阶段 6b：消息操作（重新生成 / 质量反馈，PRD 4.x 有用无用 + 体验清单）----
    host!.newSession();
    await host!.prompt("1+1等于几？只回答数字。");
    // 主进程直驱 prompt 不经过输入框 send()：渲染层须在 run_start 收到提示词后自补用户气泡并收起欢迎屏
    {
      const injected = await win!.webContents.executeJavaScript(`(async () => {
        let last = null;
        for (let i = 0; i < 20; i++) {
          const turns = document.querySelectorAll("#thread .turn");
          last = turns[turns.length - 1];
          if (last?.querySelector(".msg-user")) break;
          await new Promise((r) => setTimeout(r, 100));
        }
        return {
          turns: document.querySelectorAll("#thread .turn").length,
          hasUserBubble: !!last?.querySelector(".msg-user") && last.textContent.includes("1+1等于几"),
          emptyGone: !document.getElementById("empty-state"),
        };
      })()`);
      check("主进程直驱渲染补全（用户气泡+欢迎屏收起）", injected.turns >= 1 && injected.hasUserBubble && injected.emptyGone, JSON.stringify(injected));
    }
    const msgsBeforeRegen = host!.messageCount();
    await host!.regenerate();
    check("重新生成后消息数守恒（旧轮截掉重答）", host!.messageCount() === msgsBeforeRegen, `${msgsBeforeRegen} → ${host!.messageCount()}`);
    check("重新生成产出新回答", !!host!.lastAssistantText(), host!.lastAssistantText().slice(0, 30));
    host!.feedback("up");
    host!.feedback("down");
    const auditAll = fs
      .readdirSync(workspace!.dirs.audit)
      .filter((f) => f.endsWith(".jsonl"))
      .map((f) => fs.readFileSync(path.join(workspace!.dirs.audit, f), "utf-8"))
      .join("");
    check("回答反馈落审计行（answer_feedback 上报链路）", auditAll.includes('"answer_feedback"') && auditAll.includes('"down"'));
    // 消息操作条（渲染层真实挂载回归）：run_end 后最终回答下出现操作条（复制/重新生成/赞/踩）。
    // 曾因事件顺序 bug（assistant_done 先关 textBlock，run_end 取到空串）从不出现——渲染层断言锁住。
    // 按标题断言（版本切换箭头也是 .ma-btn，数量不恒定）
    let actionBar = "";
    for (let i = 0; i < 20 && !actionBar; i++) {
      await new Promise((r) => setTimeout(r, 250));
      actionBar = await win!.webContents.executeJavaScript(`(() => {
        const bar = document.querySelector(".msg-actions");
        return bar ? [...bar.querySelectorAll(".ma-btn")].map((b) => b.title).filter(Boolean).join("|") : "";
      })()`);
    }
    check(
      "消息操作条挂载（复制/重新生成/赞/踩）",
      ["复制回答", "重新生成", "有用", "没用"].every((t) => actionBar.includes(t)),
      actionBar || "5s 内未见 .msg-actions"
    );
    // 方案 B 原位替换 + 版本切换：点「重新生成」→ 旧回答消失新回答顶上 → 操作条出现 ‹ n/N › 计数
    const clickedRegen = await win!.webContents.executeJavaScript(`(() => {
      const b = [...document.querySelectorAll(".msg-actions .ma-btn")].find((x) => x.title === "重新生成");
      if (!b) return false;
      b.click();
      return true;
    })()`);
    let verCnt = "";
    for (let i = 0; i < 40 && !verCnt; i++) {
      await new Promise((r) => setTimeout(r, 250));
      verCnt = await win!.webContents.executeJavaScript(`(() => {
        const c = document.querySelector(".msg-actions .ma-ver-cnt");
        return c ? c.textContent : "";
      })()`);
    }
    check("重新生成原位替换 + 版本计数（‹n/N›）", clickedRegen && /^\d+\/\d+$/.test(verCnt) && verCnt !== "1/1", verCnt || "10s 内未见版本计数");
    // 切换到上一版本再切回：正文随版本重渲染，计数回到末版
    const flipBack = await win!.webContents.executeJavaScript(`(() => {
      const prev = document.querySelector(".msg-actions .ma-ver");
      if (prev && !prev.disabled) prev.click();
      return true;
    })()`);
    await new Promise((r) => setTimeout(r, 300));
    const verCnt2 = await win!.webContents.executeJavaScript(`(() => document.querySelector(".msg-actions .ma-ver-cnt")?.textContent ?? "")()`);
    const flipFwd = await win!.webContents.executeJavaScript(`(() => {
      const next = [...document.querySelectorAll(".msg-actions .ma-ver")][1];
      if (next && !next.disabled) next.click();
      return true;
    })()`);
    await new Promise((r) => setTimeout(r, 300));
    const verCnt3 = await win!.webContents.executeJavaScript(`(() => document.querySelector(".msg-actions .ma-ver-cnt")?.textContent ?? "")()`);
    check("版本箭头来回切换（计数变化且回末版）", flipBack && flipFwd && verCnt2 !== verCnt3 && verCnt3 === verCnt, `${verCnt} → ${verCnt2} → ${verCnt3}`);
    // 附件区位置（输入框上方外侧）：attach-row 是 composer 的前邻兄弟（体验升级回归）
    const attPos = await win!.webContents.executeJavaScript(`(() => {
      const row = document.getElementById("attach-row");
      const composer = document.getElementById("composer");
      if (!row || !composer) return "missing";
      return row.previousElementSibling === composer || composer.previousElementSibling === row ? (composer.previousElementSibling === row ? "outside" : "inside") : "detached";
    })()`);
    check("附件区在输入框上方外侧", attPos === "outside", attPos);

    // ---- 阶段 7：契约扩展（会话管理 / 多工作区 / 文件预览 / 技能启停 / 模型 / 停止）----
    // 7.0 自备可操作会话：直接落盘一条种子（不耗模型轮次）——不再依赖历史遗留会话（干净环境下应同样可跑）
    const victimSeed: StoredSession = {
      id: `seed-${Date.now().toString(36)}`,
      title: "自测可操作会话",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      expert: "general",
      wsId: "default",
      wsRoot: workspace!.root,
      messages: [{ role: "user", content: "自测会话种子" }],
    };
    await sessions!.save(victimSeed);
    // 7.1 会话管理：置顶 → 重命名 → 删除进回收站
    const victim = (await host!.listSessions()).find((s) => s.id !== host!.currentSessionId);
    check("存在可操作的会话", !!victim);
    const listBefore = (await host!.listSessions()).length;
    await sessions!.mutate(victim!.id, { pinned: true });
    await sessions!.mutate(victim!.id, { title: "重命名测试会话" });
    const renamed = (await host!.listSessions()).find((s) => s.id === victim!.id);
    check("会话置顶+重命名生效", renamed?.pinned === true && renamed?.title === "重命名测试会话");
    const removed = await sessions!.remove(victim!.id);
    check("会话删除进回收站", removed && !(await host!.listSessions()).some((s) => s.id === victim!.id));
    const recycled = fs.readdirSync(workspace!.dirs.recycle).some((f) => f.includes(victim!.id));
    check("回收站留有备份", recycled);
    check("删除后列表减一", (await host!.listSessions()).length === listBefore - 1);

    // 7.2 多工作区：登记临时目录 → 切换 → 围栏跟随 → 切回 → 清理（不留垃圾注册项）
    const tmpRoot = path.join(workspace!.dirs.home, "selftest-ws-" + Date.now());
    const entry = workspace!.registry.add(tmpRoot);
    const wsCountBefore = workspace!.registry.list().length;
    check("工作区登记", wsCountBefore >= 2 && entry.root === tmpRoot);
    workspace!.switchRoot(entry.root);
    await fsp.writeFile(path.join(tmpRoot, "hello.txt"), "你好工作区", "utf-8");
    check("工作区根已切换", path.resolve(workspace!.root) === path.resolve(tmpRoot));
    check("围栏跟随新根", path.resolve(workspace!.resolveInside("hello.txt")) === path.join(tmpRoot, "hello.txt"));
    let fenceEscape = false;
    try {
      workspace!.resolveInside("../esc.txt");
      fenceEscape = true;
    } catch {
      // 越界应 throw
    }
    check("围栏拒绝越界", !fenceEscape);
    workspace!.switchRoot(workspace!.registry.byId("default")!.root);
    check("切回默认工作区", workspace!.registry.currentId() === "default");
    check("临时工作区移除", workspace!.registry.remove(entry.id) && workspace!.registry.list().length === wsCountBefore - 1);
    await fsp.rm(tmpRoot, { recursive: true, force: true }).catch(() => {});

    // 7.3 文件预览（工作台交付物预览：文本走 Markdown、HTML/图片/PDF 走各自通道）
    const preview = await readFilePreview(workspace!, "data/sales.txt");
    check("文件预览可读", !!preview && preview.kind === "text" && preview.content.includes("产品A"));
    const denied = await readFilePreview(workspace!, "../../Windows/win.ini").catch(() => "fenced");
    check("文件预览围栏", denied === "fenced" || denied === null);
    const pvDir = path.join(workspace!.root, "preview-selftest");
    await fsp.mkdir(pvDir, { recursive: true });
    // 最小可用 docx/xlsx/pptx 夹具（store-only zip）；渲染端解析在 UI 冒烟里验
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const officeFx = require("../../tools/office-fixtures.cjs") as {
      makeDocx: () => Buffer;
      makeXlsx: () => Buffer;
      makePptx: () => Buffer;
    };
    try {
      await fsp.writeFile(path.join(pvDir, "a.html"), "<h1>标题</h1><script>alert(1)</script>", "utf-8");
      await fsp.writeFile(path.join(pvDir, "b.png"), Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64"));
      await fsp.writeFile(path.join(pvDir, "c.pdf"), "%PDF-1.4\n%%EOF\n", "latin1");
      await fsp.writeFile(path.join(pvDir, "d.doc"), "PK-fake-old-binary", "latin1");
      await fsp.writeFile(path.join(pvDir, "e.docx"), officeFx.makeDocx());
      await fsp.writeFile(path.join(pvDir, "f.xlsx"), officeFx.makeXlsx());
      await fsp.writeFile(path.join(pvDir, "g.pptx"), officeFx.makePptx());
      const hv = await readFilePreview(workspace!, "preview-selftest/a.html");
      check("HTML 预览走渲染通道", !!hv && hv.kind === "html" && hv.content.includes("<h1>"));
      const iv = await readFilePreview(workspace!, "preview-selftest/b.png");
      check("图片预览返回 dataURL", !!iv && iv.kind === "image" && iv.mime === "image/png" && iv.dataUrl.startsWith("data:image/png;base64,"));
      const dv = await readFilePreview(workspace!, "preview-selftest/c.pdf");
      check("PDF 预览返回 dataURL", !!dv && dv.kind === "pdf" && dv.dataUrl.startsWith("data:application/pdf;base64,"));
      const ov = await readFilePreview(workspace!, "preview-selftest/d.doc");
      check("老格式 .doc 如实回落", ov === null);
      const ev = await readFilePreview(workspace!, "preview-selftest/e.docx");
      check("docx 走 Office 通道", !!ev && ev.kind === "office" && ev.format === "docx" && ev.dataUrl.startsWith("data:application/vnd.openxmlformats-officedocument.wordprocessingml.document;base64,"));
      const evHtml = ev && ev.kind === "office" ? ev.html : undefined;
      check(
        "Office 保真主路径（view html 产出且已剥脚本）",
        !!evHtml && evHtml.includes("<") && !/<script/i.test(evHtml) && evHtml.includes("Ordo 自测周报"),
        (evHtml ?? "").slice(0, 60)
      );
      const fv = await readFilePreview(workspace!, "preview-selftest/f.xlsx");
      check("xlsx 走 Office 通道", !!fv && fv.kind === "office" && fv.format === "xlsx");
      const gv = await readFilePreview(workspace!, "preview-selftest/g.pptx");
      check("pptx 走 Office 通道", !!gv && gv.kind === "office" && gv.format === "pptx" && gv.bytes > 0);
    } finally {
      await fsp.rm(pvDir, { recursive: true, force: true }).catch(() => {});
    }

    // 7.3b 用户侧编辑回写（方案 §2.3 第一层）：md/txt/csv 文本 + xlsx 二进制；审计 user_edit；围栏与扩展名白名单
    {
      const fx = require("../../tools/office-fixtures.cjs") as { makeXlsx: () => Buffer };
      const edDir = "preview-selftest-edit";
      try {
        const saved = await saveUserEdit(workspace!, `${edDir}/notes.md`, { text: "# 改后\n\n内容 v2" }, auditRef ?? undefined);
        check(
          "文本编辑写入",
          saved.bytes > 0 && (await fsp.readFile(path.join(workspace!.root, edDir, "notes.md"), "utf-8")).includes("内容 v2")
        );
        const badExt = await saveUserEdit(workspace!, `${edDir}/x.json`, { text: "{}" }).then(
          () => "no-error",
          (e) => String(e.message)
        );
        check("编辑扩展名白名单（md/txt/csv）", badExt.includes("仅支持"));
        const fenced = await saveUserEdit(workspace!, "../outside.md", { text: "x" }).catch(() => "fenced");
        check("编辑围栏", fenced === "fenced");
        const xlsxBytes = fx.makeXlsx();
        await saveUserEdit(workspace!, `${edDir}/wb.xlsx`, { base64: xlsxBytes.toString("base64") });
        const written = await fsp.readFile(path.join(workspace!.root, edDir, "wb.xlsx"));
        check("xlsx 回写二进制（PK 头且字节一致）", written.slice(0, 2).toString("latin1") === "PK" && written.equals(xlsxBytes));
        const auditText = await fsp.readFile(path.join(workspace!.dirs.audit, `audit-${new Date().toISOString().slice(0, 10)}.jsonl`), "utf-8");
        check("user_edit 审计落盘", auditText.includes('"event":"user_edit"') && auditText.includes("notes.md"));
      } finally {
        await fsp.rm(path.join(workspace!.root, edDir), { recursive: true, force: true }).catch(() => {});
      }
    }

    // 7.3c 浏览器桥 A（方案 §5，webview 内嵌）：附着语义离线验证——隐藏替身窗口承载 data: 测试页，
    // 生产形态为面板 <webview>（dom-ready 后 attach），此处直接附着替身 WebContents 走同一代码路径
    {
      const DATA_PAGE =
        "data:text/html,<html><head><meta charset='utf-8'></head><body><h1>桥接测试页</h1><input id='q'><button id='go' onclick=\"window.__clicked=document.getElementById('q').value;console.log('clicked:'+window.__clicked)\">查询</button><script>console.log('page-ready')</script></body></html>";
      const names = host!.activeToolNames();
      check(
        "浏览器工具面注册（7 个）",
        ["browser_open", "browser_snapshot", "browser_click", "browser_type", "browser_extract", "browser_screenshot", "browser_console"].every((n) => names.includes(n))
      );
      const anyHost = host as any;
      check("browser_open 初始为 L2（跨源/首次需确认）", anyHost.levelOf("browser_open") === "L2");
      // open：主进程记账 + 广播导航（生产中由面板 webview 加载；此处替身窗口加载同 URL 再附着）
      browserBridge.open(DATA_PAGE, "agent");
      const standIn = createTestPageWindow(DATA_PAGE);
      await new Promise((r) => setTimeout(r, 700)); // 等替身页加载
      browserBridge.attach(standIn.webContents.id);
      check("受控页面附着（webview 同路径）", browserBridge.state.open && browserBridge.state.url.startsWith("data:"));
      check("同源后续导航降 L1", anyHost.levelOf("browser_open") === "L1");
      const snap = await browserBridge.snapshot();
      check("快照含页面文本", snap.includes("桥接测试页"));
      await browserBridge.type("#q", "关键词");
      await browserBridge.click("#go");
      let tail = browserBridge.consoleTail(10);
      for (let i = 0; i < 8 && !tail.some((c) => c.text.includes("clicked:关键词")); i++) {
        // 偶发竞态：type 的聚焦点击后 60ms 内焦点未落（机器负载高时），合成字符全丢 → 值为空。整链重打
        await browserBridge.type("#q", "关键词");
        await browserBridge.click("#go");
        await new Promise((r) => setTimeout(r, 250));
        tail = browserBridge.consoleTail(10);
      }
      check("输入+点击生效且控制台捕获", tail.some((c) => c.text.includes("clicked:关键词")), tail.map((c) => c.text).join(";").slice(0, 60));
      const shotRel = await browserBridge.screenshot(workspace!.root);
      const shotStat = await fsp.stat(path.join(workspace!.root, shotRel)).catch(() => null);
      check("截图存证入工作区", !!shotStat && shotStat.size > 100);
      await standIn.webContents.executeJavaScript("location.href='http://example.com/'").catch(() => {});
      await new Promise((r) => setTimeout(r, 400));
      check("跨源跳转被拦截", browserBridge.state.url.startsWith("data:"), browserBridge.state.url.slice(0, 30));
      const auditText2 = await fsp.readFile(path.join(workspace!.dirs.audit, `audit-${new Date().toISOString().slice(0, 10)}.jsonl`), "utf-8");
      check("browser_blocked 入审计", auditText2.includes('"event":"browser_blocked"'));
      check(
        "browser_open（含 source）/截图入审计",
        auditText2.includes('"event":"browser_open"') && auditText2.includes('"source":"agent"') && auditText2.includes('"event":"browser_screenshot"')
      );
      // 网址归一化（纯函数直测，不触发 open 的广播/UI 导航副作用）：裸域名补 https；补全后仍非法 → 友好报错
      check("无协议网址自动补全 https", safeUrl("www.baidu.com").href === "https://www.baidu.com/" && safeUrl("baidu.com").href === "https://baidu.com/");
      let badUrlErr = "";
      try {
        safeUrl("bad url");
      } catch (e) {
        badUrlErr = String((e as Error).message);
      }
      check("非法网址友好报错（网址无效）", badUrlErr.includes("网址无效"), badUrlErr.slice(0, 40));
      const stopped = browserBridge.stop();
      check("急停解附并重置批准源（回 L2）", stopped && !browserBridge.state.open && anyHost.levelOf("browser_open") === "L2");
      standIn.destroy();
      await fsp.rm(path.join(workspace!.root, "browser-shots"), { recursive: true, force: true }).catch(() => {});
    }

    // 7.3d 用户侧终端（方案 §6）：PowerShell pty 回环（写入命令→输出回采→尺寸→关闭），离线可测
    {
      const termEvents: Array<Record<string, unknown>> = [];
      const localTerm = new TerminalHost({
        audit: auditRef!,
        onEvent: (ev) => termEvents.push(ev),
      });
      const opened = localTerm.open(workspace!.root);
      check("终端打开（非复用）", !opened.reused && opened.cols >= 40, `cols=${opened.cols}`);
      await new Promise((r) => setTimeout(r, 400)); // 等 PowerShell 横幅
      localTerm.write("echo ordo-term-ok\r");
      let sawOk = false;
      for (let i = 0; i < 40 && !sawOk; i++) {
        await new Promise((r) => setTimeout(r, 150));
        sawOk = termEvents.some((e) => e.type === "term_data" && String(e.data).includes("ordo-term-ok"));
      }
      check("命令写入→输出回采", sawOk);
      check("终端可调整尺寸", localTerm.resize(100, 30) === true);
      check("关闭终端", localTerm.close() === true && !localTerm.active);
      const auditText3 = await fsp.readFile(path.join(workspace!.dirs.audit, `audit-${new Date().toISOString().slice(0, 10)}.jsonl`), "utf-8");
      check("term_open/term_close 入审计", auditText3.includes('"event":"term_open"') && auditText3.includes('"event":"term_close"'));
    }

    // 7.3e agent 命令执行（方案 C 自研）：白名单 L1 / 非白名单与链式 L2 / 执行回传 / 超时终止 / 审计分级
    {
      const names2 = host!.activeToolNames();
      check("run_command 已注册", names2.includes("run_command"));
      const ah = host as any;
      check("白名单命令判 L1（Get-Location）", ah.levelOf("run_command", { command: "Get-Location" }) === "L1");
      check("非白名单命令判 L2（Write-Output）", ah.levelOf("run_command", { command: "Write-Output hi" }) === "L2");
      check(
        "链式/管道一律判 L2",
        ah.levelOf("run_command", { command: "dir | Select-Object 1" }) === "L2" && ah.levelOf("run_command", { command: "dir; dir" }) === "L2"
      );
      const cmdTool = (ah.allTools as any[]).find((t) => t.name === "run_command");
      const r1 = await cmdTool.execute("t-cmd-1", { command: "Get-Location" });
      check("只读命令执行（输出含 .ordo 工作区路径）", String(r1.content[0].text).toLowerCase().includes("ordo"));
      const r2 = await cmdTool.execute("t-cmd-2", { command: "Write-Output ordo-cmd-ok" });
      check("命令输出回传", String(r2.content[0].text).includes("ordo-cmd-ok"));
      const r3 = await cmdTool.execute("t-cmd-3", { command: "Start-Sleep 8", timeout: 1 });
      check("超时终止并如实报告", /超时/.test(String(r3.content[0].text)));
      const auditText4 = await fsp.readFile(path.join(workspace!.dirs.audit, `audit-${new Date().toISOString().slice(0, 10)}.jsonl`), "utf-8");
      check(
        "run_command 执行明细入审计（含 L1/L2 分级）",
        auditText4.includes('"event":"run_command"') && auditText4.includes('"level":"L1"') && auditText4.includes('"level":"L2"')
      );
    }

    // 7.4 技能启停：停用即从系统提示词移除，启用恢复（在默认专家下验证：白名单 null = 全量）
    await host!.switchExpert("general");
    const skills = host!.listSkillsRich();
    check("技能清单含种子技能", skills.some((s) => s.name === "weekly-report" && s.enabled));
    await host!.setSkillEnabled("weekly-report", false);
    check("停用后提示词移除", !host!.systemPromptText().includes("weekly-report"));
    check("停用状态入清单", host!.listSkillsRich().find((s) => s.name === "weekly-report")?.enabled === false);
    await host!.setSkillEnabled("weekly-report", true);
    check("启用后提示词恢复", host!.systemPromptText().includes("weekly-report"));

    // 7.5 模型清单与切换（单模型配置下切换自身）
    const models = host!.listModels();
    check("模型清单含当前模型", models.items.some((m) => m.id === models.currentId));
    host!.switchModel(models.currentId);
    check("模型切换（同模型）", host!.listModels().currentId === models.currentId);

    // 7.6 停止：空闲时调用返回 false（运行中打断由交互模式验证）
    check("空闲时停止返回 false", host!.cancel() === false);

    // 7.3f 工作区指令文件 AGENTS.md（PRD 二期候选落地）：工作区根目录约定注入 system prompt 基座层之后
    {
      const agentsPath = path.join(workspace!.root, "AGENTS.md");
      await fsp.writeFile(agentsPath, "# 本工作区约定\n\n- 金额一律用万元\n- 自测标记词：ORDO-WS-AGENTS-MARK\n", "utf-8");
      host!.refreshPrompt();
      const withMd = host!.systemPromptText();
      check("AGENTS.md 注入提示词", withMd.includes("工作区约定") && withMd.includes("ORDO-WS-AGENTS-MARK"));
      await fsp.rm(agentsPath, { force: true });
      host!.refreshPrompt();
      check("删除 AGENTS.md 后提示词复原", !host!.systemPromptText().includes("ORDO-WS-AGENTS-MARK"));
    }

    // 7.3g Agent Office 工具族（OfficeCLI 引擎）：生成/编辑三格式 + 围栏 + 分级；mammoth/SheetJS 独立读回交叉验证
    {
      const anyHost2 = host as any;
      const officeNames = ["write_docx", "write_pptx", "edit_docx", "edit_pptx", "edit_xlsx"];
      const tool = (n: string) => anyHost2.allTools.find((t: any) => t.name === n);
      check("Office 工具族注册（5 个）", officeNames.every((n) => !!tool(n)), officeNames.filter((n) => !tool(n)).join(","));
      check("Office 工具全 L2（写操作须确认）", officeNames.every((n) => anyHost2.levelOf(n) === "L2"));
      const ocDir = path.join(workspace!.root, "selftest-office");
      await fsp.mkdir(ocDir, { recursive: true });
      try {
        // write_docx：结构化块 → markdown 元素 → docx
        await tool("write_docx").execute("t", {
          path: "selftest-office/r.docx",
          sections: [
            { type: "heading", level: 1, text: "SD 周报" },
            { type: "para", text: "本季 ORDO-DOCX-MARK 数据如下" },
            { type: "table", rows: [["物料", "数量"], ["标准件A", "140"]] },
            { type: "bullets", items: ["要点一", "要点二"] },
          ],
        });
        const mammoth = require("mammoth");
        const dtxt = (await mammoth.extractRawText({ path: path.join(ocDir, "r.docx") })).value;
        const dhtml = (await mammoth.convertToHtml({ path: path.join(ocDir, "r.docx") })).value;
        check("write_docx 生成（标题/表格/列表，mammoth 独立抽回）", dtxt.includes("SD 周报") && dtxt.includes("ORDO-DOCX-MARK") && dhtml.includes("<table>") && dtxt.includes("要点一"));
        // edit_docx：replace_text 往返 + 匹配不到如实报错
        await tool("edit_docx").execute("t", { path: "selftest-office/r.docx", ops: [{ op: "replace_text", find: "ORDO-DOCX-MARK", replace: "ORDO-DOCX-REPLACED" }] });
        const dtxt2 = (await mammoth.extractRawText({ path: path.join(ocDir, "r.docx") })).value;
        check("edit_docx 查找替换往返", dtxt2.includes("ORDO-DOCX-REPLACED") && !dtxt2.includes("ORDO-DOCX-MARK"));
        let missErr = "";
        try {
          await tool("edit_docx").execute("t", { path: "selftest-office/r.docx", ops: [{ op: "replace_text", find: "不存在的词XYZ", replace: "y" }] });
        } catch (e) {
          missErr = String((e as Error).message);
        }
        check("edit_docx 未找到如实报错", missErr.includes("未找到"));
        // write_pptx → edit_pptx（改字 + 删页）
        await tool("write_pptx").execute("t", {
          path: "selftest-office/d.pptx",
          slides: [
            { title: "旧首页", bullets: ["将被删除"] },
            { title: "ORDO-SLIDE-TITLE", bullets: ["要点A", "要点B"] },
          ],
        });
        await tool("edit_pptx").execute("t", {
          path: "selftest-office/d.pptx",
          ops: [
            { op: "replace_text", find: "ORDO-SLIDE-TITLE", replace: "ORDO-SLIDE-EDITED" },
            { op: "delete_slide", index: 1 },
          ],
        });
        const slides = await officeQuery(path.join(ocDir, "d.pptx"), "slide");
        check("write_pptx + edit_pptx（改字/删页，页级编辑）", slides.length === 1 && JSON.stringify(slides).includes("ORDO-SLIDE-EDITED"), JSON.stringify(slides).slice(0, 80));
        // edit_xlsx：值 + 公式计算（引擎 computedValue）+ SheetJS 独立读回
        await tool("edit_xlsx").execute("t", {
          path: "selftest-office/s.xlsx",
          updates: [{ sheet: "台账", cells: [{ ref: "A1", value: "物料" }, { ref: "B2", value: "140" }, { ref: "B3", value: "60" }, { ref: "B4", formula: "SUM(B2:B3)" }] }],
        });
        const b4 = await officeRun(["get", path.join(ocDir, "s.xlsx"), "/台账/B4"], ocDir);
        check("edit_xlsx 公式即时计算", JSON.stringify(b4).includes("200"), JSON.stringify(b4?.data?.results?.[0]?.format ?? {}).slice(0, 80));
        const XLSX2 = require("xlsx");
        const wb2 = XLSX2.readFile(path.join(ocDir, "s.xlsx"));
        check("edit_xlsx SheetJS 独立读回", wb2.SheetNames.includes("台账") && XLSX2.utils.sheet_to_csv(wb2.Sheets["台账"]).includes("200"));
        // 围栏：工作区外一律拒绝
        let fenceErr = "";
        try {
          await tool("write_docx").execute("t", { path: "../escape.docx", sections: [{ type: "para", text: "x" }] });
        } catch (e) {
          fenceErr = String((e as Error).message);
        }
        check("Office 工具围栏（工作区外拒绝）", fenceErr.length > 0, fenceErr.slice(0, 50));
      } finally {
        // query 也会驻留句柄：先逐一 close 再删目录（Windows 下被占文件 rm 会静默失败、残留引发下轮 duplicate）
        for (const f of ["r.docx", "d.pptx", "s.xlsx"]) {
          await officeRun(["close", path.join(ocDir, f)], ocDir).catch(() => {});
        }
        await fsp.rm(ocDir, { recursive: true, force: true }).catch(() => {});
      }
    }

    // ---- 阶段 8：技能体系（PRD 4.2/4.3/5.1：对话内沉淀 / 企业市场 / 自动同步 / 提交审核）----
    // M6-B：目录变更走 mock 管理端 __test/mutate（config.mock.json 已退役为测试夹具）
    const mockMutate = (op: string, payload: Record<string, unknown> = {}) =>
      adminFetchJson(ADMIN_BASE, "/__test/mutate", { method: "POST", body: JSON.stringify({ op, ...payload }) }).catch((e) => {
        throw new Error(`mock 管理端 mutate 失败（${op}）: ${String((e as Error).message ?? e)}`);
      });

    // 8.1 对话内沉淀：对助手说"沉淀成技能" → save_skill 工具落盘个人区（分级只在后台：审计记 level，界面无感）
    const namesBefore = new Set(host!.listSkillsRich().map((s) => s.name));
    await host!.prompt("请把「会议纪要三段式：结论 / 待办 / 风险」这套流程沉淀成技能");
    const createdSkills = host!.listSkillsRich().filter((s) => s.mine && !namesBefore.has(s.name));
    check("对话内沉淀出个人技能", createdSkills.length === 1, createdSkills.map((s) => s.name).join(","));
    const bornName = createdSkills[0]!.name;
    check("沉淀技能注入提示词", host!.systemPromptText().includes(bornName));
    const bornDetail = host!.readSkill(bornName);
    check("技能包内容落盘", bornDetail.content.trim().length > 0 && bornDetail.mine === true);
    const auditFile8 = path.join(workspace!.dirs.audit, `audit-${new Date().toISOString().slice(0, 10)}.jsonl`);
    const saveLine = fs.readFileSync(auditFile8, "utf-8").split("\n").find((l) => l.includes('"tool":"save_skill"'));
    check("后台审计记录分级", !!saveLine && saveLine.includes('"level":"L2"'), "界面不出现分级字眼，审计留痕");

    // 8.2 $ 引用展开：发送时注入技能全文（进入消息历史，会话内一致），界面展示仍为原文
    const idx8 = host!.messageCount();
    await host!.prompt(`$${bornName} 帮我整理今天的会议`);
    const sent8 = host!.messages()[idx8];
    const sentText8 = typeof sent8?.content === "string" ? sent8.content : JSON.stringify(sent8?.content ?? "");
    check("$ 引用展开注入", sentText8.includes("<skill") && sentText8.includes(bornName));

    // 8.3 提交审核上架：提交 → 状态可见；重复提交被拒；模拟管理端通过 → 客户端看到 approved
    const sub8 = await skillMarket!.submitForReview(bornName, workspace!.dirs.skillsPersonal);
    check("提交审核入库", sub8.status === "submitted" && sub8.name === bornName);
    const dupSubmit = String(
      await skillMarket!.submitForReview(bornName, workspace!.dirs.skillsPersonal).catch((e) => (e instanceof Error ? e.message : e))
    );
    check("重复提交被拒", dupSubmit.includes("进行中的审核"), dupSubmit.slice(0, 30));
    await mockMutate("approve-submission", { name: bornName });
    check("审核状态可见", (await skillMarket!.listSubmissions()).find((s) => s.name === bornName)?.status === "approved");

    // 8.4 删除个人技能 → 回收站
    await host!.deleteSkill(bornName);
    check("删除后提示词移除", !host!.systemPromptText().includes(bornName));
    check("删除进回收站", fs.readdirSync(workspace!.dirs.recycle).some((f) => f.startsWith(`skill-${bornName}-`)));

    // 8.5 导入技能包：目录含 SKILL.md → 拷入个人区；同名再导自动改名不覆盖
    const importSrc = path.join(workspace!.dirs.home, "selftest-skill-import");
    await fsp.rm(importSrc, { recursive: true, force: true }).catch(() => {});
    await fsp.mkdir(importSrc, { recursive: true });
    await fsp.writeFile(path.join(importSrc, "SKILL.md"), "---\nname: imported-demo\ndescription: 导入演示技能\n---\n\n# 导入演示\n", "utf-8");
    const imp1 = await host!.importSkillFromDir(importSrc);
    check("技能包导入生效", imp1.name === "imported-demo" && host!.listSkillsRich().some((s) => s.name === "imported-demo" && s.mine));
    const imp2 = await host!.importSkillFromDir(importSrc);
    check("同名导入自动改名", imp2.name === "imported-demo-2", imp2.name);
    await host!.deleteSkill("imported-demo");
    await host!.deleteSkill("imported-demo-2");
    await fsp.rm(importSrc, { recursive: true, force: true }).catch(() => {});

    // 8.6 企业市场：安装 → 注入 + 记录；目录版本变化 → 自动更新；卸载 → 记录与缓存移除
    const market0 = await skillMarket!.listMarket();
    check("市场目录可见", market0.some((s) => s.name === "erp-inventory-query" && !s.installed));
    await skillMarket!.install("erp-inventory-query");
    check("安装后注入提示词", host!.systemPromptText().includes("erp-inventory-query"));
    check("安装记录入账", (await skillMarket!.listInstalled()).some((s) => s.name === "erp-inventory-query" && s.state === "current"));
    await mockMutate("patch-skill", { name: "erp-inventory-query", version: "1.1.0", find: "ERP 库存查询规范", replaceWith: "ERP 库存查询规范（v1.1：按仓库分组汇总）" });
    const sync1 = await skillMarket!.syncNow();
    check("版本变化自动更新", sync1.updated.includes("erp-inventory-query"), sync1.updated.join(","));
    check("更新内容生效", host!.readSkill("erp-inventory-query").content.includes("v1.1"));
    await skillMarket!.uninstall("erp-inventory-query");
    check("卸载后记录移除", !(await skillMarket!.listInstalled()).some((s) => s.name === "erp-inventory-query"));

    // 8.7 管理端下架 → 后台自动移除本地缓存（回收站留痕）
    await skillMarket!.install("erp-inventory-query");
    await mockMutate("remove-skill", { name: "erp-inventory-query" });
    const sync2 = await skillMarket!.syncNow();
    check("下架自动移除", sync2.removed.includes("erp-inventory-query"), sync2.removed.join(","));
    check("移除后提示词清出", !host!.systemPromptText().includes("erp-inventory-query"));
    check("移除进回收站", fs.readdirSync(workspace!.dirs.recycle).some((f) => f.startsWith("skill-ent-erp-inventory-query-")));

    // 还原 mock 管理端目录（提交记录 / 版本改动不留痕）
    await mockMutate("restore");

    // ---- 阶段 9：MCP 连接器（PRD 4.4/3.5：目录 / 启停 / 会话挂载 / 托管只读调用 / 专家白名单）----
    // 9.1 目录与挂载：默认不挂载 → 挂载后连接器工具进入工具列表
    const conns9 = await host!.listConnectorsRich();
    check("连接器目录可见", conns9.some((c) => c.name === "erp" && c.enabled && !c.attached), conns9.map((c) => c.name).join(","));
    check("未挂载时无连接器工具", host!.activeToolNames().length === 20, "基础工具（含 update_plan + Office 工具族）");
    await host!.setActiveConnectors(["erp"]);
    const tools9 = host!.activeToolNames();
    check("挂载后工具动态合并", tools9.includes("mcp__erp__query_inventory") && tools9.includes("mcp__erp__get_material") && tools9.length === 22, `${tools9.length} 个`);

    // 9.2 托管只读调用（L1）：模型经连接器查库存，审计记 mcp_call 明细（含分级，界面无感）
    await host!.prompt("帮我查一下物料A的库存");
    const mcpLine = fs
      .readFileSync(path.join(workspace!.dirs.audit, `audit-${new Date().toISOString().slice(0, 10)}.jsonl`), "utf-8")
      .split("\n")
      .find((l) => l.includes('"event":"mcp_call"'));
    check("连接器调用入审计", !!mcpLine && mcpLine.includes('"connector":"erp"') && mcpLine.includes('"tool":"query_inventory"'));
    check("只读调用后台记 L1", !!mcpLine && mcpLine.includes('"level":"L1"'), "分级只在后台");

    // 9.3 专家白名单：drawing-checker mcpWhitelist=[] → 不挂任何连接器；切回恢复
    await host!.switchExpert("drawing-checker");
    check("白名单收窄连接器", !host!.activeToolNames().some((n) => n.startsWith("mcp__")), "白名单 [] = 不挂");
    const connBlocked = await host!.setActiveConnectors(["erp"]);
    check("连接器过滤如实返回", connBlocked.length === 0, "挂载被白名单过滤时返回空生效集");
    check("基础工具不受影响", host!.activeToolNames().length === 20);
    await host!.switchExpert("general");
    check("切回后连接器恢复", host!.activeToolNames().length === 22);

    // 9.4 市场停用：挂载集不变但生效集排除；恢复后回归
    await host!.setConnectorEnabled("erp", false);
    check("停用后工具移除", host!.activeToolNames().length === 20, "挂载 ∩ 启用 ∩ 白名单");
    check("停用状态入清单", (await host!.listConnectorsRich()).find((c) => c.name === "erp")?.enabled === false);
    await host!.setConnectorEnabled("erp", true);
    check("启用后工具恢复", host!.activeToolNames().length === 22);
    await host!.setActiveConnectors([]);
    check("卸载后回基础工具", host!.activeToolNames().length === 20);

    // 9.5 本地 MCP 包（R3，方案 §12.4）：插件包 mcp_pkg 以本地子进程运行（ELECTRON_RUN_AS_NODE + stdio JSON-RPC），
    // 与远端连接器同一挂载/分级/审计链路。伪造 test-mcp 包（脚本型）走真实握手与调用。
    const mcpDir = path.join(workspace!.dirs.managed, "mcp", "selftest-mcp", "9.9.9");
    await fsp.mkdir(mcpDir, { recursive: true });
    await fsp.writeFile(
      path.join(mcpDir, "mcp.json"),
      JSON.stringify({
        runtime: "node",
        script: "server.js",
        displayName: "自测本地工具",
        description: "本地 MCP 子进程链路自测",
        tools: [
          { name: "get_time", label: "取本机时间", level: "L1", description: "返回本机当前时间", params: [{ name: "tag", type: "string", description: "附加标记", required: false }] },
          { name: "read_env_flag", label: "读运行标记", level: "L2", description: "读子进程环境标记" },
        ],
      }, null, 2),
      "utf-8"
    );
    await fsp.writeFile(
      path.join(mcpDir, "server.js"),
      `// 最小 MCP 服务器（NDJSON over stdio）：initialize / tools/list / tools/call
      const readline = require("node:readline");
      const rl = readline.createInterface({ input: process.stdin });
      const send = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
      rl.on("line", (line) => {
        let m; try { m = JSON.parse(line); } catch { return; }
        if (m.method === "initialize") {
          send({ jsonrpc: "2.0", id: m.id, result: { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "selftest-mcp", version: "9.9.9" } } });
        } else if (m.method === "tools/list") {
          send({ jsonrpc: "2.0", id: m.id, result: { tools: [{ name: "get_time", description: "本机时间" }, { name: "read_env_flag", description: "运行标记" }] } });
        } else if (m.method === "tools/call") {
          const name = m.params && m.params.name;
          const args = (m.params && m.params.arguments) || {};
          const text = name === "get_time" ? \`SELFTEST-TIME \${new Date().toISOString()} tag=\${args.tag || "-"}\` : \`FLAG=\${process.env.SD_MCP_FLAG || "none"} as-node=\${process.env.ELECTRON_RUN_AS_NODE === "1"}\`;
          send({ jsonrpc: "2.0", id: m.id, result: { content: [{ type: "text", text }] } });
        }
      });
      `,
      "utf-8"
    );
    const localPacks = localMcp!.packs();
    check("本地 MCP 包入清单", localPacks.some((p) => p.name === "selftest-mcp" && p.manifest.tools.length === 2), JSON.stringify(localPacks.map((p) => p.name)));
    check("本地包并列连接器页", (await host!.listConnectorsRich()).some((c) => c.name === "selftest-mcp" && c.endpoint.startsWith("local://")));
    const mcpToolText = await localMcp!.call("selftest-mcp", "get_time", { tag: "hello" });
    check("本地 MCP 真实调用（子进程 JSON-RPC）", mcpToolText.includes("SELFTEST-TIME") && mcpToolText.includes("tag=hello"), mcpToolText.slice(0, 60));
    await host!.setActiveConnectors(["selftest-mcp"]);
    check("挂载本地包出工具", host!.activeToolNames().filter((n) => n.startsWith("mcp__selftest-mcp__")).length === 2, host!.activeToolNames().filter((n) => n.includes("selftest")).join(","));
    const piAiCore = await (new Function("s", "return import(s)")("@earendil-works/pi-ai"));
    const builtLocal = await connectorHost!.buildTools(piAiCore.Type, ["selftest-mcp"]);
    const timeTool = builtLocal.find((t: any) => t.name === "mcp__selftest-mcp__get_time");
    const toolResult = await timeTool.execute("t", { tag: "built" });
    check("工具定义真实执行", String(toolResult.content[0].text).includes("tag=built"));
    check("本地 L2 入预授权清单", (await connectorHost!.listL2()).some((l) => l.id === "mcp__selftest-mcp__read_env_flag"));

    // 8.2 远端 MCP HTTP 传输 + 个人连接器（体验清单 #3）：进程内 HTTP MCP 服务端到端
    {
      const http = await import("node:http");
      const httpServer = http.createServer((req, res) => {
        let body = "";
        req.on("data", (d) => (body += d));
        req.on("end", () => {
          const m = JSON.parse(body || "{}");
          const reply = (result: unknown) => {
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({ jsonrpc: "2.0", id: m.id, result }));
          };
          if (m.method === "initialize") reply({ protocolVersion: "2025-03-26", capabilities: {}, serverInfo: { name: "selftest-http-mcp", version: "1.0.0" } });
          else if (m.method === "tools/list")
            reply({ tools: [{ name: "echo_http", description: "HTTP 回声", inputSchema: { type: "object", properties: { text: { type: "string", description: "文本" } }, required: ["text"] } }] });
          else if (m.method === "tools/call") reply({ content: [{ type: "text", text: `http-echo: ${(m.params?.arguments as any)?.text ?? ""}` }] });
          else reply({});
        });
      });
      await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", () => resolve()));
      const httpPort = (httpServer.address() as { port: number }).port;
      const httpEndpoint = `http://127.0.0.1:${httpPort}/mcp`;
      try {
        const added = await personalMcp!.add({ displayName: "Selftest HTTP MCP", endpoint: httpEndpoint });
        check("个人连接器添加（真连通+工具派生）", added.tools === 1 && added.name === "selftest-http-mcp", JSON.stringify(added));
        const builtHttp = await connectorHost!.buildTools(piAiCore.Type, [added.name]);
        const httpTool = builtHttp.find((t: any) => t.name === `mcp__${added.name}__echo_http`);
        check("个人连接器工具构建（L2 默认 + schema 派生）", !!httpTool && httpTool.level === "L2");
        const httpOut = await httpTool.execute("t", { text: "你好" });
        check("个人连接器真实 HTTP 调用", String(httpOut.content[0].text).includes("http-echo: 你好"), String(httpOut.content[0].text).slice(0, 40));
        const textEnt = await mcpHttpHost!.call(httpEndpoint, undefined, "echo_http", { text: "ent" });
        check("HTTP 传输池复用（企业连接器同链路）", textEnt.includes("http-echo: ent"));
      } finally {
        const leftover = (await personalMcp!.list()).find((c) => c.endpoint === httpEndpoint);
        if (leftover) await personalMcp!.remove(leftover.id);
        httpServer.close();
      }
    }
    // 8.3 个人连接器 stdio 型：本机命令（Electron 充当 Node）+ tools/list 派生 + 本地宿主真实调用
    {
      const srvPath = path.join(workspace!.dirs.config, `selftest-stdio-mcp-${Date.now().toString(36)}.js`);
      await fsp.writeFile(
        srvPath,
        `const readline=require("node:readline");const rl=readline.createInterface({input:process.stdin,terminal:false});
const send=function(m){process.stdout.write(JSON.stringify(m)+"\\n")};
rl.on("line",function(line){let m;try{m=JSON.parse(line)}catch(e){return}
if(typeof m.id!=="number")return;
if(m.method==="initialize")send({jsonrpc:"2.0",id:m.id,result:{protocolVersion:"2024-11-05",capabilities:{},serverInfo:{name:"selftest-stdio-mcp",version:"1.0.0"}}});
else if(m.method==="tools/list")send({jsonrpc:"2.0",id:m.id,result:{tools:[{name:"echo_stdio",description:"stdio 回声",inputSchema:{type:"object",properties:{text:{type:"string",description:"文本"}},required:["text"]}}]}});
else if(m.method==="tools/call")send({jsonrpc:"2.0",id:m.id,result:{content:[{type:"text",text:"stdio-echo: "+((m.params&&m.params.arguments&&m.params.arguments.text)||"")}]}})});
`,
        "utf-8"
      );
      try {
        const added = await personalMcp!.add({
          displayName: "Selftest Stdio MCP",
          transport: "stdio",
          command: process.execPath,
          argsText: JSON.stringify([srvPath]),
          envJson: JSON.stringify({ ELECTRON_RUN_AS_NODE: "1" }),
        });
        check("个人连接器 stdio 添加（握手+工具派生）", added.tools === 1 && added.name === "selftest-stdio-mcp", JSON.stringify(added));
        const stored = (await personalMcp!.list()).find((c) => c.name === added.name);
        check("stdio 连接器落库形态", stored?.transport === "stdio" && stored?.command === process.execPath && Array.isArray(stored?.args), JSON.stringify(stored?.transport));
        const builtStdio = await connectorHost!.buildTools(piAiCore.Type, [added.name]);
        const stdioTool = builtStdio.find((t: any) => t.name === `mcp__${added.name}__echo_stdio`);
        check("stdio 连接器工具构建（L2）", !!stdioTool && stdioTool.level === "L2");
        const stdioOut = await stdioTool.execute("t", { text: "本地" });
        check("stdio 连接器真实调用（本地子进程）", String(stdioOut.content[0].text).includes("stdio-echo: 本地"), String(stdioOut.content[0].text).slice(0, 40));
        await personalMcp!.remove(stored!.id);
        const ensureGone = await localMcp!.ensure(added.name).then(
          () => false,
          () => true
        );
        check("stdio 连接器删除（规格随删，无法再拉起）", ensureGone);
      } finally {
        await fsp.rm(srvPath, { force: true }).catch(() => {});
      }
    }
    await host!.setActiveConnectors([]);
    localMcp!.stopAll();
    // Windows 句柄延迟：子进程刚 kill 时目录可能仍被占，重试清理（失败不阻断自测，目录固定版本号下轮覆盖）
    for (let i = 0; i < 10; i++) {
      try {
        await fsp.rm(path.join(workspace!.dirs.managed, "mcp", "selftest-mcp"), { recursive: true, force: true });
        break;
      } catch {
        if (i === 9) console.log("[SELFTEST] 自测 MCP 目录清理延后（句柄占用，不影响后续）");
        else await new Promise((r) => setTimeout(r, 300));
      }
    }

    // 9.6 插件包面板（M5 渲染层接线回归）：曾因 openModules 漏注册 packs 导航点击静默失败——
    // 主进程与 e2e 链路全绿也测不到渲染层接线，这里真实点击导航按钮断言模块页开合。
    const packsPanel = await win!.webContents.executeJavaScript(`(() => {
      document.getElementById("nav-packs").click();
      return {
        open: !document.getElementById("module-page").classList.contains("hidden"),
        title: document.getElementById("mv-title").textContent,
      };
    })()`);
    check("插件包面板可打开", packsPanel.open === true && packsPanel.title === "插件包", JSON.stringify(packsPanel));
    // 内置卡恒显（officecli 定性内置引擎）：面板内容异步加载，轮询 5s 断言「内置组件」区与 Office 引擎卡可见
    let builtinVisible = "";
    for (let i = 0; i < 20 && !builtinVisible; i++) {
      await new Promise((r) => setTimeout(r, 250));
      builtinVisible = await win!.webContents.executeJavaScript(`(() => {
        const page = document.getElementById("module-page");
        if (!page || page.classList.contains("hidden")) return "";
        const t = page.textContent || "";
        return t.includes("内置组件") && t.includes("OfficeCLI") ? "ok" : "";
      })()`);
    }
    check("插件包面板内置卡恒显（Office 引擎）", builtinVisible === "ok", builtinVisible === "ok" ? "「内置组件」区与 OfficeCLI 卡已渲染" : "5s 内未见「内置组件」区或 OfficeCLI 卡");
    const packsClosed = await win!.webContents.executeJavaScript(`(() => {
      document.getElementById("nav-packs").click();
      return document.getElementById("module-page").classList.contains("hidden");
    })()`);
    check("插件包面板再点关闭", packsClosed === true);

    // 9.6c 附件链路（composer 附件真实实现回归）：净化/去重落盘/相对路径/附件块拼接
    {
      const attRoot = path.join(workspace!.dirs.home, "selftest-att");
      const b64 = Buffer.from("hello-attachment").toString("base64");
      const rels = await saveAttachments(attRoot, [
        { name: "测试 报告.docx", dataBase64: b64 },
        { name: "测试 报告.docx", dataBase64: Buffer.from("second").toString("base64") },
      ]);
      check(
        "附件落盘（净化+去重+相对路径）",
        rels.length === 2 &&
          rels[0] !== rels[1] &&
          rels.every((r) => r.startsWith(".inbox/") && !r.includes("\\")) &&
          fs.existsSync(path.join(attRoot, rels[0])) &&
          fs.readFileSync(path.join(attRoot, rels[0]), "utf-8") === "hello-attachment",
        JSON.stringify(rels)
      );
      check("附件块拼接", attachmentBlock(rels).includes("- " + rels[0]) && attachmentBlock([]) === "");
      check("附件名净化（防目录穿越）", safeAttachmentName("../../evil.txt") === "evil.txt" && safeAttachmentName("") === "attachment.bin");
      fs.rmSync(attRoot, { recursive: true, force: true });
    }

    // 9.6b 遗留包清理回归（officecli 内置定性）：伪造已装 officecli 包 → cleanupLegacy → 登记与 managed 目录齐清
    // （登记文件在真实 config 区：先快照、断言后恢复，防冲掉本机已装包登记；残留由下轮启动 cleanup 兜底）
    const legacyRegFile = path.join(workspace!.dirs.config, "plugin-packs.json");
    const legacyRegBackup = await fsp.readFile(legacyRegFile, "utf-8").catch(() => "");
    await fsp.mkdir(path.join(workspace!.dirs.managed, "cli", "officecli", "1.0.0"), { recursive: true });
    await fsp.writeFile(legacyRegFile, JSON.stringify({ officecli: { name: "officecli", version: "1.0.0", installedAt: new Date().toISOString() } }), "utf-8");
    await pluginPacks!.cleanupLegacy();
    const legacyReg = JSON.parse((await fsp.readFile(legacyRegFile, "utf-8").catch(() => "{}")) || "{}") as Record<string, unknown>;
    check(
      "遗留 officecli 插件包启动自动清理（内置定性）",
      !legacyReg.officecli && !fs.existsSync(path.join(workspace!.dirs.managed, "cli", "officecli")),
      JSON.stringify({ reg: Object.keys(legacyReg), dirLeft: fs.existsSync(path.join(workspace!.dirs.managed, "cli", "officecli")) })
    );
    if (legacyRegBackup) await fsp.writeFile(legacyRegFile, legacyRegBackup, "utf-8");
    else await fsp.rm(legacyRegFile, { force: true });

    // 9.7 M6-C 面板（渲染层真实交互）：设置持久化往返 / 个人信息模态（登录身份）/ 我的申请页
    const settingsRound = await win!.webContents.executeJavaScript(`(async () => {
      const before = await window.ordo.getSettings();
      await window.ordo.setSettings({ desktopNotify: false });
      const after = await window.ordo.getSettings();
      await window.ordo.setSettings({ desktopNotify: before.desktopNotify });
      const restored = await window.ordo.getSettings();
      return { changed: after.desktopNotify === false, restored: restored.desktopNotify === before.desktopNotify };
    })()`);
    check("M6 设置持久化往返", settingsRound.changed === true && settingsRound.restored === true, JSON.stringify(settingsRound));

    const profileUi = await win!.webContents.executeJavaScript(`(() => {
      document.getElementById("user-chip").click();
      const item = [...document.querySelectorAll(".menu .menu-item")].find((b) => b.textContent.includes("个人信息"));
      if (item) item.click(); // 个人信息并入设置页「账号」节
      const page = document.querySelector("#module-page:not(.hidden) .settings-page");
      const active = page?.querySelector(".st-nav-item.active");
      const ok = !!page && active?.textContent === "账号" && page.textContent.includes("mock-emp");
      document.getElementById("mv-back")?.click(); // 返回工作区，不留打开的页面
      return ok;
    })()`);
    check("M6 个人信息（设置页账号节）", profileUi === true, profileUi ? "" : "设置页未开或未见登录工号");

    const requestsUi = await win!.webContents.executeJavaScript(`(() => {
      document.getElementById("user-chip").click();
      const item = [...document.querySelectorAll(".menu .menu-item")].find((b) => b.textContent.includes("我的申请"));
      if (item) item.click();
      const ok = !document.getElementById("module-page").classList.contains("hidden") && document.getElementById("mv-title").textContent === "我的申请";
      const nav = document.querySelector('.side-nav button[data-module="skills"]');
      if (nav) nav.click();
      if (nav) nav.click(); // 借导航开关回到对话视图，不留打开的模块页
      return ok;
    })()`);
    check("M6 我的申请页可打开", requestsUi === true);

    // ---- 阶段 10：知识库（PRD 4.5：个人库本地实现 / 企业库代理目录 / 挂载后检索 / 白名单只约束企业库）----
    // 10.1 个人库真实现：建库 → 文档入库（本地 rag 目录）→ 清单可见
    check("企业库目录可见", (await host!.listKnowledgeBasesRich()).some((k) => k.name === "公司制度库" && k.scope === "企业" && !k.mine));
    const pkbName10 = `自测个人库-${Date.now().toString(36)}`; // 唯一名：绝不与用户自建库冲突
    const pkb = await personalKb!.create(pkbName10);
    const docSrc = path.join(workspace!.dirs.home, "selftest-kb-doc.md");
    await fsp.writeFile(
      docSrc,
      ["# 项目规范", "", "交付物统一放在 out 目录，命名含日期后缀。", "", "## 评审", "", "评审意见需在 24 小时内回复，逾期视为无异议。"].join("\n"),
      "utf-8"
    );
    check("个人库文档入库", (await personalKb!.addDocs(pkb.id, [docSrc])).added.length === 1);
    check("个人库入清单", (await host!.listKnowledgeBasesRich()).some((k) => k.id === pkb.id && k.mine && k.docCount === 1));

    // 10.1b Office 入库检索（docx 走 mammoth 抽正文 / xlsx 逐表转 CSV）：夹具为 store-only 最小 OOXML
    {
      const CRC_T = (() => {
        const t = new Int32Array(256);
        for (let n = 0; n < 256; n++) {
          let c = n;
          for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
          t[n] = c;
        }
        return t;
      })();
      const crc32b = (b: Buffer) => {
        let c = ~0;
        for (let i = 0; i < b.length; i++) c = CRC_T[(c ^ b[i]) & 0xff] ^ (c >>> 8);
        return ~c >>> 0;
      };
      const zipStore = (entries: Array<{ name: string; data: string }>) => {
        const parts: Buffer[] = [];
        const centrals: Buffer[] = [];
        let off = 0;
        for (const e of entries) {
          const name = Buffer.from(e.name, "utf-8");
          const data = Buffer.from(e.data, "utf-8");
          const crc = crc32b(data);
          const lh = Buffer.alloc(30);
          lh.writeUInt32LE(0x04034b50, 0);
          lh.writeUInt32LE(crc, 14);
          lh.writeUInt32LE(data.length, 18);
          lh.writeUInt32LE(data.length, 22);
          lh.writeUInt16LE(name.length, 26);
          parts.push(lh, name, data);
          const ch = Buffer.alloc(46);
          ch.writeUInt32LE(0x02014b50, 0);
          ch.writeUInt32LE(crc, 16);
          ch.writeUInt32LE(data.length, 20);
          ch.writeUInt32LE(data.length, 24);
          ch.writeUInt16LE(name.length, 28);
          ch.writeUInt32LE(off, 42);
          centrals.push(ch, name);
          off += 30 + name.length + data.length;
        }
        const cen = Buffer.concat(centrals);
        const eocd = Buffer.alloc(22);
        eocd.writeUInt32LE(0x06054b50, 0);
        eocd.writeUInt16LE(entries.length, 8);
        eocd.writeUInt16LE(entries.length, 10);
        eocd.writeUInt32LE(cen.length, 12);
        eocd.writeUInt32LE(off, 16);
        return Buffer.concat([...parts, cen, eocd]);
      };
      const docxXml =
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
        '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>' +
        "<w:p><w:r><w:t>库存盘点约定：魔法词 ORDO-KB-DOCX-MARK，盘点差异超过百分之五需复盘。</w:t></w:r></w:p>" +
        "</w:body></w:document>";
      const docxBuf = zipStore([
        {
          name: "[Content_Types].xml",
          data:
            '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
        },
        {
          name: "_rels/.rels",
          data:
            '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
        },
        { name: "word/document.xml", data: docxXml },
      ]);
      const docxSrc = path.join(workspace!.dirs.home, "selftest-kb-doc.docx");
      await fsp.writeFile(docxSrc, docxBuf);
      const XLSX = require("xlsx");
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([["物料", "魔法词"], ["轴承", "ORDO-KB-XLSX-MARK"]]), "台账");
      const xlsxSrc = path.join(workspace!.dirs.home, "selftest-kb-sheet.xlsx");
      XLSX.writeFile(wb, xlsxSrc);
      check("Office 文档入库（docx/xlsx）", (await personalKb!.addDocs(pkb.id, [docxSrc, xlsxSrc])).added.length === 2);
      const hitDocx = await personalKb!.search(pkb.id, "ORDO-KB-DOCX-MARK 盘点");
      check("docx 检索命中（mammoth 抽正文）", hitDocx.some((h) => h.doc.includes(".docx") && h.snippet.includes("ORDO-KB-DOCX-MARK")), JSON.stringify(hitDocx[0] ?? {}).slice(0, 60));
      const hitXlsx = await personalKb!.search(pkb.id, "ORDO-KB-XLSX-MARK");
      check("xlsx 检索命中（逐表转 CSV）", hitXlsx.some((h) => h.doc.includes(".xlsx") && h.snippet.includes("ORDO-KB-XLSX-MARK")), JSON.stringify(hitXlsx[0] ?? {}).slice(0, 60));
      await fsp.rm(docxSrc, { force: true });
      await fsp.rm(xlsxSrc, { force: true });

      // PDF 入库与检索（pdf-parse，与服务端摄取同款解析链）：手工构造最小合法 PDF（含 xref）
      const buildProbePdf = (text: string): Buffer => {
        const stream = `BT /F1 12 Tf 72 720 Td (${text}) Tj ET\n`;
        const objs = [
          "<< /Type /Catalog /Pages 2 0 R >>",
          "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
          "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
          `<< /Length ${stream.length} >>\nstream\n${stream}endstream`,
          "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
        ];
        let out = "%PDF-1.4\n";
        const offs: number[] = [];
        objs.forEach((body, i) => {
          offs.push(out.length);
          out += `${i + 1} 0 obj\n${body}\nendobj\n`;
        });
        const xrefAt = out.length;
        out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
        for (const o of offs) out += `${String(o).padStart(10, "0")} 00000 n \n`;
        out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xrefAt}\n%%EOF`;
        return Buffer.from(out, "latin1");
      };
      const pdfSrc = path.join(workspace!.dirs.home, "selftest-kb-doc.pdf");
      await fsp.writeFile(pdfSrc, buildProbePdf("Ordo PDF probe ORDO-KB-PDF-MARK"));
      const pdfAdded = await personalKb!.addDocs(pkb.id, [pdfSrc]);
      check("PDF 文档入库（个人库扩展 pdf-parse）", pdfAdded.added.length === 1, JSON.stringify(pdfAdded.skipped));
      const hitPdf = await personalKb!.search(pkb.id, "ORDO-KB-PDF-MARK");
      check("PDF 检索命中", hitPdf.some((h) => h.doc.includes(".pdf") && h.snippet.includes("ORDO-KB-PDF-MARK")), JSON.stringify(hitPdf[0] ?? {}).slice(0, 60));
      await fsp.rm(pdfSrc, { force: true });
    }

    // 10.2 挂载 → search_knowledge 工具出现 → 制度问答走检索（引用来源）→ 审计 kb_search
    check("未挂载时无检索工具", !host!.activeToolNames().includes("search_knowledge"));
    await host!.setActiveKnowledgeBases([pkb.id, "kb-hr-policies"]);
    check("挂载后检索工具出现", host!.activeToolNames().includes("search_knowledge"));
    await host!.prompt("出差住宿的报销标准是什么？");
    const kbLine = fs
      .readFileSync(auditFile8, "utf-8")
      .split("\n")
      .find((l) => l.includes('"event":"kb_search"'));
    check("检索入审计", !!kbLine, "query/hits/范围全记录");
    const reply10 = host!.lastAssistantText();
    check("回答引用来源", /600|住宿/.test(reply10), reply10.slice(0, 40));

    // 10.3 专家白名单只约束企业库：个人库是用户私有数据（PRD 3.10/4.5）
    await host!.switchExpert("drawing-checker");
    const effDc = await host!.knowledgeBasesEffective();
    check("企业库受白名单约束", !effDc.some((k) => k.scope === "enterprise"), "kbWhitelist=[] 不挂企业库");
    check("个人库不受白名单约束", effDc.some((k) => k.id === pkb.id));
    const kbBlocked = await host!.setActiveKnowledgeBases(["kb-hr-policies"]);
    check("知识库过滤如实返回", kbBlocked.length === 0, "挂载企业库返回空生效集，UI 可提示");
    check("清单标注不可用", (await host!.listKnowledgeBasesRich()).find((k) => k.id === "kb-hr-policies")?.active === false);
    await host!.switchExpert("general");
    check("切回后企业库恢复", (await host!.knowledgeBasesEffective()).some((k) => k.id === "kb-hr-policies"));
    await host!.setActiveKnowledgeBases([pkb.id, "kb-hr-policies"]); // 恢复双库挂载供后续断言

    // 10.4 跨库检索正确性（企业库声明内容 / 个人库本地分块关键词）
    const hits10 = await host!.searchKnowledge("住宿标准");
    check("企业库检索命中", hits10.some((h) => h.doc.includes("差旅报销") && h.snippet.includes("600")));
    check("个人库检索命中", (await host!.searchKnowledge("评审意见")).some((h) => h.scope === "personal" && h.snippet.includes("24 小时")));

    // 10.5 卸载与删除：工具随挂载消失；删库进回收站
    await host!.setActiveKnowledgeBases([]);
    check("卸载后检索工具消失", !host!.activeToolNames().includes("search_knowledge"));
    await personalKb!.remove(pkb.id);
    check("删库进回收站", fs.readdirSync(workspace!.dirs.recycle).some((f) => f.startsWith(`kb-${pkb.id}`)));
    await fsp.rm(docSrc, { force: true }).catch(() => {});

    // ---- 阶段 11：自动化（PRD 3.7 本地型：用户自建、客户端定时器、管理端不调度）----
    const autoSvc = automations!;
    const def11 = await autoSvc.create({
      name: `自测自动化-${Date.now().toString(36)}`,
      prompt: "自动化自测：请直接回复任务已完成，不需要调用任何工具。",
      expertId: "general",
      schedule: { kind: "daily", time: "23:59" },
      preAuth: [],
    });
    check("自动化创建", !!def11.id && def11.enabled === true);
    const view11 = autoSvc.list().find((t) => t.id === def11.id);
    check("调度文本与下次时间", view11?.scheduleText === "每天 23:59" && !!view11?.nextRunAt, view11?.scheduleText ?? "");
    const rec11 = await autoSvc.runNow(def11.id, "manual");
    check("无人值守执行成功", rec11.ok, (rec11.error || rec11.summary).slice(0, 60));
    const sessions11 = await host!.listSessions();
    check("运行生成可回看会话", !!rec11.sessionId && sessions11.some((s) => s.id === rec11.sessionId));
    check("运行会话以任务命名", (sessions11.find((s) => s.id === rec11.sessionId)?.title ?? "").includes("自测自动化"));
    check("运行历史入档", autoSvc.runsOf(def11.id).some((r) => r.id === rec11.id));

    // 预授权围栏（PRD 3.7：范围仅限任务声明的动作）：未授权的写入被拒、授权的自动放行（判定均留痕）
    await fsp.rm(path.join(workspace!.root, "out"), { recursive: true, force: true }).catch(() => {});
    const WR11 = "请读取 data/sales.txt，生成周报并写入 out/weekly-report.md";
    const defFence = await autoSvc.create({
      name: `自测围栏-${Date.now().toString(36)}`,
      prompt: WR11,
      expertId: "general",
      schedule: { kind: "interval", everyMinutes: 30 },
      preAuth: [],
    });
    const recFence = await autoSvc.runNow(defFence.id, "manual");
    const fenceWritten = await fsp.stat(path.join(workspace!.root, "out", "weekly-report.md")).then(() => true).catch(() => false);
    check("未预授权写入被拒", recFence.ok && !fenceWritten, (recFence.error || recFence.summary).slice(0, 50));
    const defAllow = await autoSvc.create({
      name: `自测预授权-${Date.now().toString(36)}`,
      prompt: WR11,
      expertId: "general",
      schedule: { kind: "interval", everyMinutes: 30 },
      preAuth: ["write_file"],
    });
    const recAllow = await autoSvc.runNow(defAllow.id, "manual");
    const allowWritten = await fsp.stat(path.join(workspace!.root, "out", "weekly-report.md")).then(() => true).catch(() => false);
    check("预授权写入自动放行", recAllow.ok && allowWritten, (recAllow.error || recAllow.summary).slice(0, 50));
    check("围栏判定留痕", bgDecisions.some((d) => !d.preAuthorized) && bgDecisions.some((d) => d.preAuthorized && d.tool === "write_file"));

    // 11.x 工作目录绑定：任务锚定临时目录运行，会话归属该目录；前台工作区与"上次使用"不受影响
    const tmpWsRoot11 = path.join(workspace!.dirs.home, "selftest-auto-ws-" + Date.now().toString(36));
    const wsEntry11 = workspace!.registry.add(tmpWsRoot11);
    const fgRootBefore = path.resolve(workspace!.root);
    const fgIdBefore = workspace!.registry.currentId();
    const defWs = await autoSvc.create({
      name: `自测目录绑定-${Date.now().toString(36)}`,
      prompt: "自动化自测：请直接回复任务已完成。",
      expertId: "general",
      wsId: wsEntry11.id,
      schedule: { kind: "daily", time: "23:59" },
      preAuth: [],
    });
    check("任务绑定目录", defWs.wsId === wsEntry11.id);
    const recWs = await autoSvc.runNow(defWs.id, "manual");
    const wsSession = (await host!.listSessions()).find((s) => s.id === recWs.sessionId);
    check(
      "运行会话锚定任务目录",
      recWs.ok && wsSession?.wsId === wsEntry11.id && path.resolve(wsSession?.wsRoot ?? "") === path.resolve(wsEntry11.root),
      `${wsSession?.wsId ?? ""} ${wsSession?.wsRoot ?? ""}`
    );
    check("前台工作区不受影响", path.resolve(workspace!.root) === fgRootBefore && workspace!.registry.currentId() === fgIdBefore);
    await autoSvc.remove(defWs.id);
    workspace!.registry.remove(wsEntry11.id);
    await fsp.rm(tmpWsRoot11, { force: true, recursive: true }).catch(() => {});
    await new Promise((r) => setTimeout(r, 200));
    await fsp.rm(tmpWsRoot11, { force: true, recursive: true }).catch(() => {}); // Windows 句柄释放有延迟，补删一次

    await autoSvc.setEnabled(def11.id, false);
    check("停用后不再调度", autoSvc.list().find((t) => t.id === def11.id)?.nextRunAt == null);
    for (const t of autoSvc.list()) await autoSvc.remove(t.id);
    check("任务删除清场", autoSvc.list().length === 0);

    // ---- 阶段 12：常用任务模板（/ 命令：内置种子 + 用户 CRUD）----
    check("模板种子就绪", templates!.list().length >= 3 && templates!.list().some((t) => t.name === "周报"));
    const tplName12 = `自测模板-${Date.now().toString(36)}`;
    const tpl12 = await templates!.create({ name: tplName12, description: "自建", text: "自动化自测：请直接回复任务已完成。" });
    check("模板创建", !!tpl12.id && !tpl12.builtin);
    check("模板重名被拒", await templates!.create({ name: tplName12, text: "x" }).then(() => false, () => true));
    await templates!.update(tpl12.id, { description: "改说明", text: "改内容" });
    check("模板更新", templates!.list().find((t) => t.id === tpl12.id)?.text === "改内容");
    await templates!.remove(tpl12.id);
    check("模板删除", !templates!.list().some((t) => t.id === tpl12.id));

    // ---- 阶段 13：回收站（保留期自动清理 + 统计 + 手动清空；临时目录隔离，不动用户回收站）----
    const tmpRecycle13 = path.join(workspace!.dirs.home, `selftest-recycle-${Date.now().toString(36)}`);
    const rc13 = new RecycleService({ dir: tmpRecycle13, audit: auditRef! });
    const oldMs13 = Date.now() - 40 * 86_400_000; // 40 天前：超 30 天保留期
    await fsp.mkdir(path.join(tmpRecycle13, `skill-old-${oldMs13}`), { recursive: true });
    await fsp.writeFile(path.join(tmpRecycle13, `skill-old-${oldMs13}`, "SKILL.md"), "x", "utf-8");
    const newMs13 = Date.now(); // mkdir 与 writeFile 必须同名：两次 Date.now() 跨毫秒会 ENOENT
    await fsp.mkdir(path.join(tmpRecycle13, `skill-new-${newMs13}`), { recursive: true });
    await fsp.writeFile(path.join(tmpRecycle13, `skill-new-${newMs13}`, "SKILL.md"), "y", "utf-8");
    await fsp.writeFile(path.join(tmpRecycle13, `session-x-${oldMs13}.json`), "{}", "utf-8");
    const purged13 = await rc13.purgeExpired(30);
    const left13 = await fsp.readdir(tmpRecycle13);
    check("过期条目清理", purged13 === 2 && !left13.some((n) => n.includes("old")), `清了 ${purged13} 项`);
    check("保留期内保留", left13.some((n) => n.startsWith("skill-new-")));
    const stats13 = await rc13.stats();
    check("回收站统计", stats13.count === 1 && stats13.bytes > 0, JSON.stringify(stats13));
    check("手动清空", (await rc13.clear()) === 1 && (await fsp.readdir(tmpRecycle13)).length === 0);
    await fsp.rm(tmpRecycle13, { recursive: true, force: true }).catch(() => {});
    check("启动清理入口可跑", typeof (await recycle!.purgeExpired(30)) === "number"); // 真实回收站（当前均在新期内，不删东西）

    // ---- 阶段 12：M6-D 模式热切换（无重启：退出登录→单机回落→重新登录→联机恢复）----
    {
      const mockBase = String(process.env.ORDO_ADMIN_BASE ?? "");
      const marketBefore = (await skillMarket!.listMarket()).length;
      const expertsBefore = host!.listExperts().length;
      await clearAdminAuth();
      await enterStandalone();
      check("热退后市场目录清空", (await skillMarket!.listMarket()).length === 0);
      check("热退后专家回落内置", host!.listExperts().length === 1, host!.listExperts().map((e) => e.id).join(","));
      check("热退后企业链路停", pushRef === null && reporterRef === null && adminSyncRef === null);
      // 单机态渲染层：设置为一级页面（两栏），模型表单在「模型」节内必须可达（自动化锁住该路径）
      const modelForm = await win!.webContents.executeJavaScript(`(async () => {
        document.getElementById("open-settings").click();
        // 页骨架同步出现；模型表单经 IPC（getAuthState/getLocalModel）异步填充：点「模型」节后轮询
        let page = null, form = null, navTexts = [], backLabel = "";
        for (let i = 0; i < 30 && !form; i++) {
          page = document.querySelector("#module-page:not(.hidden)");
          if (page && !navTexts.length) {
            navTexts = [...page.querySelectorAll(".st-nav-item")].map((n) => n.textContent);
            backLabel = document.getElementById("mv-back-label")?.textContent ?? "";
            const btn = [...page.querySelectorAll(".st-nav-item")].find((b) => b.textContent === "模型");
            if (btn) btn.click();
          }
          form = page ? page.querySelector(".m-model-form") : null;
          if (!form) await new Promise((r) => setTimeout(r, 100));
        }
        // 主题节（原独立页并入）：预览卡必须能渲染出来
        let themeOk = false;
        const themeBtn = [...page.querySelectorAll(".st-nav-item")].find((b) => b.textContent === "主题");
        if (themeBtn) {
          themeBtn.click();
          for (let i = 0; i < 20 && !themeOk; i++) {
            themeOk = !!page.querySelector(".theme-preview");
            if (!themeOk) await new Promise((r) => setTimeout(r, 100));
          }
        }
        const diag = { pageOpen: !!page, navTexts, backLabel, hasForm: !!form, fields: form ? form.querySelectorAll("input").length : -1, themeOk };
        document.getElementById("mv-back")?.click(); // 收页面还原对话视图
        return diag;
      })()`);
      check(
        "热退后（单机）设置页-模型表单可达",
        modelForm.pageOpen === true &&
          ["通用", "账号", "模型", "IM 通道", "存储", "主题", "关于与企业管控"].every((t) => modelForm.navTexts.includes(t)) &&
          modelForm.backLabel === "返回工作区" &&
          modelForm.hasForm === true &&
          modelForm.fields >= 4 &&
          modelForm.themeOk === true,
        JSON.stringify(modelForm)
      );
      await adminLogin(mockBase, "mock-emp", "mock-pass");
      ADMIN_BASE = mockBase;
      await enterOnline();
      check("热登后市场目录恢复", (await skillMarket!.listMarket()).length === marketBefore);
      check("热登后专家恢复", host!.listExperts().length === expertsBefore);
      check("热登后企业链路重起", pushRef !== null && reporterRef !== null && adminSyncRef !== null);
      // M6 增强：模型列表发现（IPC 真链路 → mock 端 /v1/models）
      const discovered = await win!.webContents.executeJavaScript(`window.ordo.listLocalModels(${JSON.stringify({ baseUrl: process.env.ORDO_ADMIN_BASE + "/v1", apiKey: "mock-key", modelId: "x", modelName: "" })})`);
      check("单机模型列表发现（/models 下拉源）", Array.isArray(discovered?.models) && discovered.models.includes("ordo-mock-llm"), JSON.stringify(discovered));
    }

    // ---- 阶段 13：IM 通道（钉钉/飞书长连接桥）：假适配器注入 → 绑定 → Agent 真跑 → L2 确认 → 媒体/get → 停用 ----
    {
      // selftest 共用真实 home：用户可能已配置并启用了真实通道——先备份，测试完原样还原
      const imCfgPath = path.join(workspace!.dirs.config, "im-channels.json");
      const imCfgBackup = await fsp.readFile(imCfgPath, "utf-8").catch(() => null as string | null);
      try {
        await imBridge!.save("dingtalk", { enabled: false }); // 先停用断连：防真实入站消息插进测试链路
        await imBridge!.save("feishu", { enabled: false });
        const list0 = await imBridge!.list();
        check(
          "IM 通道清单（双通道·六位绑定码）",
          list0.length === 2 && list0.every((c) => /^\d{6}$/.test(c.bindCode)),
          JSON.stringify(list0.map((c) => ({ id: c.id, conn: c.conn, enabled: c.enabled })))
        );
        let stopCount = 0;
        imBridge!.setTestAdapter("dingtalk", {
          start: async () => {},
          stop: () => {
            stopCount++;
          },
          isOnline: () => true,
          downloadMedia: async (m) => ({ name: m.fileName || "media.bin", data: Buffer.from("Ordo IM 媒体自测内容", "utf-8") }),
        });
        const savedOn = await imBridge!.save("dingtalk", { enabled: true, clientId: "test-key", secret: "test-secret", autoApprove: false });
        check("IM 保存并连接（假适配器在线）", savedOn.find((c) => c.id === "dingtalk")?.conn === "online", JSON.stringify(savedOn.find((c) => c.id === "dingtalk")));
        const r1 = await imBridge!.deliverForTest("dingtalk", "user-abc-1", "你好");
        check("IM 未绑定 → 回复用户 ID 引导", r1.replies.some((t) => t.includes("用户 ID") && t.includes("user-abc-1")), JSON.stringify(r1));
        const rBad = await imBridge!.deliverForTest("dingtalk", "user-abc-1", "/bind 000000");
        check("IM 错误绑定码拒绝", rBad.replies.some((t) => t.includes("/bind")) && !rBad.replies.some((t) => t.includes("绑定成功")), JSON.stringify(rBad));
        const bindCode = (await imBridge!.list()).find((c) => c.id === "dingtalk")!.bindCode;
        const r2 = await imBridge!.deliverForTest("dingtalk", "user-abc-1", `/bind ${bindCode}`);
        check("IM 绑定成功", r2.replies.some((t) => t.includes("绑定成功")), JSON.stringify(r2));
        const r3 = await imBridge!.deliverForTest("dingtalk", "user-other-9", "帮我删库");
        check("IM 非绑定用户拒绝", r3.replies.some((t) => t.includes("已绑定其他用户")), JSON.stringify(r3));
        const r4 = await imBridge!.deliverForTest("dingtalk", "user-abc-1", "1+1等于几？只回答数字。");
        check("IM 消息→Agent 运行→回复", r4.replies.some((t) => /2/.test(t)), JSON.stringify(r4));
        const afterRun = (await imBridge!.list()).find((c) => c.id === "dingtalk")!;
        const imSess = afterRun.sessionId ? await sessions!.load(afterRun.sessionId) : null;
        check("IM 会话落库（独立后台会话）", !!imSess && (imSess.messages?.length ?? 0) >= 2, JSON.stringify({ sessionId: afterRun.sessionId, msgs: imSess?.messages?.length }));

        // L2 确认链路：write_file 触发确认消息 → 手机回复【同意】→ 任务继续完成
        // 顺序关键：先启动任务并等 pending 出现，再回【同意】——await 任务本身会卡在确认等待上
        const wsEntry13 = workspace!.registry.byId("default");
        const imRoot13 = wsEntry13?.root ?? workspace!.dirs.workspace;
        const l2File = path.join(imRoot13, "out", "weekly-report.md");
        const l2MtimeBefore = fs.existsSync(l2File) ? fs.statSync(l2File).mtimeMs : 0;
        const pYes = imBridge!.deliverForTest("dingtalk", "user-abc-1", "请读取 data/sales.txt，生成周报并写入 out/weekly-report.md");
        let pendingSeen = false;
        for (let i = 0; i < 1800 && !pendingSeen; i++) {
          pendingSeen = imBridge!.hasPendingConfirm("dingtalk");
          if (!pendingSeen) await new Promise((r) => setTimeout(r, 100));
        }
        const rYes = await imBridge!.deliverForTest("dingtalk", "user-abc-1", "同意");
        check("IM 回复【同意】放行", pendingSeen && rYes.replies.some((t) => t.includes("已同意")), JSON.stringify(rYes));
        const yesDone = await Promise.race([pYes, new Promise<{ replies: string[] }>((res) => setTimeout(() => res({ replies: ["timeout"] }), 300_000))]);
        check(
          "IM L2 确认消息已发出", 
          yesDone.replies.some((t) => t.includes("操作需要确认") && t.includes("write_file")),
          JSON.stringify(yesDone.replies)
        );
        const l2MtimeAfter = fs.existsSync(l2File) ? fs.statSync(l2File).mtimeMs : 0;
        check("IM 同意后任务继续完成（文件已写）", !yesDone.replies.includes("timeout") && l2MtimeAfter > l2MtimeBefore, JSON.stringify({ done: yesDone.replies.length, l2MtimeAfter, l2MtimeBefore }));
        // 拒绝路径：换措辞重触发（真实模型对完全相同的重复请求可能不再写文件）→ 回复【拒绝】→ 任务收尾不落盘
        const pNo = imBridge!.deliverForTest("dingtalk", "user-abc-1", "请读取 data/sales.txt，重新生成周报并覆盖写入 out/weekly-report.md");
        for (let i = 0; i < 1800 && !imBridge!.hasPendingConfirm("dingtalk"); i++) await new Promise((r) => setTimeout(r, 100));
        const rNo = await imBridge!.deliverForTest("dingtalk", "user-abc-1", "拒绝");
        check("IM 回复【拒绝】拦截", rNo.replies.some((t) => t.includes("已拒绝")), JSON.stringify(rNo));
        const noDone = await Promise.race([pNo, new Promise<{ replies: string[] }>((res) => setTimeout(() => res({ replies: ["timeout"] }), 300_000))]);
        check("IM 拒绝后任务收尾", !noDone.replies.includes("timeout"), JSON.stringify(noDone.replies.slice(0, 2)));

        // 媒体接收 → .inbox 附件链路；/get 回传（含越界拦截）
        const rMedia = await imBridge!.deliverForTest("dingtalk", "user-abc-1", "请看看这份文件", { kind: "file", fileName: "im-media-test.txt", mediaKey: "k-x" });
        const day13 = new Date().toISOString().slice(0, 10);
        const mediaFile = path.join(imRoot13, ".inbox", day13, "im-media-test.txt");
        const mediaOk = fs.existsSync(mediaFile) && fs.readFileSync(mediaFile, "utf-8").includes("IM 媒体自测内容");
        check("IM 媒体下载→附件落盘", mediaOk && rMedia.replies.some((t) => t.includes("收到文件")), JSON.stringify({ mediaOk, replies: rMedia.replies.slice(0, 2) }));
        const rGet = await imBridge!.deliverForTest("dingtalk", "user-abc-1", `/get .inbox/${day13}/im-media-test.txt`);
        check("IM /get 回传工作区文件", rGet.files.length === 1 && rGet.files[0].bytes > 0, JSON.stringify(rGet));
        const rEsc = await imBridge!.deliverForTest("dingtalk", "user-abc-1", "/get ../outside.txt");
        check("IM /get 越界拦截", rEsc.replies.some((t) => t.includes("路径越界")), JSON.stringify(rEsc));
        await fsp.rm(mediaFile, { force: true }).catch(() => {});

        const r5 = await imBridge!.deliverForTest("dingtalk", "user-abc-1", "/help");
        check("IM /help 用法", r5.replies.some((t) => t.includes("用法")), JSON.stringify(r5));
        // 主路径：设置页「用户 ID」字段直填绑定（飞书通道）
        const savedBound = await imBridge!.save("feishu", { enabled: false, boundUser: "ou_test_field_1" });
        check("IM 用户 ID 字段直填绑定", savedBound.find((c) => c.id === "feishu")?.boundUser === "ou_test_field_1", JSON.stringify(savedBound.find((c) => c.id === "feishu")));
        const rF1 = await imBridge!.deliverForTest("feishu", "ou_test_field_1", "/help");
        check("IM 字段绑定用户可交互", rF1.replies.some((t) => t.includes("用法")), JSON.stringify(rF1));
        const rF2 = await imBridge!.deliverForTest("feishu", "ou_someone_else", "你好");
        check("IM 字段绑定后他人仍拒绝", rF2.replies.some((t) => t.includes("已绑定其他用户")), JSON.stringify(rF2));
        const savedClear = await imBridge!.save("feishu", { boundUser: "" });
        check("IM 用户 ID 清空即解绑", !savedClear.find((c) => c.id === "feishu")?.boundUser);
        const savedOff = await imBridge!.save("dingtalk", { enabled: false });
        check("IM 停用断开", savedOff.find((c) => c.id === "dingtalk")?.conn === "off" && stopCount >= 1);
        const savedUn = await imBridge!.unbind("dingtalk");
        check("IM 解绑", !savedUn.find((c) => c.id === "dingtalk")?.boundUser);
      } finally {
        // 清场（check 失败中断也必须还原）：还原自测前的 IM 配置——不留测试凭证，也不覆盖用户真实通道
        imBridge!.setTestAdapter("dingtalk", null);
        await fsp.writeFile(imCfgPath, imCfgBackup ?? "[]", "utf-8");
      }
    }

    console.log("[SELFTEST] ===== 全部通过 =====");
    for (const line of results) console.log(`[SELFTEST] ${line}`);
    console.log(`[SELFTEST] 审计与示例会话见: ${workspace!.dirs.home}`);
    // ⏰ 自测会话清场：自动化运行会生成独立会话文件，残留会成为"最近会话"——
    // 真实应用启动自动恢复时把工作区重锚到已删的临时目录（文件清单变空的根源）。
    // 提示词指纹 + 自测时间窗双重限定（各阶段 prompt 的会话标题即提示词截断）
    for (const s of await host!.listSessions()) {
      const t = s.title ?? "";
      const mine = (t.startsWith("⏰ 自测") || t.startsWith("请读取 data/sales.txt") || t.startsWith("1+1等于几") || t.startsWith("慢速任务")) && String(s.updatedAt ?? "") >= selftestT0;
      if (mine) await sessions!.remove(s.id).catch(() => {});
    }
    clearTimeout(timer);
    app.exit(0);
  } catch (e) {
    console.error("[SELFTEST] ===== 失败 =====");
    for (const line of results) console.log(`[SELFTEST] ${line}`);
    console.error("[SELFTEST] FAIL:", e);
    await adminFetchJson(ADMIN_BASE, "/__test/mutate", { method: "POST", body: JSON.stringify({ op: "restore" }) }).catch(() => {});
    // 阶段 7 中途失败可能残留种子会话：按名清理（用户会话不受影响）；自测提示词指纹会话一并收走
    try {
      if (host && sessions) {
        for (const s of await sessions.list()) {
          const t = s.title ?? "";
          const mine =
            t === "自测可操作会话" ||
            ((t.startsWith("⏰ 自测") || t.startsWith("请读取 data/sales.txt") || t.startsWith("1+1等于几") || t.startsWith("慢速任务")) && String(s.updatedAt ?? "") >= selftestT0);
          if (mine) await sessions.remove(s.id).catch(() => {});
        }
      }
    } catch {}
    // 阶段 10 中途失败可能残留自测个人库/临时文档：按名清理（用户自建库不受影响）
    try {
      if (personalKb && workspace) {
        const leftovers = (await personalKb.list()).filter((k) => k.name.startsWith("自测个人库-"));
        for (const leftover of leftovers) await personalKb.remove(leftover.id);
      }
    } catch {}
    // 阶段 11/12 中途失败可能残留自测自动化任务/模板/临时工作区：按名清理（用户自建不受影响）
    try {
      if (automations) {
        const names = ["自测自动化-", "自测围栏-", "自测预授权-", "自测目录绑定-"];
        for (const t of automations.list()) {
          if (names.some((p) => t.name.startsWith(p))) await automations.remove(t.id).catch(() => {});
        }
      }
      if (templates) {
        for (const t of templates.list()) {
          if (t.name.startsWith("自测模板-")) await templates.remove(t.id).catch(() => {});
        }
      }
      if (workspace) {
        for (const e of workspace.registry.list()) {
          if (e.id !== "default" && e.root.includes("selftest-auto-ws-")) {
            workspace.registry.remove(e.id);
            await fsp.rm(e.root, { force: true, recursive: true }).catch(() => {});
          }
        }
        // 失败路径同样清 ⏰ 自测会话 + 磁盘上可能残留的临时目录（Windows 句柄延迟曾致 rm 失败）
        if (host) {
          for (const s of await host.listSessions()) {
            if ((s.title ?? "").startsWith("⏰ 自测")) await sessions!.remove(s.id).catch(() => {});
          }
        }
        const homeDir = workspace.dirs.home;
        for (const n of await fsp.readdir(homeDir).catch(() => [] as string[])) {
          if (n.startsWith("selftest-auto-ws-")) await fsp.rm(path.join(homeDir, n), { force: true, recursive: true }).catch(() => {});
        }
      }
    } catch {}
    if (workspace) await fsp.rm(path.join(workspace.dirs.home, "selftest-kb-doc.md"), { force: true }).catch(() => {});
    clearTimeout(timer);
    app.exit(1);
  }
}

app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  await bootstrap().catch((e) => {
    console.error("[BOOT] 启动失败:", e);
    dialog.showErrorBox("Ordo 启动失败", String((e as Error)?.message ?? e));
    app.exit(1);
  });
  // 去掉默认菜单（文件/编辑/查看…）：正式产品不需要，也顺带清掉 Ctrl+R/F12 等默认快捷键
  Menu.setApplicationMenu(null);
  win = new BrowserWindow({
    width: 1200,
    height: 800,
    title: "Ordo",
    // 开发模式任务栏/窗口图标（打包后走 exe 内嵌 icon.ico，不依赖此参数；路径不存在时静默忽略）
    icon: path.join(__dirname, "../../build/icon.png"),
    // 无边框融合：系统标题栏整条隐藏，最小化/最大化/关闭由 Windows 原生绘制为顶栏右侧覆盖层
    // （悬停/双击最大化/Win11 Snap Layouts/键盘行为全部原生）。颜色与顶栏主题一致（tokens.css --bg/--text-soft），
    // 顶栏因此改为不透明底色（半透明+模糊与不透明覆盖层会有色差）。
    // 高度 47 = 顶栏 48 − border 1：overlay 盖在网页内容之上，若同高会压住顶栏底部分割线的最后一行像素，
    // 少 1px 让分割线在三键下方贯通到窗口右缘
    titleBarStyle: "hidden",
    titleBarOverlay: { color: "#f7f6f3", symbolColor: "#5f5b52", height: 47 },
    webPreferences: {
      preload: path.join(__dirname, "../preload/index.js"),
      contextIsolation: true,
      nodeIntegration: false,
      // 浏览器桥 A 的内嵌页面容器（方案 §5）：webview 独立进程，能力面与安全守卫在主进程（browser-bridge）
      webviewTag: true,
    },
  });
  // 开发期 DevTools：默认菜单已移除，开发模式保留 Ctrl+Shift+I（正式版不响应）
  if (!app.isPackaged) {
    win.webContents.on("before-input-event", (_e, input) => {
      if (input.control && input.shift && String(input.key ?? "").toLowerCase() === "i") win!.webContents.toggleDevTools();
    });
  }
  win.loadFile(path.join(__dirname, "../../src/renderer/index.html"));

  ipcMain.handle("ordo:prompt", async (_e, text: unknown, attachments?: unknown) => {
    // 附件限流：单文件 ≤ 25MB、总量 ≤ 60MB、个数 ≤ 10（超限直接拒绝，不静默丢弃）
    const atts = Array.isArray(attachments)
      ? (attachments as Array<{ name?: unknown; size?: unknown; dataBase64?: unknown }>)
          .filter((a) => a && typeof a === "object")
          .map((a) => ({ name: String(a.name ?? ""), size: Number(a.size ?? 0), dataBase64: typeof a.dataBase64 === "string" ? a.dataBase64 : "" }))
      : [];
    if (atts.length > 10) throw new Error("附件过多（一次最多 10 个）");
    const b64Bytes = (a: { dataBase64: string }) => Math.floor(a.dataBase64.length * 0.75);
    for (const a of atts) {
      if (b64Bytes(a) > 25 * 1024 * 1024) throw new Error(`附件「${a.name}」超过单文件 25MB 上限`);
    }
    if (atts.reduce((s, a) => s + b64Bytes(a), 0) > 60 * 1024 * 1024) throw new Error("附件总大小超过 60MB 上限");
    await host!.prompt(String(text), atts.length ? atts : undefined);
    return true;
  });
  ipcMain.handle("ordo:visionSupported", () => host!.supportsVision());
  ipcMain.handle("ordo:regenerate", async () => {
    await host!.regenerate();
    return true;
  });
  ipcMain.handle("ordo:feedback", (_e, value: unknown) => {
    host!.feedback(value === "down" ? "down" : "up");
    return true;
  });
  ipcMain.handle("ordo:confirm", (_e, id: string, approved: unknown) => {
    pendingConfirms.get(String(id))?.(!!approved);
    pendingConfirms.delete(String(id));
    return true;
  });
  ipcMain.handle("ordo:workspaceInfo", () => ({
    product: "Ordo",
    root: workspace!.root,
    home: workspace!.dirs.home,
  }));
  ipcMain.handle("ordo:listExperts", () => ({
    current: host!.currentExpert,
    items: host!.listExperts(),
  }));
  ipcMain.handle("ordo:switchExpert", async (_e, id: string) => {
    // 专家随会话锁定（PRD 3.10）：仅新建会话（尚无消息）可选；续接会话恢复其保存的专家
    if (host!.messageCount() > 0) {
      throw new Error("会话已开始，专家已随会话锁定；如需更换专家请新建会话");
    }
    await host!.switchExpert(String(id));
    return true;
  });
  ipcMain.handle("ordo:thinkingState", () => ({
    current: host!.currentThinking(),
    items: host!.listThinking(),
  }));
  ipcMain.handle("ordo:switchThinking", (_e, id: string) => {
    host!.switchThinking(String(id));
    return true;
  });
  ipcMain.handle("ordo:listSessions", () => host!.listSessions());
  ipcMain.handle("ordo:newSession", () => {
    host!.newSession();
    return true;
  });
  ipcMain.handle("ordo:loadSession", (_e, id: string) => host!.loadSession(String(id)));

  // ---- 契约扩展：运行控制 ----
  ipcMain.handle("ordo:cancel", () => host!.cancel());
  // 运行中消息：引导（插入当前任务）与排队（任务完成后执行）+ 撤回排队消息
  ipcMain.handle("ordo:steer", (_e, text: unknown) => host!.steerMessage(String(text ?? "")));
  ipcMain.handle("ordo:queueFollowUp", (_e, text: unknown) => host!.queueFollowUp(String(text ?? "")));
  ipcMain.handle("ordo:cancelQueued", (_e, entryId: unknown) => host!.cancelQueued(String(entryId ?? "")));
  ipcMain.handle("ordo:switchQueued", (_e, entryId: unknown, target: unknown) =>
    host!.switchQueued(String(entryId ?? ""), target === "steer" ? "steer" : "followUp"));

  // ---- 契约扩展：工作台文件预览 / @ 引用 ----
  ipcMain.handle("ordo:readFilePreview", (_e, relPath: unknown) =>
    readFilePreview(workspace!, String(relPath))
  );

  // 用户侧编辑保存（方案 §2.3 第一层）：显式动作，审计 user_edit，不走 L2 二次确认（审计内嵌于 saveUserEdit）
  ipcMain.handle("ordo:saveFileEdit", (_e, relPath: unknown, payload: unknown) =>
    saveUserEdit(workspace!, String(relPath), payload as { text: string } | { base64: string }, auditRef ?? undefined)
  );

  // ---- 浏览器桥 A（方案 §5）：面板侧状态/控制台/急停 ----
  ipcMain.handle("ordo:browserState", () => browserBridge!.state);
  ipcMain.handle("ordo:browserConsoleTail", (_e, n: unknown) => browserBridge!.consoleTail(Number(n) || 30));
  ipcMain.handle("ordo:browserStop", () => browserBridge!.stop());
  // 新标签页手动开 URL：用户显式动作即确认（不重复弹 L2），白名单/批准源/审计照走
  ipcMain.handle("ordo:browserOpenUser", (_e, url: unknown) => browserBridge!.open(String(url), "user"));
  // 渲染端 webview dom-ready 后附着（挂控制台捕获与跳脱守卫）
  ipcMain.handle("ordo:browserAttach", (_e, id: unknown) => browserBridge!.attach(Number(id)));
  // ---- 用户侧终端（方案 §6）：打开（cwd 跟随当前工作区）/写入/尺寸/关闭 ----
  ipcMain.handle("ordo:termOpen", () => terminalHost!.open(workspace!.root));
  ipcMain.handle("ordo:termWrite", (_e, data: unknown) => terminalHost!.write(String(data)));
  ipcMain.handle("ordo:termResize", (_e, cols: unknown, rows: unknown) => terminalHost!.resize(Number(cols), Number(rows)));
  ipcMain.handle("ordo:termClose", () => terminalHost!.close());
  ipcMain.handle("ordo:termState", () => ({ active: terminalHost!.active, cwd: terminalHost!.cwdSnapshot }));

  // ---- 主题系统：自定义主题扫描/导入/删除 + 偏好持久化 + 标题栏动态着色 ----
  const themesDir = path.join(workspace!.dirs.home, "themes");
  const themePrefFile = path.join(workspace!.dirs.config, "theme-preference.json");

  // 内置守望先锋主题：首次运行时从 app 包复制到用户主题目录（用户可删除）
  // 打包后路径：app.asar 内的 src/renderer/themes/overwatch
  const bundledThemeSrc = app.isPackaged
    ? path.join(process.resourcesPath, "app.asar", "src/renderer/themes/overwatch")
    : path.join(__dirname, "../../src/renderer/themes/overwatch");
  const owDest = path.join(themesDir, "overwatch");
  try {
    await fs.promises.mkdir(themesDir, { recursive: true });
    const owExists = fs.existsSync(path.join(owDest, "theme.json"));
    if (!owExists && fs.existsSync(path.join(bundledThemeSrc, "theme.json"))) {
      await fs.promises.mkdir(owDest, { recursive: true });
      const files = await fs.promises.readdir(bundledThemeSrc);
      for (const f of files) {
        await fs.promises.copyFile(path.join(bundledThemeSrc, f), path.join(owDest, f));
      }
      console.log("[THEME] 守望先锋主题已安装");
      // 首次安装：将守望先锋设为默认主题
      const prefExists = fs.existsSync(themePrefFile);
      if (!prefExists) {
        await fs.promises.mkdir(path.dirname(themePrefFile), { recursive: true});
        await fs.promises.writeFile(themePrefFile, JSON.stringify({ themeId: "overwatch" }), "utf-8");
      }
    }
  } catch (e) { console.warn("[THEME] 种子主题复制失败:", e); }

  function themeFileUrl(themeDir: string): string {
    return "file:///" + themeDir.replace(/\\/g, "/");
  }

  ipcMain.handle("ordo:listThemes", async () => {
    try {
      await fs.promises.mkdir(themesDir, { recursive: true });
      const entries = await fs.promises.readdir(themesDir, { withFileTypes: true });
      const themes: unknown[] = [];
      for (const e of entries) {
        if (!e.isDirectory()) continue;
        const themeDir = path.join(themesDir, e.name);
        const jsonPath = path.join(themeDir, "theme.json");
        try {
          const raw = await fs.promises.readFile(jsonPath, "utf-8");
          const t = JSON.parse(raw);
          // 背景图转为 file:// URL（不再内联 base64，减小传输体积）
          if (t.background && t.background.image && !t.background.image.startsWith("data:") && !t.background.image.startsWith("file:")) {
            t.background.image = themeFileUrl(path.join(themeDir, t.background.image));
          }
          t.id = t.id || e.name;
          t.builtin = false;
          t._iconBaseUrl = themeFileUrl(themeDir);
          themes.push(t);
        } catch {}
      }
      return themes;
    } catch { return []; }
  });

  ipcMain.handle("ordo:importTheme", async () => {
    const result = await dialog.showOpenDialog(win!, {
      title: "选择主题文件夹或 zip 压缩包",
      properties: ["openFile", "openDirectory"],
      filters: [
        { name: "主题包", extensions: ["zip"] },
        { name: "所有文件", extensions: ["*"] },
      ],
    });
    if (result.canceled || !result.filePaths.length) return null;
    const src = result.filePaths[0];
    const stats = await fs.promises.stat(src);

    try {
      let themeJson = null;
      let tempDir: string | null = null;
      let sourceDir = src;

      // 如果是 zip 文件，先解压到临时目录
      if (stats.isFile() && src.toLowerCase().endsWith(".zip")) {
        const AdmZip = (await import("adm-zip")).default;
        const zip = new AdmZip(src);
        tempDir = path.join(workspace!.dirs.home, ".temp-theme-" + Date.now());
        await fs.promises.mkdir(tempDir, { recursive: true });
        zip.extractAllTo(tempDir, true);

        // 查找 theme.json（可能在根目录或子目录）
        const entries = await fs.promises.readdir(tempDir, { withFileTypes: true });
        if (entries.length === 1 && entries[0].isDirectory()) {
          sourceDir = path.join(tempDir, entries[0].name);
        } else {
          sourceDir = tempDir;
        }
      }

      // 读取并验证 theme.json
      const jsonPath = path.join(sourceDir, "theme.json");
      const raw = await fs.promises.readFile(jsonPath, "utf-8");
      themeJson = JSON.parse(raw);

      if (!themeJson.id || !themeJson.name) {
        throw new Error("theme.json 缺少必需字段 id 或 name");
      }

      // 复制到用户主题目录（主题 ID 作为文件夹名）
      const dest = path.join(themesDir, themeJson.id);
      await fs.promises.mkdir(dest, { recursive: true });
      const files = await fs.promises.readdir(sourceDir);
      for (const f of files) {
        const srcFile = path.join(sourceDir, f);
        const destFile = path.join(dest, f);
        const stat = await fs.promises.stat(srcFile);
        if (stat.isFile()) {
          await fs.promises.copyFile(srcFile, destFile);
        }
      }

      // 清理临时目录
      if (tempDir) {
        await fs.promises.rm(tempDir, { recursive: true, force: true });
      }

      console.log(`[THEME] 主题「${themeJson.name}」已导入`);
      return { id: themeJson.id, name: themeJson.name };
    } catch (e) {
      dialog.showErrorBox("主题导入失败", `错误：${(e as Error).message}\n\n请确保选择的文件夹或 zip 包含有效的 theme.json 文件。`);
      return null;
    }
  });

  ipcMain.handle("ordo:deleteTheme", async (_e, id: unknown) => {
    const target = path.join(themesDir, String(id));
    if (!target.startsWith(themesDir)) return false;
    await fs.promises.rm(target, { recursive: true, force: true });
    return true;
  });

  ipcMain.handle("ordo:getThemePreference", async () => {
    try {
      const raw = await fs.promises.readFile(themePrefFile, "utf-8");
      return JSON.parse(raw).themeId ?? "light";
    } catch { return "light"; }
  });

  ipcMain.handle("ordo:setThemePreference", async (_e, id: unknown) => {
    await fs.promises.mkdir(path.dirname(themePrefFile), { recursive: true });
    await fs.promises.writeFile(themePrefFile, JSON.stringify({ themeId: String(id) }), "utf-8");
    return true;
  });

  ipcMain.handle("ordo:setTitleBarOverlay", (_e, color: unknown, symbolColor: unknown) => {
    try {
      win!.setTitleBarOverlay({ color: String(color), symbolColor: String(symbolColor), height: 47 });
    } catch {}
    return true;
  });


  // 工作区文件清单（新标签页文件选择用）：相对路径 + 字节数（目录行以 / 结尾）
  // 交付物定位与外部打开（跨平台 shell API）：交付物都在工作区内，resolveInside 顺带围栏
  ipcMain.handle("ordo:revealFile", (_e, p: unknown) => {
    const abs = workspace!.resolveInside(String(p ?? ""));
    if (fs.existsSync(abs)) {
      shell.showItemInFolder(abs);
      return { ok: true };
    }
    const dir = path.dirname(abs);
    if (fs.existsSync(dir)) {
      shell.openPath(dir); // 文件本身不存在：退而打开所在目录
      return { ok: true, fallback: "dir" };
    }
    return { ok: false };
  });
  ipcMain.handle("ordo:openPath", async (_e, p: unknown) => {
    const abs = workspace!.resolveInside(String(p ?? ""));
    const err = await shell.openPath(abs); // 空串 = 成功；否则为系统错误描述
    return { ok: err === "" };
  });

  ipcMain.handle("ordo:getWorkspaceFiles", () => {
    const out: { path: string; size: number }[] = [];
    const walk = (dir: string, depth: number): void => {
      if (depth > 3 || out.length >= 500) return;
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        if (out.length >= 500) return;
        if (e.name.startsWith(".")) continue;
        const abs = path.join(dir, e.name);
        if (e.isDirectory()) {
          if (e.name === "node_modules" || e.name === "__pycache__") continue;
          walk(abs, depth + 1);
        } else {
          let size = 0;
          try {
            size = fs.statSync(abs).size;
          } catch {
            /* 竞态消失的文件按 0 计 */
          }
          out.push({ path: path.relative(workspace!.root, abs).split(path.sep).join("/"), size });
        }
      }
    };
    walk(workspace!.root, 0);
    return out;
  });

  // ---- 契约扩展：多工作区（PRD 3.8）----
  ipcMain.handle("ordo:listWorkspaces", () => ({
    items: workspace!.registry.list(),
    currentId: workspace!.registry.currentId(),
  }));

  // 切工作区 = 后续会话锚定新目录；当前会话已有内容时开新会话（会话锚定后不可改）
  ipcMain.handle("ordo:switchWorkspace", (_e, id: unknown) => {
    if (host!.isRunning()) throw new Error("任务运行中，不能切换工作区");
    const entry = workspace!.registry.byId(String(id));
    if (!entry) throw new Error(`未知工作区: ${id}`);
    workspace!.switchRoot(entry.root);
    if (host!.messageCount() > 0) host!.newSession();
    host!.refreshPrompt(); // AGENTS.md 工作区约定层随新根目录重读
    return { id: entry.id, root: entry.root };
  });

  // 原生目录选择器（renderer 的 webkitdirectory 在 file:// 下不可用）
  ipcMain.handle("ordo:pickDir", async (_e, title: unknown) => {
    const r = await dialog.showOpenDialog(win!, { properties: ["openDirectory"], title: String(title ?? "选择目录") });
    return r.canceled || !r.filePaths.length ? null : r.filePaths[0];
  });

  ipcMain.handle("ordo:pickWorkspace", async () => {
    if (host!.isRunning()) throw new Error("任务运行中，不能切换工作区");
    const r = await dialog.showOpenDialog(win!, { properties: ["openDirectory"], title: "选择工作区目录" });
    if (r.canceled || !r.filePaths.length) return null;
    const entry = workspace!.registry.add(r.filePaths[0]);
    workspace!.switchRoot(entry.root);
    if (host!.messageCount() > 0) host!.newSession();
    return entry;
  });

  ipcMain.handle("ordo:openWorkspaceDir", async (_e, root?: unknown) => {
    // 只打开已登记的工作区根或当前根，防止任意路径打开
    const target = root ? String(root) : workspace!.root;
    const known = [workspace!.root, ...workspace!.registry.list().map((w) => w.root)];
    if (!known.some((k) => path.resolve(k) === path.resolve(target))) {
      throw new Error("仅支持打开已登记的工作区目录");
    }
    await shell.openPath(target);
    return true;
  });

  // ---- 契约扩展：会话管理 ----
  ipcMain.handle("ordo:pinSession", async (_e, id: unknown, pinned: unknown) => {
    const s = await sessions!.mutate(String(id), { pinned: !!pinned });
    if (!s) throw new Error(`会话不存在: ${id}`);
    return true;
  });
  ipcMain.handle("ordo:renameSession", async (_e, id: unknown, title: unknown) => {
    const s = await sessions!.mutate(String(id), { title: String(title ?? "").slice(0, 40) });
    if (!s) throw new Error(`会话不存在: ${id}`);
    return true;
  });
  ipcMain.handle("ordo:deleteSession", async (_e, id: unknown) => {
    const sessionId = String(id);

    // 1. 删除记忆数据
    await host!.deleteSessionMemory(sessionId);

    // 2. 删除会话文件
    const ok = await sessions!.remove(sessionId);
    if (!ok) throw new Error(`会话不存在: ${id}`);

    // 3. 如果是当前会话，创建新会话
    if (host!.currentSessionId === sessionId) host!.newSession();

    return true;
  });

  // ---- 契约扩展：技能市场 / 资源启停 ----
  ipcMain.handle("ordo:listSkills", () => host!.listSkillsRich());
  ipcMain.handle("ordo:setResourceEnabled", async (_e, module: unknown, id: unknown, enabled: unknown) => {
    if (String(module) === "skill") return host!.setSkillEnabled(String(id), !!enabled);
    if (String(module) === "connector") return host!.setConnectorEnabled(String(id), !!enabled);
    if (String(module) === "kb") return host!.setKnowledgeBaseEnabled(String(id), !!enabled);
    if (String(module) === "automation") return automations!.setEnabled(String(id), !!enabled);
    return false;
  });

  // ---- 契约扩展：技能生命周期（沉淀走 save_skill 工具；此处为查看/编辑/删除/导入 + 企业市场）----
  ipcMain.handle("ordo:readSkill", (_e, name: unknown) => host!.readSkill(String(name ?? "")));
  ipcMain.handle("ordo:updateSkill", (_e, name: unknown, input: unknown) =>
    host!.updateSkill(String(name ?? ""), input as any)
  );
  ipcMain.handle("ordo:deleteSkill", (_e, name: unknown) => host!.deleteSkill(String(name ?? "")));
  ipcMain.handle("ordo:importSkill", (_e, src: unknown) => host!.importSkillFromDir(String(src ?? "")));
  // 原生目录选择器（技能包导入）：只选路径，导入由 ordo:importSkill 完成（便于自测直接传路径）
  ipcMain.handle("ordo:pickSkillFolder", async () => {
    if (SELFTEST) return null;
    const r = await dialog.showOpenDialog(win!, { properties: ["openDirectory"], title: "选择技能包目录（内含 SKILL.md）" });
    return r.canceled || !r.filePaths.length ? null : r.filePaths[0];
  });
  // 打开技能所在目录（资源管理器定位到 SKILL.md；仅限已加载技能的文件位置）
  ipcMain.handle("ordo:openSkillDir", async (_e, name: unknown) => {
    const s = host!.readSkill(String(name ?? ""));
    shell.showItemInFolder(s.filePath);
    return true;
  });

  // ---- 契约扩展：企业技能市场（目录按权限过滤 / 安装 / 卸载 / 提交审核 / 后台同步）----
  ipcMain.handle("ordo:skillMarket", () => skillMarket!.listMarket());
  ipcMain.handle("ordo:skillInstalled", () => skillMarket!.listInstalled());
  ipcMain.handle("ordo:installSkill", (_e, name: unknown) => skillMarket!.install(String(name ?? "")));
  ipcMain.handle("ordo:uninstallSkill", (_e, name: unknown) => skillMarket!.uninstall(String(name ?? "")));
  ipcMain.handle("ordo:submitSkill", (_e, name: unknown) =>
    skillMarket!.submitForReview(String(name ?? ""), workspace!.dirs.skillsPersonal)
  );
  ipcMain.handle("ordo:skillSubmissions", () => skillMarket!.listSubmissions());

// ---- 模式与登录（M6-B）：欢迎页/登录 gate 的主进程面；登录/切单机/退出后 relaunch 干净重入 ----
ipcMain.handle("ordo:getAuthState", () => authState());
ipcMain.handle("ordo:authLogin", async (_e, base: unknown, empNo: unknown, password: unknown) => {
  const b = String(base ?? "").trim().replace(/\/+$/, "");
  if (!/^https?:\/\//.test(b)) throw new Error("管理端地址需以 http:// 或 https:// 开头");
  const snap = await adminLogin(b, String(empNo ?? ""), String(password ?? ""));
  // M6-D 无重启热接：就地把企业配置/数据源/链路拉起（host 存活时热重建，会话不断）
  ADMIN_BASE = b;
  await enterOnline();
  return { user: snap.user };
});
ipcMain.handle("ordo:authStandalone", async () => {
  await setStandaloneMode();
  await enterStandalone();
});
ipcMain.handle("ordo:authLogout", async () => {
  await clearAdminAuth(); // 仅清 auth.json：企业下发资源与个人数据保留（用户定案）
  await enterStandalone();
});
ipcMain.handle("ordo:relaunch", () => {
  app.relaunch();
  app.exit(0);
});

// ---- 单机模型配置（M6-B）：~/.ordo/config.local.json；保存后重启生效 ----
ipcMain.handle("ordo:getLocalModel", () => loadLocalModel(workspace!.dirs.home));
ipcMain.handle("ordo:setLocalModel", async (_e, input: unknown) => {
  const saved = await saveLocalModel(workspace!.dirs.home, input as LocalModelInput);
  // 热生效：非联机态（单机/未配置）下立即按新配置重建模型；联机态模型由管理端下发，本地配置不生效
  if (authState().mode !== "online" && host) {
    cfg.model = localModelToConfig(saved);
    await host.rebuildModel();
  }
  return saved;
});
ipcMain.handle("ordo:testLocalModel", async (_e, input: unknown) => {
  const m = input as LocalModelInput;
  const err = validateLocalModel(m);
  if (err) throw new Error(err);
  // 真实对话验证（M6 增强）：仅探活 /models 不代表 key+模型可用，发一次最小对话请求
  const base = m.baseUrl.replace(/\/+$/, "");
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 20000);
  const startTime = Date.now();
  try {
    const res = await fetch(`${base}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${m.apiKey}` },
      body: JSON.stringify({ model: m.modelId, messages: [{ role: "user", content: "ping" }], max_tokens: 1, stream: false }),
      signal: ctrl.signal,
    });
    const elapsed = Date.now() - startTime;
    if (!res.ok) {
      const data = (await res.json().catch(() => ({}))) as { error?: { message?: string } | string };
      const detail = typeof data?.error === "string" ? data.error : data?.error?.message;
      throw new Error(detail ? `对话验证失败：${String(detail).slice(0, 120)}` : `接口响应 HTTP ${res.status}`);
    }
    return { ok: true, elapsed };
  } finally {
    clearTimeout(timer);
  }
});
ipcMain.handle("ordo:listLocalModels", async (_e, input: unknown) => {
  const m = input as LocalModelInput;
  // 查询模型列表时只需验证 baseUrl 和 apiKey，modelId 此时还未填写（用户正是要通过查询来发现可用模型）
  if (!input) throw new Error("配置不能为空");
  if (!/^https?:\/\//.test(String(m.baseUrl ?? ""))) throw new Error("接口地址需以 http:// 或 https:// 开头");
  if (!String(m.apiKey ?? "").trim()) throw new Error("API Key 不能为空");
  // 模型列表发现（M6 增强）：OpenAI 兼容 /models；网关不支持时前端保留手填
  const base = m.baseUrl.replace(/\/+$/, "");
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 10000);
  try {
    const res = await fetch(`${base}/models`, { headers: { authorization: `Bearer ${m.apiKey}` }, signal: ctrl.signal });
    if (!res.ok) throw new Error(`列表接口响应 HTTP ${res.status}（可手填模型 ID）`);
    const data = (await res.json()) as { data?: Array<{ id: string }> };
    const ids = Array.isArray(data?.data) ? data.data.map((x) => String(x.id)).filter(Boolean) : [];
    if (!ids.length) throw new Error("列表为空（可手填模型 ID）");
    return { models: ids.slice(0, 200) };
  } finally {
    clearTimeout(timer);
  }
});

// ---- 本机设置与面板（M6-C）：通用组持久化 / 个人信息 / 手动检查更新 ----
ipcMain.handle("ordo:getSettings", () => appSettings);

// ---- IM 通道（一期：钉钉/飞书长连接）：列表 / 保存并热应用 / 解绑 / 换绑定码 ----
ipcMain.handle("ordo:imList", () => imBridge!.list());
ipcMain.handle("ordo:imSave", (_e, id: unknown, patch: unknown) =>
  imBridge!.save(String(id), (patch ?? {}) as { enabled?: boolean; clientId?: string; secret?: string; autoApprove?: boolean; boundUser?: string })
);
ipcMain.handle("ordo:imUnbind", (_e, id: unknown) => imBridge!.unbind(String(id)));
ipcMain.handle("ordo:imNewBindCode", (_e, id: unknown) => imBridge!.newBindCode(String(id)));

// 存储目录覆盖校验：绝对路径 + 建目录 + 可写探测；空串 = 清除覆盖（回默认位置）
async function resolveDataDirOverride(raw: string, label: string): Promise<string> {
  const s = String(raw ?? "").trim();
  if (!s) return "";
  if (!path.isAbsolute(s)) throw new Error(`${label}需为绝对路径（如 D:\\Ordo\\workspace）`);
  await fsp.mkdir(s, { recursive: true });
  const probe = path.join(s, `.ordo-write-test-${Date.now()}`);
  await fsp.writeFile(probe, "ok");
  await fsp.rm(probe, { force: true });
  return s;
}

ipcMain.handle("ordo:setSettings", async (_e, patch: unknown) => {
  const p = (patch ?? {}) as Partial<AppSettings>;
  let dirChanged = "";
  const dirPatch: Partial<AppSettings> = {};
  if (typeof p.workspaceDir === "string") {
    dirPatch.workspaceDir = await resolveDataDirOverride(p.workspaceDir, "工作区目录");
    dirChanged = "工作区目录";
  }
  if (typeof p.ragDir === "string") {
    dirPatch.ragDir = await resolveDataDirOverride(p.ragDir, "个人知识库目录");
    dirChanged = "个人知识库目录";
  }
  if (dirChanged) auditRef?.append({ event: "data_dir_change", target: dirChanged, workspaceDir: dirPatch.workspaceDir ?? "", ragDir: dirPatch.ragDir ?? "" });
  appSettings = await settingsStore!.apply({
    ...(typeof p.autoStart === "boolean" ? { autoStart: p.autoStart } : {}),
    ...(typeof p.desktopNotify === "boolean" ? { desktopNotify: p.desktopNotify } : {}),
    ...(typeof p.restoreLastSession === "boolean" ? { restoreLastSession: p.restoreLastSession } : {}),
    ...(p.confirmMode !== undefined ? { confirmMode: normalizeConfirmMode(p.confirmMode) } : {}),
    ...dirPatch,
  });
  if (!SELFTEST) {
    try {
      app.setLoginItemSettings({ openAtLogin: appSettings.autoStart, args: ["--hidden"] });
    } catch {
      /* 无注册权限环境忽略 */
    }
  }
  return appSettings;
});
ipcMain.handle("ordo:getProfile", () => ({
  ...authState(),
  version: app.getVersion(),
  workspaceRoot: workspace?.root ?? "",
  dataDir: workspace?.dirs.home ?? "",
}));
ipcMain.handle("ordo:checkUpdate", async () => {
  if (!ADMIN_BASE || !adminToken()) return { status: "standalone" as const, version: app.getVersion() };
  const status = await checkClientUpdate(ADMIN_BASE, win).catch(() => "failed" as const);
  return { status, version: app.getVersion() };
});

// 记忆系统配置
ipcMain.handle("ordo:getMemoryConfig", () => {
  if (!host) throw new Error("Host not initialized");
  return host.getMemoryConfig();
});

ipcMain.handle("ordo:setMemoryConfig", async (_e, config: unknown) => {
  if (!host) throw new Error("Host not initialized");
  await host.setMemoryConfig(config as any);
  return true;
});

ipcMain.handle("ordo:testMemorySummaryModel", async (_e, config: unknown) => {
  if (!host) throw new Error("Host not initialized");
  return await host.testMemorySummaryModel(config as any);
});

ipcMain.handle("ordo:testMemoryEmbeddingModel", async (_e, config: unknown) => {
  if (!host) throw new Error("Host not initialized");
  return await host.testMemoryEmbeddingModel(config as any);
});

// 插件包（M5）：目录 + 已装状态；安装/卸载（无管理端时空目录）
ipcMain.handle("ordo:pluginPacks", async () => ({
  catalog: pluginPacks ? await pluginPacks.catalog() : [],
  installed: pluginPacks ? await pluginPacks.listInstalled() : {},
  // 内置组件（面板「内置」区）：静态恒显，单机/联机/未配置三态一致；版本随客户端发版
  builtin: [
    {
      name: "officecli",
      title: "Office 引擎",
      version: officeBuiltinVersion(),
      note: "OfficeCLI：随安装包内置，开箱即用；docx/xlsx/pptx 生成、编辑与保真预览的底层引擎，随客户端发版更新",
    },
  ],
}));
ipcMain.handle("ordo:pluginPackInstall", (_e, name: string) => pluginPacks!.install(String(name)));
ipcMain.handle("ordo:pluginPackUninstall", (_e, name: string) => pluginPacks!.uninstall(String(name)));
  ipcMain.handle("ordo:syncSkills", () => skillMarket!.syncNow());

  // ---- 契约扩展：模型切换（PRD 3.4）----
  ipcMain.handle("ordo:listModels", () => host!.listModels());
  ipcMain.handle("ordo:switchModel", (_e, id: unknown) => host!.switchModel(String(id)));

  // ---- 契约扩展：MCP 连接器（PRD 4.4：目录 / 市场启停 / 会话挂载）----
  ipcMain.handle("ordo:listConnectors", () => host!.listConnectorsRich());
  ipcMain.handle("ordo:addPersonalConnector", async (_e, input: unknown) => {
    const r = await personalMcp!.add((input ?? {}) as { displayName: string; endpoint: string; headersJson?: string });
    return { ...r, rows: await host!.listConnectorsRich() };
  });
  ipcMain.handle("ordo:removePersonalConnector", async (_e, id: string) => {
    await personalMcp!.remove(String(id));
    return true;
  });
  ipcMain.handle("ordo:setActiveConnectors", (_e, names: unknown) =>
    host!.setActiveConnectors(Array.isArray(names) ? names.map(String) : [])
  );

  // ---- 契约扩展：知识库（PRD 4.5：企业库目录/挂载 + 个人库建删/传文档/挂载）----
  ipcMain.handle("ordo:listKnowledgeBases", () => host!.listKnowledgeBasesRich());
  ipcMain.handle("ordo:setActiveKnowledgeBases", (_e, ids: unknown) =>
    host!.setActiveKnowledgeBases(Array.isArray(ids) ? ids.map(String) : [])
  );
  ipcMain.handle("ordo:createKb", (_e, name: unknown) => personalKb!.create(String(name ?? "")));
  ipcMain.handle("ordo:deleteKb", (_e, id: unknown) => personalKb!.remove(String(id ?? "")));
  ipcMain.handle("ordo:listKbDocs", (_e, id: unknown) => personalKb!.listDocs(String(id ?? "")));
  ipcMain.handle("ordo:addKbDocs", (_e, id: unknown, paths: unknown) =>
    personalKb!.addDocs(String(id ?? ""), Array.isArray(paths) ? paths.map(String) : [])
  );
  ipcMain.handle("ordo:removeKbDoc", (_e, id: unknown, doc: unknown) =>
    personalKb!.removeDoc(String(id ?? ""), String(doc ?? ""))
  );
  // 原生多选文件选择器（个人库上传：一期文本格式，Office/扫描件解析走 sidecar 二期）
  ipcMain.handle("ordo:pickKbFiles", async () => {
    if (SELFTEST) return null;
    const r = await dialog.showOpenDialog(win!, {
      properties: ["openFile", "multiSelections"],
      title: "选择要入库的文档（一期支持文本格式）",
      filters: [{ name: "文本文档", extensions: ["md", "txt", "csv", "json", "log", "html", "xml", "yaml", "yml"] }],
    });
    return r.canceled ? null : r.filePaths;
  });

  // ---- 契约扩展：自动化（PRD 3.7 本地型：用户自建、客户端定时器、管理端不调度；服务端交互型不在客户端展示）----
  ipcMain.handle("ordo:listAutomations", async () => {
    const experts = host!.listExperts();
    const l2 = await host!.l2ToolCatalog();
    return automations!.list().map((t) => ({
      ...t,
      expertName: experts.find((e) => e.id === t.expertId)?.name ?? t.expertId,
      wsName: workspace!.registry.byId(t.wsId)?.label ?? t.wsId,
      preAuthLabels: t.preAuth.map((p) => l2.find((x) => x.id === p)?.label ?? p),
    }));
  });
  // 无人值守可预授权的敏感操作目录（创建/编辑弹窗勾选项）
  ipcMain.handle("ordo:automationCatalog", () => host!.l2ToolCatalog());
  ipcMain.handle("ordo:createAutomation", (_e, input: unknown) => automations!.create(input as any));
  ipcMain.handle("ordo:updateAutomation", (_e, id: unknown, patch: unknown) =>
    automations!.update(String(id ?? ""), patch as any)
  );
  ipcMain.handle("ordo:deleteAutomation", (_e, id: unknown) => automations!.remove(String(id ?? "")));
  ipcMain.handle("ordo:runAutomation", (_e, id: unknown) => automations!.runNow(String(id ?? ""), "manual"));
  ipcMain.handle("ordo:automationRuns", (_e, id: unknown) => automations!.runsOf(String(id ?? "")));

  // ---- 契约扩展：常用任务模板（/ 命令）----
  ipcMain.handle("ordo:listTemplates", () => templates!.list());
  ipcMain.handle("ordo:createTemplate", (_e, input: unknown) => templates!.create(input as any));
  ipcMain.handle("ordo:updateTemplate", (_e, id: unknown, patch: unknown) =>
    templates!.update(String(id ?? ""), patch as any)
  );
  ipcMain.handle("ordo:deleteTemplate", (_e, id: unknown) => templates!.remove(String(id ?? "")));

  // ---- 契约扩展：回收站（统计 / 手动清空；保留期清理在启动时自动执行）----
  ipcMain.handle("ordo:recycleStats", () => recycle!.stats());
  ipcMain.handle("ordo:clearRecycle", () => recycle!.clear());

  win.webContents.on("did-finish-load", () => {
    if (SELFTEST) {
      void runSelftest();
    } else {
      // 交互模式：启动时自动恢复最近会话（PRD 3.3 续接；可在设置-通用关闭）
      if (appSettings?.restoreLastSession === false) return;
      host!
        .loadLatestSession()
        .then((s) => {
          if (s) {
            emit({ type: "session_loaded", id: s.id, title: s.title, expert: s.expert, messages: s.messages });
          }
        })
        .catch(() => {});
    }
  });
});

app.on("window-all-closed", () => {
  skillMarket?.dispose();
  automations?.dispose();
  localMcp?.stopAll();
  // pi 会话仓库收尾（释放打开的 session 句柄与写入 claim）
  void sessions?.close().catch(() => {});
  // 退出竞态兜底：拆掉浏览器桥钩子、关掉 pty，销毁后的残留事件一律静默（sendUi 已判销毁）
  try {
    browserBridge?.stop();
  } catch {}
  try {
    terminalHost?.close();
  } catch {}
  app.quit();
});
