// 个人连接器（体验清单 #3）：用户在客户端自行添加的 MCP——HTTP 端点或本机 stdio 进程。
// 存储于 config/personal-connectors.json（本机个人配置，不出本机）；添加时 probe 真连通并缓存
// tools/list 派生的参数声明；工具默认全部 L2（安全默认：未经企业分级的一律需确认）。
// stdio 型：用户自担的本机命令（同 Claude/Cursor 的手动 MCP 配置），子进程由 LocalMcpHost 规格注册管理。
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import type { Audit } from "./audit";
import type { LocalMcpHost } from "./mcp-local";
import type { McpHttpHost } from "./mcp-http";

export interface PersonalTool {
  name: string;
  label: string;
  level: "L1" | "L2";
  description: string;
  params: Array<{ name: string; type: "string" | "number" | "boolean"; description: string; required?: boolean }>;
}

export interface PersonalConnector {
  id: string;
  name: string; // 挂载名（mcp__<name>__<tool>；ASCII slug）
  displayName: string;
  description: string;
  transport?: "http" | "stdio"; // 缺省 http（旧条目兼容）
  endpoint?: string; // http 型
  headers?: Record<string, string>; // http 型
  command?: string; // stdio 型
  args?: string[]; // stdio 型
  env?: Record<string, string>; // stdio 型
  cwd?: string; // stdio 型
  tools: PersonalTool[];
  addedAt: string;
}

function slugify(s: string): string {
  const slug = String(s ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9-_]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 24);
  return slug || `mcp-${Date.now().toString(36)}`;
}

export class PersonalMcpStore {
  constructor(private opts: { file: string; http: McpHttpHost; local: LocalMcpHost; audit: Audit }) {}

  private async readAll(): Promise<PersonalConnector[]> {
    try {
      return JSON.parse(await fsp.readFile(this.opts.file, "utf-8")) as PersonalConnector[];
    } catch {
      return [];
    }
  }

  private async writeAll(list: PersonalConnector[]): Promise<void> {
    await fsp.mkdir(path.dirname(this.opts.file), { recursive: true });
    await fsp.writeFile(this.opts.file, JSON.stringify(list, null, 2), "utf-8");
  }

  async list(): Promise<PersonalConnector[]> {
    return await this.readAll();
  }

  async get(name: string): Promise<PersonalConnector | undefined> {
    return (await this.readAll()).find((c) => c.name === name);
  }

  /** JSON Schema（inputSchema.properties）→ 声明式 params（仅映射原始类型，其余按 string 兜底） */
  private deriveTools(raw: Array<{ name?: string; description?: string; inputSchema?: any }>): PersonalTool[] {
    const out: PersonalTool[] = [];
    for (const t of raw) {
      if (!t?.name) continue;
      const props = (t.inputSchema?.properties ?? {}) as Record<string, any>;
      const required: string[] = Array.isArray(t.inputSchema?.required) ? t.inputSchema.required : [];
      const params = Object.entries(props)
        .slice(0, 20)
        .map(([name, p]) => {
          const type = p?.type === "number" || p?.type === "integer" ? "number" : p?.type === "boolean" ? "boolean" : "string";
          return { name, type, description: String(p?.description ?? name), required: required.includes(name) } as PersonalTool["params"][number];
        });
      out.push({ name: String(t.name), label: String(t.name), level: "L2", description: String(t.description ?? `个人连接器工具 ${t.name}`), params });
    }
    return out;
  }

  /** 启动时回登记 stdio 规格（跨重启的子进程可在首次调用时拉起；HTTP 型无需登记） */
  async syncSpecs(): Promise<void> {
    for (const c of await this.readAll()) {
      if (c.transport === "stdio" && c.command) {
        this.opts.local.registerSpec(c.name, { command: c.command, args: c.args ?? [], env: c.env, cwd: c.cwd });
      }
    }
  }

