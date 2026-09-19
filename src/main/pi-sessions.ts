// pi 会话存储（P1「让 pi 做」）：正文消息走 pi JsonlSessionRepo（逐条 append、断尾自愈、按 cwd 分桶），
// 产品元数据（标题/专家/工作区锚定/置顶/回收站）走 sidecar index.json——pi 的 JSONL header 不带可变业务字段。
// 旧 session-*.json 启动时一次性迁移（原件保留为 .migrated）。压缩以 sd_compaction custom entry 追加落盘
// （append-only 不可重写），重放按 pi buildContextEntries 语义折叠：最后一个压缩点之前的消息全部丢弃，
// 压缩点展开为「摘要消息 + retainedTail」，其后 MessageEntry 依次衔接——与内存中压缩后状态一致。
import * as fsp from "node:fs/promises";
import * as fsSync from "node:fs";
import * as path from "node:path";

const dynamicImport = new Function("s", "return import(s)") as (s: string) => Promise<any>;

export interface StoredSession {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  expert: string;
  messages: any[];
  wsId?: string;
  wsRoot?: string;
  pinned?: boolean;
}

export interface SessionMeta {
  id: string;
  title: string;
  updatedAt: string;
  expert: string;
  messageCount: number;
  wsId?: string;
  wsRoot?: string;
  pinned?: boolean;
}

/** sidecar 索引条目（index.json sessions[id]） */
interface IndexEntry {
  title: string;
  expert: string;
  createdAt: string;
  updatedAt: string;
  wsId?: string;
  wsRoot?: string;
  pinned?: boolean;
  /** 进回收站时间（ISO）；存在即不在列表 */
  deletedAt?: string;
  /** pi JSONL 文件相对 repo 根的路径（含 cwd 桶目录），回收站恢复用 */
  relPath?: string;
}

const BRANCH = "main";
const COMPACT_CUSTOM = "sd_compaction";

/** pi 上下文语义：未落定的助手消息不参与重放（stopReason error/aborted/deferred） */
function isContextMessage(m: any): boolean {
  return !(m?.role === "assistant" && ["error", "aborted", "deferred"].includes(String(m.stopReason)));
}

/**
 * entries → 消息数组（pi buildContextEntries 折叠语义 + sd_compaction/custom 折叠扩展）：
 * 最后一个压缩点（原生 compaction 或 P1 的 sd_compaction）之前的消息全部丢弃，
 * 压缩点展开为「摘要消息 + retainedTail」，其后 MessageEntry 依次衔接。
 */
export function replayEntries(core: any, entries: any[]): any[] {
  let cut = -1;
  let compact: any = null;
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    if (e?.type === "compaction" || (e?.type === "custom" && e.customType === COMPACT_CUSTOM)) {
      cut = i;
      compact = e;
      break;
    }
  }
  const out: any[] = [];
  if (compact) {
    const c = compact.type === "compaction" ? compact : compact.data ?? {};
    out.push(core.createCompactionSummaryMessage(String(c.summary ?? ""), Number(c.tokensBefore ?? 0), compact.timestamp));
    for (const m of c.retainedTail ?? []) if (isContextMessage(m)) out.push(m);
  }
  for (const e of entries.slice(cut + 1)) {
    if (e?.type === "message" && isContextMessage(e.message)) out.push(e.message);
  }
  return out;
}

export class PiSessionStore {
  private core: any = null;
  private repo: any = null;
  private ctx: any = null;
  private index = new Map<string, IndexEntry>();
  private idMeta = new Map<string, any>(); // id → JsonlSessionMetadata（repo.list 缓存）
  private openCache = new Map<string, any>(); // id → 打开中的 Session
  private messagesCount = new Map<string, number>(); // id → 重放消息数（列表 messageCount，load 后缓存）

  constructor(
    private dir: string,
    private recycleDir: string,
    /** 当前工作区根（新建会话的 pi cwd 分桶依据） */
    private cwdProvider: () => string
  ) {}

  async init(): Promise<void> {
    this.core = await dynamicImport("@earendil-works/pi-agent-core");
    const { NodeExecutionEnv } = await dynamicImport("@earendil-works/pi-agent-core/node");
    // NodeExecutionEnv 同时实现 pi 的 FileSystem 抽象，直接作为 repo 的文件系统
    const env = new NodeExecutionEnv({ cwd: process.cwd() });
    this.ctx = this.core.BACKGROUND_CONTEXT;
    this.repo = new this.core.JsonlSessionRepo({ fileSystem: env, sessionsRoot: this.piRoot() });
    await this.loadIndex();
    await this.refreshRepoList();
    await this.migrateLegacy();
    this.saveIndex(); // 迁移可能有更新
  }

