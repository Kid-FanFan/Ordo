// 本地 MCP 宿主（R3，方案 §12.4 遗留项）：插件包下发的 mcp_pkg（managed/mcp/<pack>/<version>/）作为
// 本地子进程运行——stdio 上的 MCP 协议（NDJSON 帧：initialize → tools/list → tools/call）。
// node 型入口用 ELECTRON_RUN_AS_NODE 以客户端自带 Electron 充当 Node 运行时（零外部依赖）；
// 工具分级/标签/参数由包内 mcp.json 声明（MCP 协议无分级概念，企业管控由管理端包作者定）。
import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import type { Audit } from "./audit";

export interface McpParamDecl {
  name: string;
  type: "string" | "number" | "boolean";
  description?: string;
  required?: boolean;
}

export interface McpToolDecl {
  name: string;
  label?: string;
  level: "L1" | "L2";
  description?: string;
  params?: McpParamDecl[];
}

export interface McpPackManifest {
  runtime: "node" | "binary";
  script: string;
  displayName?: string;
  description?: string;
  tools: McpToolDecl[];
}

export interface LocalMcpPack {
  name: string;
  version: string;
  dir: string;
  manifest: McpPackManifest;
}

// 注册式启动规格（个人连接器 stdio 型）：与插件包清单并存，ensure 时优先于包目录查找
export interface McpLaunchSpec {
  command: string;
  args: string[];
  env?: Record<string, string>;
  cwd?: string;
}

interface Pending {
  resolve: (v: any) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
}

export interface Proc {
  child: ChildProcess;
  ready: Promise<void>;
  nextId: number;
  pending: Map<number, Pending>;
  buffer: string;
  tools: Set<string>;
  // tools/list 捕获的原始声明（个人 stdio 连接器派生参数用；插件包路径不依赖）
  schemas: Map<string, { description?: string; inputSchema?: any }>;
}

const INIT_TIMEOUT_MS = 15_000;
const CALL_TIMEOUT_MS = 60_000;

export class LocalMcpHost {
  private procs = new Map<string, Proc>();
  private specs = new Map<string, McpLaunchSpec>();

  constructor(private deps: { audit: Audit; root: string }) {}

  /** 登记启动规格（同名校验由调用方负责；重复登记覆盖） */
  registerSpec(name: string, spec: McpLaunchSpec): void {
    this.specs.set(name, spec);
  }

  unregisterSpec(name: string): void {
    this.specs.delete(name);
  }

  /** 已安装的本地 MCP 包（managed/mcp/<pack>/<version>/mcp.json；取版本目录最大者） */
  packs(): LocalMcpPack[] {
    const root = path.join(this.deps.root, "mcp");
    const out: LocalMcpPack[] = [];
    for (const pack of safeList(root)) {
      if (!pack.isDirectory()) continue;
      const versions = safeList(path.join(root, pack.name))
        .filter((v) => v.isDirectory() && /^\d/.test(v.name))
        .map((v) => v.name)
        .sort();
      const version = versions[versions.length - 1];
      if (!version) continue;
      const dir = path.join(root, pack.name, version);
      const mf = path.join(dir, "mcp.json");
      if (!fs.existsSync(mf)) continue;
      try {
        const manifest = JSON.parse(fs.readFileSync(mf, "utf-8")) as McpPackManifest;
        if (manifest?.runtime && manifest?.script && Array.isArray(manifest.tools)) out.push({ name: pack.name, version, dir, manifest });
      } catch {
        /* 脏清单跳过 */
      }
    }
    return out;
  }

  pack(name: string): LocalMcpPack | undefined {
    return this.packs().find((p) => p.name === name);
  }

  /** 确保子进程就绪（initialize 握手 + tools/list 缓存）；已就绪幂等。查找顺序：存活进程 → 注册规格 → 插件包 */
  async ensure(name: string): Promise<Proc> {
    const existing = this.procs.get(name);
    if (existing) {
      await existing.ready;
      return existing;
    }
    const spec = this.specs.get(name);
    if (spec) {
      const proc = this.spawnSpec(name, spec);
      this.procs.set(name, proc);
      proc.ready = this.handshake(name, proc);
      await proc.ready;
      return proc;
    }
    const pack = this.pack(name);
    if (!pack) throw new Error(`本地 MCP 包未安装: ${name}`);
    const child =
      pack.manifest.runtime === "node"
        ? spawn(process.execPath, [path.join(pack.dir, pack.manifest.script)], {
            cwd: pack.dir,
            env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
            stdio: ["pipe", "pipe", "pipe"],
          })
        : spawn(path.join(pack.dir, pack.manifest.script), { cwd: pack.dir, stdio: ["pipe", "pipe", "pipe"] });

    const proc: Proc = { child, ready: Promise.resolve(), nextId: 1, pending: new Map(), buffer: "", tools: new Set(), schemas: new Map() };
    this.procs.set(name, proc);
    proc.ready = this.handshake(name, proc);
    await proc.ready;
    return proc;
  }

