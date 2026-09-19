// MCP 连接器（对应 PRD 4.4 远程 API 型 + 3.5 托管执行）：管理端配置端点/授权/审计，员工侧启停 + 会话挂载。
// 远端执行（体验清单 #3）：HttpTransport 真调用（mcp-http.ts，Streamable HTTP），mock 返回退役；
// 企业连接器参数声明沿用管理端 tools_json（分级/标签管理控语义），个人连接器见 personal-mcp.ts。
// pi 工具名采用 mcp__<连接器>__<工具> 约定（与业界 MCP 客户端一致，审计可按前缀归因）。
import * as fsp from "node:fs/promises";
import { adminFetchJson } from "./admin-link";
import type { McpPackManifest } from "./mcp-local";
import type { McpHttpHost } from "./mcp-http";
import type { PersonalConnector } from "./personal-mcp";
import type { Audit } from "./audit";

export interface ConnectorToolDef {
  name: string;
  label: string;
  /** L1 = 只读自动执行；L2 = 需确认（PRD 3.9 分级对用户无感，只进审计与门控） */
  level: "L1" | "L2";
  description: string;
  params: Array<{ name: string; type: "string" | "number" | "boolean"; description: string; required?: boolean }>;
  /** mock 执行结果（模板字符串；真实接入后由 HttpTransport 调用端点） */
  mockResult: string;
}

export interface ConnectorDef {
  name: string;
  displayName: string;
  description: string;
  /** 管理端托管端点（展示与追溯用） */
  endpoint: string;
  /** 声明式请求头（值支持 $ENV:NAME 调用时解析，密钥不落库明文） */
  headers?: Record<string, string>;
  tools: ConnectorToolDef[];
}

export interface McpRegistryProvider {
  /** 按当前用户权限过滤后的连接器目录（权限判断在管理端） */
  catalog(): Promise<ConnectorDef[]>;
}

/** 原型期数据源：config.mock.json 的 mcpRegistry，每次现读 */
/** M6：单机/锁定态数据源——企业连接器目录恒空（本地 MCP 包由 LocalMcpHost 另行供给） */
export class EmptyMcpProvider implements McpRegistryProvider {
  async catalog(): Promise<ConnectorDef[]> {
    return [];
  }
}

/** 管理端数据源（M1）：目录走 HTTP；失败返回空目录（对齐 Mock 降级语义） */
export class HttpMcpRegistryProvider implements McpRegistryProvider {
  constructor(private base: string) {}

  async catalog(): Promise<ConnectorDef[]> {
    try {
      return await adminFetchJson<ConnectorDef[]>(this.base, "/api/v1/catalog/mcp");
    } catch {
      return [];
    }
  }
}

export interface ConnectorHostDeps {
  audit: Audit;
  /** 本地 MCP 包宿主（R3）：已安装的插件包 mcp_pkg 以本地子进程运行，与远端连接器同一挂载/分级/审计链路 */
  local?: { packs(): Array<{ name: string; version: string; manifest: McpPackManifest }>; call(name: string, tool: string, args: Record<string, unknown>): Promise<string> };
  /** 远端 HTTP MCP 传输池（体验清单 #3：连接器真执行） */
  remoteHttp?: McpHttpHost;
  /** 个人连接器（客户端自添加）：目录并列展示与挂载 */
  personal?: { list(): Promise<PersonalConnector[]> };
}

export function connectorToolName(connector: string, tool: string): string {
  return `mcp__${connector}__${tool}`;
}

export class ConnectorHost {
  constructor(private provider: McpRegistryProvider, private deps: ConnectorHostDeps) {}

  /** 数据源热切换（M6-D 登录/退出无重启：Empty ↔ HTTP；本地 MCP 包不受影响） */
  setProvider(p: McpRegistryProvider): void {
    this.provider = p;
  }

  async listRich(disabled: Set<string>): Promise<Array<{ name: string; displayName: string; desc: string; endpoint: string; enabled: boolean; tools: string[]; personal?: boolean; id?: string }>> {
    const catalog = await this.provider.catalog();
    const rows: Array<{ name: string; displayName: string; desc: string; endpoint: string; enabled: boolean; tools: string[]; personal?: boolean; id?: string }> = catalog.map((c) => ({
      name: c.name,
      displayName: c.displayName,
      desc: c.description,
      endpoint: c.endpoint,
      enabled: !disabled.has(c.name),
      tools: c.tools.map((t) => t.label),
    }));
    // 本地 MCP 包（插件包下发）并列展示：endpoint 标 local://，与远端同一启停/挂载语义
    for (const p of this.deps.local?.packs() ?? []) {
      rows.push({
        name: p.name,
        displayName: `${p.manifest.displayName ?? p.name}（本地 v${p.version}）`,
        desc: p.manifest.description ?? "插件包下发的本地 MCP 工具",
        endpoint: `local://${p.name}/${p.version}`,
        enabled: !disabled.has(p.name),
        tools: p.manifest.tools.map((t) => t.label ?? t.name),
      });
    }
    // 个人连接器（客户端自添加）：同一挂载语义；personal 标记供面板渲染删除按钮。
    // stdio 型 endpoint 留空（desc 已带启动命令，避免"端点 <命令>"的错位文案）
    for (const p of (await this.deps.personal?.list()) ?? []) {
      rows.push({
        name: p.name,
        displayName: `${p.displayName}（个人）`,
        desc: p.description,
        endpoint: p.transport === "stdio" ? "" : p.endpoint!,
        enabled: !disabled.has(p.name),
        tools: p.tools.map((t) => t.label ?? t.name),
        personal: true,
        id: p.id,
      });
    }
    return rows;
  }

