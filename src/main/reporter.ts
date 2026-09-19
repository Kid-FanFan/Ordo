// 上报 worker（M3）：审计 JSONL 增量补传 + 使用量（当日会话数）上报。
// 仅 admin.baseUrl 非空时激活；失败静默整批下轮重试（服务端 工号+日+行号 幂等键保证不重）。
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { adminFetchJson } from "./admin-link";

const BATCH = 200;
const STATE_KEEP_DAYS = 30;

interface ReportState {
  audit?: Record<string, number>; // day -> 已上报最大行号
  usage?: { lastDay?: string; lastSessions?: number };
}

export interface ReporterDeps {
  base: string;
  auditDir: string;
  stateFile: string;
  /** 当日（本地时区 YYYY-MM-DD）会话创建数 */
  sessionsToday: () => number;
}

export class AdminReporter {
  private timer: NodeJS.Timeout | null = null;
  private state: ReportState = {};

  constructor(private deps: ReporterDeps) {}

  async start(): Promise<void> {
    this.state = await this.readState();
    let sent = 0;
    try {
      sent = await this.tick();
    } finally {
      console.log(`[ADMIN-REPORT] ready sent=${sent}`); // 首轮完成标记（e2e 对账用：无论是否冲刷了新行都打）
    }
    // 启动尾部可能有迟到落盘的审计行（初始化流程晚于 reporter 的 append），4s 后补冲一次
    setTimeout(() => {
      void this.tick().then((s) => console.log(`[ADMIN-REPORT] ready2 sent=${s}`));
    }, 4000).unref?.();
    this.timer = setInterval(() => void this.tick(), 10 * 60 * 1000);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  private async readState(): Promise<ReportState> {
    try {
      return JSON.parse(await fsp.readFile(this.deps.stateFile, "utf-8"));
    } catch {
      return {};
    }
  }

  private async saveState(): Promise<void> {
    // 状态只留近 30 天（跨月文件不再重扫）
    const cutoff = new Date(Date.now() - STATE_KEEP_DAYS * 86400000).toISOString().slice(0, 10);
    for (const k of Object.keys(this.state.audit ?? {})) {
      if (k < cutoff) delete this.state.audit![k];
    }
    await fsp.mkdir(path.dirname(this.deps.stateFile), { recursive: true });
    await fsp.writeFile(this.deps.stateFile, JSON.stringify(this.state), "utf-8");
  }

  private async tick(): Promise<number> {
    let sent = 0;
    try {
      sent += await this.flushAudit();
      await this.reportUsage();
    } catch {
      /* 不可达：下轮重试（幂等） */
    }
    return sent;
  }

  /** 立即增量冲刷审计（公共：插件包安装等追加审计的动作可即时补传，e2e 对账不漏行） */
  async flushAudit(): Promise<number> {
    try {
      return await this.flushAuditInner();
    } catch {
      return 0;
    }
  }

  private async flushAuditInner(): Promise<number> {
    const files = await fsp.readdir(this.deps.auditDir).catch(() => [] as string[]);
    const auditFiles = files.filter((f) => /^audit-\d{4}-\d{2}-\d{2}\.jsonl$/.test(f)).sort();
    this.state.audit ??= {};
    let anySent = 0;
    let anyDay = "";
    for (const f of auditFiles) {
      const day = f.slice(6, 16);
      const lines = (await fsp.readFile(path.join(this.deps.auditDir, f), "utf-8").catch(() => "")).split("\n").filter((l) => l.trim());
      let from = this.state.audit[day] ?? 0;
      for (let start = from; start < lines.length; start += BATCH) {
        const slice = lines.slice(start, start + BATCH);
        const rows = slice.map((line, i) => {
          const rec = JSON.parse(line) as Record<string, unknown>;
          const { ts, event, tool, level, ...detail } = rec;
          return { seq: start + i + 1, ts: String(ts ?? ""), event: String(event ?? ""), tool: tool == null ? undefined : String(tool), level: level == null ? undefined : String(level), detail: Object.keys(detail).length ? detail : undefined };
        });
        const r = await adminFetchJson<{ stored: number; duplicated: number }>(this.deps.base, "/api/v1/report/audit", {
          method: "POST",
          body: JSON.stringify({ day, rows }),
        });
        from = start + slice.length;
        this.state.audit[day] = from;
        anySent += r.stored;
        anyDay = day;
        await this.saveState();
      }
    }
    if (anySent > 0) console.log(`[ADMIN-REPORT] audit day=${anyDay} sent=${anySent}`);
    return anySent;
  }

  private async reportUsage(): Promise<void> {
    const today = localDay();
    this.state.usage ??= {};
    const sessions = this.deps.sessionsToday();
    const tokens = this.tokensToday(today);
    await adminFetchJson(this.deps.base, "/api/v1/report/usage", {
      method: "POST",
      body: JSON.stringify({ date: today, sessions, tokensIn: tokens.in, tokensOut: tokens.out }),
    });
    // 跨天首次 tick：补报前一日终值（昨日已按当时值上报过的就维持幂等覆盖语义）
    const last = this.state.usage.lastDay;
    if (last && last !== today) {
      const lastTokens = this.tokensToday(last);
      await adminFetchJson(this.deps.base, "/api/v1/report/usage", {
        method: "POST",
        body: JSON.stringify({ date: last, sessions: this.state.usage.lastSessions ?? 0, tokensIn: lastTokens.in, tokensOut: lastTokens.out }),
      });
    }
    this.state.usage = { lastDay: today, lastSessions: sessions };
    await this.saveState();
  }

  /** 某日 turn_usage 审计行聚合（token 计量 R1；全量重读当日文件，绝对值幂等） */
  private tokensToday(day: string): { in: number; out: number } {
    const file = path.join(this.deps.auditDir, `audit-${day}.jsonl`);
    try {
      const lines = fs.readFileSync(file, "utf-8").split("\n").filter((l) => l.trim());
      let tin = 0;
      let tout = 0;
      for (const line of lines) {
        try {
          const r = JSON.parse(line) as { event?: string; tokensIn?: number; tokensOut?: number };
          if (r.event === "turn_usage") {
            tin += Number(r.tokensIn ?? 0);
            tout += Number(r.tokensOut ?? 0);
          }
        } catch {
          /* 脏行跳过 */
        }
      }
      return { in: tin, out: tout };
    } catch {
      return { in: 0, out: 0 };
    }
  }
}

function localDay(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** 当日会话数（sidecar index.json 里 createdAt 为今天且未删除的会话计数；供 reporter 增量读取） */
export function countSessionsToday(sessionsDir: string): number {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(sessionsDir, "index.json"), "utf-8")) as {
      sessions?: Record<string, { createdAt?: string; deletedAt?: string }>;
    };
    let n = 0;
    for (const v of Object.values(raw.sessions ?? {})) {
      if (v?.deletedAt) continue;
      if (v.createdAt && v.createdAt.slice(0, 10) === localDay()) n++;
    }
    return n;
  } catch {
    return 0;
  }
}
