// 工作区与本地数据目录（对应 PRD 3.8）：
// ~/.ordo/{workspace,sessions,memory,rag,skills/personal,skills/enterprise,recycle,audit,logs,config}
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

const SEED_SALES = "本周销售数据（样例，由 Ordo 首次启动种子生成）：\n产品A,100\n产品B,200\n产品C,150\n";

const SEED_SKILL = `---
name: weekly-report
description: 生成销售周报时使用：规定周报结构（概况/明细/合计）与数据口径（以 data/sales.txt 为准）
---

# 周报生成规范

1. 数据来源：仅使用工作区 data/sales.txt 的数字，不编造
2. 结构：# 周报 → ## 本周销售概况 → 每产品一行 → 合计 → ## 说明
3. 输出路径：out/weekly-report.md
`;

export interface OrdoDirs {
  home: string;
  workspace: string;
  sessions: string;
  memory: string;
  rag: string;
  skillsPersonal: string;
  skillsEnterprise: string;
  recycle: string;
  audit: string;
  logs: string;
  config: string;
  /** 管理端插件包安装区（M5）：managed/{skills,mcp,cli,asset}/<pack>/<version> */
  managed: string;
}

export interface WorkspaceEntry {
  id: string;
  label: string;
  root: string;
  tag?: string;
}

// 工作区注册表（PRD 3.8：默认工作区 + 用户自选目录，落盘 ~/.ordo/config/workspaces.json）
// 记住「上次使用」：currentId 持久化，启动时恢复；会话锚定某个工作区后不可改（前端锁定）
export class WorkspaceRegistry {
  private entries: WorkspaceEntry[] = [];
  private cur = "default";

  constructor(
    private configDir: string,
    private defaultRoot: string
  ) {}

  load(): void {
    const file = path.join(this.configDir, "workspaces.json");
    try {
      const d = JSON.parse(fs.readFileSync(file, "utf-8"));
      if (Array.isArray(d.items)) {
        this.entries = d.items.filter((x: any) => x && typeof x.root === "string");
      }
      if (typeof d.currentId === "string") this.cur = d.currentId;
    } catch {
      this.entries = [];
    }
    // 默认项永远在首位且不可删除；root 以本机实际 home 为准（换机器/挪目录后自动纠正）
    this.entries = this.entries.filter((x) => x.id !== "default");
    this.entries.unshift({ id: "default", label: "默认工作区", root: this.defaultRoot, tag: "默认" });
    if (!this.entries.some((x) => x.id === this.cur)) this.cur = "default";
  }

  private save(): void {
    const file = path.join(this.configDir, "workspaces.json");
    fs.mkdirSync(this.configDir, { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ items: this.entries, currentId: this.cur }, null, 2), "utf-8");
  }

  list(): WorkspaceEntry[] {
    return this.entries.map((x) => ({ ...x }));
  }

  currentId(): string {
    return this.cur;
  }

  byId(id: string): WorkspaceEntry | null {
    return this.entries.find((x) => x.id === id) ?? null;
  }

  byRoot(root: string): WorkspaceEntry | null {
    const abs = path.resolve(root);
    return this.entries.find((x) => path.resolve(x.root) === abs) ?? null;
  }

  current(): WorkspaceEntry {
    return this.byId(this.cur) ?? this.entries[0];
  }

  setCurrent(id: string): void {
    if (!this.byId(id)) return;
    this.cur = id;
    this.save();
  }

  // 移除登记项（默认工作区不可移除）；当前项被移除时回落默认
  remove(id: string): boolean {
    if (id === "default") return false;
    const before = this.entries.length;
    this.entries = this.entries.filter((x) => x.id !== id);
    if (this.entries.length === before) return false;
    if (this.cur === id) this.cur = "default";
    this.save();
    return true;
  }

  // 登记新工作区（按 root 去重，label 取目录名）；返回已有或新建的条目
  add(root: string): WorkspaceEntry {
    const existing = this.byRoot(root);
    if (existing) return existing;
    const abs = path.resolve(root);
    const entry: WorkspaceEntry = {
      id: "ws-" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      label: path.basename(abs) || abs,
      root: abs,
      tag: "新",
    };
    this.entries.push(entry);
    this.save();
    return { ...entry };
  }
}

export class Workspace {
  readonly dirs: OrdoDirs;
  readonly registry: WorkspaceRegistry;
  // 当前工作区根：会话锚定的工作目录（默认工作区或用户自选目录）
  private currentRoot: string;
  // 非持久锚定的 wsId（persist=false 切换时设置；null = 跟随注册表 currentId）
  private anchoredWsId: string | null = null;

