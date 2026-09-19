// 会话存储（对应 PRD 3.3 本地无限期保留 + 3.8 sessions 目录约定）
// 同一会话稳定 id、单文件更新；列表按更新时间倒序；兼容旧格式（无 id/title 的历史文件）
// 会话锚定工作区（PRD 3.8）：wsId/wsRoot 记录创建时的工作区，侧栏按此分组；删除移入 recycle 回收站
import * as fsp from "node:fs/promises";
import * as path from "node:path";

export interface StoredSession {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  expert: string;
  messages: any[];
  /** 创建/续接时锚定的工作区 */
  wsId?: string;
  wsRoot?: string;
  /** 置顶（用户标记，列表排序用） */
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

export class SessionStore {
  constructor(private dir: string) {}

  private file(id: string): string {
    return path.join(this.dir, `session-${id}.json`);
  }

  async save(s: StoredSession): Promise<void> {
    await fsp.writeFile(this.file(s.id), JSON.stringify(s, null, 2), "utf-8");
  }

  async load(id: string): Promise<StoredSession | null> {
    try {
      return JSON.parse(await fsp.readFile(this.file(id), "utf-8"));
    } catch {
      return null;
    }
  }

  // 就地更新元数据字段（置顶/重命名等，不动消息体）
  async mutate(id: string, patch: Partial<Pick<StoredSession, "title" | "pinned">>): Promise<StoredSession | null> {
    const s = await this.load(id);
    if (!s) return null;
    const next: StoredSession = { ...s, ...patch };
    next.title = String(next.title ?? "").slice(0, 40) || s.title;
    await this.save(next);
    return next;
  }

  // 删除 → 回收站（PRD 3.8 recycle 目录；不做物理删除，保留恢复余地）
  async remove(id: string, recycleDir: string): Promise<boolean> {
    const src = this.file(id);
    try {
      await fsp.access(src);
    } catch {
      return false;
    }
    await fsp.mkdir(recycleDir, { recursive: true });
    const dest = path.join(recycleDir, `session-${id}-${Date.now()}.json`);
    await fsp.rename(src, dest);
    return true;
  }

  async list(): Promise<SessionMeta[]> {
    const files = await fsp.readdir(this.dir).catch(() => [] as string[]);
    const metas: SessionMeta[] = [];
    for (const f of files) {
      if (!f.startsWith("session-") || !f.endsWith(".json")) continue;
      try {
        const d = JSON.parse(await fsp.readFile(path.join(this.dir, f), "utf-8"));
        const id = typeof d.id === "string" ? d.id : f.slice("session-".length, -".json".length);
        metas.push({
          id,
          title: d.title ?? String(d.prompt ?? "旧会话").slice(0, 30),
          updatedAt: d.updatedAt ?? d.ts ?? "",
          expert: d.expert ?? "general",
          messageCount: Array.isArray(d.messages) ? d.messages.length : 0,
          wsId: typeof d.wsId === "string" ? d.wsId : undefined,
          wsRoot: typeof d.wsRoot === "string" ? d.wsRoot : undefined,
          pinned: d.pinned === true,
        });
      } catch {
        // 损坏文件跳过
      }
    }
    return metas.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  }
}
