// IM 通道（一期：钉钉 + 飞书）：客户端直连平台长连接（WebSocket，无需公网 IP/回调地址）。
// 手机发消息/图片/文件 → 绑定校验 → 独立后台 AgentHost 会话运行（同自动化 bgHost 模式，不进前台对话流）→ 回复推回 IM。
// 确认语义（L2）：autoApprove=true 直接放行；否则发确认消息，手机回复【同意】/【拒绝】，5 分钟超时视为拒绝
// （官方 SDK 长连接不支持按钮卡片回调：飞书 node-sdk WSClient 无 cardActionHandler、HTTP 回调需公网、钉钉互动卡片需模板——关键词是免公网免配置的唯一做法）。
// 配置存 config/im-channels.json（本机个人配置，不出本机）；secret 支持 $ENV:NAME 引用不落明文。
import * as fsp from "node:fs/promises";
import * as fsSync from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DWClient, TOPIC_ROBOT } from "dingtalk-stream";
import * as lark from "@larksuiteoapi/node-sdk";
import type { Audit } from "./audit";
import type { UiEvent, ImChannelInfo } from "../shared/protocol";

/** 结构化最小 AgentHost 面积（真实 AgentHost 天然满足；自测可注入桩） */
export interface ImHostLike {
  newSession(): void;
  loadSession(id: string): Promise<unknown>;
  prompt(text: string, attachments?: Array<{ name: string; size?: number; dataBase64?: string }>): Promise<void>;
  /** 手机侧固定排队语义：当前任务自然结束后追加执行（pi followUp 队列） */
  queueFollowUp(text: string): Promise<unknown>;
  cancel(): void;
  readonly lastAssistantStop?: string;
}

export interface ImInbound {
  fromId: string;
  fromName: string;
  text: string;
  messageId?: string;
  kind?: "text" | "image" | "file";
  fileName?: string; // 文件原名（图片由下载侧推断扩展名）
  mediaKey?: string; // 飞书 image_key/file_key；钉钉 downloadCode
  robotCode?: string; // 钉钉 media/download 需要
}

/** 每条入站消息的回复上下文：文本回复 + 文件回传（不支持的通道 sendFile 抛错） */
export interface ImSendCtx {
  reply(text: string): Promise<void>;
  sendFile(absPath: string): Promise<void>;
}

export interface ImMedia {
  name: string;
  data: Buffer;
}

/** 平台适配器：长连接生命周期 + 媒体下载；自测可注入假实现 */
export interface ImAdapter {
  start(cfg: { clientId: string; secret: string }, onMessage: (m: ImInbound, ctx: ImSendCtx) => void | Promise<void>): Promise<void>;
  downloadMedia?(m: ImInbound): Promise<ImMedia>;
  stop(): void;
  isOnline(): boolean;
}

export interface ImChannelConfig {
  id: "dingtalk" | "feishu";
  enabled: boolean;
  clientId: string; // 钉钉 AppKey / 飞书 App ID
  secret: string; // 钉钉 Client Secret / 飞书 App Secret；支持 $ENV:NAME
  autoApprove: boolean; // L2 自动放行（等同自动化预授权全开）；默认 false
  boundUser?: string; // 钉钉 senderStaffId / 飞书 open_id
  boundName?: string;
  bindCode: string; // /bind 兜底绑定码（持久化：重启不变）
}

interface PendingConfirm {
  tool: string;
  resolve: (ok: boolean) => void;
  timer: NodeJS.Timeout;
}

interface ChannelRt {
  adapter: ImAdapter | null;
  host: ImHostLike | null;
  buf: string; // text_delta 累积（回复正文）
  savedId?: string; // session_saved 捕获
  sessionId?: string; // 通道绑定会话（跨消息续接）
  busy: boolean;
  seen: Set<string>; // messageId 去重环形
  lastInboundAt?: string;
  conn: ImChannelInfo["conn"];
  detail?: string;
  lastCtx?: ImSendCtx; // 当前消息的回复上下文（确认请求用）
  pending?: PendingConfirm; // 待确认的 L2 操作（同时最多一个：通道串行）
}

const RUN_TIMEOUT_MS = 480_000; // 手机侧等待上限：8 分钟无进展即中止并回复
const CONFIRM_TIMEOUT_MS = 300_000; // L2 确认等待：5 分钟未回复视为拒绝
const CHUNK_MAX = 1800; // 回复分段长度（IM 气泡可读性）
const CHUNKS_MAX = 6;
const MEDIA_MAX = 20 * 1024 * 1024; // 手机发来的媒体上限（20MB，与附件链路一致）
const SEND_MAX = 30 * 1024 * 1024; // /get 回传上限（飞书文件接口 30MB）

const LABELS: Record<ImChannelConfig["id"], string> = { dingtalk: "钉钉", feishu: "飞书" };

export function resolveSecret(s: string): string {
  return s.startsWith("$ENV:") ? (process.env[s.slice(5)] ?? "") : s;
}

function newBindCode(): string {
  return String(Math.floor(100000 + Math.random() * 900000));
}

