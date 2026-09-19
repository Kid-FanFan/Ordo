// 浏览器桥 A（方案 §5，D1）：页面以 <webview> 内嵌在预览面板标签中（用户可旁观、单一界面），
// 主进程持有 WebContents 引用执行能力面：executeJavaScript（提取/快照）、sendInputEvent（点击/输入）、capturePage（截图存证）。
// 安全：URL 白名单（预留管理端下发）、跨源 will-navigate 拦截、全程审计、急停重置批准源。
import { BrowserWindow, webContents } from "electron";
import * as path from "node:path";
import * as fs from "node:fs";
import type { Audit } from "./audit";

export interface ConsoleEntry {
  seq: number;
  kind: "log" | "warn" | "error" | "pageerror";
  text: string;
  at: string;
}
export interface BridgeState {
  open: boolean; // 已有附着页面（webview 存活）
  url: string;
  origin: string;
  consoleCount: number;
  lastScreenshot: string;
}

const RING_MAX = 200;
const ALLOWED_SCHEMES = new Set(["http:", "https:", "data:"]);

export function safeUrl(raw: string): URL {
  let s = String(raw).trim();
  // 无协议头默认补 https：用户输 www.baidu.com 这类裸域名也应能开
  if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(s)) s = `https://${s}`;
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    throw new Error(`网址无效：${s}`);
  }
  if (!ALLOWED_SCHEMES.has(u.protocol)) throw new Error(`不允许的协议：${u.protocol}（仅 http/https/data）`);
  return u;
}
function originOf(u: URL): string {
  return u.protocol === "data:" ? "data:" : `${u.protocol}//${u.host}`;
}

export class BrowserBridge {
  private wc: Electron.WebContents | null = null;
  private approvedOrigin = "";
  private currentUrl = "";
  private ring: ConsoleEntry[] = [];
  private seq = 0;
  private lastScreenshot = "";

  constructor(
    private opts: {
      audit: Audit;
      /** 预留：管理端下发的 URL 白名单（host），空数组 = 不限制 */
      whitelist: string[];
      onEvent: (ev: Record<string, unknown>) => void;
    }
  ) {}

  /** 管理端平台配置热更时替换白名单（open() 每次现读 opts） */
  setWhitelist(list: string[]): void {
    this.opts.whitelist = list;
  }

  get state(): BridgeState {
    return {
      open: !!(this.wc && !this.wc.isDestroyed()),
      url: this.currentUrl,
      origin: this.approvedOrigin,
      consoleCount: this.ring.length,
      lastScreenshot: this.lastScreenshot,
    };
  }

  /** 已批准过某源 → 同源后续导航免二次确认（browser_open 动态降 L1 的依据） */
  get sameOriginNext(): boolean {
    return this.approvedOrigin !== "";
  }

  private pushConsole(kind: ConsoleEntry["kind"], text: string) {
    this.ring.push({ seq: ++this.seq, kind, text: String(text).slice(0, 500), at: new Date().toISOString() });
    if (this.ring.length > RING_MAX) this.ring.shift();
    this.opts.onEvent({ type: "browser_console_append" });
  }

  /**
   * 打开 URL：记录批准源与审计，向渲染端发 browser_navigate（由面板里的 webview 实际加载）。
   * source="agent" 的调用发生在 L2 确认之后（agent-host beforeToolCall）；
   * source="user" 为面板 ＋ 菜单显式输入（用户即确认主体，不重复弹卡）。
   */
  open(rawUrl: string, source: "agent" | "user" = "agent"): string {
    const u = safeUrl(rawUrl);
    if (this.opts.whitelist.length && u.host && !this.opts.whitelist.includes(u.host)) {
      throw new Error(`目标不在浏览器白名单内：${u.host}`);
    }
    const origin = originOf(u);
    const sameOrigin = this.approvedOrigin !== "" && origin === this.approvedOrigin;
    this.approvedOrigin = origin;
    this.currentUrl = u.href;
    this.opts.audit.append({ event: "browser_open", url: u.href, origin, sameOrigin, source });
    this.opts.onEvent({ type: "browser_navigate", url: u.href });
    this.opts.onEvent({ type: "browser_state_changed" });
    return `已请求打开 ${u.href}${sameOrigin ? "（同源导航，免确认）" : ""}`;
  }

