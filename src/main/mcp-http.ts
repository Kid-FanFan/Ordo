// 远端 MCP HTTP 传输（连接器真执行）：Streamable HTTP（2025-03 规范，JSON 或 SSE 响应自适应）。
// JSON-RPC over POST；Mcp-Session-Id 会话保持；initialize → tools/list → tools/call。
// 鉴权：headers 声明式下发/自填，值支持 $ENV:NAME 调用时解析（密钥不落库明文，与平台配置同口径）。
// 管控语义：工具分级（L1/L2）与参数 schema 来自管理端声明/自添加时缓存，端点 tools/list 仅做能力校验。
export const MCP_INIT_TIMEOUT_MS = 15_000;
export const MCP_CALL_TIMEOUT_MS = 60_000;

export interface McpHttpConfig {
  endpoint: string;
  headers?: Record<string, string>;
}

/** $ENV:NAME → process.env；其余原样 */
export function resolveHeader(v: string): string {
  const m = /^\$ENV:(.+)$/.exec(String(v ?? "").trim());
  return m ? process.env[m[1]] ?? "" : String(v ?? "");
}

/** 单端点传输会话：懒初始化，幂等 ensure；进程内复用（同端点多工具共享） */
export class McpHttpTransport {
  private sessionId: string | null = null;
  private initialized = false;
  private initPromise: Promise<void> | null = null;
  private nextId = 1;
  private tools = new Set<string>();
  private rawToolsList: Array<{ name?: string; description?: string; inputSchema?: unknown }> = [];

  /** tools/list 原始返回（个人连接器派生参数声明用；ensure 后可用） */
  get rawTools(): Array<{ name?: string; description?: string; inputSchema?: unknown }> {
    return this.rawToolsList;
  }

  constructor(private cfg: McpHttpConfig) {}