/** 是否含 markdown 语法（agent 输出默认 markdown）：有 → 走平台的 markdown 渲染通道；无 → 纯文本更轻量 */
export function looksLikeMd(text: string): boolean {
  return /(^|\n)\s*(#{1,6}\s|[-*]\s|\d+\.\s|>\s)|\*\*|`|\[[^\]]+\]\([^)]+\)/.test(text);
}

/** 回复正文分段：超长内容切条，超出上限截断并提示去电脑端看完整会话 */
export function chunkReply(text: string): string[] {
  const t = String(text ?? "").trim() || "（本轮无文本输出）";
  if (t.length <= CHUNK_MAX) return [t];
  const out: string[] = [];
  for (let i = 0; i < t.length && out.length < CHUNKS_MAX; i += CHUNK_MAX) out.push(t.slice(i, i + CHUNK_MAX));
  if (t.length > CHUNK_MAX * CHUNKS_MAX) out.push("…（内容过长已截断，完整结果请在电脑端 Ordo 会话中查看）");
  return out;
}

function isImageName(name: string): boolean {
  return /\.(png|jpe?g|gif|webp|bmp|ico)$/i.test(name);
}

/** SDK 二进制响应 → Buffer（兼容 Buffer/ArrayBuffer/string 兜底） */
function toBuffer(data: unknown): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  if (typeof data === "string") return Buffer.from(data, "utf-8");
  throw new Error("未知的媒体响应格式");
}

function mdSendPayload(text: string): Record<string, unknown> {
  const isMd = looksLikeMd(text);
  if (!isMd) return { msgtype: "text", text: { content: text } };
  const first = text.split("\n").find((l) => l.trim()) ?? "";
  const title =
    first
      .replace(/[#*`>\-[\]()!]/g, "")
      .trim()
      .slice(0, 20) || "Ordo";
  return { msgtype: "markdown", markdown: { title, text } };
}

// ---------- 平台适配器（官方 SDK） ----------

/** 钉钉 Stream 模式：机器人消息经长连接推送；回复走 sessionWebhook；媒体经 media/download 换临时链接下载 */
export class DingtalkAdapter implements ImAdapter {
  private client: DWClient | null = null;
  private token?: { value: string; expireAt: number };

  async start(cfg: { clientId: string; secret: string }, onMessage: (m: ImInbound, ctx: ImSendCtx) => void | Promise<void>): Promise<void> {
    const client = new DWClient({ clientId: cfg.clientId, clientSecret: cfg.secret, keepAlive: true });
    this.client = client;
    client.registerCallbackListener(TOPIC_ROBOT, (msg) => {
      let body: any = {};
      try {
        body = JSON.parse(msg.data);
      } catch {
        /* 非 JSON 忽略 */
      }
      // 先应答防服务端 60s 重推，再慢慢处理
      try {
        client.socketCallBackResponse(msg.headers.messageId, { status: "SUCCESS" });
      } catch {
        /* 应答失败靠去重兜底 */
      }
      const webhook: string = body?.sessionWebhook ?? "";
      const ctx: ImSendCtx = {
        reply: async (text) => {
          await this.webhookReply(webhook, text);
        },
        sendFile: async () => {
          throw new Error("钉钉机器人不支持发送文件，请在电脑端 Ordo 查看");
        },
      };
      const base = {
        fromId: String(body?.senderStaffId || body?.senderId || ""),
        fromName: String(body?.senderNick || ""),
        messageId: body?.msgId ? String(body.msgId) : undefined,
        robotCode: body?.robotCode ? String(body.robotCode) : undefined,
      };
      let m: ImInbound | null = null;
      if (body?.msgtype === "text" && typeof body.text?.content === "string" && body.text.content.trim()) {
        m = { ...base, kind: "text", text: String(body.text.content) };
      } else if (body?.msgtype === "picture" && body?.content?.downloadCode) {
        m = { ...base, kind: "image", text: "", mediaKey: String(body.content.downloadCode) };
      } else if (body?.msgtype === "file" && body?.content?.downloadCode) {
        m = { ...base, kind: "file", text: "", mediaKey: String(body.content.downloadCode), fileName: String(body.content.fileName || body.content.filename || "") || undefined };
      }
      if (m) void Promise.resolve(onMessage(m, ctx)).catch(() => {});
    });
    await client.connect(); // 内部吞错并自动重连；connected 反映本次结果
    if (!client.connected) throw new Error("钉钉长连接暂未建立（凭证可能有误），SDK 将自动重试");
  }

  private async accessToken(clientId: string, secret: string): Promise<string> {
    if (this.token && this.token.expireAt > Date.now() + 60_000) return this.token.value;
    const res = await fetch("https://api.dingtalk.com/v1.0/oauth2/accessToken", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ appKey: clientId, appSecret: secret }) });
    const j = (await res.json().catch(() => ({}))) as { accessToken?: string; expireIn?: number };
    if (!j.accessToken) throw new Error(`钉钉获取 accessToken 失败：HTTP ${res.status}`);
    this.token = { value: j.accessToken, expireAt: Date.now() + (j.expireIn ?? 7200) * 1000 };
    return this.token.value;
  }

  private async webhookReply(webhook: string, text: string): Promise<void> {
    if (!webhook) throw new Error("缺少 sessionWebhook，无法回复");
    const res = await fetch(webhook, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(mdSendPayload(text)) });
    const j = (await res.json().catch(() => ({}))) as { errcode?: number; errmsg?: string };
    if (!res.ok || (j.errcode ?? 0) !== 0) throw new Error(`钉钉回复失败：${j.errmsg ?? res.status}`);
  }

  async downloadMedia(m: ImInbound): Promise<ImMedia> {
    if (!this.client || !m.mediaKey) throw new Error("缺少下载凭证");
    const cfg = this.client.getConfig();
    const token = await this.accessToken(cfg.clientId, cfg.clientSecret);
    const res = await fetch("https://api.dingtalk.com/v1.0/im/bot/media/download", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-acs-dingtalk-access-token": token },
      body: JSON.stringify({ downloadCode: m.mediaKey, robotCode: m.robotCode }),
    });
    const j = (await res.json().catch(() => ({}))) as { downloadUrl?: string };
    if (!j.downloadUrl) throw new Error(`钉钉媒体下载失败：HTTP ${res.status}`);
    const bin = await fetch(j.downloadUrl);
    if (!bin.ok) throw new Error(`钉钉媒体下载失败：HTTP ${bin.status}`);
    const name = m.fileName || `${m.kind === "image" ? "image" : "file"}-${Date.now()}${m.kind === "image" ? ".png" : ""}`;
    return { name, data: toBuffer(await bin.arrayBuffer()) };
  }

  stop(): void {
    try {
      this.client?.disconnect();
    } catch {
      /* 已断开 */
    }
    this.client = null;
    this.token = undefined;
  }

  isOnline(): boolean {
    return !!this.client?.connected;
  }
}

