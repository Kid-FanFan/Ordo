// AgentHost：Ordo 的壳（对应 PRD 3.1 基座规格 + 3.9 操作分级 + 3.10 专家）
// Pi 运行时（pi-agent-core / pi-ai）以 SDK 方式嵌入；L1/L2 确认门挂在 beforeToolCall。
// 注意：Pi 包为 ESM-only，主进程编译为 CJS，故用 Function 构造的原生 import() 动态加载，
// 避免 TypeScript 在 CJS 输出里把 import() 改写成 require()。
import * as fsp from "node:fs/promises";
import * as fsSync from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { attachmentBlock, saveAttachments } from "./attachments";
import { ocrImage as ocrImageFile } from "./ocr";
import type { UiEvent } from "../shared/protocol";
import type { Workspace } from "./workspace";
import type { Audit } from "./audit";
import { ExpertRegistry, ExpertDef, ExpertInfo } from "./experts";
import { SkillStore, validateSkillName, validateSkillDescription, renderSkillMd } from "./skills";
import { ConnectorHost } from "./connectors";
import { KnowledgeProvider, PersonalKbStore, searchChunks } from "./knowledge";
import { officeAvailable, officeBatch, officeQuery, officeRun } from "./office-cli";
import type { ConsoleEntry } from "./browser-bridge";
import { PiSessionStore, replayEntries, type StoredSession, type SessionMeta } from "./pi-sessions";
import { MemorySystem, type MemoryConfig } from "./memory";
import { createSearchMemoryToolDefinition, shouldEnableSearchMemory, executeSearchMemory } from "./memory/tool";
import { MemoryConfigStore } from "./memory/config-store";

const dynamicImport = new Function("s", "return import(s)") as (s: string) => Promise<any>;

export interface ConfirmRequest {
  id: string;
  tool: string;
  args: Record<string, unknown>;
  /** 确认层自动放行时的来源标注（如 "mode:autoEdit"）；进 l2_confirm 审计 decision，与用户手点同意区分 */
  autoBy?: string;
}

export interface AgentHostDeps {
  workspace: Workspace;
  audit: Audit;
  sessions: PiSessionStore;
  /** 管理端插件包技能目录提供者（M5）：SkillStore 每次 load 现取，安装/卸载后 reloadSkills 即生效 */
  managedSkillDirs?: () => string[];
  emit: (ev: UiEvent) => void;
  confirm: (req: ConfirmRequest) => Promise<boolean>;
  selfTest: boolean;
  /** MCP 连接器宿主（PRD 4.4）：目录/工具构建/执行 */
  connectors: ConnectorHost;
  /** 企业知识库（PRD 4.5）：目录与代理检索 */
  knowledge: KnowledgeProvider;
  /** 个人知识库（PRD 4.5）：本地真实现 */
  personalKb: PersonalKbStore;
  /** 浏览器桥 A（方案 §5，可选）：提供 browser_* 工具面 */
  browser?: { open(u: string, source?: "agent" | "user"): string; snapshot(): Promise<string>; click(s: string): Promise<string>; type(s: string, t: string): Promise<string>; extract(s: string): Promise<string>; screenshot(root: string): Promise<string>; consoleTail(n?: number): ConsoleEntry[]; readonly sameOriginNext: boolean };
}

interface ThinkingConfig {
  levels: Array<{ id: string; label: string }>;
  defaultId: string;
  budgets: Record<string, number>;
}

interface CompactionConfig {
  enabled: boolean;
  /** 触发阈值 = contextWindow × contextRatio（默认 1，即窗口减 reserve 后触发） */
  contextRatio?: number;
  reserveTokens?: number;
  keepRecentTokens?: number;
}

interface AppConfig {
  model: {
    providerId: string;
    providerName: string;
    baseUrl: string;
    /** 配置直持密钥（管理端统一下发的 mock；优先于 apiKeyEnv） */
    apiKey?: string;
    apiKeyEnv?: string;
    models: Array<{ id: string; name: string; contextWindow: number; maxTokens: number; thinkingLevelMap?: Record<string, string | null>; input?: string[] }>;
    /** 思考强度配置（PRD 3.4 模型接入） */
    thinking?: ThinkingConfig;
    /** OpenAI 兼容参数直传（thinkingFormat/maxTokensField 等）；缺省由 pi 按 provider/baseUrl 自动探测 */
    compat?: Record<string, unknown>;
  };
  basePrompt: string;
  experts: { defaultId: string; items: ExpertDef[] };
  compaction?: CompactionConfig;
  /** agent 命令执行（方案 C 自研）：只读白名单 L1 自动执行，其余 L2 确认；管理端可下发收敛 */
  shell?: { enabled?: boolean; readOnlyCommands?: string[]; defaultTimeoutSec?: number };
}

export class AgentHost {
  private agent: any = null;
  private allTools: any[] = [];
  private registry!: ExpertRegistry;
  private skillStore: SkillStore;
  private skillBlock = "";
  private currentExpertId = "";
  private skillsLoaded = 0;
  private sessionId: string | null = null;
  // 当前会话标题（新建时定稿；session_saved 事件与 pi 索引共用）
  private sessionTitle = "";
  // 停用的技能（市场开关）：不注入系统提示词，本机不调用；持久化在 config/resources.json
  private disabledSkills = new Set<string>();
  // MCP 连接器：市场停用集合（持久化）+ 会话挂载集合（内存，composer 多选）
  private disabledConnectors = new Set<string>();
  private activeConnectors = new Set<string>();
  // 知识库：市场停用集合（持久化，企业库用）+ 会话挂载集合（内存，composer 多选；个人库不受专家白名单约束）
  private disabledKnowledge = new Set<string>();
  private activeKnowledge = new Set<string>();
  // pi 的 Type 构造器（init 时留存，连接器工具动态构建用）
  private piType: any = null;
  // pi 原语引用（init 装载，rebuildModel 热切换复用）
  private piRefs: { piAi: any; piCore: any } | null = null;
  // pi AgentHarness（0.85 runtime）：编排/事件/确认门/自动压缩/逐事件落盘全部由 pi 承担
  private harness: any = null;
  private lane: any = null;
  private harnessSession: any = null;
  private piCtx: any = null;
  // 消息镜像（watch 快照重放；事件驱动失效，惰性重建——替代 agent.state.messages）
  private msgMirror: any[] = [];
  private mirrorDirty = true;
  // 当前思考档位（pi 原生 id：off/low/medium/high；lane.setThinkingLevel 同步）
  private thinkingId = "off";
  // 当前生效工具面（基础 + 已挂载连接器/知识库；lane.setTools 同步）
  private curTools: any[] = [];
  // 最近一条助手消息的 stopReason（bridge 捕获；"error" 表示模型调用失败且无输出）
  private lastStopReason: string | null = null;
  private lastModelError = "";
  private summaryPrefix = "";
  private summarySuffix = "";
  private modelsRef: any = null;
  private modelRef: any = null;
  // 记忆系统
  private memorySystem: MemorySystem | null = null;
  private memoryConfigStore: MemoryConfigStore | null = null;
  private memoryConfig: MemoryConfig = {
    bm25: { enabled: true },
    vector: {
      enabled: false,
      embeddingEndpoint: '',
      embeddingModel: '',
      embeddingDimension: 1024,
      summaryModelSource: 'current',
      timeout: 5000,
      maxRetries: 2,
      failureThreshold: 3
    }
  };

  constructor(private cfg: AppConfig, private deps: AgentHostDeps) {
    this.registry = new ExpertRegistry(cfg.experts.items, cfg.experts.defaultId);
    this.skillStore = new SkillStore(deps.workspace.dirs.skillsPersonal, deps.workspace.dirs.skillsEnterprise, deps.managedSkillDirs ?? (() => []));
  }

  async init(): Promise<void> {
    // ① SKILL 加载（个人区 + 企业区，PRD 4.2/4.3 客户端侧）；市场停用状态从 resources.json 恢复
    await this.loadDisabledSkills();
    const loaded = await this.skillStore.load();
    this.skillsLoaded = loaded.count;
    this.deps.audit.append({ event: "skills_load", count: loaded.count, names: this.skillStore.list().map((s) => s.name) });

    // ② 记忆系统初始化
    try {
      // 使用 memory 目录（已在 OrdoDirs 中定义）
      const memoryDir = this.deps.workspace.dirs.memory;

      // 加载配置
      this.memoryConfigStore = new MemoryConfigStore(memoryDir);
      this.memoryConfig = this.memoryConfigStore.load();

      // 初始化记忆系统
      this.memorySystem = new MemorySystem(memoryDir, this.memoryConfig);

      // 设置当前模型获取器
      this.memorySystem.setCurrentModelGetter(() => {
        const m = this.cfg.model;
        return {
          endpoint: m.baseUrl,
          model: m.models[0]?.id || '',
          apiKey: m.apiKey
        };
      });

      await this.memorySystem.initialize();
      // console.log('[HOST] 记忆系统已初始化');
    } catch (error) {
      console.error('[HOST] 记忆系统初始化失败:', error);
      // 不阻塞启动
    }

    // ③ pi 原语装载（模型注册/Agent 构建抽成可复用方法，供登录热接 rebuildModel 使用）
    const piAi = await dynamicImport("@earendil-works/pi-ai");
    const piCore = await dynamicImport("@earendil-works/pi-agent-core");
    this.piRefs = { piAi, piCore };
    this.piCtx = piCore.BACKGROUND_CONTEXT;

    // 摘要消息格式常量（pi 标准格式，见 harness/messages.ts；convertToLlm 重放包装用）
    this.summaryPrefix = piCore.COMPACTION_SUMMARY_PREFIX;
    this.summarySuffix = piCore.COMPACTION_SUMMARY_SUFFIX;

    // ③ 默认专家：基础工具全量注册（专家不做工具约束，PRD 3.10），技能块按专家白名单注入
    this.piType = piAi.Type;
    this.allTools = this.buildTools(piAi.Type);
    const expert = this.registry.defaultExpert;
    this.currentExpertId = expert.id;
    this.refreshPrompt();

    // ④ 模型注册（harness 懒建：首次 prompt/loadSession 时绑定 pi 会话创建；单机未配置 = 跳过，prompt 入口拦截）
    const refs = await this.buildModelRefs();
    if (!refs) {
      console.log("[HOST] 模型未配置（单机模式）：会话功能待「设置 → 模型」配置后生效");
      return;
    }
    this.modelsRef = refs.models;
    this.modelRef = refs.model;
    this.thinkingId = this.cfg.model.thinking?.defaultId ?? "off";
    this.curTools = [...this.allTools];
  }

  /** 按当前 cfg.model 注册 provider/models；未配置（models 空）返回 null。须在 init 之后调用。 */
  private async buildModelRefs(): Promise<{ models: any; model: any } | null> {
    const piRefs = this.piRefs!;
    const { createProvider, envApiKeyAuth } = piRefs.piAi;
    const { openAICompletionsApi } = await dynamicImport("@earendil-works/pi-ai/api/openai-completions.lazy");

    const m = this.cfg.model;
    const thinking = m.thinking;
    if (m.models.length === 0) return null;
    const provider = createProvider({
      id: m.providerId,
      name: m.providerName,
      baseUrl: m.baseUrl,
      // 密钥两途：配置直持（管理端下发）或环境变量；注意必须包一层 { apiKey: ... }
      auth: {
        apiKey: m.apiKey
          ? {
              name: `${m.providerName} Key`,
              resolve: async () => ({ auth: { apiKey: m.apiKey }, source: "config" }),
            }
          : envApiKeyAuth(`${m.providerName} Key`, [m.apiKeyEnv ?? "ORDO_MODEL_KEY"]),
      },
      api: openAICompletionsApi(),
      models: m.models.map((x) => ({
        id: x.id,
        name: x.name,
        api: "openai-completions",
        provider: m.providerId,
        baseUrl: m.baseUrl,
        // 思考型模型：档位经 agent-loop 转成 reasoning effort；「关闭」单档 = 非思考型（不启用 reasoning）
        reasoning: !!(thinking && thinking.levels && thinking.levels.length > 1),
        // 兼容参数两途：配置直传（自定义网关），或缺省走 pi 自动探测（deepseek.com → thinking:{type} + reasoning_effort + max_tokens + reasoning_content 回传）
        ...(m.compat ? { compat: m.compat } : {}),
        // 应用档位 → provider effort 值映射（如 DeepSeek：medium→high，官方映射表）
        ...(x.thinkingLevelMap ? { thinkingLevelMap: x.thinkingLevelMap } : {}),
        // 模型能力声明式透传（缺省纯文本）；input 含 "image" = 多模态（管理端配置/单机表单标记）
        input: Array.isArray(x.input) && x.input.length ? x.input : ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: x.contextWindow,
        maxTokens: x.maxTokens,
      })),
    });
    const models = piRefs.piAi.createModels();
    models.setProvider(provider);
    const model = models.getModel(m.providerId, m.models[0].id);
    if (!model) throw new Error(`模型注册失败: ${m.providerId}/${m.models[0].id}`);
    return { models, model };
  }