  private authHeaders(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(this.cfg.headers ?? {})) out[k] = resolveHeader(v);
    return out;
  }

  /** POST 一条 JSON-RPC；Streamable HTTP 下响应可能是 application/json 或 text/event-stream */
  private async post(body: unknown, requestId: number | null, timeoutMs: number): Promise<any | null> {
    const res = await fetch(this.cfg.endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        ...(this.sessionId ? { "mcp-session-id": this.sessionId } : {}),
        ...this.authHeaders(),
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const sid = res.headers.get("mcp-session-id");
    if (sid) this.sessionId = sid;
    if (res.status === 202) return null; // 通知类：接受即成
    if (!res.ok) throw new Error(`MCP HTTP ${res.status}${res.statusText ? ` ${res.statusText}` : ""}`);
    const ct = res.headers.get("content-type") ?? "";
    if (ct.includes("text/event-stream")) return await this.readSse(res, requestId, timeoutMs);
    const j = (await res.json()) as { error?: { message?: string }; result?: any };
    if (j.error) throw new Error(String(j.error.message ?? "MCP 调用错误"));
    return j.result ?? null;
  }

  /** SSE 流解析：逐事件取 data: 行，返回第一个匹配 requestId 的响应；无 id 响应兜底取首个 result */
  private async readSse(res: Response, requestId: number | null, timeoutMs: number): Promise<any | null> {
    const reader = res.body?.getReader();
    if (!reader) throw new Error("MCP SSE 响应无内容");
    const decoder = new TextDecoder();
    let buf = "";
    let fallback: any | null = null;
    return await new Promise<any | null>((resolve, reject) => {
      const timer = setTimeout(() => {
        try {
          reader.cancel();
        } catch {}
        reject(new Error(`MCP SSE 响应超时（${timeoutMs}ms）`));
      }, timeoutMs);
      const finish = (fn: () => void) => {
        clearTimeout(timer);
        fn();
      };
      const pump = async () => {
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            buf += decoder.decode(value, { stream: true });
            let idx: number;
            while ((idx = buf.indexOf("\n\n")) >= 0) {
              const raw = buf.slice(0, idx);
              buf = buf.slice(idx + 2);
              for (const line of raw.split("\n")) {
                const m = /^data:\s*(.+)$/.exec(line.trim());
                if (!m) continue;
                try {
                  const msg = JSON.parse(m[1]) as { id?: number; result?: any; error?: { message?: string } };
                  if (typeof msg.id === "number" && (requestId === null || msg.id === requestId)) {
                    const em = msg.error;
                    if (em) finish(() => reject(new Error(String(em.message ?? "MCP 调用错误"))));
                    else finish(() => resolve(msg.result ?? null));
                    return;
                  }
                  if (msg.result && fallback === null) fallback = msg.result;
                } catch {
                  /* 非 JSON data 行忽略 */
                }
              }
            }
          }
          finish(() => resolve(fallback));
        } catch (e) {
          finish(() => reject(e as Error));
        }
      };
      void pump();
    });
  }

  private async rpc(method: string, params: unknown, timeoutMs: number): Promise<any> {
    const id = this.nextId++;
    return await this.post({ jsonrpc: "2.0", id, method, params }, id, timeoutMs);
  }

  /** 确保会话就绪（initialize → initialized → tools/list 缓存）；幂等；返回工具名集合 */
  async ensure(): Promise<Set<string>> {
    if (this.initialized) return this.tools;
    if (!this.initPromise) {
      this.initPromise = (async () => {
        const init = await this.rpc(
          "initialize",
          { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "ordo", version: "1.0" } },
          MCP_INIT_TIMEOUT_MS
        );
        if (!init) throw new Error("MCP initialize 无响应");
        await this.post({ jsonrpc: "2.0", method: "notifications/initialized" }, null, MCP_INIT_TIMEOUT_MS).catch(() => {});
        const list = (await this.rpc("tools/list", {}, MCP_INIT_TIMEOUT_MS)) as { tools?: Array<{ name?: string; description?: string; inputSchema?: unknown }> } | null;
        this.rawToolsList = list?.tools ?? [];
        for (const t of this.rawToolsList) {
          if (t?.name) this.tools.add(String(t.name));
        }
        if (!this.tools.size) throw new Error("MCP tools/list 为空（端点不可用或非 MCP 服务）");
        this.initialized = true;
      })().catch((e) => {
        this.initPromise = null;
        throw e;
      });
    }
    await this.initPromise;
    return this.tools;
  }

  async call(tool: string, args: Record<string, unknown>): Promise<string> {
    await this.ensure();
    if (!this.tools.has(tool)) throw new Error(`远端 MCP 无工具 ${tool}（声明与端点能力不一致？）`);
    const r = (await this.rpc("tools/call", { name: tool, arguments: args ?? {} }, MCP_CALL_TIMEOUT_MS)) as {
      content?: Array<{ type?: string; text?: string }>;
    } | null;
    const texts = (r?.content ?? []).filter((c) => c?.type === "text").map((c) => String(c.text ?? ""));
    return texts.join("\n") || JSON.stringify(r ?? {});
  }
}

/** 进程内「端点+头」→ 传输复用池（企业连接器与个人连接器共用） */
export class McpHttpHost {
  private pool = new Map<string, McpHttpTransport>();

  private keyOf(endpoint: string, headers?: Record<string, string>): string {
    return endpoint + "\n" + JSON.stringify(headers ?? {});
  }

  transport(endpoint: string, headers?: Record<string, string>): McpHttpTransport {
    const key = this.keyOf(endpoint, headers);
    let t = this.pool.get(key);
    if (!t) {
      t = new McpHttpTransport({ endpoint, headers });
      this.pool.set(key, t);
    }
    return t;
  }

  /** 连通性测试：initialize + tools/list，返回工具名列表 */
  async probe(endpoint: string, headers?: Record<string, string>): Promise<string[]> {
    return [...(await this.transport(endpoint, headers).ensure())];
  }

  async call(endpoint: string, headers: Record<string, string> | undefined, tool: string, args: Record<string, unknown>): Promise<string> {
    return await this.transport(endpoint, headers).call(tool, args);
  }
}