  private piRoot(): string {
    return path.join(this.dir, "pi");
  }

  // ---------- sidecar 索引 ----------

  private indexFile(): string {
    return path.join(this.dir, "index.json");
  }

  private async loadIndex(): Promise<void> {
    try {
      const raw = JSON.parse(await fsp.readFile(this.indexFile(), "utf-8"));
      const sessions = raw?.sessions ?? {};
      for (const [id, v] of Object.entries<any>(sessions)) {
        if (v && typeof v.title === "string") this.index.set(id, v);
      }
    } catch {
      /* 无索引或损坏：从空开始（旧数据迁移会补全） */
    }
  }

  private saveIndex(): void {
    const sessions: Record<string, IndexEntry> = {};
    for (const [id, v] of this.index) sessions[id] = v;
    try {
      fsSync.mkdirSync(this.dir, { recursive: true });
      fsSync.writeFileSync(this.indexFile(), JSON.stringify({ version: 1, sessions }, null, 2), "utf-8");
    } catch {
      /* 索引写失败不阻断（正文仍在 pi 文件里） */
    }
  }

  // ---------- 旧数据迁移 ----------

  /** 旧 session-*.json → pi JSONL + index 条目；原件改名 .migrated 保留（不删用户数据） */
  private async migrateLegacy(): Promise<void> {
    const files = await fsp.readdir(this.dir).catch(() => [] as string[]);
    for (const f of files) {
      if (!f.startsWith("session-") || !f.endsWith(".json")) continue;
      const full = path.join(this.dir, f);
      let data: any = null;
      try {
        data = JSON.parse(await fsp.readFile(full, "utf-8"));
      } catch {
        await fsp.rename(full, `${full}.broken`).catch(() => {});
        continue;
      }
      const id = typeof data.id === "string" && data.id ? data.id : f.slice("session-".length, -".json".length);
      if (!this.core || !/^[A-Za-z0-9]([A-Za-z0-9._-]*[A-Za-z0-9])?$/.test(id)) {
        await fsp.rename(full, `${full}.broken`).catch(() => {});
        continue;
      }
      if (this.index.has(id) && !this.index.get(id)!.deletedAt) {
        // 已迁移过（异常中断的重跑）：仅收尾改名
        await fsp.rename(full, `${full}.migrated`).catch(() => {});
        continue;
      }
      const cwd = typeof data.wsRoot === "string" && data.wsRoot ? data.wsRoot : this.cwdProvider();
      const now = new Date().toISOString();
      const entry: IndexEntry = {
        title: String(data.title ?? "旧会话").slice(0, 40),
        expert: String(data.expert ?? "general"),
        createdAt: data.createdAt ?? now,
        updatedAt: data.updatedAt ?? now,
        ...(data.wsId ? { wsId: data.wsId } : {}),
        ...(data.wsRoot ? { wsRoot: data.wsRoot } : {}),
        ...(data.pinned === true ? { pinned: true } : {}),
      };
      try {
        const session = await this.createSession(id, cwd);
        await this.appendAll(session, Array.isArray(data.messages) ? data.messages : []);
        const meta = await this.metaOf(id);
        this.index.set(id, { ...entry, relPath: meta ? path.relative(this.piRoot(), meta.path) : undefined });
      } catch (e) {
        // 单条迁移失败不影响其余；保留原件下次重试
        console.error(`[pi-sessions] 迁移失败 ${id}:`, e instanceof Error ? e.message : e);
        continue;
      }
      await fsp.rename(full, `${full}.migrated`).catch(() => {});
    }
  }

  // ---------- pi repo 封装 ----------

  private async refreshRepoList(): Promise<void> {
    const metas = await this.repo.list(undefined, this.ctx).catch(() => []);
    this.idMeta.clear();
    for (const m of metas) this.idMeta.set(m.id, m);
  }

  private async metaOf(id: string): Promise<any | null> {
    if (!this.idMeta.has(id)) await this.refreshRepoList();
    return this.idMeta.get(id) ?? null;
  }

  private async createSession(id: string, cwd: string): Promise<any> {
    const session = await this.repo.create({ id, cwd }, this.ctx);
    this.openCache.set(id, session);
    await this.refreshRepoList();
    return session;
  }

  /** 供 AgentHarness 绑定：打开（或复用缓存中的）pi Session 对象（不存在返回 null） */
  async openSessionObject(id: string): Promise<any | null> {
    return this.openSession(id);
  }

  /** harness close 会连带关闭其绑定的 session 对象：从缓存摘除，下次 open 重新 repo.open */
  forget(id: string | null): void {
    if (id) this.openCache.delete(id);
  }