  /** 渲染端 webview dom-ready 后附着：挂控制台/跳脱守卫（页面容器随标签创建销毁，可能多次附着） */
  attach(webContentsId: number): void {
    const wc = webContents.fromId(Number(webContentsId));
    if (!wc || wc.isDestroyed()) throw new Error("无效的 webContents");
    this.detach();
    this.wc = wc;
    wc.on("console-message", (e: any) => {
      const level = Number(e.level ?? 0);
      const msg = String(e.message ?? "");
      // 引擎自身的安全告警不进业务控制台（对用户是噪音，也会把真实日志挤出环形尾部）
      if (msg.includes("Electron Security Warning")) return;
      this.pushConsole(level >= 2 ? "error" : level === 1 ? "warn" : "log", msg);
    });
    wc.on("will-navigate", (e: Electron.Event, target: string) => {
      let tOrigin = "";
      try {
        tOrigin = originOf(safeUrl(target));
      } catch {
        e.preventDefault();
        this.pushConsole("warn", `已拦截跳转（非法地址）：${target}`);
        this.opts.audit.append({ event: "browser_blocked", from: this.currentUrl, to: target });
        return;
      }
      if (this.approvedOrigin && tOrigin !== this.approvedOrigin) {
        e.preventDefault();
        this.pushConsole("warn", `已拦截跳转（跨源，未确认）：${target}`);
        this.opts.audit.append({ event: "browser_blocked", from: this.currentUrl, to: target });
        this.opts.onEvent({ type: "browser_state_changed" });
      }
    });
    wc.once("destroyed", () => {
      if (this.wc === wc) {
        this.wc = null;
        this.currentUrl = "";
        this.opts.onEvent({ type: "browser_state_changed" });
      }
    });
    this.opts.onEvent({ type: "browser_state_changed" });
  }

  detach(): void {
    if (this.wc && !this.wc.isDestroyed()) {
      this.wc.removeAllListeners("console-message");
      this.wc.removeAllListeners("will-navigate");
    }
    this.wc = null;
  }

  private requireWc(): Electron.WebContents {
    if (!this.wc || this.wc.isDestroyed()) throw new Error("浏览器未打开（先 browser_open）");
    return this.wc;
  }

  /** 简化 DOM 快照给模型看：深度/节点数受限的树（tag + 可见文本摘要） */
  async snapshot(): Promise<string> {
    const wc = this.requireWc();
    const tree = await wc.executeJavaScript(`(function(){
      const out = [];
      const walk = (node, depth) => {
        if (out.length > 300 || depth > 8) return;
        for (const child of node.children || []) {
          const tag = child.tagName ? child.tagName.toLowerCase() : "#text";
          if (tag === "script" || tag === "style") continue;
          const text = (child.innerText || "").trim().replace(/\\s+/g, " ").slice(0, 80);
          const attrs = {};
          if (child.id) attrs.id = child.id;
          if (child.getAttribute && child.getAttribute("aria-label")) attrs.aria = child.getAttribute("aria-label");
          out.push({ tag, text, ...attrs });
          walk(child, depth + 1);
        }
      };
      walk(document.body, 0);
      return { title: document.title, url: location.href, nodes: out.slice(0, 120) };
    })()`);
    this.opts.audit.append({ event: "browser_snapshot", url: this.currentUrl });
    return JSON.stringify(tree).slice(0, 6000);
  }

  /** 点击（选择器定位 → 元素中心 sendInputEvent） */
  async click(selector: string): Promise<string> {
    const wc = this.requireWc();
    const rect = await wc.executeJavaScript(`(function(){
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return null;
      el.scrollIntoView({ block: "center" });
      const r = el.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    })()`);
    if (!rect) throw new Error(`未找到元素：${selector}`);
    wc.sendInputEvent({ type: "mouseMove", x: rect.x, y: rect.y });
    wc.sendInputEvent({ type: "mouseDown", x: rect.x, y: rect.y, button: "left", clickCount: 1 });
    wc.sendInputEvent({ type: "mouseUp", x: rect.x, y: rect.y, button: "left", clickCount: 1 });
    this.opts.audit.append({ event: "browser_click", selector, url: this.currentUrl });
    return `已点击 ${selector}`;
  }

