// 企业技能市场（PRD 4.2/4.3/5.1 客户端侧）：目录按权限过滤展示、安装/卸载、提交审核、版本一致性自动同步。
// 管理端未就绪：数据源走 SkillRegistryProvider 适配层，原型用 MockRegistryProvider（读 config.mock.json，
// 每次现读以模拟管理端变更生效）；管理端就绪后补 HttpProvider，其余代码零改动。
// 对用户无感：同步在后台完成（启动 + 定期 + 打开市场页），版本不一致自动更新、管理端下架自动移除。
import * as fsp from "node:fs/promises";
import * as fsSync from "node:fs";
import * as path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { adminFetchJson } from "./admin-link";
import type { Workspace } from "./workspace";
import type { Audit } from "./audit";

export interface RegistrySkill {
  name: string;
  version: string;
  description: string;
  /** sha256:<hex>；缺省时以 files 内容现算（自洽校验）。管理端就绪后必填（防篡改） */
  checksum?: string;
  files: Array<{ path: string; content: string }>;
  /** 更新策略预留（PRD 4.2：默认可选+宽限；敏感类强制）。原型统一按 auto（无感） */
  updatePolicy?: "auto" | "grace" | "force";
}

export interface SkillSubmission {
  id: string;
  name: string;
  version: string;
  status: "submitted" | "reviewing" | "approved" | "rejected";
  reviewerNote?: string;
  submittedAt: string;
  package: Array<{ path: string; content: string }>;
}

export interface InstalledRecord {
  version: string;
  checksum: string;
  installedAt: string;
  lastSyncedAt: string;
  state: "current" | "pendingUpdate" | "removed" | "offline";
  /** 宽限期（updatePolicy=grace）：待升级版本与期限；期内保持旧版运行，期满自动应用（R2） */
  pendingVersion?: string;
  graceDeadline?: string;
}

export interface SkillRegistryProvider {
  /** 按当前用户权限过滤后的可见目录（权限判断在管理端，客户端不自行判权） */
  catalog(): Promise<RegistrySkill[]>;
  submissions(): Promise<SkillSubmission[]>;
  createSubmission(sub: SkillSubmission): Promise<void>;
}

/** 原型期数据源：config.mock.json 的 skillRegistry / skillSubmissions，每次现读（模拟管理端变更） */
export class MockRegistryProvider implements SkillRegistryProvider {
  constructor(private configFile: string) {}

  private async read<T extends { skillRegistry?: RegistrySkill[]; skillSubmissions?: SkillSubmission[] }>(): Promise<T> {
    return JSON.parse(await fsp.readFile(this.configFile, "utf-8"));
  }

  async catalog(): Promise<RegistrySkill[]> {
    return (await this.read()).skillRegistry ?? [];
  }

  async submissions(): Promise<SkillSubmission[]> {
    return (await this.read()).skillSubmissions ?? [];
  }

  async createSubmission(sub: SkillSubmission): Promise<void> {
    const cfg = await this.read();
    // 同名技能只保留最新一次提交（重复提交 = 覆盖前次的未终态记录）
    cfg.skillSubmissions = [...(cfg.skillSubmissions ?? []).filter((s) => s.name !== sub.name), sub];
    await fsp.writeFile(this.configFile, JSON.stringify(cfg, null, 2) + "\n", "utf-8");
  }
}

/** M6：单机/锁定态数据源——企业市场恒空；单机无审核流（自建技能保存即用） */
export class EmptySkillRegistryProvider implements SkillRegistryProvider {
  async catalog(): Promise<RegistrySkill[]> {
    return [];
  }

  async submissions(): Promise<SkillSubmission[]> {
    return [];
  }

  async createSubmission(): Promise<void> {
    throw new Error("单机模式无企业审核流：自建技能保存即用，接入企业管理端后可提交上架");
  }
}

/** 管理端数据源（M1）：目录/提交状态走 HTTP；失败抛错由 SkillMarketService 既有 offline 降级路径接住（4.6） */
export class HttpRegistryProvider implements SkillRegistryProvider {
  constructor(private base: string) {}