/** 飞书长连接：WSClient 事件订阅接收消息；回复走 IM API（文本/markdown 卡片/图片/文件） */
export class FeishuAdapter implements ImAdapter {
  private ws: lark.WSClient | null = null;
  private client: lark.Client | null = null;
  private chatIds = new Map<string, string>(); // messageId → chatId（下载媒体无关，回复走 ctx 闭包）

  async start(cfg: { clientId: string; secret: string }, onMessage: (m: ImInbound, ctx: ImSendCtx) => void | Promise<void>): Promise<void> {
    this.client = new lark.Client({ appId: cfg.clientId, appSecret: cfg.secret, appType: lark.AppType.SelfBuild, domain: lark.Domain.Feishu, loggerLevel: lark.LoggerLevel.warn });
    const dispatcher = new lark.EventDispatcher({ loggerLevel: lark.LoggerLevel.warn }).register({
      "im.message.receive_v1": async (data) => {
        try {
          const m = (data as any).message ?? {};
          const sender = (data as any).sender ?? {};
          if (sender.sender_type && sender.sender_type !== "user") return; // 忽略其他机器人
          const chatId = String(m.chat_id ?? "");
          const ctx: ImSendCtx = {
            reply: async (text) => {
              await this.reply(chatId, text);
            },
            sendFile: async (absPath) => {
              await this.sendFile(chatId, absPath);
            },
          };
          let inbound: ImInbound | null = null;
          if (m.message_type === "text") {
            let text = "";
            try {
              text = String(JSON.parse(m.content)?.text ?? "");
            } catch {
              /* 非 JSON 忽略 */
            }
            if (text.trim()) inbound = { fromId: String(sender.sender_id?.open_id ?? ""), fromName: "", text, messageId: String(m.message_id ?? ""), kind: "text" };
          } else if (m.message_type === "image" || m.message_type === "file") {
            let fileName: string | undefined;
            let mediaKey = "";
            try {
              const c = JSON.parse(m.content);
              mediaKey = String(m.message_type === "image" ? c?.image_key : c?.file_key ?? "");
              fileName = m.message_type === "file" ? String(c?.file_name ?? "") || undefined : undefined;
            } catch {
              /* 非 JSON 忽略 */
            }
            if (mediaKey) inbound = { fromId: String(sender.sender_id?.open_id ?? ""), fromName: "", text: "", messageId: String(m.message_id ?? ""), kind: m.message_type, fileName, mediaKey };
          }
          if (inbound) await onMessage(inbound, ctx);
        } catch {
          // 事件回调不抛出（抛错只进 SDK 日志；业务失败已在 reply/run 内自行兜底）
        }
      },
    });
    this.ws = new lark.WSClient({
      appId: cfg.clientId,
      appSecret: cfg.secret,
      domain: lark.Domain.Feishu,
      loggerLevel: lark.LoggerLevel.warn,
      autoReconnect: true,
      onReady: () => undefined,
      onError: () => undefined,
    });
    await this.ws.start({ eventDispatcher: dispatcher });
    // start() 返回后轮询等首次握手（onReady 时机不定）：最多 10s
    for (let i = 0; i < 20 && !this.isOnline(); i++) await new Promise((r) => setTimeout(r, 500));
    if (!this.isOnline()) throw new Error("飞书长连接暂未建立（凭证/权限可能有误），SDK 将自动重试");
  }