  // 个人连接器 stdio 启动：用户自己的本机命令。Windows 上 .cmd/.bat（npx 等）无法直接 spawn，
  // 统一经 cmd /c（参数含空格自动加引号）；POSIX 直接 argv（shebang 可执行）
  private spawnSpec(name: string, spec: McpLaunchSpec): Proc {
    const env = { ...process.env, ...(spec.env ?? {}) };
    const cwd = spec.cwd || undefined;
    let child: ChildProcess;
    if (process.platform === "win32") {
      const q = (a: string) => (/[\s"]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a);
      child = spawn([spec.command, ...spec.args].map(q).join(" "), { shell: true, cwd, env, stdio: ["pipe", "pipe", "pipe"] });
    } else {
      child = spawn(spec.command, spec.args, { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
    }
    return { child, ready: Promise.resolve(), nextId: 1, pending: new Map(), buffer: "", tools: new Set(), schemas: new Map() };
  }

  private request(proc: Proc, method: string, params: unknown, timeoutMs: number): Promise<any> {
    const id = proc.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        proc.pending.delete(id);
        reject(new Error(`MCP ${method} 超时（${timeoutMs}ms）`));
      }, timeoutMs);
      proc.pending.set(id, { resolve, reject, timer });
      try {
        proc.child.stdin!.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
      } catch (e) {
        clearTimeout(timer);
        proc.pending.delete(id);
        reject(e as Error);
      }
    });
  }

  private async handshake(name: string, proc: Proc): Promise<void> {
    proc.child.stdout!.setEncoding("utf-8");
    proc.child.stdout!.on("data", (d) => this.onStdout(proc, d));
    proc.child.stderr!.setEncoding("utf-8");
    proc.child.stderr!.on("data", (d) => process.env.ORDO_SELFTEST === "1" && console.log(`[MCP:${name}] ${String(d).trim()}`.slice(0, 300)));
    proc.child.on("exit", (code) => {
      for (const [, p] of proc.pending) {
        clearTimeout(p.timer);
        p.reject(new Error(`MCP 进程退出（code=${code}）`));
      }
      proc.pending.clear();
      this.procs.delete(name);
    });
    try {
      await this.request(proc, "initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "ordo", version: "1.0" } }, INIT_TIMEOUT_MS);
      proc.child.stdin!.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
      const list = await this.request(proc, "tools/list", {}, INIT_TIMEOUT_MS);
      for (const t of list?.tools ?? []) {
        if (t?.name) {
          proc.tools.add(String(t.name));
          proc.schemas.set(String(t.name), { description: t.description, inputSchema: t.inputSchema });
        }
      }
      if (!proc.tools.size) throw new Error("MCP tools/list 为空");
    } catch (e) {
      try {
        proc.child.kill();
      } catch {}
      this.procs.delete(name);
      throw e;
    }
  }

  private onStdout(proc: Proc, chunk: string): void {
    proc.buffer += chunk;
    let idx = proc.buffer.indexOf("\n");
    while (idx >= 0) {
      const line = proc.buffer.slice(0, idx).trim();
      proc.buffer = proc.buffer.slice(idx + 1);
      if (line) {
        try {
          const msg = JSON.parse(line) as { id?: number; result?: unknown; error?: { message?: string } };
          if (typeof msg.id === "number") {
            const p = proc.pending.get(msg.id);
            if (p) {
              clearTimeout(p.timer);
              proc.pending.delete(msg.id);
              if (msg.error) p.reject(new Error(String(msg.error.message ?? "MCP 调用错误")));
              else p.resolve(msg.result);
            }
          }
        } catch {
          /* 非 JSON 行忽略 */
        }
      }
      idx = proc.buffer.indexOf("\n");
    }
  }

  /** 调用本地工具：返回 text content 拼接（与远端连接器返回形态一致） */
  async call(name: string, tool: string, args: Record<string, unknown>): Promise<string> {
    const proc = await this.ensure(name);
    if (!proc.tools.has(tool)) throw new Error(`本地 MCP ${name} 无工具 ${tool}（服务端声明与 mcp.json 不一致？）`);
    const r = await this.request(proc, "tools/call", { name: tool, arguments: args ?? {} }, CALL_TIMEOUT_MS);
    const texts = (r?.content ?? []).filter((c: any) => c?.type === "text").map((c: any) => String(c.text ?? ""));
    return texts.join("\n") || JSON.stringify(r ?? {});
  }

  stop(name: string): void {
    const proc = this.procs.get(name);
    if (!proc) return;
    try {
      proc.child.kill();
    } catch {
      /* */
    }
    this.procs.delete(name);
  }

  stopAll(): void {
    for (const [name, proc] of this.procs) {
      try {
        proc.child.kill();
      } catch {
        /* */
      }
      this.procs.delete(name);
    }
  }
}

function safeList(dir: string): Array<{ name: string; isDirectory: () => boolean }> {
  try {
    return fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}