  /** AgentHarness 构建（0.85 runtime）：编排/事件/确认门/自动压缩/逐事件落盘由 pi 承担；session = 当前 pi 会话 */
  private async buildHarness(piSession: any): Promise<void> {
    const { piCore } = this.piRefs!;
    const m = this.cfg.model;
    const thinking = m.thinking;
    const created = await piCore.AgentHarness.create(
      {
        session: piSession,
        models: this.modelsRef,
        model: this.modelRef,
        tools: this.curTools,
        activeToolNames: this.curTools.map((t: any) => t.name),
        thinkingLevel: thinking ? this.thinkingId : "off",
        ...(thinking?.budgets ? { thinkingBudgets: thinking.budgets } : {}),
        streamOptions: {},
        // 函数式提示词：每轮现组（专家角色层/工作区 AGENTS.md/技能块切换即时生效，无需重建 harness）
        systemPrompt: () => this.composePrompt(this.registry.byId(this.currentExpertId) ?? this.registry.defaultExpert),
        compaction: this.piCompactionSettings(),
        // 关闭档时剥离重放消息中的 thinking 块（toProviderMessages）：Qwen 网关确保 enable_thinking:false 生效；
        // DeepSeek 思考档带工具时必须回传 reasoning_content（pi 自动序列化），开档保留即满足，切勿在开档剥离。
        toProviderMessages: async (messages: any[]) => this.convertToLlm(messages),
      },
      this.piCtx
    );
    this.harness = created.harness;
    this.harnessSession = piSession;
    this.lane = await created.harness.lane("main", this.piCtx);
    this.attachHarnessListeners();
    // 悬挂操作（上次崩溃遗留的未完 run/压缩）：本进程策略为丢弃提示——用户重新发送即可，
    // 不做自动续跑（半途输出接续语义不明）；明示用户 + 审计留痕便于排查
    if (Array.isArray(created.open) && created.open.length) {
      const n = created.open.length;
      console.log(`[HOST] 检测到 ${n} 个未完成操作（上次异常退出遗留），已忽略`);
      this.deps.audit.append({ event: "recovered_ops_dropped", count: n });
      this.deps.emit({ type: "notice", text: `检测到上次有 ${n} 个未完成任务（异常退出遗留），已忽略；如需继续请重新发送` });
    }
    this.mirrorDirty = true;
  }

  /** 事件桥 + L1/L2 确认门 + 工具审计挂载（每次 buildHarness 后重挂） */
  private attachHarnessListeners(): void {
    const h = this.harness;
    // 流式增量：harness 事件载荷的 AssistantMessageEvent 字段名为 event（agent-loop 时期叫 assistantMessageEvent）
    h.events.on("message_update", (ev: any) => {
      const delta = ev.event;
      if (delta?.type === "text_delta") this.deps.emit({ type: "text_delta", text: delta.delta });
      else if (delta?.type === "thinking_delta") this.deps.emit({ type: "thinking_delta", text: delta.delta });
    });
    h.events.on("message_end", (ev: any) => {
      this.mirrorDirty = true;
      void this.refreshMirror();
      if (ev.message?.role === "assistant") {
        // pi 在模型调用失败时以 stopReason="error" 正常收束回合（不抛异常，内容为空）：记录供收尾判定
        this.lastStopReason = String(ev.message?.stopReason ?? "");
        if (this.lastStopReason === "error") this.lastModelError = String(ev.message?.errorMessage ?? "");
        this.deps.emit({ type: "assistant_done" });
      }
    });
    h.events.on("tool_start", (ev: any) => this.deps.emit({ type: "tool_start", name: ev.toolName }));
    h.events.on("tool_end", (ev: any) => {
      this.mirrorDirty = true;
      void this.refreshMirror();
      this.deps.emit({ type: "tool_end", name: ev.toolName });
      this.deps.audit.append({ event: "tool_end", tool: ev.toolName });
    });
    h.events.on("run_start", () => {
      this.mirrorDirty = true;
    });
    h.events.on("run_end", () => {
      this.mirrorDirty = true;
      void this.refreshMirror();
    });
    // L1/L2 确认门：before_tool 可异步等待用户确认并可否决（block 后 pi 以错误 toolResult 回给模型）
    h.hooks.on("before_tool", async (e: any) => {
      const r = await this.beforeToolCall({ name: e.toolName }, e.args);
      if (r?.block) return { block: { reason: r.reason ?? "操作被拒绝" } };
      return undefined;
    });
  }

  /** cfg.compaction → pi CompactionSettings（contextRatio 折算为保留预算） */
  private piCompactionSettings(): { enabled: boolean; reserveTokens: number; keepRecentTokens: number } {
    const c = this.cfg.compaction ?? { enabled: true };
    const window = Number(this.cfg.model?.models?.[0]?.contextWindow ?? 128000) || 128000;
    const ratio = Number((c as any).contextRatio ?? 1) || 1;
    const budget = Math.max(2000, Math.floor((window * ratio) / 4));
    return {
      enabled: c.enabled !== false,
      reserveTokens: Math.min(16000, Math.max(2000, Math.floor(budget / 4))),
      keepRecentTokens: budget,
    };
  }

  /**
   * 模型热切换（M6-D 登录无重启）：cfg.model 已更新后调用——重建 provider 注册，
   * harness 绑同一 pi 会话重建（消息在会话里，天然不断流）；切到未配置（models 空）则拆除。
   */
  async rebuildModel(): Promise<void> {
    if (!this.piRefs) throw new Error("host 未初始化");
    const refs = await this.buildModelRefs();
    if (!refs) {
      await this.teardownHarness();
      this.modelsRef = null;
      this.modelRef = null;
      console.log("[HOST] 模型已拆除（未配置）：会话功能待配置后生效");
      return;
    }
    // 当前有活跃会话则 teardown 后按 id 重开（harness close 连带关闭旧 session 对象，不能复用引用）
    const hadHarness = !!this.harness;
    const keepSessionId = this.sessionId;
    if (hadHarness) await this.teardownHarness();
    this.modelsRef = refs.models;
    this.modelRef = refs.model;
    // 基础工具面随模型能力重算（如视觉模型隐藏 ocr_image）
    this.allTools = this.buildTools(this.piType);
    this.curTools = [...this.allTools];
    if (hadHarness && keepSessionId) {
      const piSession = await this.deps.sessions.openSessionObject(keepSessionId);
      if (piSession) await this.buildHarness(piSession);
    }
    await this.refreshDynamicTools();
  }

  // 在飞的 harness close 链：newSession（void 语境）fire，loadSession/prompt 前必须 await——
  // repo 对 session 有独占 claim，close 未落定就重新 open 同 id 会撞 "Session is already open"
  private teardownPromise: Promise<void> = Promise.resolve();

  /** 同步摘除引用/镜像/缓存并启动 close（fire）；引用清理即时生效，close 计入收尾链 */
  private detachHarnessNow(): void {
    const h = this.harness;
    if (!h) return;
    const lane = this.lane;
    const sid = this.sessionId;
    const queuedIds = [...this.queuedMsgs.keys()];
    this.harness = null;
    this.lane = null;
    this.harnessSession = null;
    this.msgMirror = [];
    this.mirrorDirty = true;
    // 排队消息随会话撤除（UI 立即清空；durable 队列在 close 前逐条撤销，不留幽灵消息）
    this.queuedMsgs.clear();
    this.emitQueue();
    // harness close 连带关闭其 session 对象：缓存摘除，后续按 id 重新打开
    this.deps.sessions.forget(sid);
    const closing = (async () => {
      for (const id of queuedIds) await lane.cancelQueued(id, this.piCtx).catch(() => {});
      await h.close(this.piCtx).catch(() => {});
    })();
    this.teardownPromise = this.teardownPromise.then(() => closing);
  }

  /** 等待在飞 close 后摘除并等本次 close 完成（loadSession/rebuildModel 等 async 语境用） */
  private async teardownHarness(): Promise<void> {
    await this.teardownPromise;
    this.detachHarnessNow();
    await this.teardownPromise;
  }

  /** 专家表热切换（M6-D 登录无重启）：目录 experts 到达/回落内置助手时调用；当前专家不在新表则回默认 */
  rebuildExperts(doc: { defaultId: string; items: ExpertDef[] }): void {
    this.cfg.experts = doc;
    this.registry = new ExpertRegistry(doc.items, doc.defaultId);
    if (!this.registry.byId(this.currentExpertId)) this.currentExpertId = this.registry.defaultExpert.id;
    this.refreshPrompt();
    void this.refreshDynamicTools();
  }

  // 提示词分层（PRD 3.1/3.10）：基座层不可覆盖，工作区约定层随工作区生效，专家只替换角色层，SKILL 块追加
  private composePrompt(expert: ExpertDef): string {
    return [this.cfg.basePrompt, this.workspaceBlock(), expert.rolePrompt, this.skillBlock].filter(Boolean).join("\n\n");
  }

  // 工作区指令文件 AGENTS.md（PRD 二期候选落地）：工作区根目录的项目级约定，注入基座层之后；
  // 每次组合现读（切工作区/改文件即生效），超长截断防提示词膨胀
  private workspaceBlock(): string {
    try {
      const raw = fsSync.readFileSync(path.join(this.deps.workspace.root, "AGENTS.md"), "utf-8").trim();
      if (!raw) return "";
      const cap = 8000;
      const body = raw.length > cap ? `${raw.slice(0, cap)}\n…（AGENTS.md 超长截断）` : raw;
      return `# 工作区约定（来自当前工作区的 AGENTS.md，优先级高于通用默认）\n${body}`;
    } catch {
      return ""; // 无文件或不可读：安静跳过
    }
  }

  // ---------- 专家切换（PRD 3.10：人设+业务资源白名单；基础工具不变；随会话锁定） ----------
  async switchExpert(id: string): Promise<ExpertInfo> {
    const expert = this.registry.byId(id);
    if (!expert) throw new Error(`未知专家: ${id}`);
    if (!this.modelsRef) throw new Error("agent 未初始化");
    const from = this.currentExpertId;
    this.currentExpertId = id;
    this.refreshPrompt(); // 角色层 + 按专家白名单过滤后的技能块（同步）
    await this.refreshDynamicTools(); // 连接器与知识库白名单随专家重算（个人库不受白名单约束）
    ExpertRegistry.auditSwitch(this.deps.audit, from, id);
    this.deps.emit({ type: "expert_switched", id: expert.id, name: expert.name });
    return { id: expert.id, name: expert.name, description: expert.description, skillWhitelist: expert.skillWhitelist, mcpWhitelist: expert.mcpWhitelist, kbWhitelist: expert.kbWhitelist };
  }

  get currentExpert(): ExpertInfo {
    const e = this.registry.byId(this.currentExpertId) ?? this.registry.defaultExpert;
    return { id: e.id, name: e.name, description: e.description, skillWhitelist: e.skillWhitelist, mcpWhitelist: e.mcpWhitelist, kbWhitelist: e.kbWhitelist };
  }

  listExperts(): ExpertInfo[] {
    return this.registry.list();
  }

  // ---------- 思考强度切换（PRD 3.4；off / low / medium / high） ----------
  thinkingConfigured(): boolean {
    return !!this.cfg.model.thinking;
  }

  switchThinking(id: string): { id: string; label: string } {
    const t = this.cfg.model.thinking;
    if (!t) throw new Error("当前模型未配置思考强度");
    const level = t.levels.find((l) => l.id === id);
    if (!level) throw new Error(`未知思考强度: ${id}`);
    if (!this.modelsRef) throw new Error("agent 未初始化");
    const from = this.thinkingId;
    this.thinkingId = id; // pi 原生档位：off→enable_thinking:false；档位→thinking_budget
    if (this.lane) void this.lane.setThinkingLevel(id, this.piCtx).catch(() => {});
    this.deps.audit.append({ event: "thinking_switch", from, to: id });
    this.deps.emit({ type: "thinking_switched", id: level.id, label: level.label });
    return { id: level.id, label: level.label };
  }

  currentThinking(): { id: string; label: string } {
    const t = this.cfg.model.thinking;
    if (!t) return { id: "n/a", label: "不可用" };
    const level = t.levels.find((l) => l.id === this.thinkingId) ?? t.levels[0];
    return { id: level.id, label: level.label };
  }

  listThinking(): Array<{ id: string; label: string }> {
    return this.cfg.model.thinking?.levels ?? [];
  }

  // ---------- 运行控制：停止（打断当前回合，PRD 3.9 用户可随时收回控制权） ----------
  private running = false;

  isRunning(): boolean {
    return this.running;
  }

  // 打断当前运行：pi lane.abort() 中止流式与工具执行，prompt 的 finally 仍会收尾保存会话；
  // 停止后未消费的排队消息一并撤除（排队区清空）
  cancel(): boolean {
    if (!this.lane || !this.running) return false;
    void this.lane
      .abort(this.piCtx)
      .then(() => {
        if (this.queuedMsgs.size) {
          this.queuedMsgs.clear();
          this.emitQueue();
        }
      })
      .catch(() => {});
    this.deps.audit.append({ event: "run_cancel" });
    return true;
  }

  // ---------- 运行中消息：引导（steer）与排队（followUp）——pi harness 队列透传 ----------
  // queuedMsgs 为主进程侧队列镜像（queue_changed 数据源）；真实队列在 pi lane（durable 落盘）
  private queuedMsgs = new Map<string, { kind: "steer" | "followUp"; raw: string; full: string }>();

  private emitQueue(): void {
    this.deps.emit({
      type: "queue_changed",
      items: [...this.queuedMsgs.entries()].map(([entryId, v]) => ({ entryId, kind: v.kind, text: v.raw })),
    });
  }

  /** 引导：插入当前任务——当前步骤的工具全部完成后、下一轮 LLM 调用前注入（不打断、不取消工具） */
  async steerMessage(text: string): Promise<string> {
    if (!this.lane || !this.running) throw new Error("当前没有运行中的任务，直接发送即可");
    const full = this.expandSkillRefs(text);
    const r = await this.lane.steer(full, undefined, this.piCtx);
    if (r.ok !== true || !r.value?.entryId) {
      throw new Error(String((r as any).error?.message ?? "引导消息入队失败"));
    }
    this.queuedMsgs.set(r.value.entryId, { kind: "steer", raw: text, full });
    this.deps.audit.append({ event: "queue_steered", text: full.slice(0, 80) });
    this.emitQueue();
    return r.value.entryId;
  }