  private async sendRaw(chatId: string, msgType: string, content: unknown): Promise<void> {
    if (!this.client || !chatId) throw new Error("飞书回复通道不可用");
    const res = (await this.client.im.message.create({
      params: { receive_id_type: "chat_id" },
      data: { receive_id: chatId, content: JSON.stringify(content), msg_type: msgType },
    })) as unknown as { code?: number; msg?: string };
    if (res && typeof res.code === "number" && res.code !== 0) throw new Error(`飞书回复失败：${res.msg ?? res.code}`);
  }

  private async reply(chatId: string, text: string): Promise<void> {
    // text 类型是纯文本；带 markdown 语法的回复走 interactive 消息卡片（markdown 组件渲染粗体/列表/代码等）
    if (looksLikeMd(text)) await this.sendRaw(chatId, "interactive", { config: { wide_screen_mode: true }, elements: [{ tag: "markdown", content: text }] });
    else await this.sendRaw(chatId, "text", { text });
  }

  private async sendFile(chatId: string, absPath: string): Promise<void> {
    if (!this.client) throw new Error("飞书回复通道不可用");
    const st = await fsp.stat(absPath).catch(() => null);
    if (!st || !st.isFile()) throw new Error("文件不存在");
    const name = path.basename(absPath);
    if (st.size > SEND_MAX) throw new Error(`文件超过 30MB（${Math.round(st.size / 1048576)}MB），无法回传`);
    if (isImageName(name) && st.size <= 10 * 1024 * 1024) {
      const up = (await this.client.im.image.create({ data: { image_type: "message", image: fsSync.createReadStream(absPath) } })) as unknown as { image_key?: string } | null;
      if (!up?.image_key) throw new Error("飞书图片上传失败");
      await this.sendRaw(chatId, "image", { image_key: up.image_key });
      return;
    }
    const ext = (name.split(".").pop() ?? "").toLowerCase();
    const fileType = (["pdf", "doc", "xls", "ppt", "mp4", "opus"].includes(ext) ? ext : "stream") as "pdf" | "doc" | "xls" | "ppt" | "mp4" | "opus" | "stream";
    const up = (await this.client.im.file.create({ data: { file_type: fileType, file_name: name, file: fsSync.createReadStream(absPath) } })) as unknown as { file_key?: string } | null;
    if (!up?.file_key) throw new Error("飞书文件上传失败");
    await this.sendRaw(chatId, "file", { file_key: up.file_key });
  }