  constructor(home: string) {
    // 存储目录覆盖（设置页「存储」，PRD 3.8 延伸）：默认工作区与个人知识库可指向本机任意目录。
    // 重启生效；不迁移旧文件（旧目录保留）；其余目录（会话/审计/日志/插件包/配置/回收站）固定在数据根。
    let wsOverride = "";
    let ragOverride = "";
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(home, "config", "settings.json"), "utf-8")) as Record<string, unknown>;
      if (typeof raw.workspaceDir === "string" && raw.workspaceDir.trim()) wsOverride = raw.workspaceDir.trim();
      if (typeof raw.ragDir === "string" && raw.ragDir.trim()) ragOverride = raw.ragDir.trim();
    } catch {
      /* 无设置文件：默认位置 */
    }
    const d: OrdoDirs = {
      home,
      workspace: wsOverride || path.join(home, "workspace"),
      sessions: path.join(home, "sessions"),
      memory: path.join(home, "memory"),
      rag: ragOverride || path.join(home, "rag"),
      skillsPersonal: path.join(home, "skills", "personal"),
      skillsEnterprise: path.join(home, "skills", "enterprise"),
      recycle: path.join(home, "recycle"),
      audit: path.join(home, "audit"),
      logs: path.join(home, "logs"),
      config: path.join(home, "config"),
      managed: path.join(home, "managed"),
    };
    this.dirs = d;
    this.registry = new WorkspaceRegistry(d.config, d.workspace);
    this.currentRoot = d.workspace;
  }

  get root(): string {
    return this.currentRoot;
  }

  get currentWsId(): string {
    return this.anchoredWsId ?? this.registry.currentId();
  }

  // 切换工作区根：会话锚定新目录（新会话生效；已有会话在 loadSession 时按其 wsRoot 重锚定）。
  // persist=false 仅锚定本实例（自动化后台运行用）：不改动注册表 currentId、不落盘——前台"上次使用"不受影响
  switchRoot(absRoot: string, persist = true): void {
    const abs = path.resolve(absRoot);
    fs.mkdirSync(abs, { recursive: true });
    this.currentRoot = abs;
    const entry = this.registry.byRoot(abs);
    if (!persist) {
      this.anchoredWsId = entry?.id ?? null;
      return;
    }
    this.anchoredWsId = null;
    if (entry) this.registry.setCurrent(entry.id);
  }

  static init(): Workspace {
    const home = path.join(os.homedir(), ".ordo");
    // 品牌迁移（一次性）：旧数据根 ~/.ScreenDesk 整体改名为 ~/.ordo（rename 原子，原件不动）。
    // 失败不阻断启动：新根照常创建为空，旧数据仍在原处可手工迁移。
    const legacyHome = path.join(os.homedir(), ".ScreenDesk");
    if (!fs.existsSync(home) && fs.existsSync(legacyHome)) {
      try {
        fs.renameSync(legacyHome, home);
      } catch (e) {
        console.error("[workspace] ~/.ScreenDesk → ~/.ordo 迁移失败（目录被占用？）:", e);
      }
    }
    const ws = new Workspace(home);
    for (const dir of Object.values(ws.dirs)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    ws.registry.load();
    // 恢复上次使用的工作区（默认项 root 总是有效；登记项目录被删时 switchRoot 会重建）
    const cur = ws.registry.current();
    if (cur && cur.id !== "default") ws.switchRoot(cur.root);
    // 冷启动种子：默认工作区放一份示例数据，首跑即可体验 P0 旅程 3
    const seed = path.join(ws.dirs.workspace, "data", "sales.txt");
    if (!fs.existsSync(seed)) {
      fs.mkdirSync(path.dirname(seed), { recursive: true });
      fs.writeFileSync(seed, SEED_SALES, "utf-8");
    }
    // 冷启动种子：个人技能区放一个示例 SKILL（PRD 4.3 个人区，管理端不可见）
    const skillFile = path.join(ws.dirs.skillsPersonal, "weekly-report", "SKILL.md");
    if (!fs.existsSync(skillFile)) {
      fs.mkdirSync(path.dirname(skillFile), { recursive: true });
      fs.writeFileSync(skillFile, SEED_SKILL, "utf-8");
    }
    return ws;
  }

  // 路径围栏：工具只能访问工作区内的路径。
  // 写围栏 = 工作区 + 本工作区产品域暂存（~/.ordo/workspaces/<id>/tmp，中间产物/溢出输出落这里，
  // 由 TTL 清理）；读围栏 = 写围栏 + 技能分区（SKILL.md 按需可读）。工作区外路径由会话级授权放行（agent-host grants）。
  resolveInside(rel: string): string {
    const abs = path.resolve(this.root, rel);
    if (!this.isInWriteFence(abs)) {
      throw new Error(`路径超出工作区范围（骨架版仅允许工作区内路径）: ${rel}`);
    }
    return abs;
  }

  // 可写围栏判定（工作区 + 产品域暂存根）
  isInWriteFence(abs: string): boolean {
    const tmp = this.tempRoot;
    return abs === this.root || abs.startsWith(this.root + path.sep) || abs === tmp || abs.startsWith(tmp + path.sep);
  }

  // 只读资源围栏：写围栏 + 技能分区；绝对路径原样判定（附件引用/外部授权路径走 grants，不在此层）
  resolveReadable(rel: string): string {
    const abs = path.resolve(this.root, rel);
    const roots = [this.root, this.tempRoot, this.dirs.skillsPersonal, this.dirs.skillsEnterprise];
    for (const r of roots) {
      if (abs === r || abs.startsWith(r + path.sep)) return abs;
    }
    throw new Error(`路径超出可读范围（工作区与技能目录）: ${rel}`);
  }

  // 产品域暂存根（按工作区隔离）：中间产物 / 上传字节落盘 / 命令溢出输出。启动时按 TTL 清理（sweepTemp）
  get tempRoot(): string {
    return path.join(this.dirs.home, "workspaces", this.currentWsId, "tmp");
  }
}