  /** 排队：当前任务自然结束后追加执行（one-at-a-time：每轮消费最旧一条） */
  async queueFollowUp(text: string): Promise<string> {
    if (!this.lane || !this.running) throw new Error("当前没有运行中的任务，直接发送即可");
    const full = this.expandSkillRefs(text);
    const r = await this.lane.followUp(full, undefined, this.piCtx);
    if (r.ok !== true || !r.value?.entryId) {
      throw new Error(String((r as any).error?.message ?? "排队消息入队失败"));
    }
    this.queuedMsgs.set(r.value.entryId, { kind: "followUp", raw: text, full });
    this.deps.audit.append({ event: "queue_followup", text: full.slice(0, 80) });
    this.emitQueue();
    return r.value.entryId;
  }

  /**
   * 模式切换（排队 ⇄ 引导）：撤旧条目并以目标模式重新入队。
   * 发送即默认排队，切换到引导 = 当前步骤完成后插入；消息本体不变。
   */
  async switchQueued(entryId: string, target: "steer" | "followUp"): Promise<string | null> {
    const prev = this.queuedMsgs.get(entryId);
    if (!prev || !this.lane) return null;
    if (prev.kind === target) return entryId;
    await this.cancelQueued(entryId);
    const next =
      target === "steer"
        ? await this.lane.steer(prev.full, undefined, this.piCtx)
        : await this.lane.followUp(prev.full, undefined, this.piCtx);
    if (next.ok !== true || !next.value?.entryId) {
      throw new Error(String((next as any).error?.message ?? "模式切换入队失败"));
    }
    this.queuedMsgs.set(next.value.entryId, { kind: target, raw: prev.raw, full: prev.full });
    this.deps.audit.append({ event: "queue_switched", to: target, text: prev.full.slice(0, 80) });
    this.emitQueue();
    return next.value.entryId;
  }

  /** 撤回排队消息（回撤编辑/直接删除共用；消费前任意时刻可撤） */
  async cancelQueued(entryId: string): Promise<boolean> {
    const known = this.queuedMsgs.delete(entryId);
    if (this.lane) await this.lane.cancelQueued(entryId, this.piCtx).catch(() => {});
    if (known) {
      this.deps.audit.append({ event: "queue_cancelled", entryId });
      this.emitQueue();
    }
    return true;
  }

  /**
   * 排队消息兜底续跑：run 结束后 pi 的队列消费需要下一次 accept 触发——
   * 以空 prompt 续跑（accept 消费 inbox 中已排队消息作为新输入），直到队列清空。
   * 续跑期间保持运行态（UI 流式/浮标连续），事件桥正常转发。
   */
  private async drainQueuedAfterRun(): Promise<void> {
    for (let i = 0; i < 10 && this.lane && this.queuedMsgs.size; i++) {
      this.running = true;
      try {
        const r = await this.lane.prompt([], this.piCtx);
        await this.refreshMirror();
        if (r.ok !== true || r.value?.status !== "completed") break;
      } catch {
        break;
      }
    }
    this.running = false;
  }

  /** 队列快照（自测观测点）：未消费的引导/排队条目 */
  queueSnapshot(): Array<{ entryId: string; kind: string; text: string }> {
    return [...this.queuedMsgs.entries()].map(([entryId, v]) => ({ entryId, kind: v.kind, text: v.raw }));
  }

  /**
   * 消费检测（refreshMirror 尾部调用）：以 pi lane 的真实未消费队列为准
   * （watch 快照 queues）——文本匹配不可靠：同文本历史消息（如自测残留）会误判为已消费。
   */
  private async reconcileQueued(): Promise<void> {
    if (!this.queuedMsgs.size || !this.lane) return;
    try {
      const w = await this.lane.watch(this.piCtx);
      try {
        w.unsubscribe?.();
      } catch {
        /* 快照句柄释放失败无碍 */
      }
      const q = w.snapshot?.queues;
      const pending = new Set<string>();
      for (const arr of [q?.steer, q?.followUp, q?.nextRun]) {
        for (const it of arr ?? []) if (it?.entryId) pending.add(it.entryId);
      }
      let changed = false;
      for (const [entryId, v] of [...this.queuedMsgs]) {
        if (!pending.has(entryId)) {
          this.queuedMsgs.delete(entryId);
          this.deps.audit.append({ event: "queue_consumed", kind: v.kind, text: v.full.slice(0, 80) });
          changed = true;
        }
      }
      if (changed) this.emitQueue();
    } catch {
      /* lane 已关闭等：保留镜像，下次再试 */
    }
  }

  // ---------- 模型切换（PRD 3.4：管理端配置内的模型，员工可切换） ----------
  listModels(): { currentId: string; items: Array<{ id: string; name: string; desc: string }> } {
    return {
      currentId: String(this.modelRef?.id ?? this.cfg.model.models[0]?.id ?? ""),
      items: this.cfg.model.models.map((x) => ({
        id: x.id,
        name: x.name,
        desc: `${Math.round(x.contextWindow / 1024)}K 上下文 · ${this.cfg.model.providerName}`,
      })),
    };
  }

  switchModel(id: string): { id: string } {
    const model = this.modelsRef?.getModel(this.cfg.model.providerId, id);
    if (!model) throw new Error(`未配置的模型: ${id}`);
    if (!this.modelsRef) throw new Error("agent 未初始化");
    if (this.lane) {
      // pi lane 模型热切（ModelIdentity 还原）；未建 harness 时仅记录引用
      void this.lane.setModel({ provider: this.cfg.model.providerId, modelId: id }, this.piCtx).catch(() => {});
    }
    this.modelRef = model;
    this.deps.audit.append({ event: "model_switch", to: id });
    return { id };
  }

  // ---------- 技能启停（市场开关：停用 = 不注入提示词，本机不调用） ----------
  private resourcesFile(): string {
    return path.join(this.deps.workspace.dirs.config, "resources.json");
  }

  private async loadDisabledSkills(): Promise<void> {
    try {
      const d = JSON.parse(await fsp.readFile(this.resourcesFile(), "utf-8"));
      this.disabledSkills = new Set(Array.isArray(d?.disabled?.skill) ? d.disabled.skill.map(String) : []);
      this.disabledConnectors = new Set(Array.isArray(d?.disabled?.connector) ? d.disabled.connector.map(String) : []);
      this.disabledKnowledge = new Set(Array.isArray(d?.disabled?.kb) ? d.disabled.kb.map(String) : []);
    } catch {
      this.disabledSkills = new Set();
      this.disabledConnectors = new Set();
      this.disabledKnowledge = new Set();
    }
  }

  private async persistDisabledSkills(): Promise<void> {
    const file = this.resourcesFile();
    await fsp.mkdir(path.dirname(file), { recursive: true });
    await fsp.writeFile(
      file,
      JSON.stringify(
        { disabled: { skill: [...this.disabledSkills], connector: [...this.disabledConnectors], kb: [...this.disabledKnowledge] } },
        null,
        2
      ),
      "utf-8"
    );
  }

  // 当前专家的提示词：角色层 + 技能块（市场启停 ∩ 专家技能白名单）；基座层不变，工具不变。
  // harness 的 systemPrompt 为函数式注入（每轮现组），此处只需更新技能块缓存
  refreshPrompt(): void {
    const expert = this.registry.byId(this.currentExpertId) ?? this.registry.defaultExpert;
    const allowed = this.registry.allowedSkills(expert);
    this.skillBlock = this.skillStore.formatBlock(this.disabledSkills, allowed);
  }

  async setSkillEnabled(name: string, enabled: boolean): Promise<boolean> {
    const known = this.skillStore.listAll().some((s) => s.name === name);
    if (!known) throw new Error(`未知技能: ${name}`);
    if (enabled) this.disabledSkills.delete(name);
    else this.disabledSkills.add(name);
    await this.persistDisabledSkills();
    this.refreshPrompt();
    this.deps.audit.append({ event: "skill_toggle", name, enabled });
    return true;
  }

  // 市场页清单：名称/描述/来源分区/启停状态；active = 启用 ∩ 当前专家白名单（$ 引用与菜单只列 active）
  listSkillsRich(): Array<{ id: string; name: string; desc: string; scope: string; mine: boolean; enabled: boolean; active: boolean }> {
    return this.skillStore.listAll().map((s) => ({
      id: s.name,
      name: s.name,
      desc: s.description,
      scope: s.scope === "personal" ? "个人" : "企业",
      mine: s.mine,
      enabled: !this.disabledSkills.has(s.name),
      active: this.skillActive(s.name),
    }));
  }

  // ---------- MCP 连接器（PRD 4.4 远程 API 型：市场启停 + 会话挂载 + 专家白名单） ----------
  // 挂载集合 = 本会话 composer 多选；生效 = 挂载 ∩ 市场启用 ∩ 专家白名单，重建 agent 工具列表
  // 返回【生效集】（子集）：被专家白名单过滤掉的挂载如实暴露给 UI 提示，不静默吞
  async setActiveConnectors(names: string[]): Promise<string[]> {
    this.activeConnectors = new Set(names.map(String));
    await this.refreshDynamicTools();
    this.deps.audit.append({ event: "mcp_attach", connectors: [...this.activeConnectors] });
    const allowed = this.registry.allowedConnectors(this.registry.byId(this.currentExpertId) ?? this.registry.defaultExpert);
    this.emitMounts();
    return [...this.activeConnectors].filter((c) => !this.disabledConnectors.has(c) && (!allowed || allowed.has(c)));
  }

  // 挂载集广播：徽标/选中态以主进程为准（新建与续接会话的清空也会走这里，杜绝“看着挂了其实没有”）
  private emitMounts(): void {
    this.deps.emit({ type: "mounts_changed", connectors: [...this.activeConnectors], kbs: [...this.activeKnowledge] });
  }

  get attachedConnectors(): string[] {
    return [...this.activeConnectors];
  }

  async setConnectorEnabled(name: string, enabled: boolean): Promise<boolean> {
    const known = (await this.deps.connectors.listRich(this.disabledConnectors)).some((c) => c.name === name);
    if (!known) throw new Error(`未知连接器: ${name}`);
    if (enabled) this.disabledConnectors.delete(name);
    else this.disabledConnectors.add(name);
    await this.persistDisabledSkills();
    await this.refreshDynamicTools();
    this.deps.audit.append({ event: "connector_toggle", name, enabled });
    return true;
  }

  // active = 当前会话真正生效（挂载 ∩ 启用 ∩ 专家白名单）：UI 据此标注"当前专家不可用"，不再静默
  async listConnectorsRich(): Promise<Array<{ name: string; displayName: string; desc: string; endpoint: string; enabled: boolean; tools: string[]; attached: boolean; active: boolean }>> {
    const rich = await this.deps.connectors.listRich(this.disabledConnectors);
    const allowed = this.registry.allowedConnectors(this.registry.byId(this.currentExpertId) ?? this.registry.defaultExpert);
    return rich.map((c) => ({
      ...c,
      attached: this.activeConnectors.has(c.name),
      active: c.enabled && (!allowed || allowed.has(c.name)),
    }));
  }

  /** 自动化预授权目录（PRD 3.7）：无人值守时可勾选自动放行的敏感操作 = L2 基础工具 + L2 连接器操作 */
  async l2ToolCatalog(): Promise<Array<{ id: string; label: string }>> {
    const base = this.allTools.filter((t) => t.level === "L2").map((t) => ({ id: t.name, label: t.label }));
    const conn = await this.deps.connectors.listL2();
    return [...base, ...conn];
  }

  // ---------- 知识库（PRD 4.5：企业库代理检索 + 个人库本地实现；挂载后出现检索工具） ----------
  // 返回【生效集】：企业库被专家白名单过滤时如实告知（个人库不受白名单约束，PRD 3.10/4.5）
  async setActiveKnowledgeBases(ids: string[]): Promise<string[]> {
    this.activeKnowledge = new Set(ids.map(String));
    await this.refreshDynamicTools();
    this.deps.audit.append({ event: "kb_attach", kbs: [...this.activeKnowledge] });
    const effective = await this.knowledgeBasesEffective();
    this.emitMounts();
    return effective.map((k) => k.id);
  }

  async setKnowledgeBaseEnabled(id: string, enabled: boolean): Promise<boolean> {
    const known = (await this.listKnowledgeBasesRich()).some((k) => k.id === id);
    if (!known) throw new Error(`未知知识库: ${id}`);
    if (enabled) this.disabledKnowledge.delete(id);
    else this.disabledKnowledge.add(id);
    await this.persistDisabledSkills();
    await this.refreshDynamicTools();
    this.deps.audit.append({ event: "kb_toggle", id, enabled });
    return true;
  }

  async listKnowledgeBasesRich(): Promise<Array<{ id: string; name: string; desc: string; scope: string; mine: boolean; enabled: boolean; attached: boolean; active: boolean; docCount: number }>> {
    const ent = await this.deps.knowledge.catalog();
    const per = await this.deps.personalKb.list();
    const allowed = this.registry.allowedKnowledgeBases(this.registry.byId(this.currentExpertId) ?? this.registry.defaultExpert);
    return [
      ...ent.map((e) => ({
        id: e.id,
        name: e.name,
        desc: e.description,
        scope: "企业",
        mine: false,
        enabled: !this.disabledKnowledge.has(e.id),
        attached: this.activeKnowledge.has(e.id),
        active: !this.disabledKnowledge.has(e.id) && (!allowed || allowed.has(e.id)),
        docCount: e.docs?.length ?? 0,
      })),
      ...per.map((p) => ({
        id: p.id,
        name: p.name,
        desc: p.description,
        scope: "个人",
        mine: true,
        enabled: !this.disabledKnowledge.has(p.id),
        attached: this.activeKnowledge.has(p.id),
        active: !this.disabledKnowledge.has(p.id),
        docCount: p.docCount ?? 0,
      })),
    ];
  }