  /** 无人值守预授权可选项（PRD 3.7）：目录中所有需确认的连接器操作 */
  async listL2(): Promise<Array<{ id: string; label: string }>> {
    const catalog = await this.provider.catalog();
    const out: Array<{ id: string; label: string }> = [];
    for (const c of catalog) {
      for (const t of c.tools) {
        if (t.level === "L2") out.push({ id: connectorToolName(c.name, t.name), label: `${c.displayName} · ${t.label}` });
      }
    }
    for (const p of this.deps.local?.packs() ?? []) {
      for (const t of p.manifest.tools) {
        if (t.level === "L2") out.push({ id: connectorToolName(p.name, t.name), label: `${p.manifest.displayName ?? p.name} · ${t.label ?? t.name}` });
      }
    }
    for (const pc of (await this.deps.personal?.list()) ?? []) {
      for (const t of pc.tools) {
        if (t.level === "L2") out.push({ id: connectorToolName(pc.name, t.name), label: `${pc.displayName} · ${t.label ?? t.name}` });
      }
    }
    return out;
  }

  /**
   * 生成 pi 工具对象（挂载到 agent 的工具列表）。
   * effectiveNames = 会话挂载 ∩ 市场启用 ∩ 专家白名单（调用方算好传入）。
   */
  async buildTools(Type: any, effectiveNames: string[]): Promise<any[]> {
    const catalog = await this.provider.catalog();
    const byName = new Map(catalog.map((c) => [c.name, c]));
    const localByName = new Map((this.deps.local?.packs() ?? []).map((p) => [p.name, p]));
    const personal = (await this.deps.personal?.list()) ?? [];
    const personalByName = new Map(personal.map((c) => [c.name, c]));
    const tools: any[] = [];
    for (const connName of effectiveNames) {
      const conn = byName.get(connName);
      if (!conn) {
        // 本地 MCP 包（R3）：mcp.json 声明驱动 schema/分级；真实调用走子进程 stdio
        const pack = localByName.get(connName);
        if (pack) {
          for (const t of pack.manifest.tools) {
            const props: Record<string, any> = {};
            for (const p of t.params ?? []) {
              const tt = p.type === "number" ? Type.Number : p.type === "boolean" ? Type.Boolean : Type.String;
              props[p.name] = p.required === false ? Type.Optional(tt({ description: p.description })) : tt({ description: p.description });
            }
            tools.push({
              name: connectorToolName(pack.name, t.name),
              label: t.label ?? t.name,
              level: t.level,
              description: t.description ?? `本地 MCP 工具（插件包 ${pack.name} v${pack.version}）`,
              parameters: Type.Object(props),
              execute: async (_id: string, args: any) => {
                this.deps.audit.append({ event: "mcp_call", connector: pack.name, tool: t.name, level: t.level, local: true, args: args ?? {} });
                const text = await this.deps.local!.call(pack.name, t.name, args ?? {});
                return { content: [{ type: "text", text }], details: { connector: pack.name, tool: t.name, local: true } };
              },
            });
          }
          continue;
        }
        // 个人连接器（自添加）：添加时缓存的声明驱动 schema，全部 L2；按类型分发（HTTP 传输 / 本地 stdio 宿主）
        const pc = personalByName.get(connName);
        if (pc) {
          for (const t of pc.tools) {
            const props: Record<string, any> = {};
            for (const p of t.params) {
              const tt = p.type === "number" ? Type.Number : p.type === "boolean" ? Type.Boolean : Type.String;
              props[p.name] = p.required === false ? Type.Optional(tt({ description: p.description })) : tt({ description: p.description });
            }
            tools.push({
              name: connectorToolName(pc.name, t.name),
              label: t.label ?? t.name,
              level: t.level,
              description: t.description,
              parameters: Type.Object(props),
              execute: async (_id: string, args: any) => {
                this.deps.audit.append({ event: "mcp_call", connector: pc.name, tool: t.name, level: t.level, personal: true, args: args ?? {} });
                const text =
                  pc.transport === "stdio"
                    ? await this.deps.local!.call(pc.name, t.name, args ?? {})
                    : await this.deps.remoteHttp!.call(pc.endpoint!, pc.headers, t.name, args ?? {});
                return { content: [{ type: "text", text }], details: { connector: pc.name, tool: t.name, personal: true } };
              },
            });
          }
          continue;
        }
        continue; // 管理端已下架且无本地/个人实现：静默跳过（同步口径同技能）
      }
      for (const t of conn.tools) {
        const props: Record<string, any> = {};
        for (const p of t.params) {
          const tt = p.type === "number" ? Type.Number : p.type === "boolean" ? Type.Boolean : Type.String;
          props[p.name] = p.required === false ? Type.Optional(tt({ description: p.description })) : tt({ description: p.description });
        }
        tools.push({
          name: connectorToolName(conn.name, t.name),
          label: t.label,
          level: t.level,
          description: t.description,
          parameters: Type.Object(props),
          execute: async (_id: string, args: any) => {
            // 审计记明细（PRD 4.4：谁/何时/接口/参数）；执行 = HTTP 传输真调用（失败如实报错，不再返回 mock）
            this.deps.audit.append({ event: "mcp_call", connector: conn.name, tool: t.name, level: t.level, args: args ?? {} });
            if (!this.deps.remoteHttp) throw new Error("远端 MCP 传输未就绪");
            const text = await this.deps.remoteHttp.call(conn.endpoint, conn.headers, t.name, args ?? {});
            return { content: [{ type: "text", text }], details: { connector: conn.name, tool: t.name } };
          },
        });
      }
    }
    return tools;
  }
}