  async catalog(): Promise<RegistrySkill[]> {
    return adminFetchJson<RegistrySkill[]>(this.base, "/api/v1/catalog/skills");
  }

  async submissions(): Promise<SkillSubmission[]> {
    return adminFetchJson<SkillSubmission[]>(this.base, "/api/v1/catalog/skill-submissions");
  }

  async createSubmission(sub: SkillSubmission): Promise<void> {
    await adminFetchJson(this.base, "/api/v1/submissions/skills", { method: "POST", body: JSON.stringify(sub) });
  }
}

/** 文本文件白名单：技能包原型期只收集文本（脚本/模板/说明），二进制资源留给管理端包格式 */
const TEXT_EXT = new Set([".md", ".txt", ".json", ".js", ".mjs", ".cjs", ".ts", ".py", ".csv", ".yaml", ".yml", ".html", ".css", ".xml", ".sql", ".sh", ".ps1", ""]);

async function readPackageDir(dir: string): Promise<Array<{ path: string; content: string }>> {
  const out: Array<{ path: string; content: string }> = [];
  const walk = async (d: string, rel: string) => {
    for (const e of await fsp.readdir(d, { withFileTypes: true })) {
      if (e.name === "node_modules" || e.name.startsWith(".")) continue;
      const abs = path.join(d, e.name);
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        await walk(abs, r);
        continue;
      }
      if (!TEXT_EXT.has(path.extname(e.name).toLowerCase())) continue;
      const stat = await fsp.stat(abs).catch(() => null);
      if (!stat || stat.size > 1024 * 1024) continue;
      const content = await fsp.readFile(abs, "utf-8");
      if (content.includes("\u0000")) continue; // 二进制误判兜底
      out.push({ path: r, content });
    }
  };
  await walk(dir, "");
  return out;
}

export interface SkillMarketDeps {
  workspace: Workspace;
  audit: Audit;
  /** 技能落盘变化后重扫并刷新提示词（AgentHost.reloadSkills） */
  reload: (reason: string) => Promise<void>;
  /** 任务运行中跳过同步（PRD 4.2 版本锁：执行中锁定所用版本） */
  isBusy: () => boolean;
}

export interface SyncResult {
  skipped?: boolean;
  offline?: boolean;
  updated: string[];
  removed: string[];
}

export class SkillMarketService {
  private records: Record<string, InstalledRecord> = {};
  private timer: NodeJS.Timeout | null = null;

  constructor(private provider: SkillRegistryProvider, private deps: SkillMarketDeps) {}

  /** 数据源热切换（M6-D 登录/退出无重启：Empty ↔ HTTP） */
  setProvider(p: SkillRegistryProvider): void {
    this.provider = p;
  }

  private get recordsFile(): string {
    return path.join(this.deps.workspace.dirs.config, "installed-skills.json");
  }

  private get enterpriseDir(): string {
    return this.deps.workspace.dirs.skillsEnterprise;
  }

  async init(opts?: { autoSync?: boolean }): Promise<void> {
    try {
      this.records = JSON.parse(await fsp.readFile(this.recordsFile, "utf-8"));
    } catch {
      this.records = {};
    }
    if (opts?.autoSync === false) return;
    // 启动后延迟首轮（避免与模型首连争抢），此后定期；同步自身带 isBusy 跳过
    const tick = async () => {
      if (this.deps.isBusy()) return;
      try {
        await this.syncNow();
      } catch {
        /* 单轮失败不致命，下轮再试 */
      }
    };
    setTimeout(() => void tick(), 30_000);
    this.timer = setInterval(() => void tick(), 30 * 60_000);
  }