  // 生效知识库：企业库 = 挂载 ∩ 启用 ∩ 专家白名单；个人库 = 挂载 ∩ 启用（用户私有，不受白名单约束）
  async knowledgeBasesEffective(): Promise<Array<{ id: string; name: string; scope: "enterprise" | "personal" }>> {
    const expert = this.registry.byId(this.currentExpertId) ?? this.registry.defaultExpert;
    const allowed = this.registry.allowedKnowledgeBases(expert);
    const ent = (await this.deps.knowledge.catalog())
      .filter((c) => this.activeKnowledge.has(c.id) && !this.disabledKnowledge.has(c.id) && (!allowed || allowed.has(c.id)))
      .map((c) => ({ id: c.id, name: c.name, scope: "enterprise" as const }));
    const per = (await this.deps.personalKb.list())
      .filter((k) => this.activeKnowledge.has(k.id) && !this.disabledKnowledge.has(k.id))
      .map((k) => ({ id: k.id, name: k.name, scope: "personal" as const }));
    return [...ent, ...per];
  }

  // 跨库检索（search_knowledge 工具的执行体）：企业库走 Provider（管理端代理检索优先，M4 RAG；不可达降级本地关键词），个人库本地
  async searchKnowledge(query: string): Promise<Array<{ kb: string; scope: string; doc: string; section?: string; snippet: string; score: number }>> {
    const hits: any[] = [];
    const prov = this.deps.knowledge;
    for (const kb of await this.knowledgeBasesEffective()) {
      if (kb.scope === "enterprise") {
        let remote: Awaited<ReturnType<NonNullable<typeof prov.search>>> | null = null;
        if (typeof prov.search === "function") {
          try {
            remote = await prov.search(query, { kbId: kb.id, limit: 2 });
          } catch {
            remote = null; // 管理端不可达：降级本地关键词（目录 chunks 已随 catalog 缓存，PRD 4.6）
          }
        }
        if (remote) {
          hits.push(...remote);
          continue;
        }
        const entry = (await prov.catalog()).find((c) => c.id === kb.id);
        if (!entry) continue; // 管理端已下架：静默跳过
        for (const doc of entry.docs ?? []) hits.push(...searchChunks(entry.name, "enterprise", doc.name, doc.chunks, query));
      } else {
        hits.push(...(await this.deps.personalKb.search(kb.id, query, 2)));
      }
    }
    return hits.sort((a, b) => b.score - a.score).slice(0, 5);
  }

  // 动态工具（连接器 + 知识库检索）热挂：pi 每轮读 state.tools，重建即生效
  private async refreshDynamicTools(): Promise<void> {
    if (!this.modelsRef) return;
    const expert = this.registry.byId(this.currentExpertId) ?? this.registry.defaultExpert;
    const allowedConn = this.registry.allowedConnectors(expert);
    const effectiveConn = [...this.activeConnectors].filter((c) => !this.disabledConnectors.has(c) && (!allowedConn || allowedConn.has(c)));
    const connTools = effectiveConn.length ? await this.deps.connectors.buildTools(this.piType, effectiveConn) : [];
    const kbTool = await this.buildKnowledgeTool();
    const next = [...this.allTools, ...connTools, ...(kbTool ? [kbTool] : [])];
    const changed = next.length !== this.curTools.length || next.some((t, i) => t !== this.curTools[i]);
    this.curTools = next;
    // pi lane 工具面热更新（运行间隙生效；未建 harness 时下次 buildHarness 自然带入）
    if (this.lane && changed) {
      const names = next.map((t: any) => t.name);
      await this.harness.setTools(next, this.piCtx).catch(() => {});
      await this.lane.setActiveTools(names, this.piCtx).catch(() => {});
    }
  }

  // 检索工具：仅在挂载了至少一个生效知识库时出现（L1 只读；结果带来源供引用溯源）
  private async buildKnowledgeTool(): Promise<any | null> {
    if (!(await this.knowledgeBasesEffective()).length) return null;
    return {
      name: "search_knowledge",
      label: "检索知识库",
      level: "L1",
      description: [
        "检索当前挂载的知识库（企业知识库 + 个人知识库），返回相关片段与来源（库/文档/小节）。",
        "回答涉及公司制度、规范、流程、历史文档等事实性内容时，先用本工具检索再回答，并引用来源；",
        "检索不到相关内容就如实说明，不得编造。检索词用文档中可能出现的原词。",
      ].join("\n"),
      parameters: this.piType.Object({ query: this.piType.String({ description: "检索关键词或问题" }) }),
      execute: async (_id: string, p: any) => {
        const query = String(p?.query ?? "").trim();
        if (!query) throw new Error("检索词不能为空");
        const hits = await this.searchKnowledge(query);
        this.deps.audit.append({ event: "kb_search", query, hits: hits.length, scopes: hits.map((h) => h.scope) });
        const text = hits.length
          ? hits.map((h) => `【${h.kb}｜${h.doc}${h.section ? "｜" + h.section : ""}】\n${h.snippet}`).join("\n\n")
          : "（无匹配结果：已挂载的知识库中未检索到相关内容，请如实告知用户并建议补充文档）";
        return { content: [{ type: "text", text }], details: { hits: hits.length } };
      },
    };
  }

  // ---------- 技能生命周期（PRD 4.3：技能从会话沉淀（save_skill 工具）或导入，不走表单） ----------
  // 沉淀/导入/编辑/同步后重扫两个分区并重算提示词
  async reloadSkills(event: string, extra?: Record<string, unknown>): Promise<void> {
    const loaded = await this.skillStore.reload();
    this.skillsLoaded = loaded.count;
    this.refreshPrompt();
    this.deps.audit.append({ event, count: loaded.count, ...(extra ?? {}) });
    this.deps.emit({ type: "skills_changed", reason: event });
  }

  // 详情（含 body 与文件位置）；同名并存时个人区优先（加载顺序在前）
  readSkill(name: string): { name: string; description: string; content: string; filePath: string; scope: string; mine: boolean; enabled: boolean } {
    const s = this.skillStore.find(String(name ?? ""));
    if (!s) throw new Error(`未知技能: ${name}`);
    return {
      name: s.name,
      description: s.description,
      content: s.content,
      filePath: s.filePath,
      scope: s.scope === "personal" ? "个人" : "企业",
      mine: s.mine,
      enabled: !this.disabledSkills.has(s.name),
    };
  }

  // 编辑（仅个人区；企业技能由管理端管控，PRD 4.3）
  async updateSkill(name: string, input: { description?: string; content?: string }): Promise<void> {
    const s = this.skillStore.find(String(name ?? ""));
    if (!s) throw new Error(`未知技能: ${name}`);
    if (!s.mine) throw new Error(`「${name}」为企业技能，由管理端统一更新，本机不可编辑`);
    const description = input.description === undefined ? s.description : String(input.description).trim();
    const content = input.content === undefined ? s.content : String(input.content).trim();
    const descErr = validateSkillDescription(description);
    if (descErr) throw new Error(descErr);
    await fsp.writeFile(s.filePath, renderSkillMd(s.name, description, content), "utf-8");
    await this.reloadSkills("skill_update", { name: s.name });
  }

  // 删除（仅个人区）：目录移入 ~/.ordo/recycle（PRD 3.8 删除进回收站），可手工恢复
  async deleteSkill(name: string): Promise<void> {
    const s = this.skillStore.find(String(name ?? ""));
    if (!s) throw new Error(`未知技能: ${name}`);
    if (!s.mine) throw new Error(`「${name}」为企业技能，由管理端统一下发与回收，本机不可删除`);
    const srcDir = path.dirname(s.filePath);
    const recycleDir = path.join(this.deps.workspace.dirs.recycle, `skill-${s.name}-${Date.now()}`);
    await fsp.mkdir(path.dirname(recycleDir), { recursive: true });
    await fsp.rename(srcDir, recycleDir);
    if (this.disabledSkills.delete(s.name)) await this.persistDisabledSkills();
    await this.reloadSkills("skill_delete", { name: s.name, recycled: recycleDir });
  }