  /** 测试连通并添加（端点/命令不可达或非 MCP 服务即失败，不落半成品） */
  async add(input: {
    displayName: string;
    transport?: string;
    endpoint?: string;
    headersJson?: string;
    command?: string;
    argsText?: string;
    envJson?: string;
    cwd?: string;
  }): Promise<{ name: string; tools: number }> {
    const displayName = String(input.displayName ?? "").trim();
    if (!displayName) throw new Error("名称必填");
    const kind = input.transport === "stdio" ? "stdio" : "http";

    let endpoint: string | undefined;
    let headers: Record<string, string> | undefined;
    let spec: { command: string; args: string[]; env?: Record<string, string>; cwd?: string } | undefined;
    if (kind === "http") {
      endpoint = String(input.endpoint ?? "").trim().replace(/\/+$/, "");
      if (!/^https?:\/\//i.test(endpoint)) throw new Error("端点需为 http(s) 地址");
      if (input.headersJson && input.headersJson.trim()) {
        try {
          const parsed = JSON.parse(input.headersJson) as unknown;
          if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("需为对象");
          headers = Object.fromEntries(Object.entries(parsed as Record<string, unknown>).map(([k, v]) => [k, String(v)]));
        } catch (e) {
          throw new Error(`请求头 JSON 无效：${(e as Error).message}`);
        }
      }
    } else {
      const command = String(input.command ?? "").trim();
      if (!command) throw new Error("启动命令必填（如 node / python / npx 或可执行文件路径）");
      // 参数：JSON 数组精确表达（路径含空格），否则按空白切分
      let args: string[] = [];
      const rawArgs = String(input.argsText ?? "").trim();
      if (rawArgs) {
        if (rawArgs.startsWith("[")) {
          try {
            const parsed = JSON.parse(rawArgs) as unknown;
            if (!Array.isArray(parsed) || parsed.some((x) => typeof x !== "string")) throw new Error("需为字符串数组");
            args = parsed as string[];
          } catch (e) {
            throw new Error(`参数 JSON 无效：${(e as Error).message}`);
          }
        } else {
          args = rawArgs.split(/\s+/);
        }
      }
      let env: Record<string, string> | undefined;
      if (input.envJson && input.envJson.trim()) {
        try {
          const parsed = JSON.parse(input.envJson) as unknown;
          if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("需为对象");
          env = Object.fromEntries(Object.entries(parsed as Record<string, unknown>).map(([k, v]) => [k, String(v)]));
        } catch (e) {
          throw new Error(`环境变量 JSON 无效：${(e as Error).message}`);
        }
      }
      const cwd = String(input.cwd ?? "").trim() || undefined;
      spec = { command, args, env, cwd };
    }

    const list = await this.readAll();
    const dedupeKey = kind === "http" ? endpoint! : `${spec!.command} ${spec!.args.join(" ")}`;
    let name = slugify(displayName);
    while (list.some((c) => c.name === name && `${c.endpoint ?? ""} ${c.command ?? ""}`.trim() !== dedupeKey)) {
      name = `${slugify(displayName)}-${Math.random().toString(36).slice(2, 6)}`;
    }

    // 真连通 + tools/list（失败即失败）：http 走传输探活；stdio 注册规格后经本地宿主握手
    let rawTools: Array<{ name?: string; description?: string; inputSchema?: any }>;
    if (kind === "http") {
      const transport = this.opts.http.transport(endpoint!, headers);
      await transport.ensure();
      rawTools = transport.rawTools;
    } else {
      this.opts.local.registerSpec(name, spec!);
      try {
        const proc = await this.opts.local.ensure(name);
        rawTools = [...proc.tools].map((t) => ({ name: t, description: proc.schemas.get(t)?.description, inputSchema: proc.schemas.get(t)?.inputSchema }));
      } catch (e) {
        this.opts.local.unregisterSpec(name); // 握手失败不留半成品规格（进程宿主已自行清理）
        throw e;
      }
    }
    const tools = this.deriveTools(rawTools);
    if (!tools.length) {
      if (kind === "stdio") {
        this.opts.local.stop(name);
        this.opts.local.unregisterSpec(name);
      }
      throw new Error(kind === "http" ? "端点未提供任何工具（tools/list 为空）" : "服务未提供任何工具（tools/list 为空）");
    }

    const conn: PersonalConnector = {
      id: `pm-${Date.now().toString(36)}`,
      name,
      displayName,
      description: kind === "http" ? `个人连接器 · ${endpoint}` : `个人连接器（本地） · ${spec!.command}`,
      transport: kind,
      ...(kind === "http" ? { endpoint, headers } : { command: spec!.command, args: spec!.args, env: spec!.env, cwd: spec!.cwd }),
      tools,
      addedAt: new Date().toISOString(),
    };
    const idx = list.findIndex((c) => c.name === name);
    if (idx >= 0) list[idx] = conn;
    else list.push(conn);
    await this.writeAll(list);
    this.opts.audit.append({
      event: "personal_connector_add",
      name: conn.name,
      transport: kind,
      target: kind === "http" ? endpoint! : spec!.command,
      tools: tools.length,
    });
    return { name: conn.name, tools: tools.length };
  }

  async remove(id: string): Promise<void> {
    const list = await this.readAll();
    const victim = list.find((c) => c.id === id);
    const next = list.filter((c) => c.id !== id);
    if (next.length === list.length) return;
    await this.writeAll(next);
    if (victim?.transport === "stdio" && victim.command) {
      this.opts.local.stop(victim.name);
      this.opts.local.unregisterSpec(victim.name);
    }
    this.opts.audit.append({ event: "personal_connector_remove", id });
  }
}
