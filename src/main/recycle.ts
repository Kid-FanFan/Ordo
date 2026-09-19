// 回收站：删除只进不出会被无限堆高。两条出口（PRD 3.8 只规定"删除进回收站可恢复"，保留期按桌面工具惯例 30 天）：
// ① 启动时自动清理超过保留期的条目；② 设置里手动清空（永久删除）。
// 条目的删除时间优先取名字里的毫秒时间戳（写入方约定：skill-x-<ms>、kb-<id>-<ms>、session-<uuid>-<ms>.json、
// sessions-cleanup-<ISO>）；rename 保留原 mtime，故 mtime 只做无时间戳条目的兜底。
import fsp from "node:fs/promises";
import path from "node:path";
import type { Audit } from "./audit";

export interface RecycleDeps {
  dir: string;
  audit: Audit;
  /** 保留期（天），默认 30 */
  retentionDays?: number;
}

const DAY_MS = 86_400_000;

export class RecycleService {
  constructor(private deps: RecycleDeps) {}

  private deletedAt(name: string, mtimeMs: number): number {
    const ms = name.match(/\d{13}/); // 13 位毫秒时间戳
    if (ms) return Number(ms[0]);
    const iso = name.match(/(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})/); // sessions-cleanup-<ISO，冒号被替换为横线
    if (iso) {
      const t = Date.parse(`${iso[1]}T${iso[2]}:${iso[3]}:${iso[4]}`);
      if (!Number.isNaN(t)) return t;
    }
    return mtimeMs;
  }

  /** 清掉超过保留期的条目，返回清理数 */
  async purgeExpired(retentionDays: number = this.deps.retentionDays ?? 30): Promise<number> {
    let entries: string[] = [];
    try {
      entries = await fsp.readdir(this.deps.dir);
    } catch {
      return 0; // 目录不存在 = 无可清理
    }
    const cutoff = Date.now() - retentionDays * DAY_MS;
    let removed = 0;
    for (const name of entries) {
      const full = path.join(this.deps.dir, name);
      try {
        const st = await fsp.stat(full);
        if (this.deletedAt(name, st.mtimeMs) < cutoff) {
          await fsp.rm(full, { recursive: true, force: true });
          removed++;
        }
      } catch {
        // 单条失败不阻断其余清理
      }
    }
    if (removed) this.deps.audit.append({ event: "recycle_purge", removed, retentionDays });
    return removed;
  }

  /** 手动清空（永久删除全部条目），返回清除数 */
  async clear(): Promise<number> {
    let entries: string[] = [];
    try {
      entries = await fsp.readdir(this.deps.dir);
    } catch {
      return 0;
    }
    let removed = 0;
    for (const name of entries) {
      await fsp.rm(path.join(this.deps.dir, name), { recursive: true, force: true }).catch(() => {});
      removed++;
    }
    this.deps.audit.append({ event: "recycle_clear", removed });
    return removed;
  }

  /** 条目数与总体积（供设置展示） */
  async stats(): Promise<{ count: number; bytes: number }> {
    let count = 0;
    let bytes = 0;
    const walk = async (p: string): Promise<void> => {
      const st = await fsp.stat(p).catch(() => null);
      if (!st) return;
      if (st.isDirectory()) {
        const kids = await fsp.readdir(p).catch(() => []);
        for (const k of kids) await walk(path.join(p, k));
      } else {
        count++;
        bytes += st.size;
      }
    };
    let entries: string[] = [];
    try {
      entries = await fsp.readdir(this.deps.dir);
    } catch {
      return { count: 0, bytes: 0 };
    }
    for (const name of entries) await walk(path.join(this.deps.dir, name));
    return { count: entries.length, bytes };
  }
}