  // 导入技能包（WorkBuddy 式本地导入）：接受技能目录或 SKILL.md 文件，整目录拷入个人区
  async importSkillFromDir(src: string): Promise<{ name: string; description: string; scope: string; mine: boolean }> {
    const srcPath = path.resolve(String(src ?? ""));
    const stat = await fsp.stat(srcPath).catch(() => null);
    if (!stat) throw new Error("所选路径不存在");
    let srcDir = srcPath;
    let skillFile = path.join(srcPath, "SKILL.md");
    if (stat.isFile()) {
      if (path.basename(srcPath).toLowerCase() !== "skill.md") throw new Error("请选择技能目录（内含 SKILL.md）或 SKILL.md 文件本身");
      srcDir = path.dirname(srcPath);
      skillFile = srcPath;
    } else {
      const has = await fsp.access(skillFile).then(() => true).catch(() => false);
      if (!has) throw new Error("目录内未找到 SKILL.md（技能包需包含 SKILL.md）");
    }
    // 目标名取 frontmatter name（缺省用目录名），规范化为合法技能名；冲突时追加序号并改写 frontmatter 保持名/目录一致
    const raw = await fsp.readFile(skillFile, "utf-8");
    const fmName = /^name:\s*(.+)$/m.exec(raw)?.[1]?.trim().replace(/^["']|["']$/g, "") || "";
    const base = AgentHost.slugifySkill(fmName || path.basename(srcDir));
    let name = base;
    for (let i = 2; this.skillStore.hasName(name) || AgentHost.dirExistsSync(this.skillStore.personalPath(name)); i++) {
      name = `${base}-${i}`;
      if (i > 50) throw new Error("同名技能过多，请整理后重试");
    }
    const target = this.skillStore.personalPath(name);
    await fsp.cp(srcDir, target, { recursive: true });
    await fsp.writeFile(path.join(target, "SKILL.md"), raw.replace(/^name:.*$/m, `name: ${name}`), "utf-8");
    await this.reloadSkills("skill_import", { name, from: srcDir });
    const s = this.skillStore.find(name);
    if (!s) throw new Error("导入完成但技能未被加载，请检查 SKILL.md 格式（需含 name/description）");
    return { name: s.name, description: s.description, scope: "个人", mine: true };
  }

  // ---------- $技能 引用展开（PRD 4.3 调用时明确指定） ----------
  private skillActive(name: string): boolean {
    if (this.disabledSkills.has(name)) return false;
    const expert = this.registry.byId(this.currentExpertId) ?? this.registry.defaultExpert;
    const allowed = this.registry.allowedSkills(expert);
    return !allowed || allowed.has(name);
  }

  // 展开为 pi harness 的标准注入格式（<skill name=... location=...>content</skill>），原文作为附加指令保留
  private expandSkillRefs(text: string): string {
    const names = new Set<string>();
    for (const m of text.matchAll(/(^|\s)\$([a-z0-9][a-z0-9-]{0,63})/g)) names.add(m[2]);
    if (!names.size) return text;
    const blocks: string[] = [];
    const unavailable: string[] = [];
    for (const name of names) {
      const s = this.skillStore.find(name);
      if (!s) continue; // 非技能引用（如 $5 报价），原样发送
      if (!this.skillActive(name)) {
        unavailable.push(name);
        continue;
      }
      blocks.push(`<skill name="${s.name}" location="${s.filePath}">\nReferences are relative to ${path.dirname(s.filePath)}.\n\n${s.content}\n</skill>`);
    }
    if (unavailable.length) {
      this.deps.emit({ type: "notice", text: `技能 ${unavailable.join("、")} 当前不可用（已停用或不在当前专家白名单），本次按原文发送` });
    }
    return blocks.length ? `${blocks.join("\n\n")}\n\n${text}` : text;
  }

  private static dirExistsSync(p: string): boolean {
    try {
      return fsSync.statSync(p).isDirectory();
    } catch {
      return false;
    }
  }

  private static slugifySkill(s: string): string {
    const slug = s.trim().toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "").slice(0, 64);
    return slug || `skill-${Date.now().toString(36)}`;
  }

  // ---------- 自测/调试观测点 ----------
  messageCount(): number {
    return this.msgMirror.length;
  }

  // 消息快照（镜像由事件驱动刷新：message_end/tool_end/run_end 后台重建，prompt 收尾处落定）
  messages(): any[] {
    return this.msgMirror;
  }

  /** 从 pi lane 重放重建消息镜像（buildContextEntries 折叠语义；失败保留旧镜像） */
  private async refreshMirror(): Promise<void> {
    if (!this.lane || !this.piRefs) return;
    try {
      const entries = await this.lane.findEntries({ order: "oldestFirst" }, this.piCtx);
      this.msgMirror = replayEntries(this.piRefs.piCore, entries ?? []);
      this.mirrorDirty = false;
      this.reconcileQueued();
    } catch {
      /* 保留旧镜像 */
    }
  }

  // 自指定下标起，是否出现过 assistant 的 thinking 内容块（用于验证思考关闭）
  hasThinkingBlockSince(index: number): boolean {
    const msgs: any[] = this.msgMirror;
    for (let i = index; i < msgs.length; i++) {
      const m = msgs[i];
      if (m?.role !== "assistant") continue;
      for (const c of m.content ?? []) {
        if (c?.type === "thinking") return true;
      }
    }
    return false;
  }

  // 最近一条 assistant 的文本（自测断言用）
  lastAssistantText(): string {
    const msgs: any[] = this.msgMirror;
    for (let i = msgs.length - 1; i >= 0; i--) {
      if (msgs[i]?.role === "assistant") return AgentHost.textOf(msgs[i]);
    }
    return "";
  }

  // 消息列表首条角色（自测断言：压缩后应为 compactionSummary）
  headMessageRole(): string {
    return this.msgMirror[0]?.role ?? "";
  }
  activeToolNames(): string[] {
    // 当前生效工具 = 基础工具 + 已挂载连接器工具（专家不约束基础工具，PRD 3.10）
    return this.curTools.map((t: any) => t.name);
  }

  systemPromptText(): string {
    return this.composePrompt(this.registry.byId(this.currentExpertId) ?? this.registry.defaultExpert);
  }

  skillsCount(): number {
    return this.skillsLoaded;
  }

  // ---------- 工具（L1/L2 分级，PRD 3.9） ----------
  private buildTools(Type: any): any[] {
    const ws = this.deps.workspace;

    const readFile = {
      name: "read_file",
      label: "读取文件",
      level: "L1",
      description: "读取工作区内文件内容。L1 操作，自动执行。",
      parameters: Type.Object({ path: Type.String({ description: "相对工作区的路径" }) }),
      execute: async (_id: string, params: any) => {
        const abs = ws.resolveReadable(params.path); // 读：工作区 + 技能目录（SKILL.md 按需可读）
        const text = await fsp.readFile(abs, "utf-8");
        return { content: [{ type: "text", text }], details: { path: params.path } };
      },
    };

    // 图片 OCR（Tesseract.js）：非多模态模型"读图"的桥——提取图片中的文字（文档/表格截图效果好），
    // 不理解图像语义。L1 只读；语言数据首次使用联网下载并缓存 ~/.ordo/ocr-cache（离线机预置）。
    const ocrImage = {
      name: "ocr_image",
      label: "图片文字识别（OCR）",
      level: "L1",
      description:
        "提取图片中的文字内容（OCR）。适用于文档/表格/字幕类截图；不能理解图像语义（图表含义、照片场景无法分析）。L1 操作，自动执行。",
      parameters: Type.Object({ path: Type.String({ description: "相对工作区的图片路径（png/jpg/webp/gif/bmp）" }) }),
      execute: async (_id: string, params: any) => {
        const abs = ws.resolveReadable(params.path);
        try {
          const text = await ocrImageFile(abs);
          return {
            content: [{ type: "text", text: text ? `OCR 提取文字（chi_sim+eng）：\n${text}` : "未识别到文字（可能为纯图形图片，或清晰度不足）" }],
            details: { path: params.path },
          };
        } catch (e) {
          const msg = String((e as Error)?.message ?? e);
          throw new Error(/fetch|network|download/i.test(msg) ? `OCR 语言数据需首次联网下载（缓存于 ~/.ordo/ocr-cache；离线机请预置该目录）。原始错误：${msg}` : `OCR 失败：${msg}`);
        }
      },
    };

    const writeFile = {
      name: "write_file",
      label: "写入文件",
      level: "L2",
      description: "向工作区写入文件。L2 操作，需本人确认。",
      parameters: Type.Object({
        path: Type.String({ description: "相对工作区的路径" }),
        content: Type.String({ description: "写入内容" }),
      }),
      execute: async (_id: string, params: any) => {
        const abs = ws.resolveInside(params.path);
        await fsp.mkdir(path.dirname(abs), { recursive: true });
        await fsp.writeFile(abs, params.content, "utf-8");
        return { content: [{ type: "text", text: `已写入 ${params.path}` }], details: { path: params.path } };
      },
    };

    // 计划上报（方案 §3 浮标数据源）：多步骤任务先列计划、随执行更新状态；状态直通渲染端浮标
    const updatePlan = {
      name: "update_plan",
      label: "更新计划",
      level: "L1",
      description: "上报或更新任务执行计划（步骤清单与各自状态）。多步骤任务开始时先建计划，随执行推进更新。",
      parameters: Type.Object({
        steps: Type.Array(
          Type.Object({
            text: Type.String({ description: "步骤描述（短语）" }),
            status: Type.Union([Type.Literal("pending"), Type.Literal("running"), Type.Literal("done")], { description: "步骤状态" }),
          })
        ),
      }),
      execute: async (_id: string, params: any) => {
        const steps = Array.isArray(params.steps) ? params.steps : [];
        this.deps.emit({ type: "plan_update", steps });
        const done = steps.filter((s: any) => s.status === "done").length;
        return { content: [{ type: "text", text: `计划已更新（${done}/${steps.length}）` }], details: {} };
      },
    };

    // ---------- Agent Office 工具族（OfficeCLI 引擎，方案 A 修订版）：docx/xlsx/pptx 生成与编辑 ----------
    // 设计口径：结构化参数进、引擎序列化出；编辑匹配不到如实报错；与 write_file 同围栏（仅工作区内）；全 L2。
    const officeTools: any[] = (() => {
      const ensureTarget = (p: any): string => {
        const rel = String(p?.path ?? "").trim();
        if (!rel) throw new Error("缺少 path 参数");
        if (!officeAvailable()) throw new Error("OfficeCLI 引擎不可用（二进制缺失，无法处理 Office 文档）");
        return ws.resolveInside(rel); // 围栏：仅工作区内（与 write_file 一致）
      };
      const capCount = (n: number, what: string) => {
        if (!Number.isFinite(n) || n < 1) throw new Error(`${what} 不能为空`);
        if (n > 200) throw new Error(`${what} 超上限（200）`);
      };
      // sections → markdown：docx 走 officecli markdown 元素（标题/表格/列表/加粗一次成型）；
      // 注意块内（表格行/列表项）必须单换行紧邻，块间用空行分隔，否则表格语法被拆散
      const sectionsToMd = (sections: any[]): string => {
        const parts: string[] = [];
        for (const s of sections ?? []) {
          const t = String(s?.type ?? "");
          if (t === "heading") {
            const lv = Math.min(Math.max(Number(s.level) || 1, 1), 4);
            parts.push(`${"#".repeat(lv)} ${String(s.text ?? "")}`);
          } else if (t === "para") parts.push(String(s.text ?? ""));
          else if (t === "bullets") {
            const items = (s.items ?? []).map((it: any) => `- ${String(it)}`);
            if (items.length) parts.push(items.join("\n"));
          } else if (t === "table" && Array.isArray(s.rows) && s.rows.length) {
            const rows: any[][] = s.rows.map((r: any) => (Array.isArray(r) ? r : [r]));
            const lines = [`| ${rows[0].join(" | ")} |`, `| ${rows[0].map(() => "---").join(" | ")} |`, ...rows.slice(1).map((r) => `| ${r.join(" | ")} |`)];
            parts.push(lines.join("\n"));
          } else throw new Error(`未知 section 类型：${t || "(空)"}（支持 heading/para/bullets/table）`);
        }
        return parts.join("\n\n");
      };
      // write_* 覆盖语义：close（释放可能驻留的句柄）→ 删旧 → 新建
      const recreate = async (abs: string) => {
        await officeRun(["close", abs], path.dirname(abs)).catch(() => {});
        await fsp.rm(abs, { force: true });
        await officeRun(["create", abs], path.dirname(abs));
      };
      const sectionsParam = Type.Array(
        Type.Object({
          type: Type.Union([Type.Literal("heading"), Type.Literal("para"), Type.Literal("bullets"), Type.Literal("table")]),
          level: Type.Optional(Type.Number({ description: "heading 标题级别 1~4" })),
          text: Type.Optional(Type.String()),
          items: Type.Optional(Type.Array(Type.String(), { description: "bullets 列表项" })),
          rows: Type.Optional(Type.Array(Type.Array(Type.String()), { description: "table 行（首行为表头）" })),
        })
      );

      const writeDocx = {
        name: "write_docx",
        label: "生成 Word",
        level: "L2",
        description:
          "生成 Word 文档（.docx，覆盖已有文件）。sections 为结构化内容块：标题(heading)/段落(para)/列表(bullets)/表格(table)。需本人确认。",
        parameters: Type.Object({ path: Type.String({ description: "相对工作区的输出路径（.docx）" }), sections: sectionsParam }),
        execute: async (_id: string, p: any) => {
          const abs = ensureTarget(p);
          capCount((p.sections ?? []).length, "sections");
          await recreate(abs);
          await officeBatch(abs, [{ command: "add", parent: "/body", type: "markdown", props: { markdown: sectionsToMd(p.sections) } }]);
          return { content: [{ type: "text", text: `已生成 ${p.path}（${p.sections.length} 节）` }], details: { path: p.path } };
        },
      };

      const writePptx = {
        name: "write_pptx",
        label: "生成 PPT",
        level: "L2",
        description:
          "生成演示文稿（.pptx，覆盖已有文件）。slides 每页 = 标题 + 要点列表（自动套用「标题和内容」版式）。需本人确认。",
        parameters: Type.Object({
          path: Type.String({ description: "相对工作区的输出路径（.pptx）" }),
          slides: Type.Array(Type.Object({ title: Type.String({ description: "页标题" }), bullets: Type.Optional(Type.Array(Type.String(), { description: "要点（每条一行）" })) })),
        }),
        execute: async (_id: string, p: any) => {
          const abs = ensureTarget(p);
          capCount((p.slides ?? []).length, "slides");
          await recreate(abs);
          await officeBatch(
            abs,
            (p.slides ?? []).map((s: any) => ({
              command: "add",
              parent: "/",
              type: "slide",
              props: { layout: "Title and Content", title: String(s.title ?? ""), text: (s.bullets ?? []).join("\n") },
            }))
          );
          return { content: [{ type: "text", text: `已生成 ${p.path}（${p.slides.length} 页）` }], details: { path: p.path } };
        },
      };

      const editDocx = {
        name: "edit_docx",
        label: "编辑 Word",
        level: "L2",
        description:
          "编辑现有 Word 文档。ops：replace_text（查找替换，匹配不到会报错）、set_paragraph（按序号改整段，1 起）、append（文末追加内容块）。需本人确认。",
        parameters: Type.Object({
          path: Type.String({ description: "相对工作区的文档路径（.docx）" }),
          ops: Type.Array(
            Type.Object({
              op: Type.Union([Type.Literal("replace_text"), Type.Literal("set_paragraph"), Type.Literal("append")]),
              find: Type.Optional(Type.String({ description: "replace_text：要查找的文本" })),
              replace: Type.Optional(Type.String({ description: "replace_text：替换为" })),
              all: Type.Optional(Type.Boolean({ description: "替换全部出现（默认 true）" })),
              index: Type.Optional(Type.Number({ description: "set_paragraph：段落序号（1 起）" })),
              text: Type.Optional(Type.String({ description: "新文本" })),
              sections: Type.Optional(sectionsParam),
            })
          ),
        }),
        execute: async (_id: string, p: any) => {
          const abs = ensureTarget(p);
          if (!fsSync.existsSync(abs)) throw new Error(`文件不存在：${p.path}`);
          capCount((p.ops ?? []).length, "ops");
          const cmds: Array<Record<string, unknown>> = [];
          for (const op of p.ops ?? []) {
            if (op.op === "replace_text") {
              const paras = await officeQuery(abs, "paragraph");
              const hit = paras.filter((x) => (x.text ?? "").includes(String(op.find)));
              if (!hit.length) throw new Error(`未找到要替换的内容：${String(op.find).slice(0, 60)}`);
              for (const h of op.all === false ? hit.slice(0, 1) : hit) {
                cmds.push({ command: "set", path: h.path, props: { text: (h.text ?? "").split(String(op.find)).join(String(op.replace)) } });
              }
            } else if (op.op === "set_paragraph") {
              const i = Number(op.index);
              if (!(i >= 1)) throw new Error("set_paragraph 需要 1 起的 index");
              cmds.push({ command: "set", path: `/body/p[${i}]`, props: { text: String(op.text ?? "") } });
            } else if (op.op === "append") {
              cmds.push({ command: "add", parent: "/body", type: "markdown", props: { markdown: sectionsToMd(op.sections ?? []) } });
            } else throw new Error(`未知 op：${op.op}`);
          }
          await officeBatch(abs, cmds);
          return { content: [{ type: "text", text: `已编辑 ${p.path}（${p.ops.length} 项操作）` }], details: { path: p.path } };
        },
      };

      const editPptx = {
        name: "edit_pptx",
        label: "编辑 PPT",
        level: "L2",
        description:
          "编辑现有演示文稿（页级，不整篇重生成）。ops：replace_text（可选限定页码）、add_slide（页尾加一页）、delete_slide（按页码删）。需本人确认。",
        parameters: Type.Object({
          path: Type.String({ description: "相对工作区的文档路径（.pptx）" }),
          ops: Type.Array(
            Type.Object({
              op: Type.Union([Type.Literal("replace_text"), Type.Literal("add_slide"), Type.Literal("delete_slide")]),
              find: Type.Optional(Type.String()),
              replace: Type.Optional(Type.String()),
              slide: Type.Optional(Type.Number({ description: "replace_text：限定页码（1 起，缺省全篇）" })),
              title: Type.Optional(Type.String({ description: "add_slide：页标题" })),
              bullets: Type.Optional(Type.Array(Type.String())),
              index: Type.Optional(Type.Number({ description: "delete_slide：页码（1 起）" })),
            })
          ),
        }),
        execute: async (_id: string, p: any) => {
          const abs = ensureTarget(p);
          if (!fsSync.existsSync(abs)) throw new Error(`文件不存在：${p.path}`);
          capCount((p.ops ?? []).length, "ops");
          const cmds: Array<Record<string, unknown>> = [];
          for (const op of p.ops ?? []) {
            if (op.op === "replace_text") {
              const shapes = await officeQuery(abs, "shape");
              const prefix = op.slide ? `/slide[${Number(op.slide)}]/` : "/slide[";
              const hit = shapes.filter((x) => x.path.startsWith(prefix) && (x.text ?? "").includes(String(op.find)));
              if (!hit.length) throw new Error(`未找到要替换的内容：${String(op.find).slice(0, 60)}`);
              for (const h of hit) {
                cmds.push({ command: "set", path: h.path, props: { text: (h.text ?? "").split(String(op.find)).join(String(op.replace)) } });
              }
            } else if (op.op === "add_slide") {
              cmds.push({
                command: "add",
                parent: "/",
                type: "slide",
                props: { layout: "Title and Content", title: String(op.title ?? ""), text: (op.bullets ?? []).join("\n") },
              });
            } else if (op.op === "delete_slide") {
              const i = Number(op.index);
              if (!(i >= 1)) throw new Error("delete_slide 需要 1 起的 index");
              cmds.push({ command: "remove", path: `/slide[${i}]` });
            } else throw new Error(`未知 op：${op.op}`);
          }
          await officeBatch(abs, cmds);
          return { content: [{ type: "text", text: `已编辑 ${p.path}（${p.ops.length} 项操作）` }], details: { path: p.path } };
        },
      };

      const editXlsx = {
        name: "edit_xlsx",
        label: "编辑 Excel",
        level: "L2",
        description:
          "编辑现有 Excel（.xlsx，不存在则新建）：按表更新单元格。value 为字面值；formula 为公式（不带 =，如 SUM(B2:B10)，引擎即时计算并缓存结果）。工作表不存在自动创建。需本人确认。",
        parameters: Type.Object({
          path: Type.String({ description: "相对工作区的文档路径（.xlsx）" }),
          updates: Type.Array(
            Type.Object({
              sheet: Type.String({ description: "工作表名" }),
              cells: Type.Array(
                Type.Object({
                  ref: Type.String({ description: "单元格引用，如 B4 或 B4:C9" }),
                  value: Type.Optional(Type.String({ description: "字面值（数字传数字字符串即可）" })),
                  formula: Type.Optional(Type.String({ description: "公式（不带前导 =）" })),
                })
              ),
            })
          ),
        }),
        execute: async (_id: string, p: any) => {
          const abs = ensureTarget(p);
          capCount((p.updates ?? []).length, "updates");
          if (!fsSync.existsSync(abs)) await officeRun(["create", abs], path.dirname(abs));
          // sheet 的显示名在 preview 字段（text 仅文本元素有）
          const existing = new Set((await officeQuery(abs, "sheet")).map((s) => String(s.text || s.preview || "")));
          const cmds: Array<Record<string, unknown>> = [];
          for (const u of p.updates ?? []) {
            const sheet = String(u.sheet ?? "").trim();
            if (!sheet) throw new Error("updates.sheet 不能为空");
            if (!existing.has(sheet)) {
              existing.add(sheet);
              cmds.push({ command: "add", parent: "/", type: "sheet", props: { name: sheet } });
            }
            capCount((u.cells ?? []).length, "cells");
            for (const c of u.cells ?? []) {
              const props: Record<string, unknown> = {};
              if (c.formula !== undefined && c.formula !== "") props.formula = String(c.formula);
              else if (c.value !== undefined) props.value = String(c.value);
              else throw new Error("单元格需要 value 或 formula 之一");
              cmds.push({ command: "set", path: `/${sheet}/${String(c.ref)}`, props });
            }
          }
          await officeBatch(abs, cmds);
          return { content: [{ type: "text", text: `已编辑 ${p.path}（${p.updates.length} 个工作表）` }], details: { path: p.path } };
        },
      };

      return [writeDocx, writePptx, editDocx, editPptx, editXlsx];
    })();

    // 浏览器桥 A 工具面（方案 §5）：browser_open 动态分级——跨源/首次 L2（确认卡呈现完整 URL），
    // 同源后续导航降 L1（levelOf 每次读取 getter，实时反映桥内批准源状态）
    const bridge = this.deps.browser;
    const extraTools: any[] = [];
    if (bridge) {
      const bOpen = {
        name: "browser_open",
        label: "打开网页",
        description: "在受控浏览器窗口打开 URL 并等待加载。跨站点或首次打开需本人确认（确认卡显示完整地址）；同源后续导航免确认。",
        parameters: Type.Object({ url: Type.String({ description: "完整 URL（http/https）" }) }),
        get level(): "L1" | "L2" {
          return bridge.sameOriginNext ? "L1" : "L2";
        },
        execute: async (_id: string, params: any) => {
          const r = await bridge.open(String(params.url));
          return { content: [{ type: "text", text: r }], details: { url: params.url } };
        },
      };
      const bSnapshot = {
        name: "browser_snapshot",
        label: "页面快照",
        level: "L1",
        description: "获取当前页面的简化 DOM 结构（标签+可见文本，深度与数量受限），用于了解页面内容。",
        parameters: Type.Object({}),
        execute: async () => ({ content: [{ type: "text", text: await bridge.snapshot() }], details: {} }),
      };
      const bClick = {
        name: "browser_click",
        label: "点击页面元素",
        level: "L1",
        description: "按 CSS 选择器点击页面元素。",
        parameters: Type.Object({ selector: Type.String({ description: "CSS 选择器" }) }),
        execute: async (_id: string, params: any) => {
          const r = await bridge.click(String(params.selector));
          return { content: [{ type: "text", text: r }], details: {} };
        },
      };
      const bType = {
        name: "browser_type",
        label: "页面输入",
        level: "L1",
        description: "向页面输入框输入文本（先定位聚焦再输入）。",
        parameters: Type.Object({ selector: Type.String({ description: "CSS 选择器" }), text: Type.String({ description: "要输入的文本" }) }),
        execute: async (_id: string, params: any) => {
          const r = await bridge.type(String(params.selector), String(params.text));
          return { content: [{ type: "text", text: r }], details: {} };
        },
      };
      const bExtract = {
        name: "browser_extract",
        label: "提取页面数据",
        level: "L1",
        description: "按 CSS 选择器提取页面元素的文本/链接/值（最多 50 个元素）。",
        parameters: Type.Object({ selector: Type.String({ description: "CSS 选择器" }) }),
        execute: async (_id: string, params: any) => {
          const r = await bridge.extract(String(params.selector));
          return { content: [{ type: "text", text: r }], details: {} };
        },
      };
      const bShot = {
        name: "browser_screenshot",
        label: "页面截图",
        level: "L1",
        description: "截取当前页面存证（存入工作区 browser-shots/，作为交付物可预览）。",
        parameters: Type.Object({}),
        execute: async () => {
          const rel = await bridge.screenshot(this.deps.workspace.root);
          return { content: [{ type: "text", text: `已截图存证：${rel}` }], details: { path: rel } };
        },
      };
      const bConsole = {
        name: "browser_console",
        label: "读控制台",
        level: "L1",
        description: "读取受控浏览器控制台最近 N 条输出（含页面错误，可用于排查）。",
        parameters: Type.Object({ tail: Type.Optional(Type.Number({ description: "取最近 N 条，默认 30" })) }),
        execute: async (_id: string, params: any) => {
          const list = bridge.consoleTail(Number(params?.tail) || 30);
          return { content: [{ type: "text", text: JSON.stringify(list) }], details: {} };
        },
      };
      extraTools.push(bOpen, bSnapshot, bClick, bType, bExtract, bShot, bConsole);
    }

    // 命令执行（方案 C 自研，pi 原生 bash 未采用）：只读白名单 L1 自动执行；
    // 其余（含链式/管道/子表达式）L2，确认卡显示完整命令。一次性执行、超时终止、输出截断回传
    const shellCfg = this.cfg.shell ?? {};
    if (shellCfg.enabled !== false) {
      const DEFAULT_READ_ONLY = [
        "dir", "get-childitem", "get-content", "get-item", "get-location",
        "tree", "type", "get-date", "whoami", "findstr", "where", "select-string",
      ];
      const readOnlySet = new Set((shellCfg.readOnlyCommands ?? DEFAULT_READ_ONLY).map((x) => String(x).toLowerCase()));
      const isReadOnlyCommand = (raw: unknown): boolean => {
        const cmd = String(raw ?? "").trim();
        if (!cmd) return false;
        if (/[\n;|&`]|\$\(/.test(cmd)) return false; // 链式/管道/子表达式：白名单语义失效，一律按 L2
        const head = (cmd.split(/\s+/)[0] || "").replace(/\.exe$/i, "").split(/[\\/]/).pop() || "";
        return readOnlySet.has(head.toLowerCase());
      };
      const runCommand = {
        name: "run_command",
        label: "执行命令",
        description:
          "执行一条 PowerShell 命令（一次性子进程，工作目录为工作区根，无交互）。查目录/读文本/搜字符串等只读命令免确认自动执行；其余命令需本人确认。输出超限截断，超时自动终止。",
        parameters: Type.Object({
          command: Type.String({ description: "完整命令（单条，不带链式分隔符）" }),
          timeout: Type.Optional(Type.Number({ description: "超时秒数（1~300，默认 60）" })),
        }),
        // 分级按命令动态判定（beforeToolCall 经 levelOf 调用）
        levelFor: (args: any) => (isReadOnlyCommand(args?.command) ? "L1" : "L2"),
        get level(): "L1" | "L2" {
          return "L2";
        },
        execute: async (_id: string, params: any) => {
          const cmd = String(params.command ?? "");
          const timeoutSec = Math.min(Math.max(Number(params.timeout) || (shellCfg.defaultTimeoutSec ?? 60), 1), 300);
          const started = Date.now();
          const res = await new Promise<{ out: string; err: string; code: number | null; timedOut: boolean }>((resolve) => {
            const child = spawn("powershell.exe", ["-NoProfile", "-Command", cmd], { cwd: ws.root, windowsHide: true });
            let out = "";
            let err = "";
            let timedOut = false;
            const timer = setTimeout(() => {
              timedOut = true;
              child.kill();
            }, timeoutSec * 1000);
            child.stdout?.on("data", (d) => {
              if (out.length < 200000) out += d.toString();
            });
            child.stderr?.on("data", (d) => {
              if (err.length < 50000) err += d.toString();
            });
            child.on("error", (e) => {
              clearTimeout(timer);
              resolve({ out, err: err + String(e.message), code: -1, timedOut });
            });
            child.on("close", (code) => {
              clearTimeout(timer);
              resolve({ out, err, code, timedOut });
            });
          });
          const ms = Date.now() - started;
          const clip = (t: string, n: number) => (t.length > n ? `…（输出超限，仅保留末尾 ${n} 字符）\n` + t.slice(-n) : t);
          const text = [
            res.timedOut ? `命令超时（${timeoutSec}s），已强制终止。已捕获输出：` : `退出码 ${res.code ?? "?"} · ${ms}ms`,
            res.out ? clip(res.out, 8000) : "",
            res.err ? `[stderr]\n${clip(res.err, 2000)}` : "",
          ]
            .filter(Boolean)
            .join("\n");
          this.deps.audit.append({
            event: "run_command",
            command: cmd.slice(0, 500),
            level: isReadOnlyCommand(cmd) ? "L1" : "L2",
            exitCode: res.code,
            timedOut: res.timedOut,
            ms,
          });
          return { content: [{ type: "text", text: text || "（无输出）" }], details: { command: cmd, exitCode: res.code, timedOut: res.timedOut } };
        },
      };
      extraTools.push(runCommand);
    }

    // 记忆检索工具（search_memory）- 根据配置动态注册
    if (shouldEnableSearchMemory(this.memoryConfig)) {
      const toolDef = createSearchMemoryToolDefinition(this.memoryConfig);
      const searchMemory = {
        name: toolDef.name,
        label: "检索记忆",
        level: "L1",
        description: toolDef.description,
        parameters: Type.Object({
          query: Type.String({ description: toolDef.input_schema.properties.query.description }),
          limit: Type.Optional(Type.Number({ description: toolDef.input_schema.properties.limit.description, default: 3 }))
        }),
        execute: async (_id: string, params: any) => {
          if (!this.memorySystem) {
            return { content: [{ type: "text", text: "记忆系统未初始化" }], details: {} };
          }
          const result = await executeSearchMemory(this.memorySystem, params, this.sessionId ?? undefined);
          return { content: [{ type: "text", text: result }], details: {} };
        }
      };
      extraTools.push(searchMemory);
    }

    const listFiles = {
      name: "list_files",
      label: "列出文件",
      level: "L1",
      description: "列出工作区内某目录的文件与子目录。L1 操作，自动执行。",
      parameters: Type.Object({ dir: Type.String({ description: "相对工作区的目录，默认 ." }) }),
      execute: async (_id: string, params: any) => {
        const abs = ws.resolveReadable(params?.dir || "."); // 列目录：工作区 + 技能目录
        const entries = await fsp.readdir(abs, { withFileTypes: true });
        const text = entries.map((e) => (e.isDirectory() ? `${e.name}/` : e.name)).join("\n") || "(空目录)";
        return { content: [{ type: "text", text }], details: {} };
      },
    };

    // 流程沉淀（PRD 3.6/4.3）：把会话中验证过的流程写成个人技能包；写个人技能区 = 工作区外写 = 需确认
    const saveSkill = {
      name: "save_skill",
      label: "保存技能",
      level: "L2",
      description: [
        "把本次会话验证过的流程沉淀为个人技能（写入个人技能区，会请求用户确认）。",
        "调用时机：用户要求「做成技能 / 沉淀流程 / 以后复用这套做法」时。",
        "写法：SKILL.md 正文写清标准流程、输出结构、数据口径、注意事项——写给未来的模型执行用，简洁可执行；",
        "固定模板/清单等辅助文件作为附加 files 一并打包（路径相对技能目录）。",
        "同名冲突会报错；经用户同意后可用 overwrite=true 覆盖。",
      ].join("\n"),
      parameters: Type.Object({
        name: Type.String({ description: "技能名：小写字母/数字/连字符（如 weekly-report）" }),
        description: Type.String({ description: "何时使用该技能（一句话，模型靠它判断触发时机）" }),
        files: Type.Array(
          Type.Object({
            path: Type.String({ description: "相对路径；必含 SKILL.md（只写正文，无需 frontmatter）" }),
            content: Type.String({ description: "文件内容" }),
          })
        ),
        overwrite: Type.Optional(Type.Boolean({ description: "同名覆盖（须先经用户同意）" })),
      }),
      execute: async (_id: string, p: any) => {
        const name = String(p.name ?? "").trim();
        const description = String(p.description ?? "").trim();
        const nameErr = validateSkillName(name);
        if (nameErr) throw new Error(nameErr);
        const descErr = validateSkillDescription(description);
        if (descErr) throw new Error(descErr);
        const rawFiles = Array.isArray(p.files) ? p.files : [];
        if (!rawFiles.length) throw new Error("files 不能为空");
        // 路径围栏：所有文件必须落在技能目录内（拒绝绝对路径/越界/盘符）
        const clean = new Map<string, string>();
        for (const f of rawFiles) {
          const rel = String(f?.path ?? "").replace(/\\/g, "/").replace(/^\.\//, "").replace(/^\/+/, "");
          if (!rel || rel.split("/").includes("..") || /^[a-zA-Z]:/.test(rel)) throw new Error(`非法文件路径: ${f?.path}`);
          clean.set(rel, rel === "SKILL.md" ? renderSkillMd(name, description, String(f?.content ?? "")) : String(f?.content ?? ""));
        }
        if (!clean.has("SKILL.md")) throw new Error("files 必须包含 SKILL.md（正文内容，无需 frontmatter）");
        const dir = this.skillStore.personalPath(name);
        if ((this.skillStore.hasName(name) || AgentHost.dirExistsSync(dir)) && !p.overwrite) {
          throw new Error(`已存在同名技能 ${name}；如用户同意覆盖，请以 overwrite=true 重新调用`);
        }
        await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
        await fsp.mkdir(dir, { recursive: true });
        for (const [rel, content] of clean) {
          const abs = path.join(dir, ...rel.split("/"));
          await fsp.mkdir(path.dirname(abs), { recursive: true });
          await fsp.writeFile(abs, content, "utf-8");
        }
        await this.reloadSkills("skill_create", { name, source: "agent", files: [...clean.keys()] });
        return {
          content: [{ type: "text", text: `技能 ${name} 已保存（${clean.size} 个文件），本会话即生效；可用 $${name} 指定调用` }],
          details: { name, files: [...clean.keys()] },
        };
      },
    };

    // 多模态模型能直接看图，ocr_image 冗余——不为视觉模型注册（非视觉模型才需要 OCR 桥）
    const vision = Array.isArray(this.cfg.model.models?.[0]?.input) && this.cfg.model.models[0].input.includes("image");
    return [readFile, ...(vision ? [] : [ocrImage]), writeFile, listFiles, saveSkill, updatePlan, ...officeTools, ...extraTools];
  }

  private levelOf(toolName: string, args?: any): "L1" | "L2" | "?" {
    // 连接器工具热挂在 state.tools 上，与基础工具一并查；
    // 带 levelFor 的工具（run_command）按调用参数动态分级（只读白名单 → L1）
    const pool: any[] = this.curTools;
    const tool = pool.find((t) => t.name === toolName);
    if (!tool) return "?";
    if (typeof tool.levelFor === "function") return tool.levelFor(args);
    return tool.level ?? "?";
  }

  // LLM 重放格式转换：compactionSummary 按 pi 标准格式转 user 消息；思考关闭档剥离 thinking 块
  private convertToLlm(messages: any[]): any[] {
    const off = this.thinkingId === "off";
    return messages
      .filter((m) => m && ["user", "assistant", "toolResult", "compactionSummary"].includes(m.role))
      .map((m) => {
        if (m.role === "compactionSummary") {
          return {
            role: "user",
            content: [{ type: "text", text: this.summaryPrefix + m.summary + this.summarySuffix }],
            timestamp: m.timestamp,
          };
        }
        if (!off || m.role !== "assistant" || !Array.isArray(m.content)) return m;
        return { ...m, content: m.content.filter((c: any) => c?.type !== "thinking") };
      });
  }

  // ---------- 上下文压缩（PRD 3.3：接近窗口上限自动摘要，用户可见不静默丢上下文） ----------
  // P2 起压缩编排由 pi harness 承担：自动档 = CompactionSettings(threshold) 随 run 触发；
  // compactNow 仅为自测/显式入口（同步设置后手动触发一次 lane.compact）

  async compactNow(
    settings?: { reserveTokens: number; keepRecentTokens: number }
  ): Promise<{ ok: boolean; reason?: string; tokensBefore?: number; tokensAfter?: number; messagesBefore?: number; messagesAfter?: number }> {
    if (!this.lane) return { ok: false, reason: "压缩组件未就绪" };
    const before = this.msgMirror.length;
    try {
      if (settings) await this.harness.setCompactionSettings(settings, this.piCtx);
      const result = await this.lane.compact(undefined, this.piCtx);
      await this.refreshMirror();
      const msgs = this.msgMirror;
      const ok = result.ok === true && result.value?.compaction?.status === "completed";
      if (!ok) {
        const reason = result.ok === false ? String(result.error?.message ?? "压缩被拒绝") : String(result.value?.compaction?.error?.message ?? "压缩未完成");
        this.deps.audit.append({ event: "context_compact_failed", reason });
        return { ok: false, reason };
      }
      // 摘要消息由 pi 落盘（原生 CompactionEntry）；tokens 取摘要消息携带值
      const summaryMsg = msgs.find((m: any) => m?.role === "compactionSummary");
      const tokensBefore = Number(summaryMsg?.tokensBefore ?? 0);
      const est = this.piRefs!.piCore.estimateTokens;
      const tokensAfter = msgs.reduce((s: number, m: any) => s + Number(est?.(m) ?? 0), 0);
      this.deps.audit.append({ event: "context_compact", tokensBefore, tokensAfter, messagesBefore: before, messagesAfter: msgs.length });
      this.deps.emit({
        type: "context_compacted",
        tokensBefore,
        tokensAfter,
        messagesBefore: before,
        messagesAfter: msgs.length,
        summary: String(summaryMsg?.summary ?? ""),
      });
      return { ok: true, tokensBefore, tokensAfter, messagesBefore: before, messagesAfter: msgs.length };
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      this.deps.audit.append({ event: "context_compact_failed", reason });
      return { ok: false, reason };
    }
  }

  private async beforeToolCall(toolCall: any, args: any): Promise<{ block: boolean; reason: string } | undefined> {
    const level = this.levelOf(toolCall.name, args);
    // 分级只进审计（后台有区分有记录）；用户界面不暴露 L1/L2 概念，确认弹窗只说"做什么、动哪些文件"
    this.deps.audit.append({ event: "tool_call", tool: toolCall.name, level, args: args ?? {} });

    if (level !== "L2") {
      return; // 放行（步骤可见性由工具组卡片呈现，不打扰）
    }

    const req: ConfirmRequest = { id: randomUUID(), tool: toolCall.name, args: args ?? {} };
    const approved = await this.deps.confirm(req);
    this.deps.audit.append({
      event: "l2_confirm",
      tool: toolCall.name,
      decision: approved
        ? req.autoBy
          ? `auto-approved(${req.autoBy})`
          : this.deps.selfTest
            ? "auto-approved(selftest)"
            : "approved"
        : "denied",
    });
    if (!approved) {
      return { block: true, reason: "本人确认拒绝：用户在确认弹窗中选择了取消" };
    }
  }

  /** 最近一条助手消息的结束原因（"error" = 模型调用失败且本轮无输出） */
  get lastAssistantStop(): string {
    return this.lastStopReason ?? "";
  }

  /** 模型调用失败的网关原文（如 "402: {...Insufficient Balance...}"），提取人话给用户 */
  private prettyModelError(): string {
    const raw = (this as any).lastModelError ?? "";
    if (!raw) return "";
    const m = /^\d+\s*:\s*(\{.*)$/s.exec(raw.trim());
    if (m) {
      try {
        const j = JSON.parse(m[1]);
        if (j?.message) return `${j.message}（${j.code ?? ""}）`.replace(/（）/g, "");
      } catch {
        /* 非 JSON 体原样截断 */
      }
    }
    return raw.slice(0, 120);
  }

  private usageMark = 0;

  /** 自上次读取以来的新增 assistant usage 增量（会话切换/回放时跳过积压，宁可少计不重计） */
  private takeUsageDelta(): { input: number; output: number } | null {
    const msgs = this.messages() as Array<{ role?: string; usage?: { input?: number; output?: number } }>;
    if (msgs.length < this.usageMark) this.usageMark = msgs.length;
    let input = 0;
    let output = 0;
    for (let i = this.usageMark; i < msgs.length; i++) {
      const m = msgs[i];
      if (m?.role === "assistant" && m.usage) {
        input += Number(m.usage.input ?? 0);
        output += Number(m.usage.output ?? 0);
      }
    }
    this.usageMark = msgs.length;
    return input || output ? { input, output } : null;
  }

  /** 重新生成：截掉最后一条 user 及其后消息（state.messages 赋值为复制语义，pi agent.d.ts 明确支持），重新 prompt 原文 */
  async regenerate(): Promise<void> {
    if (!this.modelsRef) throw new Error("模型未配置：单机模式请在「设置 → 模型」配置大模型 API");
    if (this.running) throw new Error("当前有任务在运行，请先停止");
    await this.refreshMirror();
    const messages: any[] = this.msgMirror;
    let lastUserIdx = -1;
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i]?.role === "user") {
        lastUserIdx = i;
        break;
      }
    }
    if (lastUserIdx < 0) throw new Error("当前会话没有可重新生成的消息");
    const text = AgentHost.textOf(messages[lastUserIdx]);
    if (!text) throw new Error("上一条消息无法还原为文本，无法重新生成");
    // 回退到该 user 消息之前：pi 树状会话原生支持（navigateTree 到 lastUser 的父节点，可选分支摘要关闭）
    if (this.lane) {
      try {
        const entries = await this.lane.findEntries({ order: "oldestFirst" }, this.piCtx);
        const msgEntries = entries.filter((e: any) => e?.type === "message" && e.message?.role === "user");
        const target = msgEntries[msgEntries.length - 1];
        if (target) {
          // parentId 为 null（首个 user）也合法：navigateTree(null) 即回到会话起点
          await this.lane.navigateTree(target.parentId ?? null, { summarize: false }, this.piCtx);
        }
      } catch {
        /* 回退失败（无 harness/树操作被拒）则直接重发——重复历史由压缩折叠兜底 */
      }
      await this.refreshMirror();
    }
    // 重新提问：附件块已内嵌在原文中（saveAttachments 不再重复执行；$ 引用已展开，重复展开无标记可匹配，幂等安全）
    await this.prompt(text);
  }

  /** 当前模型是否声明视觉能力（多模态，input 含 image）；无模型（未配置）为 false */
  supportsVision(): boolean {
    const m = this.cfg.model;
    return Array.isArray(m.models?.[0]?.input) && m.models[0].input.includes("image") && !!this.modelsRef;
  }

  /** 回答质量反馈（PRD 4.x 有用/无用）：落审计行，经 reporter 自动上报服务端（质量运营查询用） */
  feedback(value: "up" | "down"): void {
    this.deps.audit.append({ event: "answer_feedback", value, session: this.sessionId ?? null });
  }

  /** 确保 harness 就绪：新会话懒建 pi session + harness（标题在首轮 prompt 语境下定稿） */
  private async ensureHarness(firstPrompt: string): Promise<void> {
    await this.teardownPromise;
    if (this.lane) return;
    if (!this.modelsRef) throw new Error("模型未配置：单机模式请在「设置 → 模型」配置大模型 API");
    let id = this.sessionId;
    if (!id) {
      id = randomUUID();
      this.sessionId = id;
      const title = (firstPrompt.split("\n\n[用户附件]")[0] || "新会话").slice(0, 40) || "新会话";
      this.sessionTitle = title;
      await this.deps.sessions.createSessionObject(id, {
        title,
        expert: this.currentExpertId,
        wsId: this.deps.workspace.currentWsId,
        wsRoot: this.deps.workspace.root,
      });
      // 创建即广播：首轮刚开始侧栏就出现会话条目（session_saved 本就每轮幂等重发，
      // 渲染层处理为"设 id + 设标题 + 刷新"，多一次不影响语义）
      this.deps.emit({ type: "session_saved", id, title });
    }
    const piSession = await this.deps.sessions.openSessionObject(id);
    if (!piSession) throw new Error(`会话不存在: ${id}`);
    await this.buildHarness(piSession);
  }

  async prompt(text: string, attachments?: Array<{ name: string; size?: number; dataBase64?: string }>): Promise<void> {
    if (!this.modelsRef) {
      throw new Error("模型未配置：单机模式请在「设置 → 模型」配置大模型 API");
    }
    let full = text;
    let images: Array<{ type: "image"; data: string; mimeType: string }> | undefined;
    const valid = (attachments ?? []).filter((a): a is { name: string; size?: number; dataBase64: string } => !!a && !!a.name && typeof a.dataBase64 === "string" && a.dataBase64.length > 0);
    if (valid.length) {
      const saved = await saveAttachments(this.deps.workspace.root, valid, this.deps.audit);
      full = text + attachmentBlock(saved);
      // 多模态：图片附件直传模型（ImageContent）；同时仍落 .inbox 存档（agent 可用工具处理文件本身）
      if (this.supportsVision()) {
        const MIME: Record<string, string> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp", gif: "image/gif" };
        const imgs = valid
          .map((a, i) => ({ ext: String(a.name).split(".").pop()?.toLowerCase() ?? "", b64: a.dataBase64!, rel: saved[i] }))
          .filter((x) => MIME[x.ext])
          .map((x) => ({ type: "image" as const, data: x.b64, mimeType: MIME[x.ext] }));
        if (imgs.length) images = imgs;
      }
    }
    this.deps.emit({ type: "run_start", prompt: text }); // prompt 供渲染层补画用户气泡（主进程直驱 prompt 时输入框链路未走）
    this.running = true;
    try {
      await this.ensureHarness(text);
      // $技能 引用在此展开（pi harness 惯例：注入后进入消息历史，会话内保持一致）；界面展示与标题仍用原文
      const result = await this.lane.prompt(this.expandSkillRefs(full), images, this.piCtx);
      // RunResult 的 ok=true 仅表示操作落账；内层 status 才是运行结果（aborted=用户打断）
      if (result.ok === true && result.value?.status === "failed") {
        const why = String(result.value?.error?.message ?? "");
        if (!/abort/i.test(why)) throw new Error(why || "模型运行失败");
      }
    } catch (e) {
      const msg = String((e as any)?.message ?? e);
      if (/abort/i.test(msg)) {
        // 用户主动打断：正常收尾，不作为错误呈现
        this.deps.emit({ type: "notice", text: "已停止（当前回合被用户打断）" });
      } else {
        throw e;
      }
    } finally {
      this.running = false;
      this.deps.emit({ type: "run_end" });
      await this.refreshMirror();
      // token 计量（R1）：pi 在 assistant 消息挂 usage{input,output}；逐回合审计留痕，上报 worker 按日聚合
      try {
        const u = this.takeUsageDelta();
        if (u && (u.input > 0 || u.output > 0)) this.deps.audit.append({ event: "turn_usage", tokensIn: u.input, tokensOut: u.output });
      } catch {
        /* 计量不阻塞主流程 */
      }
      // 模型调用失败 pi 不抛异常（空内容收束）：不明示的话用户只看到"发出去没反应"；带网关原文（如余额不足）
      if (this.lastStopReason === "error") {
        const why = this.prettyModelError();
        this.deps.emit({ type: "notice", text: `模型服务调用失败（本轮无输出）${why ? `：${why}` : ""}。请检查网络/余额/模型配置后重试` });
      }
      // 排队消息兜底续跑：pi 0.85 的 turn 边界消费在部分入队时点（run 启动窗口）会错过，
      // run 落定后队列若仍有未消费条目，以空 prompt 触发新 run 把它们注入（最多 10 轮防失控）
      await this.drainQueuedAfterRun();
      // 自动压缩由 pi harness 按 CompactionSettings 阈值在 run 间隙触发（无需手动编排）
      await this.upsertSession(text);
      // 保存到记忆系统（异步，不阻塞）
      this.saveToMemory(text).catch(err => {
        console.error('[Memory] Failed to save conversation:', err);
      });
    }
  }

  // ---------- 会话生命周期（PRD 3.3：本地保留 / 续接） ----------
  get currentSessionId(): string | null {
    return this.sessionId;
  }

  async listSessions(): Promise<SessionMeta[]> {
    return this.deps.sessions.list();
  }

  // 新建会话：清空上下文，回到默认专家（专家随会话保存/恢复；上个会话的只读角色
  // 不带入新会话，避免用户在不知情下处于无写权限状态），思考强度保留（全局偏好）
  newSession(): void {
    if (!this.modelsRef) return;
    // 摘除当前 harness（正文已在 pi JSONL；新会话在下次 prompt 时懒建）
    this.detachHarnessNow();
    this.sessionId = null;
    this.sessionTitle = "";
    // 挂载（连接器/知识库）是会话级状态：新建即清空，不跨会话残留
    this.activeConnectors = new Set();
    this.activeKnowledge = new Set();
    if (this.currentExpertId !== this.registry.defaultExpert.id) {
      void this.switchExpert(this.registry.defaultExpert.id); // 异步刷连接器，不阻塞新建（其中含挂载清空后的工具重建）
    } else {
      void this.refreshDynamicTools();
    }
    this.emitMounts();
  }

  // 续接：恢复消息与所用专家（PRD 3.10 任务一致性）；并把工作区重锚定到该会话创建时的工作区（PRD 3.8）
  async loadSession(id: string): Promise<StoredSession> {
    // repo 对 session 独占：先等在飞的 teardown close 落定（newSession 后立即续接同一会话的场景）
    await this.teardownPromise;
    const data = await this.deps.sessions.load(id);
    if (!data) throw new Error(`会话不存在: ${id}`);
    if (!this.modelsRef) throw new Error("agent 未初始化");
    if (data.wsRoot && path.resolve(data.wsRoot) !== path.resolve(this.deps.workspace.root)) {
      if (fsSync.existsSync(data.wsRoot)) {
        this.deps.workspace.switchRoot(data.wsRoot);
      } else {
        // 会话锚定的工作区目录已不存在（被清理/换机/删盘）：绝不锚到幽灵目录——
        // 否则文件清单为空、读写全部落空。沿用当前工作区并明示
        this.deps.emit({ type: "notice", text: "该会话原工作区已不存在，已沿用当前工作区" });
      }
    }
    // 切换 harness 到目标 pi 会话（消息由 pi 重放接管，无需回填内存）；先等在飞的 teardown 收尾
    await this.teardownPromise;
    await this.teardownHarness();
    this.sessionId = id;
    this.sessionTitle = data.title ?? "";
    const piSession = await this.deps.sessions.openSessionObject(id);
    if (piSession) await this.buildHarness(piSession);
    this.msgMirror = Array.isArray(data.messages) ? data.messages : [];
    this.mirrorDirty = false;
    // 挂载是会话级状态：续接不继承上个会话的挂载（一期会话不落盘挂载清单）
    this.activeConnectors = new Set();
    this.activeKnowledge = new Set();
    if (data.expert && this.registry.byId(data.expert) && data.expert !== this.currentExpertId) {
      await this.switchExpert(data.expert);
    } else {
      await this.refreshDynamicTools();
    }
    this.emitMounts();
    this.deps.audit.append({ event: "session_load", id, messages: this.msgMirror.length });
    return data;
  }

  // 启动时恢复最近会话（交互模式）
  async loadLatestSession(): Promise<StoredSession | null> {
    const list = await this.deps.sessions.list();
    if (!list.length) return null;
    return this.loadSession(list[0].id);
  }

  // 会话元数据收尾（正文与压缩已由 pi harness 逐事件落盘；此处只更新 sidecar 索引的活跃时间）
  private async upsertSession(_lastPrompt: string): Promise<void> {
    try {
      const id = this.sessionId;
      if (!id || !this.msgMirror.length) return;
      await this.deps.sessions.touchMeta(id, { expert: this.currentExpertId });
      this.deps.emit({ type: "session_saved", id, title: this.sessionTitle });
    } catch (e) {
      // 索引更新失败不阻断主流程
      console.error("[HOST] 会话索引更新失败:", e instanceof Error ? e.message : e);
    }
  }

  private static textOf(m: any): string {
    if (!m) return "";
    if (typeof m.content === "string") return m.content;
    return (m.content ?? [])
      .filter((c: any) => c?.type === "text")
      .map((c: any) => c.text ?? "")
      .join("")
      .trim();
  }

  // ---------- 记忆系统相关方法 ----------

  /** 保存对话到记忆系统 */
  private async saveToMemory(userInput: string): Promise<void> {
    if (!this.memorySystem || !this.sessionId) return;

    const messages = this.msgMirror;
    if (messages.length < 2) return;

    // 获取最后一条助手消息
    let lastAssistant: any = null;
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i]?.role === 'assistant') {
        lastAssistant = messages[i];
        break;
      }
    }

    if (!lastAssistant) return;

    const assistantOutput = AgentHost.textOf(lastAssistant);
    if (!assistantOutput) return;

    // 生成 turn_id
    const turnId = `turn-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;

    // 异步保存（Fire-and-Forget）
    await this.memorySystem.addConversation(
      this.sessionId,
      turnId,
      userInput,
      assistantOutput
    );
  }

  /** 更新记忆系统配置 */
  async updateMemoryConfig(config: MemoryConfig): Promise<void> {
    // 验证配置
    const validation = MemoryConfigStore.validate(config);
    if (!validation.valid) {
      throw new Error(`配置验证失败: ${validation.errors.join(', ')}`);
    }

    this.memoryConfig = config;

    // 保存配置
    if (this.memoryConfigStore) {
      this.memoryConfigStore.save(config);
    }

    // 更新记忆系统
    if (this.memorySystem) {
      await this.memorySystem.updateConfig(config);
    }

    // 重新构建工具列表（因为 search_memory 工具的可见性取决于配置）
    if (this.piType) {
      this.allTools = this.buildTools(this.piType);

      // 重建基础工具面并同步 lane（保留连接器等动态工具）
      const connectorTools = this.curTools.filter((t: any) => !this.allTools.find(bt => bt.name === t.name));
      const next = [...this.allTools, ...connectorTools];
      const changed = next.length !== this.curTools.length || next.some((t, i) => t !== this.curTools[i]);
      this.curTools = next;
      if (this.lane && changed) {
        const names = next.map((t: any) => t.name);
        void this.harness.setTools(next, this.piCtx).catch(() => {});
        void this.lane.setActiveTools(names, this.piCtx).catch(() => {});
      }
    }
  }

  /** 获取记忆系统配置 */
  getMemoryConfig(): MemoryConfig {
    return this.memoryConfig;
  }

  /** 获取记忆系统统计信息 */
  getMemoryStats() {
    return this.memorySystem?.getStats() ?? null;
  }

  /** 删除会话记忆 */
  async deleteSessionMemory(sessionId: string): Promise<void> {
    if (this.memorySystem) {
      await this.memorySystem.deleteSession(sessionId);
    }
  }

  /** 设置记忆配置 */
  async setMemoryConfig(config: any): Promise<void> {
    this.memoryConfig = config;
    this.memoryConfigStore?.save(config);
    if (this.memorySystem) {
      await this.memorySystem.updateConfig(config);
    }
  }

  /** 测试总结模型 */
  async testMemorySummaryModel(testConfig: any): Promise<{ success: boolean; message: string }> {
    try {
      const endpoint = testConfig.summaryModelSource === 'current'
        ? this.cfg.model.baseUrl
        : testConfig.summaryEndpoint;
      const model = testConfig.summaryModelSource === 'current'
        ? this.cfg.model.models[0]?.id || ''
        : testConfig.summaryModel;
      const apiKey = testConfig.summaryModelSource === 'current'
        ? this.cfg.model.apiKey || ''
        : testConfig.summaryApiKey || '';

      if (!endpoint || !model) {
        return { success: false, message: '请配置模型接口地址和模型名' };
      }

      // 简单测试：请求一个总结
      const headers: Record<string, string> = {
        'Content-Type': 'application/json'
      };

      if (apiKey) {
        headers['Authorization'] = `Bearer ${apiKey}`;
      }

      const response = await fetch(`${endpoint}/chat/completions`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model: model,
          messages: [{ role: 'user', content: '请用一句话总结：今天天气不错。' }],
          max_tokens: 50
        })
      });

      if (!response.ok) {
        const errorText = await response.text().catch(() => response.statusText);
        return { success: false, message: `HTTP ${response.status}: ${errorText}` };
      }

      const data = await response.json();
      if (data.choices && data.choices[0]) {
        return { success: true, message: '连接成功！模型响应正常' };
      }

      return { success: false, message: '响应格式异常' };
    } catch (error: any) {
      return { success: false, message: error.message || String(error) };
    }
  }

  /** 测试向量化模型 */
  async testMemoryEmbeddingModel(testConfig: any): Promise<{ success: boolean; message: string; dimension?: number }> {
    try {
      const endpoint = testConfig.embeddingEndpoint;
      const model = testConfig.embeddingModel;
      const apiKey = testConfig.embeddingApiKey || '';

      if (!endpoint || !model) {
        return { success: false, message: '请配置向量化接口地址和模型名' };
      }

      const headers: Record<string, string> = {
        'Content-Type': 'application/json'
      };

      if (apiKey) {
        headers['Authorization'] = `Bearer ${apiKey}`;
      }

      // 测试：请求一个向量
      const response = await fetch(`${endpoint}/embeddings`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model: model,
          input: '测试文本'
        })
      });

      if (!response.ok) {
        const errorText = await response.text().catch(() => response.statusText);
        return { success: false, message: `HTTP ${response.status}: ${errorText}` };
      }

      const data = await response.json();
      if (data.data && data.data[0] && data.data[0].embedding) {
        const dimension = data.data[0].embedding.length;
        return {
          success: true,
          message: `连接成功！向量维度: ${dimension}`,
          dimension
        };
      }

      return { success: false, message: '响应格式异常' };
    } catch (error: any) {
      return { success: false, message: error.message || String(error) };
    }
  }
}