  async downloadMedia(m: ImInbound): Promise<ImMedia> {
    if (!this.client || !m.messageId || !m.mediaKey) throw new Error("缺少下载凭证");
    const res = await this.client.im.messageResource.get({ path: { message_id: m.messageId, file_key: m.mediaKey }, params: { type: m.kind === "image" ? "image" : "file" } });
    const tmp = path.join(os.tmpdir(), `ordo-im-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await res.writeFile(tmp);
    const data = await fsp.readFile(tmp);
    await fsp.rm(tmp, { force: true });
    const name = m.fileName || `${m.kind}-${Date.now()}${m.kind === "image" ? ".png" : ""}`;
    return { name, data };
  }

  stop(): void {
    try {
      this.ws?.close({ force: true });
    } catch {
      /* 已关闭 */
    }
    this.ws = null;
    this.client = null;
    this.chatIds.clear();
  }

  isOnline(): boolean {
    return this.ws?.getConnectionStatus().state === "connected";
  }
}

function defaultAdapter(id: ImChannelConfig["id"]): ImAdapter {
  return id === "dingtalk" ? new DingtalkAdapter() : new FeishuAdapter();
}

// ---------- 桥主体 ----------

export class ImBridge {
  private channels = new Map<ImChannelConfig["id"], ImChannelConfig>();
  private rt = new Map<ImChannelConfig["id"], ChannelRt>();
  private testAdapters = new Map<string, ImAdapter>();
  private pollTimer?: NodeJS.Timeout;

  constructor(
    private opts: {
      file: string;
      audit: Audit;
      emit: (ev: UiEvent) => void;
      /** IM 会话锚定的默认工作区根（/get 文件围栏用；每次现读以跟随目录覆盖） */
      resolveImRoot: () => string;
      createHost: (channelId: ImChannelConfig["id"], hooks: { emit: (ev: UiEvent) => void; confirm: (req: { tool: string; args: Record<string, unknown> }) => Promise<boolean> }) => Promise<ImHostLike>;
    }
  ) {}

  private ids(): ImChannelConfig["id"][] {
    return ["dingtalk", "feishu"];
  }

  private async load(): Promise<void> {
    if (this.channels.size) return;
    let saved: ImChannelConfig[] = [];
    try {
      const parsed = JSON.parse(await fsp.readFile(this.opts.file, "utf-8")) as ImChannelConfig[];
      if (Array.isArray(parsed)) saved = parsed;
    } catch {
      /* 首次无文件 */
    }
    for (const id of this.ids()) {
      const s = saved.find((c) => c.id === id);
      this.channels.set(id, {
        id,
        enabled: s?.enabled === true,
        clientId: String(s?.clientId ?? ""),
        secret: String(s?.secret ?? ""),
        autoApprove: s?.autoApprove === true,
        boundUser: s?.boundUser || undefined,
        boundName: s?.boundName || undefined,
        bindCode: /^\d{6}$/.test(String(s?.bindCode ?? "")) ? String(s?.bindCode) : newBindCode(),
      });
      this.rt.set(id, { adapter: null, host: null, buf: "", busy: false, seen: new Set(), conn: "off" });
    }
  }

  private async persist(): Promise<void> {
    await fsp.mkdir(path.dirname(this.opts.file), { recursive: true });
    await fsp.writeFile(this.opts.file, JSON.stringify([...this.channels.values()], null, 2), "utf-8");
  }

  private ch(id: string): ImChannelConfig {
    const c = this.channels.get(id as ImChannelConfig["id"]);
    if (!c) throw new Error(`未知 IM 通道：${id}`);
    return c;
  }

  private r(id: string): ChannelRt {
    const r = this.rt.get(id as ImChannelConfig["id"]);
    if (!r) throw new Error(`未知 IM 通道运行时：${id}`);
    return r;
  }

  /** 状态快照（IPC / 事件推送共用） */
  private infoList(): ImChannelInfo[] {
    return this.ids().map((id) => {
      const c = this.channels.get(id)!;
      const r = this.rt.get(id)!;
      return {
        id,
        label: LABELS[id],
        enabled: c.enabled,
        configured: !!(c.clientId && c.secret),
        hasSecret: !!c.secret,
        clientId: c.clientId,
        secretValue: c.secret || undefined, // 本机设置的回显（渲染端密码态 + 眼睛切换；不上报、不出本机）
        autoApprove: c.autoApprove,
        boundUser: c.boundUser,
        boundName: c.boundName,
        bindCode: c.bindCode,
        conn: r.conn,
        detail: r.detail,
        lastInboundAt: r.lastInboundAt,
        sessionId: r.sessionId,
      };
    });
  }

  private pushState(id: ImChannelConfig["id"], touchedSessionId?: string): void {
    this.opts.emit({ type: "im_channels", channels: this.infoList(), ...(touchedSessionId ? { touchedSessionId } : {}) });
  }

  /** 启动时自连已启用通道；并开启状态轮询（SDK 自动重连后状态跟着翻绿） */
  async apply(): Promise<void> {
    await this.load();
    if (!this.pollTimer) {
      this.pollTimer = setInterval(() => {
        for (const id of this.ids()) {
          const r = this.rt.get(id)!;
          if (!r.adapter) continue;
          const next: ImChannelInfo["conn"] = r.adapter.isOnline() ? "online" : r.conn === "connecting" ? "connecting" : "error";
          if (next !== r.conn && !(next === "connecting" && r.conn === "online")) {
            r.conn = next;
            if (next === "online") r.detail = undefined;
            this.pushState(id);
          }
        }
      }, 15_000);
      this.pollTimer.unref?.();
    }
    for (const id of this.ids()) await this.applyChannel(id);
  }

  /** 应用单通道：先停旧连接；enabled 且凭证齐 → 连接（异步置态，不阻塞 IPC） */
  private async applyChannel(id: ImChannelConfig["id"]): Promise<void> {
    const c = this.ch(id);
    const r = this.r(id);
    if (r.adapter) {
      const old = r.adapter;
      r.adapter = null;
      old.stop();
    }
    r.conn = "off";
    r.detail = undefined;
    if (!c.enabled) {
      this.pushState(id);
      return;
    }
    if (!c.clientId || !resolveSecret(c.secret)) {
      r.conn = "error";
      r.detail = "已启用但凭证不全：请补全 ID 与 Secret";
      this.pushState(id);
      return;
    }
    r.conn = "connecting";
    this.pushState(id);
    const adapter = this.testAdapters.get(id) ?? defaultAdapter(id);
    try {
      await adapter.start({ clientId: c.clientId, secret: resolveSecret(c.secret) }, (m, ctx) => this.handleInbound(id, m, ctx));
      r.adapter = adapter;
      r.conn = "online";
      r.detail = undefined;
      this.opts.audit.append({ event: "im_channel_online", channel: id });
    } catch (e) {
      r.conn = "error";
      r.detail = String((e as Error)?.message ?? e).slice(0, 200);
      this.opts.audit.append({ event: "im_channel_error", channel: id, error: r.detail });
    }
    this.pushState(id);
  }

  // ---------- 入站主链路：去重 → 绑定/白名单 → 确认关键词 → 任务/媒体 ----------

  private static YES_RE = /^(同意|允许|确认|好|可以|y|yes|ok)[。.!！]?$/i;
  private static NO_RE = /^(拒绝|否|不同意|取消|不行|n|no)[。.!！]?$/i;

  private async handleInbound(id: ImChannelConfig["id"], m: ImInbound, ctx: ImSendCtx): Promise<void> {
    const c = this.ch(id);
    const r = this.r(id);
    if (m.messageId) {
      if (r.seen.has(m.messageId)) return;
      r.seen.add(m.messageId);
      if (r.seen.size > 400) {
        const first = r.seen.values().next().value;
        if (first) r.seen.delete(first);
      }
    }
    const text = m.text.replace(/^@\S+\s*/, "").trim(); // 群聊 @机器人 前缀清理
    this.opts.audit.append({ event: "im_message_in", channel: id, from: m.fromId, chars: text.length, kind: m.kind ?? "text" });
    r.lastInboundAt = new Date().toISOString();
    r.lastCtx = ctx;
    try {
      // 绑定/白名单（媒体消息同样受控）
      if (!c.boundUser) {
        const bm = /^\/?bind\s*(\d{6})$/i.exec(text);
        if (bm && bm[1] === c.bindCode) {
          c.boundUser = m.fromId;
          c.boundName = m.fromName || `${m.fromId.slice(-6)}`;
          await this.persist();
          this.opts.audit.append({ event: "im_bind", channel: id, user: m.fromId });
          await ctx.reply("✅ 绑定成功。直接发消息即可下达任务（客户端需保持运行）；发送 /help 查看用法");
          this.pushState(id);
        } else {
          await ctx.reply(`本机器人尚未绑定用户。你的用户 ID：${m.fromId}\n在电脑端 Ordo「设置 → IM 通道」的「用户 ID」填入并保存即可完成绑定（也可回复 /bind 绑定码）`);
        }
        return;
      }
      if (m.fromId !== c.boundUser) {
        this.opts.audit.append({ event: "im_auth_denied", channel: id, from: m.fromId });
        await ctx.reply("该机器人已绑定其他用户，无法为你操作");
        return;
      }
      const cmd = text.toLowerCase();
      if (cmd === "/unbind" || cmd === "解绑") {
        c.boundUser = undefined;
        c.boundName = undefined;
        await this.persist();
        this.opts.audit.append({ event: "im_unbind", channel: id });
        await ctx.reply("已解绑。重新绑定请回复 /bind 绑定码");
        this.pushState(id);
        return;
      }
      if (cmd === "/help" || cmd === "帮助") {
        await ctx.reply(
          [
            "Ordo 手机通道 · 用法：",
            "· 直接发消息 = 下达任务（等同电脑端会话输入）",
            "· 发图片/文件 = 交给 Agent 处理（≤20MB），可附文字说明",
            "· /get 相对路径 = 取工作区文件到手机（如 /get out/周报.docx，飞书支持）",
            "· 敏感操作会先发确认消息：回复【同意】或【拒绝】（5 分钟内）",
            "· 群聊里需 @机器人 · /unbind 解绑",
            "任务在电脑端执行：会话与产物在电脑端同步可见",
          ].join("\n")
        );
        return;
      }
      // 待确认的 L2 操作：关键词回复优先于新任务（通道串行，此时不可能在跑别的）
      if (r.pending) {
        if (ImBridge.YES_RE.test(text)) {
          this.resolvePending(id, true, "reply");
          await ctx.reply("✅ 已同意，继续执行");
          return;
        }
        if (ImBridge.NO_RE.test(text)) {
          this.resolvePending(id, false, "reply");
          await ctx.reply("⛔ 已拒绝该操作");
          return;
        }
        await ctx.reply(`有一条操作待确认（工具：${r.pending.tool}）。回复【同意】或【拒绝】`);
        return;
      }
      // 媒体消息 → 下载 → 附件链路进会话
      if (m.kind === "image" || m.kind === "file") {
        await this.runMediaTask(id, m, ctx);
        return;
      }
      if (!text) return;
      // /get 相对路径：工作区文件回传手机
      if (/^\/?get(\s|$)/i.test(text)) {
        await this.handleGet(id, text, ctx);
        return;
      }
      if (r.busy) {
        // 手机侧没有模式切换的余地：busy 时固定排队（followUp），当前任务完成后自动执行
        try {
          if (r.host) {
            await r.host.queueFollowUp(text);
            await ctx.reply("📨 已收到，将在当前任务完成后执行");
            return;
          }
        } catch {
          /* 入队失败回退为提示等待 */
        }
        await ctx.reply("上一条消息还在执行中，请等它完成再发下一条");
        return;
      }
      r.busy = true;
      try {
        await this.runAgent(id, text, ctx);
      } finally {
        r.busy = false;
      }
    } catch (e) {
      this.opts.audit.append({ event: "im_reply_out", channel: id, ok: false, error: String((e as Error)?.message ?? e).slice(0, 200) });
      await ctx.reply(`⚠️ 处理失败：${String((e as Error)?.message ?? e).slice(0, 300)}`).catch(() => {});
    }
  }

  // ---------- L2 确认：autoApprove 直放；否则确认消息 + 关键词回复 + 5 分钟超时 ----------

  private static confirmDetail(req: { tool: string; args: Record<string, unknown> }): string {
    const keys = ["path", "name", "url", "command", "query", "skill"];
    const parts = Object.entries(req.args ?? {})
      .filter(([k]) => keys.includes(k))
      .map(([k, v]) => `${k}: ${String(v).slice(0, 80)}`);
    return (parts.join("；") || JSON.stringify(req.args ?? {})).slice(0, 160);
  }

  private resolvePending(id: ImChannelConfig["id"], ok: boolean, by: "reply" | "timeout"): void {
    const r = this.r(id);
    if (!r.pending) return;
    clearTimeout(r.pending.timer);
    const p = r.pending;
    r.pending = undefined;
    this.opts.audit.append({ event: "im_confirm_result", channel: id, tool: p.tool, decision: ok ? "allow" : "deny", by });
    p.resolve(ok);
  }

  // ---------- 任务运行（文本 / 媒体附件共用） ----------

  private async runMediaTask(id: ImChannelConfig["id"], m: ImInbound, ctx: ImSendCtx): Promise<void> {
    const r = this.r(id);
    if (r.busy) {
      await ctx.reply("上一条消息还在执行中，请等它完成再发下一条");
      return;
    }
    r.busy = true;
    try {
      await ctx.reply(`🫡 收到${m.kind === "image" ? "图片" : "文件"}，正在处理`);
      const dl = r.adapter?.downloadMedia;
      if (!dl) throw new Error("当前通道暂不支持下载媒体文件");
      const media = await dl.call(r.adapter, m);
      if (media.data.length > MEDIA_MAX) {
        await ctx.reply(`文件超过 20MB（${Math.round(media.data.length / 1048576)}MB），暂不处理`);
        return;
      }
      const promptText = m.text?.trim() || `请查看我刚发来的${m.kind === "image" ? "图片" : "文件"}并按需处理`;
      await this.runAgent(id, promptText, ctx, [{ name: media.name, size: media.data.length, dataBase64: media.data.toString("base64") }]);
    } catch (e) {
      await ctx.reply(`⚠️ 媒体处理失败：${String((e as Error)?.message ?? e).slice(0, 200)}`).catch(() => {});
    } finally {
      r.busy = false;
    }
  }

  private async handleGet(id: ImChannelConfig["id"], text: string, ctx: ImSendCtx): Promise<void> {
    const rel = text.replace(/^\/?get\s*/i, "").trim().replace(/^["']+|["']+$/g, "");
    if (!rel) {
      await ctx.reply("用法：/get 相对路径（如 /get out/weekly-report.docx）");
      return;
    }
    const root = path.resolve(this.opts.resolveImRoot());
    const abs = path.resolve(root, rel);
    if (abs !== root && !abs.startsWith(root + path.sep)) {
      await ctx.reply("路径越界：只能取工作区内的文件");
      return;
    }
    try {
      await ctx.sendFile(abs);
      this.opts.audit.append({ event: "im_file_out", channel: id, path: rel });
    } catch (e) {
      await ctx.reply(`⚠️ 取文件失败：${String((e as Error)?.message ?? e).slice(0, 200)}`).catch(() => {});
    }
  }

  private async runAgent(id: ImChannelConfig["id"], text: string, ctx: ImSendCtx, attachments?: Array<{ name: string; size?: number; dataBase64?: string }>): Promise<void> {
    const c = this.ch(id);
    const r = this.r(id);
    r.lastCtx = ctx;
    if (!attachments) await ctx.reply("🫡 已接收，正在处理（完成后回复结果）");
    if (!r.host) {
      r.host = await this.opts.createHost(id, {
        emit: (ev) => {
          if (ev.type === "text_delta") r.buf += ev.text;
          else if (ev.type === "session_saved") r.savedId = ev.id;
        },
        confirm: async (req) => {
          if (c.autoApprove) {
            this.opts.audit.append({ event: "im_l2", channel: id, tool: req.tool, allowed: true });
            return true;
          }
          // 用当前消息的 ctx（r.lastCtx）：host 缓存导致创建时闭包里的 ctx 可能是几条消息前的旧 webhook
          const cur = r.lastCtx ?? ctx;
          const detail = ImBridge.confirmDetail(req);
          this.opts.audit.append({ event: "im_confirm_request", channel: id, tool: req.tool, detail });
          await cur.reply(`⚠️ 操作需要确认\n工具：${req.tool}\n${detail}\n回复【同意】执行 /【拒绝】取消（5 分钟内有效）`);
          const ok = await new Promise<boolean>((resolve) => {
            const timer = setTimeout(() => {
              this.resolvePending(id, false, "timeout");
              void r.lastCtx?.reply("⏰ 5 分钟未确认，操作已拒绝").catch(() => {});
            }, CONFIRM_TIMEOUT_MS);
            timer.unref?.();
            r.pending = { tool: req.tool, resolve, timer };
          });
          return ok;
        },
      });
    }
    const h = r.host;
    r.buf = "";
    r.savedId = undefined;
    let timedOut = false;
    const watchdog = setTimeout(() => {
      timedOut = true;
      try {
        h.cancel();
      } catch {
        /* 已结束 */
      }
    }, RUN_TIMEOUT_MS);
    try {
      if (r.sessionId) await h.loadSession(r.sessionId);
      else h.newSession();
      await h.prompt(text, attachments);
    } catch (e) {
      if (!timedOut) {
        await ctx.reply(`⚠️ 执行失败：${String((e as Error)?.message ?? e).slice(0, 300)}`).catch(() => {});
        return;
      }
    } finally {
      clearTimeout(watchdog);
    }
    if (timedOut) {
      await ctx.reply("⏱️ 执行超过 8 分钟已自动中止。复杂任务建议拆分，或在电脑端继续").catch(() => {});
      return;
    }
    if (r.savedId) r.sessionId = r.savedId;
    let out = r.buf.trim();
    if (h.lastAssistantStop === "error" || !out) {
      out = "⚠️ 模型服务调用失败（本轮无输出）。请在电脑端检查模型配置/网络后重试";
    }
    const segs = chunkReply(out);
    for (const s of segs) {
      try {
        await ctx.reply(s);
      } catch (e) {
        // 回复失败手机端看不到任何反馈，把原因顶到设置页状态行（如飞书 99991672 = 缺发消息权限）
        const raw = String((e as Error)?.message ?? e);
        const hint = /99991672|send_as_bot/i.test(raw) ? "（飞书应用缺发消息权限：开放平台「权限管理」开通 im:message:send_as_bot 并发布版本后生效）" : "";
        this.r(id).detail = `回复推送失败：${raw.slice(0, 140)}${hint}`;
        this.pushState(id);
      }
    }
    this.opts.audit.append({ event: "im_reply_out", channel: id, chars: out.length, segments: segs.length, session: r.sessionId ?? null });
    this.pushState(id, r.sessionId); // touchedSessionId → 渲染端刷新侧栏（IM 会话可回看）
  }

  // ---------- IPC 面向 ----------

  async list(): Promise<ImChannelInfo[]> {
    await this.load();
    return this.infoList();
  }

  /** 保存并热应用（enabled 变更/凭证变更都会重连）；secret 传 undefined/"" 表示保持不变；boundUser 传空串=解绑 */
  async save(id: string, patch: { enabled?: boolean; clientId?: string; secret?: string; autoApprove?: boolean; boundUser?: string }): Promise<ImChannelInfo[]> {
    await this.load();
    const c = this.ch(id);
    if (patch.clientId !== undefined) c.clientId = String(patch.clientId).trim();
    if (patch.secret) c.secret = String(patch.secret).trim();
    if (patch.autoApprove !== undefined) c.autoApprove = patch.autoApprove === true;
    if (patch.enabled !== undefined) c.enabled = patch.enabled === true;
    if (patch.boundUser !== undefined) {
      const v = String(patch.boundUser).trim();
      if (v && v !== c.boundUser) {
        c.boundUser = v;
        c.boundName = undefined;
        this.opts.audit.append({ event: "im_bind", channel: id, user: v, by: "field" });
      } else if (!v && c.boundUser) {
        c.boundUser = undefined;
        c.boundName = undefined;
        this.opts.audit.append({ event: "im_unbind", channel: id, by: "field" });
      }
    }
    if (c.enabled && (!c.clientId || !c.secret)) throw new Error("启用前需填写 ID 与 Secret（Secret 支持填 $ENV:变量名）");
    await this.persist();
    this.opts.audit.append({ event: "im_channel_change", channel: id, enabled: c.enabled, autoApprove: c.autoApprove });
    await this.applyChannel(c.id);
    return this.infoList();
  }

  async unbind(id: string): Promise<ImChannelInfo[]> {
    await this.load();
    const c = this.ch(id);
    c.boundUser = undefined;
    c.boundName = undefined;
    await this.persist();
    this.opts.audit.append({ event: "im_unbind", channel: id, by: "client" });
    this.pushState(c.id);
    return this.infoList();
  }

  async newBindCode(id: string): Promise<ImChannelInfo[]> {
    await this.load();
    const c = this.ch(id);
    c.bindCode = newBindCode();
    await this.persist();
    this.pushState(c.id);
    return this.infoList();
  }

  // ---------- 自测钩子（SELFTEST 专用：假适配器 + 直接投递，不碰网络） ----------

  setTestAdapter(id: string, adapter: ImAdapter | null): void {
    if (adapter) this.testAdapters.set(id, adapter);
    else this.testAdapters.delete(id);
  }

  /** 指定通道是否有待确认操作（自测轮询用） */
  hasPendingConfirm(id: string): boolean {
    return !!this.rt.get(id as ImChannelConfig["id"])?.pending;
  }

  /** 注入一条入站消息并等全链路跑完；返回捕获的回复与回传文件（真实适配器不经过此路径） */
  async deliverForTest(
    id: string,
    fromId: string,
    text: string,
    extra?: { kind?: "image" | "file"; fileName?: string; mediaKey?: string }
  ): Promise<{ replies: string[]; files: Array<{ name: string; bytes: number }> }> {
    await this.load();
    const got: { replies: string[]; files: Array<{ name: string; bytes: number }> } = { replies: [], files: [] };
    await this.handleInbound(
      this.ch(id).id,
      { fromId, fromName: `测试用户-${fromId.slice(-4)}`, text, kind: extra?.kind, fileName: extra?.fileName, mediaKey: extra?.mediaKey },
      {
        reply: async (t) => {
          got.replies.push(t);
        },
        sendFile: async (absPath) => {
          const st = await fsp.stat(absPath);
          got.files.push({ name: path.basename(absPath), bytes: st.size });
        },
      }
    );
    return got;
  }
}
