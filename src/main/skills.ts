// SKILL 加载（对应 PRD 4.2/4.3 客户端侧）：复用 Pi harness 的 loadSkills
// 个人区 ~/.ordo/skills/personal + 企业区 skills/enterprise，SKILL.md 带 frontmatter
// 启停（市场开关）：disabled 集合持久化在调用方；停用的技能不注入系统提示词（本机不调用）
import * as fsSync from "node:fs";
import * as path from "node:path";

const dynamicImport = new Function("s", "return import(s)") as (s: string) => Promise<any>;

export interface SkillSummary {
  name: string;
  description: string;
}

// pi harness 的技能命名规范（skills.ts validateName）：小写字母/数字/连字符，≤64
const NAME_RE = /^[a-z0-9][a-z0-9-]*$/;
const MAX_NAME = 64;
const MAX_DESC = 1024;

export function validateSkillName(name: string): string | null {
  if (!name) return "名称不能为空";
  if (name.length > MAX_NAME) return `名称长度不能超过 ${MAX_NAME}`;
  if (!NAME_RE.test(name) || name.includes("--")) return "名称仅允许小写字母、数字与连字符（如 weekly-report）";
  return null;
}

export function validateSkillDescription(desc: string): string | null {
  if (!desc.trim()) return "描述不能为空（模型靠它判断何时使用该技能）";
  if (desc.length > MAX_DESC) return `描述长度不能超过 ${MAX_DESC}`;
  return null;
}

// SKILL.md 渲染：frontmatter 值用 JSON 字符串形式（YAML 兼容），避免描述里的冒号/引号破坏解析
export function renderSkillMd(name: string, description: string, content: string): string {
  return `---\nname: ${name}\ndescription: ${JSON.stringify(description)}\n---\n\n${content.trim()}\n`;
}

export class SkillStore {
  private skills: any[] = [];
  private core: any = null;

  constructor(
    private personalDir: string,
    private enterpriseDir: string,
    /** 管理端插件包技能目录（M5）：每次 load 现取（安装/卸载后 reloadSkills 即生效）；同名时管理端下发优先 */
    private managedDirs: () => string[] = () => []
  ) {}

  async load(): Promise<{ count: number; systemPromptBlock: string; diagnostics: any[] }> {
    const core = await dynamicImport("@earendil-works/pi-agent-core");
    this.core = core;
    const { NodeExecutionEnv } = await dynamicImport("@earendil-works/pi-agent-core/node");
    const env = new NodeExecutionEnv({ cwd: process.cwd() });
    const { skills, diagnostics } = await core.loadSkills(env, [
      ...(this.managedDirs() || []).filter((d) => {
        try {
          return fsSync.existsSync(d);
        } catch {
          return false;
        }
      }),
      this.personalDir,
      this.enterpriseDir,
    ], core.BACKGROUND_CONTEXT);
    // 同名冲突：管理端下发（managed 目录内）优先（方案 §12.4 企业管控语义）
    const byName = new Map<string, any>();
    for (const s of skills) {
      const prev = byName.get(s.name);
      const mine = (this.managedDirs() || []).some((d) => String(s.filePath ?? "").startsWith(d));
      if (!prev || (mine && !(prev.__managed ?? false))) byName.set(s.name, mine ? Object.assign(s, { __managed: true }) : s);
    }
    this.skills = [...byName.values()];
    const block = skills.length ? String(core.formatSkillsForSystemPrompt(skills)) : "";
    return { count: skills.length, systemPromptBlock: block, diagnostics };
  }

  list(): SkillSummary[] {
    return this.skills.map((s) => ({ name: s.name, description: s.description }));
  }

  // 含来源分区的完整清单（市场页展示；mine = 个人区）
  listAll(): Array<{ name: string; description: string; scope: "personal" | "enterprise"; mine: boolean }> {
    return this.skills.map((s) => {
      const file = String(s.filePath ?? "");
      const scope: "personal" | "enterprise" = file.startsWith(this.personalDir) ? "personal" : "enterprise";
      return { name: s.name, description: s.description, scope, mine: scope === "personal" };
    });
  }

  // 单个技能全量信息（详情/编辑用；含 body 内容与文件位置）
  find(name: string): { name: string; description: string; content: string; filePath: string; scope: "personal" | "enterprise"; mine: boolean } | null {
    const s = this.skills.find((x) => x.name === name);
    if (!s) return null;
    const file = String(s.filePath ?? "");
    const scope: "personal" | "enterprise" = file.startsWith(this.personalDir) ? "personal" : "enterprise";
    return {
      name: s.name,
      description: s.description,
      content: String(s.content ?? ""),
      filePath: file,
      scope,
      mine: scope === "personal",
    };
  }

  // 变更后重载（创建/编辑/删除/导入共用）：重新扫描两个分区并返回统计
  async reload(): Promise<{ count: number; diagnostics: any[] }> {
    const loaded = await this.load();
    return { count: loaded.count, diagnostics: loaded.diagnostics };
  }

  // 个人区技能目录（创建/导入落点）
  personalPath(name: string): string {
    return path.join(this.personalDir, name);
  }

  hasName(name: string): boolean {
    return this.skills.some((s) => s.name === name);
  }

  // 按启停状态与专家白名单重算系统提示词块（disabled 中的技能对本机不可见；
  // allowed 为 null = 不收窄；空 Set = 不挂任何技能）
  formatBlock(disabled: Set<string>, allowed: Set<string> | null): string {
    const active = this.skills.filter(
      (s) => !disabled.has(s.name) && (!allowed || allowed.has(s.name))
    );
    if (!active.length || !this.core) return "";
    return String(this.core.formatSkillsForSystemPrompt(active));
  }
}