  /** 供 AgentHarness 绑定：新建 pi Session 并登记索引（title/expert 等元数据随后 touchMeta 补全） */
  async createSessionObject(id: string, meta: { title: string; expert?: string; wsId?: string; wsRoot?: string }): Promise<any> {
    const cwd = meta.wsRoot || this.cwdProvider();
    const session = await this.createSession(id, cwd);
    const now = new Date().toISOString();
    const m = await this.metaOf(id);
    this.index.set(id, {
      title: meta.title.slice(0, 40) || "新会话",
      expert: meta.expert ?? "general",
      createdAt: now,
      updatedAt: now,
      ...(meta.wsId ? { wsId: meta.wsId } : {}),
      ...(meta.wsRoot ? { wsRoot: meta.wsRoot } : {}),
      relPath: m ? path.relative(this.piRoot(), m.path) : undefined,
    });
    this.saveIndex();
    return session;
  }

  /** 更新索引元数据（updatedAt/title/expert 等）；不触碰 pi 正文 */
  async touchMeta(id: string, patch: { title?: string; expert?: string }): Promise<void> {
    const v = this.index.get(id);
    if (!v || v.deletedAt) return;
    if (patch.title) v.title = String(patch.title).slice(0, 40) || v.title;
    if (patch.expert) v.expert = patch.expert;
    v.updatedAt = new Date().toISOString();
    this.saveIndex();
  }

  private async openSession(id: string): Promise<any | null> {
    if (this.openCache.has(id)) return this.openCache.get(id)!;
    const meta = await this.metaOf(id);
    if (!meta) return null;
    const session = await this.repo.open(meta, this.ctx);
    this.openCache.set(id, session);
    return session;
  }

  private async mainBranch(session: any): Promise<any> {
    return (await session.branch(BRANCH, this.ctx)) ?? (await session.createBranch(BRANCH, null, this.ctx));
  }

  /** 逐条追加消息；compactionSummary 转为 sd_compaction entry（retainedTail 空——其后消息照常 append，重放等价） */
  private async appendAll(session: any, messages: any[]): Promise<void> {
    if (!messages.length) return;
    const branch = await this.mainBranch(session);
    for (const m of messages) {
      if (!m || typeof m.role !== "string") continue;
      if (m.role === "compactionSummary") {
        await branch.appendCustomEntry(
          COMPACT_CUSTOM,
          { summary: String(m.summary ?? ""), retainedTail: [], tokensBefore: Number(m.tokensBefore ?? 0) },
          this.ctx
        );
      } else {
        await branch.appendMessage(m, this.ctx);
      }
    }
  }

  // pi 上下文语义：未落定的助手消息不参与重放（stopReason error/aborted/deferred）
  private static isContextMessage(m: any): boolean {
    return isContextMessage(m);
  }

  /** entries → 消息数组（replayEntries 的实例便捷入口） */
  private replay(entries: any[]): any[] {
    return replayEntries(this.core, entries);
  }

  // ---------- 公共接口（对齐旧 SessionStore 语义 + 增量通道） ----------

  async list(): Promise<SessionMeta[]> {
    const metas: SessionMeta[] = [];
    for (const [id, v] of this.index) {
      if (v.deletedAt) continue;
      metas.push({
        id,
        title: v.title,
        updatedAt: v.updatedAt,
        expert: v.expert,
        messageCount: this.messagesCount.get(id) ?? 0,
        wsId: v.wsId,
        wsRoot: v.wsRoot,
        pinned: v.pinned === true,
      });
    }
    return metas.sort((a, b) => {
      if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
      return String(b.updatedAt).localeCompare(String(a.updatedAt));
    });
  }

  async load(id: string): Promise<StoredSession | null> {
    const v = this.index.get(id);
    if (!v || v.deletedAt) return null;
    const session = await this.openSession(id);
    if (!session) return null;
    const branch = await this.mainBranch(session);
    const entries = await branch.findEntries({ order: "oldestFirst" }, this.ctx);
    const messages = this.replay(entries);
    this.messagesCount.set(id, messages.length);
    return {
      id,
      title: v.title,
      createdAt: v.createdAt,
      updatedAt: v.updatedAt,
      expert: v.expert,
      messages,
      wsId: v.wsId,
      wsRoot: v.wsRoot,
      pinned: v.pinned === true,
    };
  }

  /** 增量追加新消息（正常轮次落盘通道；id 必须已存在） */
  async appendMessages(id: string, messages: any[]): Promise<void> {
    const session = await this.openSession(id);
    if (!session) throw new Error(`会话不存在: ${id}`);
    await this.appendAll(session, messages.filter((m) => m && m.role !== "compactionSummary"));
    void this.touchMeta(id, {});
  }

