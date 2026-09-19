// 管理端推送客户端（R2→M6）：WS 接入 /api/v1/ws?token=（Bearer 同源 JWT），管理端变更秒级触达；
// 断线指数退避重连，期间轮询兜底（4.6）；token 失效（auth_failed）停止重连，等重新登录。
// 用 ws 包（Electron 主进程的 global WebSocket 不可靠）；不可达时静默重试，不影响既有 30 分钟轮询节律。
import { WebSocket } from "ws";

export type PushEvent =
  | { type: "hello"; emp?: string }
  | { type: "auth_failed" }
  | { type: "catalog_changed"; resource: "skills" | "mcp" | "kb" }
  | { type: "config_changed"; version: number }
  | { type: "packs_changed" }
  | { type: "client_version_changed"; version: string };

export class AdminPushClient {
  private ws: WebSocket | null = null;
  private retry = 0;
  private timer: NodeJS.Timeout | null = null;
  private stopped = false;

  constructor(private opts: { base: string; token: () => string; onEvent: (ev: PushEvent) => void }) {}

  start(): void {
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    try {
      this.ws?.close();
    } catch {
      /* 已断开 */
    }
  }

  private connect(): void {
    if (this.stopped) return;
    const url = `${this.opts.base.replace(/^http/, "ws")}/api/v1/ws?token=${encodeURIComponent(this.opts.token())}`;
    let ws: WebSocket;
    try {
      ws = new WebSocket(url);
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;
    ws.on("open", () => {
      this.retry = 0;
      console.log("[ADMIN-WS] connected");
    });
    ws.on("message", (data: unknown) => {
      try {
        const msg = JSON.parse(String(data)) as PushEvent;
        if (msg.type === "hello") return;
        if (msg.type === "auth_failed") {
          console.log("[ADMIN-WS] token 失效，停止重连（等重新登录）");
          this.stopped = true;
          return;
        }
        console.log(`[ADMIN-WS] ${msg.type}${(msg as { resource?: string }).resource ? ":" + (msg as { resource: string }).resource : ""}`);
        this.opts.onEvent(msg);
      } catch {
        /* 非 JSON 帧忽略 */
      }
    });
    ws.on("close", () => this.scheduleReconnect());
    ws.on("error", () => {
      /* close 随后触发，重连统一在 close 处理 */
    });
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.timer) return;
    const delay = Math.min(30000, 1000 * 2 ** Math.min(this.retry, 5));
    this.retry++;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.connect();
    }, delay);
    this.timer.unref?.();
  }
}