  /** 输入文本（先点选目标聚焦，再逐字符注入） */
  async type(selector: string, text: string): Promise<string> {
    const wc = this.requireWc();
    await this.click(selector);
    await new Promise((r) => setTimeout(r, 60));
    for (const ch of String(text)) {
      wc.sendInputEvent({ type: "char", keyCode: ch });
    }
    this.opts.audit.append({ event: "browser_type", selector, len: String(text).length, url: this.currentUrl });
    return `已向 ${selector} 输入 ${String(text).length} 字符`;
  }

  /** 数据提取：返回选择器命中元素的文本/常用属性（尺寸受限） */
  async extract(selector: string): Promise<string> {
    const wc = this.requireWc();
    const data = await wc.executeJavaScript(`(function(){
      const els = [...document.querySelectorAll(${JSON.stringify(selector)})].slice(0, 50);
      return els.map((el) => ({
        tag: el.tagName.toLowerCase(),
        text: (el.innerText || "").trim().replace(/\\s+/g, " ").slice(0, 200),
        href: el.getAttribute("href") || undefined,
        value: el.value !== undefined ? String(el.value).slice(0, 200) : undefined,
      }));
    })()`);
    this.opts.audit.append({ event: "browser_extract", selector, hits: Array.isArray(data) ? data.length : 0 });
    return JSON.stringify(data).slice(0, 6000);
  }

  /** 截图存证：存入工作区 browser-shots/，路径回传（渲染端登记为交付物）。
   *  capturePage 偶发 UnknownVizError（GPU 合成器抖动）→ 小退避重试 */
  async screenshot(wsRoot: string): Promise<string> {
    const wc = this.requireWc();
    let img: Electron.NativeImage | null = null;
    let lastErr: unknown = null;
    for (let i = 0; i < 3 && (!img || img.isEmpty()); i++) {
      try {
        img = await wc.capturePage();
      } catch (e) {
        lastErr = e;
        await new Promise((r) => setTimeout(r, 350));
      }
    }
    if (!img || img.isEmpty()) {
      throw new Error(`页面截图失败（${String((lastErr as Error | null)?.message ?? lastErr ?? "空图")}），可重试`);
    }
    const dir = path.join(wsRoot, "browser-shots");
    await fs.promises.mkdir(dir, { recursive: true });
    const rel = `browser-shots/shot-${new Date().toISOString().replace(/[:.]/g, "-")}.png`;
    await fs.promises.writeFile(path.join(wsRoot, rel), img.toPNG());
    this.lastScreenshot = rel;
    this.opts.audit.append({ event: "browser_screenshot", path: rel });
    this.opts.onEvent({ type: "artifact_added", path: rel });
    this.opts.onEvent({ type: "browser_state_changed" });
    return rel;
  }

  consoleTail(n = 30): ConsoleEntry[] {
    return this.ring.slice(-Math.max(1, Math.min(n, RING_MAX)));
  }

  /** 急停：通知渲染端销毁 webview 标签，主进程解附并重置批准源（再开需重新确认） */
  stop(): boolean {
    this.opts.audit.append({ event: "browser_stop", url: this.currentUrl });
    const had = !!this.wc || this.currentUrl !== "";
    this.detach();
    this.currentUrl = "";
    this.approvedOrigin = "";
    this.opts.onEvent({ type: "browser_stop" });
    this.opts.onEvent({ type: "browser_state_changed" });
    return had;
  }
}

// 测试辅助（selftest 用）：构造一个隐藏 BrowserWindow 作为 webview 的替身 WebContents，
// 仅用于离线验证桥的附着语义（快照/输入/控制台/拦截/截图），不参与产品运行时。
export function createTestPageWindow(url: string): BrowserWindow {
  const win = new BrowserWindow({
    width: 800,
    height: 600,
    show: false,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true },
  });
  win.removeMenu();
  void win.loadURL(url);
  return win;
}
