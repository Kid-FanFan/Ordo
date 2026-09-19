// 常用任务模板（/ 命令）：name + 一句话说明 + 提示词正文。
// 形态对齐主流 agent 应用（Cursor /commands、Claude 自定义命令）：模板 = 可复用的提示词，
// 输入 / 选中后把正文插入输入框、可再编辑，不直接发送。
// 内置种子（可编辑可删除，不装不可改的假数据）+ 用户自建 CRUD；存储 ~/.ordo/templates.json
import fsp from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { Audit } from "./audit";

export interface TaskTemplate {
  id: string;
  /** 模板名（输入 /名 触发），不含斜杠 */
  name: string;
  description: string;
  /** 提示词正文（插入输入框的内容） */
  text: string;
  builtin?: boolean;
  createdAt: string;
}

export interface TemplateStoreDeps {
  home: string;
  audit: Audit;
}

const SEEDS: Array<Omit<TaskTemplate, "id" | "createdAt">> = [
  {
    name: "周报",
    description: "读取销售数据生成本周周报",
    text: "请读取 data/sales.txt，生成本周销售周报，并写入 out/weekly-report.md",
    builtin: true,
  },
  {
    name: "核对",
    description: "对数据文件做一致性核对",
    text: "请读取工作区的数据文件，对数字做一致性核对，输出核对表和发现的差异。",
    builtin: true,
  },
  {
    name: "浏览",
    description: "列出工作区结构并说明用途",
    text: "请列出工作区的文件结构，并简要说明每部分的用途。",
    builtin: true,
  },
];

function validateName(name: string): string | null {
  if (!name || name.length > 20 || name.includes("/")) return "模板名需 1–20 字且不含 /";
  return null;
}

export class TemplateStore {
  private items: TaskTemplate[] = [];
  private file: string;

  constructor(private deps: TemplateStoreDeps) {
    this.file = path.join(deps.home, "templates.json");
  }

  async init(): Promise<void> {
    try {
      const data = JSON.parse(await fsp.readFile(this.file, "utf-8"));
      if (Array.isArray(data.items)) {
        this.items = data.items.filter((t: any) => t && typeof t.name === "string" && typeof t.text === "string");
      }
    } catch {
      // 首次启动：种入内置模板
      this.items = SEEDS.map((s) => ({ ...s, id: `tpl-${randomUUID().slice(0, 8)}`, createdAt: new Date().toISOString() }));
      await this.persist().catch(() => {});
    }
  }

  private async persist(): Promise<void> {
    const tmp = `${this.file}.tmp`;
    await fsp.writeFile(tmp, JSON.stringify({ items: this.items }, null, 2), "utf-8");
    await fsp.rename(tmp, this.file);
  }

  list(): TaskTemplate[] {
    return this.items.map((t) => ({ ...t }));
  }

  async create(input: { name: string; description?: string; text: string }): Promise<TaskTemplate> {
    const name = String(input?.name ?? "").trim();
    const text = String(input?.text ?? "").trim();
    const nameErr = validateName(name);
    if (nameErr) throw new Error(nameErr);
    if (!text || text.length > 4000) throw new Error("模板内容需 1–4000 字");
    if (this.items.some((t) => t.name === name)) throw new Error(`已存在同名模板「${name}」`);
    const tpl: TaskTemplate = {
      id: `tpl-${randomUUID().slice(0, 8)}`,
      name,
      description: String(input?.description ?? "").trim().slice(0, 60),
      text,
      builtin: false,
      createdAt: new Date().toISOString(),
    };
    this.items.push(tpl);
    await this.persist();
    this.deps.audit.append({ event: "template_create", name });
    return { ...tpl };
  }

  async update(id: string, patch: { name?: string; description?: string; text?: string }): Promise<TaskTemplate> {
    const tpl = this.items.find((t) => t.id === id);
    if (!tpl) throw new Error(`模板不存在: ${id}`);
    if (patch.name !== undefined) {
      const name = String(patch.name).trim();
      const nameErr = validateName(name);
      if (nameErr) throw new Error(nameErr);
      if (this.items.some((t) => t.name === name && t.id !== id)) throw new Error(`已存在同名模板「${name}」`);
      tpl.name = name;
    }
    if (patch.description !== undefined) tpl.description = String(patch.description).trim().slice(0, 60);
    if (patch.text !== undefined) {
      const text = String(patch.text).trim();
      if (!text || text.length > 4000) throw new Error("模板内容需 1–4000 字");
      tpl.text = text;
    }
    await this.persist();
    this.deps.audit.append({ event: "template_update", name: tpl.name });
    return { ...tpl };
  }

  async remove(id: string): Promise<void> {
    const tpl = this.items.find((t) => t.id === id);
    if (!tpl) throw new Error(`模板不存在: ${id}`);
    this.items = this.items.filter((t) => t.id !== id);
    await this.persist();
    this.deps.audit.append({ event: "template_delete", name: tpl.name });
  }
}