  /** 压缩事件落盘（retainedTail = 压缩后保留的尾部消息，重放时由 entry 还原） */
  async appendCompaction(id: string, payload: { summary: string; retainedTail: any[]; tokensBefore: number }): Promise<void> {
    const session = await this.openSession(id);
    if (!session) throw new Error(`会话不存在: ${id}`);
    const branch = await this.mainBranch(session);
    await branch.appendCustomEntry(
      COMPACT_CUSTOM,
      { summary: payload.summary, retainedTail: payload.retainedTail, tokensBefore: payload.tokensBefore },
      this.ctx
    );
    void this.touchMeta(id, {});
  }

  /** 新建会话（正文与索引同时建立） */
  async create(id: string, meta: Omit<IndexEntry, "createdAt" | "updatedAt"> & Partial<Pick<IndexEntry, "createdAt" | "updatedAt">>): Promise<void> {
    const cwd = meta.wsRoot || this.cwdProvider();
    const now = new Date().toISOString();
    await this.createSession(id, cwd);
    const m = await this.metaOf(id);
    this.index.set(id, {
      title: meta.title.slice(0, 40) || "新会话",
      expert: meta.expert ?? "general",
      createdAt: meta.createdAt ?? now,
      updatedAt: now,
      ...(meta.wsId ? { wsId: meta.wsId } : {}),
      ...(meta.wsRoot ? { wsRoot: meta.wsRoot } : {}),
      ...(meta.pinned ? { pinned: true } : {}),
      relPath: m ? path.relative(this.piRoot(), m.path) : undefined,
    });
    this.saveIndex();
  }

  /** 兼容旧接口：置顶/重命名（只动索引；旧返回值仅 title/pinned 被消费） */
  async mutate(id: string, patch: { title?: string; pinned?: boolean }): Promise<StoredSession | null> {
    const v = this.index.get(id);
    if (!v || v.deletedAt) return null;
    if (patch.title !== undefined) v.title = String(patch.title).slice(0, 40) || v.title;
    if (patch.pinned !== undefined) v.pinned = patch.pinned === true;
    v.updatedAt = new Date().toISOString();
    this.saveIndex();
    return { id, title: v.title, createdAt: v.createdAt, updatedAt: v.updatedAt, expert: v.expert, messages: [], wsId: v.wsId, wsRoot: v.wsRoot, pinned: v.pinned === true };
  }

  /** 兼容旧接口：整写通道（自测种子/一次性导入）——已存在则物理重建 */
  async save(s: StoredSession): Promise<void> {
    const existing = this.index.get(s.id);
    if (existing && !existing.deletedAt) {
      const session = this.openCache.get(s.id) ?? null;
      if (session) await session.close(this.ctx).catch(() => {});
      this.openCache.delete(s.id);
      const meta = await this.metaOf(s.id);
      if (meta) await this.repo.delete(meta, this.ctx).catch(() => {});
    }
    await this.create(s.id, {
      title: s.title,
      expert: s.expert,
      wsId: s.wsId,
      wsRoot: s.wsRoot,
      pinned: s.pinned,
      createdAt: s.createdAt,
      updatedAt: s.updatedAt,
    });
    const session = await this.openSession(s.id);
    if (session) await this.appendAll(session, Array.isArray(s.messages) ? s.messages : []);
    if (existing?.deletedAt) delete existing.deletedAt;
    void this.touchMeta(s.id, { title: s.title });
  }

  /** 删除 → 回收站（pi 文件移入 recycle；索引留痕 deletedAt，可恢复） */
  async remove(id: string): Promise<boolean> {
    const v = this.index.get(id);
    if (!v || v.deletedAt) return false;
    const meta = await this.metaOf(id);
    if (meta?.path) {
      try {
        await fsp.mkdir(this.recycleDir, { recursive: true });
        await fsp.rename(meta.path, path.join(this.recycleDir, `session-${id}-${Date.now()}.jsonl`));
      } catch {
        await this.repo.delete(meta, this.ctx).catch(() => {});
      }
    }
    const session = this.openCache.get(id);
    if (session) await session.close(this.ctx).catch(() => {});
    this.openCache.delete(id);
    v.deletedAt = new Date().toISOString();
    this.saveIndex();
    return true;
  }

  /** 关闭（进程退出前调用；repo 内部 drain 落盘） */
  async close(): Promise<void> {
    for (const s of this.openCache.values()) await s.close(this.ctx).catch(() => {});
    this.openCache.clear();
    await this.repo?.close(this.ctx).catch(() => {});
  }
}