  dispose(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  checksumOf(files: Array<{ path: string; content: string }>): string {
    const canon = [...files].sort((a, b) => a.path.localeCompare(b.path)).map((f) => `${f.path}\u0000${f.content}`).join("\u0001");
    return `sha256:${createHash("sha256").update(canon, "utf-8").digest("hex")}`;
  }

  /** 版本一致性同步（PRD 4.2）：目录里没了 → 自动移除；版本/校验和变了 → 自动更新；不可达 → 标记离线继续用本地缓存 */
  async syncNow(): Promise<SyncResult> {
    if (this.deps.isBusy()) return { skipped: true, updated: [], removed: [] };
    let catalog: RegistrySkill[];
    try {
      catalog = await this.provider.catalog();
    } catch (e) {
      // 离线降级（PRD 4.6）：本地缓存版本继续可用，恢复后自动补同步
      for (const rec of Object.values(this.records)) rec.state = "offline";
      await this.persistRecords();
      this.deps.audit.append({ event: "skill_sync_offline", reason: String((e as Error)?.message ?? e) });
      return { offline: true, updated: [], removed: [] };
    }
    const byName = new Map(catalog.map((s) => [s.name, s]));
    const updated: string[] = [];
    const removed: string[] = [];
    const now = new Date().toISOString();
    for (const [name, rec] of Object.entries(this.records)) {
      const entry = byName.get(name);
      if (!entry) {
        await this.removeLocal(name, "管理端已下架");
        delete this.records[name];
        removed.push(name);
        continue;
      }
      const sum = this.checksumOf(entry.files);
      if (entry.version === rec.version && sum === rec.checksum) {
        rec.state = "current";
        rec.lastSyncedAt = now;
        continue;
      }
      // 宽限期（R2）：grace 策略下版本变化先挂起（旧版继续可用），7 天期满或用户手动更新（install）才应用
      const GRACE_MS = 7 * 24 * 60 * 60 * 1000;
      if (entry.updatePolicy === "grace") {
        if (rec.state !== "pendingUpdate") {
          rec.state = "pendingUpdate";
          rec.pendingVersion = entry.version;
          rec.graceDeadline = new Date(Date.now() + GRACE_MS).toISOString();
          this.deps.audit.append({ event: "skill_update_grace", name, from: rec.version, to: entry.version, deadline: rec.graceDeadline });
          continue;
        }
        if (rec.graceDeadline && Date.now() < Date.parse(rec.graceDeadline)) continue; // 宽限期内保持旧版
      }
      if (await this.applyPackage(entry, sum)) updated.push(name);
    }
    await this.persistRecords();
    this.deps.audit.append({ event: "skill_sync", updated, removed });
    if (updated.length || removed.length) await this.deps.reload("skill_sync");
    return { updated, removed };
  }

  /** 写入企业区并登记版本（checksum 校验失败 → 保留旧版并告警，PRD 4.2 防篡改） */
  private async applyPackage(entry: RegistrySkill, sum?: string): Promise<boolean> {
    const checksum = sum ?? this.checksumOf(entry.files);
    if (entry.checksum && entry.checksum !== checksum) {
      this.deps.audit.append({ event: "skill_sync_failed", name: entry.name, reason: "checksum 不符，拒绝替换（防篡改）" });
      return false;
    }
    const dir = path.join(this.enterpriseDir, entry.name);
    await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
    await fsp.mkdir(dir, { recursive: true });
    for (const f of entry.files) {
      const abs = path.join(dir, ...String(f.path).replace(/\\/g, "/").split("/"));
      await fsp.mkdir(path.dirname(abs), { recursive: true });
      await fsp.writeFile(abs, f.content, "utf-8");
    }
    const prev = this.records[entry.name];
    const now = new Date().toISOString();
    this.records[entry.name] = {
      version: entry.version,
      checksum,
      installedAt: prev?.installedAt ?? now,
      lastSyncedAt: now,
      state: "current",
    };
    return true;
  }

  /** 移除本地缓存 → 回收站留痕（PRD 3.8），不动 disabled 记录（技能没了启停状态自然失效） */
  private async removeLocal(name: string, reason: string): Promise<void> {
    const dir = path.join(this.enterpriseDir, name);
    if (fsSync.existsSync(dir)) {
      const recycleDir = path.join(this.deps.workspace.dirs.recycle, `skill-ent-${name}-${Date.now()}`);
      await fsp.mkdir(this.deps.workspace.dirs.recycle, { recursive: true });
      await fsp.rename(dir, recycleDir).catch(() => {});
      this.deps.audit.append({ event: "skill_remove", name, reason, recycled: recycleDir });
    }
  }

  async install(name: string): Promise<RegistrySkill> {
    const entry = (await this.provider.catalog()).find((s) => s.name === name);
    if (!entry) throw new Error(`企业技能目录中没有「${name}」（可能已下架或无权限）`);
    if (!(await this.applyPackage(entry))) throw new Error("安装失败：包校验未通过");
    await this.persistRecords();
    await this.deps.reload("skill_install");
    this.deps.audit.append({ event: "skill_install", name, version: entry.version });
    return entry;
  }

  async uninstall(name: string): Promise<void> {
    if (!this.records[name]) throw new Error(`未安装的企业技能: ${name}`);
    await this.removeLocal(name, "用户卸载");
    delete this.records[name];
    await this.persistRecords();
    await this.deps.reload("skill_uninstall");
    this.deps.audit.append({ event: "skill_uninstall", name });
  }

  /** 市场页数据：目录（已按权限过滤）∪ 安装状态 */
  async listMarket(): Promise<Array<{ name: string; version: string; description: string; installed: boolean; localVersion?: string; state?: string }>> {
    const catalog = await this.provider.catalog();
    return catalog.map((s) => ({
      name: s.name,
      version: s.version,
      description: s.description,
      installed: !!this.records[s.name],
      localVersion: this.records[s.name]?.version,
      state: this.records[s.name]?.state,
    }));
  }

  /** 已安装清单：安装记录 ∪ 本地存在性（记录丢失但目录在 → 标 unknown 待同步自愈） */
  async listInstalled(): Promise<Array<{ name: string; version: string; state: string; lastSyncedAt: string }>> {
    return Object.entries(this.records).map(([name, r]) => ({
      name,
      version: r.version,
      state: fsSync.existsSync(path.join(this.enterpriseDir, name)) ? r.state : "removed",
      lastSyncedAt: r.lastSyncedAt,
    }));
  }

  /** 个人技能提交审核（PRD 4.3/5.1：员工沉淀 = 提交管理员 → 审核 → 发布） */
  async submitForReview(name: string, personalDir: string): Promise<SkillSubmission> {
    const dir = path.join(personalDir, name);
    if (!fsSync.existsSync(dir)) throw new Error(`个人技能不存在: ${name}`);
    const files = await readPackageDir(dir);
    const skillMd = files.find((f) => f.path === "SKILL.md");
    if (!skillMd) throw new Error("技能包缺少 SKILL.md");
    const existing = (await this.provider.submissions()).find((s) => s.name === name && (s.status === "submitted" || s.status === "reviewing"));
    if (existing) throw new Error(`「${name}」已有进行中的审核（${existing.status === "submitted" ? "已提交" : "审核中"}），请等待结果`);
    const sub: SkillSubmission = {
      id: `sub-${randomUUID().slice(0, 8)}`,
      name,
      version: "0.1.0",
      status: "submitted",
      submittedAt: new Date().toISOString(),
      package: files,
    };
    await this.provider.createSubmission(sub);
    this.deps.audit.append({ event: "skill_submit", name, files: files.length });
    return sub;
  }

  /** 我的提交（审核状态；UI 用，不回传包内容） */
  async listSubmissions(): Promise<Array<Omit<SkillSubmission, "package">>> {
    const list = await this.provider.submissions();
    return [...list].sort((a, b) => b.submittedAt.localeCompare(a.submittedAt)).map(({ package: _pkg, ...rest }) => rest);
  }

  private async persistRecords(): Promise<void> {
    await fsp.mkdir(path.dirname(this.recordsFile), { recursive: true });
    await fsp.writeFile(this.recordsFile, JSON.stringify(this.records, null, 2), "utf-8");
  }
}
