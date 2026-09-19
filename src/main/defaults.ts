// M6 内置默认值：客户端运行时不再读 config.mock.json（其退役为 mock-server/自测夹具）。
// 平台行为四键（compaction/basePrompt/shell/browser）= 单机基线；联机模式由管理端下发覆盖（AdminConfigSync apply）。
// 值提炼自原 config.mock.json（v1.2 方案口径），修改请同步方案文档。

export const DEFAULT_BASE_PROMPT = `你是 Ordo 企业助手。以下是基座层规范，任何专家模式下均生效，不可被覆盖：
- 安全红线：只能访问工作区内路径；写操作直接调用 write_file 发起，由系统弹出确认卡经本人确认后执行（不要改为在对话中口头征求许可）
- 输出规范：中文、简洁、结论可溯源到来源文件
- 工具：读文件 read_file、写文件 write_file、列目录 list_files、沉淀技能 save_skill、更新计划 update_plan，路径相对工作区
- 计划：多步骤任务开始时先用 update_plan 列出步骤清单（全部 pending），随执行推进更新各步骤状态（running/done），让用户随时可见进度
- 命令：查目录/读文本/搜字符串等只读操作可用 run_command（白名单内免确认自动执行）；其余命令会弹确认卡；文件写入仍用 write_file
- 连接器：mcp__ 开头的是企业系统工具（ERP/OA 等，只读为主），按会话挂载；调用结果注明数据来源，不得虚构未返回的数据
- 知识库：涉及公司制度/规范/历史文档的问题先用 search_knowledge 检索（挂载了知识库才可用），回答引用来源（库/文档/小节）；检索不到就明说，不编造
- 流程沉淀：用户要求把本次流程做成技能/沉淀复用时，用 save_skill 把验证过的流程整理为个人技能（SKILL.md 正文写流程、输出结构、数据口径；模板清单等作为附加文件打包）
- 完成任务后简短汇报结果
- 诚实汇报：工具执行失败、被拦截或未执行时，必须如实告知用户未完成与原因，严禁声称已完成`;

export const DEFAULT_COMPACTATION = {
  enabled: true,
  contextRatio: 1,
  reserveTokens: 16384,
  keepRecentTokens: 20000,
};

export const DEFAULT_SHELL = {
  enabled: true,
  readOnlyCommands: ["dir", "Get-ChildItem", "Get-Content", "Get-Item", "Get-Location", "Tree", "Type", "Get-Date", "Whoami", "Findstr", "Where.exe", "Select-String"],
  defaultTimeoutSec: 60,
};

export const DEFAULT_BROWSER = { urlWhitelist: [] as string[] };

/** 单机模式自配模型的思考档位（固定四档；管理端下发模型用下发值） */
export const DEFAULT_THINKING = {
  levels: [
    { id: "off", label: "关闭" },
    { id: "low", label: "低" },
    { id: "medium", label: "中" },
    { id: "high", label: "高" },
  ],
  defaultId: "medium",
  budgets: { low: 512, medium: 2048, high: 8192 },
} as const;

/** 单机模式唯一内置专家（联机模式专家由管理端 catalog/experts 下发） */
export const DEFAULT_EXPERTS = {
  defaultId: "general",
  items: [
    {
      id: "general",
      name: "通用助手",
      description: "单机模式默认助手：本地技能 / 个人知识库 / 工作台全可用",
      rolePrompt: "",
      skillWhitelist: null,
      mcpWhitelist: null,
      kbWhitelist: null,
    },
  ],
};

/** 模型未配置时的占位（models 为空 → AgentHost 跳过模型注册，prompt 前拦截引导配置） */
export const EMPTY_MODEL = {
  providerId: "local",
  providerName: "未配置",
  baseUrl: "",
  apiKey: "",
  models: [],
  thinking: { levels: [{ id: "off", label: "关闭" }], defaultId: "off", budgets: {} },
};

/** 单机模型配置（~/.ordo/config.local.json，用户自配仅一个） → 运行时 ModelConfig */
export interface LocalModelInput {
  baseUrl: string;
  apiKey: string;
  modelId: string;
  modelName: string;
  /** 高级（M6 增强）：缺省 128K / 16K；思考型模型开关与默认档位（off/low/medium/high） */
  contextWindow?: number;
  maxTokens?: number;
  thinking?: boolean;
  thinkingDefault?: string;
  /** 视觉（多模态）：声明式标记（无跨厂商探测 API），开启后注册 input: ["text","image"]，图片可直传模型 */
  vision?: boolean;
}

/** 思考关闭时的单档配置 */
const THINKING_OFF = { levels: [{ id: "off", label: "关闭" }], defaultId: "off", budgets: {} } as const;

export function localModelToConfig(input: LocalModelInput) {
  const thinkingOn = input.thinking === true;
  const def = thinkingOn
    ? { ...DEFAULT_THINKING, defaultId: DEFAULT_THINKING.levels.some((l) => l.id === input.thinkingDefault) ? input.thinkingDefault! : "medium" }
    : { ...THINKING_OFF };
  return {
    providerId: "local",
    providerName: input.modelName || input.modelId || "自配模型",
    baseUrl: input.baseUrl,
    apiKey: input.apiKey,
    models: [
      {
        id: input.modelId,
        name: input.modelName || input.modelId,
        contextWindow: Number(input.contextWindow) > 0 ? Number(input.contextWindow) : 131072,
        maxTokens: Number(input.maxTokens) > 0 ? Number(input.maxTokens) : 16384,
        input: input.vision ? ["text", "image"] : ["text"],
      },
    ],
    // 开关即 pi 的 reasoning 生效开关（agent-host 按 thinking 配置注册档位）
    thinking: def,
  };
}

// ---------- 单机模型配置持久化（~/.ordo/config.local.json） ----------
import * as fsp from "node:fs/promises";
import * as path from "node:path";

export function validateLocalModel(input: Partial<LocalModelInput> | null | undefined): string | null {
  if (!input) return "配置不能为空";
  if (!/^https?:\/\//.test(String(input.baseUrl ?? ""))) return "接口地址需以 http:// 或 https:// 开头";
  if (!String(input.modelId ?? "").trim()) return "模型 ID 不能为空";
  if (!String(input.apiKey ?? "").trim()) return "API Key 不能为空";
  return null;
}

export async function loadLocalModel(home: string): Promise<LocalModelInput | null> {
  try {
    const raw = JSON.parse(await fsp.readFile(path.join(home, "config.local.json"), "utf-8")) as LocalModelInput;
    if (raw && typeof raw.baseUrl === "string" && raw.modelId) return raw;
  } catch {
    /* 未配置 */
  }
  return null;
}

export async function saveLocalModel(home: string, input: LocalModelInput): Promise<LocalModelInput> {
  const err = validateLocalModel(input);
  if (err) throw new Error(err);
  await fsp.writeFile(path.join(home, "config.local.json"), JSON.stringify(input, null, 2), "utf-8");
  return input;
}
