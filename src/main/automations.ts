// 本地型定时任务（PRD 3.7）：用户自建、客户端定时器触发、纯本地执行、管理端不调度。
// 服务端交互型（管理端调度 + 离线补跑）不在客户端展示——本文件只承载本地型，界面只见用户自建任务。
// 无人值守预授权：任务创建时声明可自动放行的敏感操作（工具名），范围外一律拒绝并审计（见 index.ts bgConfirm）。
import fsp from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { Audit } from "./audit";

export type ScheduleKind = "daily" | "weekly" | "interval";

export interface AutomationSchedule {
  kind: ScheduleKind;
  /** daily / weekly：运行时间 HH:MM（24h） */
  time?: string;
  /** weekly：1=周一 … 7=周日 */
  weekdays?: number[];
  /** interval：间隔分钟（1..1440） */
  everyMinutes?: number;
}

export interface AutomationDef {
  id: string;
  name: string;
  /** 任务指令（无人值守时发给 agent 的完整 prompt） */
  prompt: string;
  /** 创建时锁定的专家（PRD 3.10 任务一致性；每次运行前重锚定到该专家） */
  expertId: string;
  /** 绑定的工作目录（PRD 3.8：任务的读写与产物都锚定该目录；会话归属同目录） */
  wsId: string;
  schedule: AutomationSchedule;
  /** 预授权的敏感操作（工具名，如 write_file）：无人值守时仅这些自动放行 */
  preAuth: string[];
  enabled: boolean;
  createdAt: string;
  lastRunAt?: string;
  lastStatus?: "ok" | "error";
  lastSummary?: string;
  lastSessionId?: string;
  runCount: number;
}

export interface AutomationRunRecord {
  id: string;
  taskId: string;
  taskName: string;
  trigger: "timer" | "manual";
  startedAt: string;
  durationMs: number;
  ok: boolean;
  summary: string;
  error?: string;
  /** 本次运行产生的会话（侧栏可点开回看） */
  sessionId?: string;
}

export interface AutomationView extends AutomationDef {
  scheduleText: string;
  nextRunAt: string | null;
}

export interface AutomationRunnerResult {
  ok: boolean;
  summary: string;
  sessionId?: string;
  error?: string;
}

export interface CreateAutomationInput {
  name: string;
  prompt: string;
  expertId: string;
  /** 绑定的工作目录 id（缺省 default） */
  wsId?: string;
  schedule: AutomationSchedule;
  preAuth?: string[];
}

export interface AutomationServiceDeps {
  /** 数据目录（~/.ordo） */
  home: string;
  audit: Audit;
  /** 校验专家存在（锁定专家引用有效性） */
  expertExists: (id: string) => boolean;
  /** 校验工作目录存在并取其根（运行锚定与引用有效性） */
  workspaceOf: (id: string) => { root: string } | null;
  /** 无人值守执行（index.ts 注入：后台 AgentHost 跑一轮） */
  run: (task: AutomationDef, trigger: "timer" | "manual") => Promise<AutomationRunnerResult>;
  /** 运行结束回调（桌面通知 / UI 事件） */
  onRun?: (task: AutomationDef, record: AutomationRunRecord) => void;
  /** 自测模式：不开定时器，全靠手动驱动 */
  selfTest?: boolean;
}

const WEEK_LABEL = ["", "周一", "周二", "周三", "周四", "周五", "周六", "周日"];
const TICK_MS = 30_000;
const RUN_HISTORY_CAP = 100;
const PER_TASK_RUNS = 20;

const DAY_MS = 86_400_000;

/** 调度的中文展示（卡片/详情共用） */
export function scheduleText(s: AutomationSchedule): string {
  if (s.kind === "daily") return `每天 ${s.time ?? ""}`.trim();
  if (s.kind === "weekly") {
    const days = [...(s.weekdays ?? [])].sort((a, b) => a - b).map((d) => WEEK_LABEL[d] ?? String(d));
    return `每${days.join("、") || "?"} ${s.time ?? ""}`.trim();
  }
  const n = s.everyMinutes ?? 0;
  return n >= 60 && n % 60 === 0 ? `每 ${n / 60} 小时` : `每 ${Math.max(1, n)} 分钟`;
}

function weekdayOf(d: Date): number {
  const w = d.getDay(); // 0=周日
  return w === 0 ? 7 : w;
}

/** 下次运行时刻：interval 基于 lastRunAt 推进（过期则立即到期，跑一次后重新起算）；daily/weekly 总是取未来最近时刻 */
export function nextRunOf(task: AutomationDef, from: Date = new Date()): Date | null {
  if (!task.enabled) return null;
  const s = task.schedule;
  if (s.kind === "interval") {
    const base = new Date(task.lastRunAt ?? task.createdAt).getTime();
    const next = base + Math.max(1, s.everyMinutes ?? 30) * 60_000;
    return next <= from.getTime() ? new Date(from.getTime() + 1000) : new Date(next);
  }
  const [h, m] = String(s.time ?? "09:00").split(":").map(Number);
  const at = (d: Date): Date => {
    const x = new Date(d);
    x.setHours(h || 0, m || 0, 0, 0);
    return x;
  };
  if (s.kind === "daily") {
    const t = at(from);
    return t > from ? t : new Date(t.getTime() + DAY_MS);
  }
  for (let off = 0; off <= 7; off++) {
    const day = new Date(from.getTime() + off * DAY_MS);
    const cand = at(day);
    if (cand > from && (s.weekdays ?? []).includes(weekdayOf(day))) return cand;
  }
  return null;
}

function normalizeSchedule(s: AutomationSchedule): AutomationSchedule {
  const out: AutomationSchedule = { kind: s.kind };
  if (s.kind === "daily" || s.kind === "weekly") {
    const [h = 0, m = 0] = String(s.time ?? "09:00").split(":").map(Number);
    out.time = `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
    if (s.kind === "weekly") out.weekdays = [...new Set(s.weekdays ?? [])].filter((d) => d >= 1 && d <= 7).sort((a, b) => a - b);
  } else {
    out.everyMinutes = Math.max(1, Math.round(Number(s.everyMinutes ?? 30)));
  }
  return out;
}

function validateSchedule(s: AutomationSchedule): string | null {
  if (s.kind === "daily" || s.kind === "weekly") {
    if (!/^\d{1,2}:\d{1,2}$/.test(String(s.time ?? ""))) return "请填写运行时间（HH:MM）";
    const [h, m] = String(s.time).split(":").map(Number);
    if (h > 23 || m > 59) return "运行时间超出范围（00:00–23:59）";
    if (s.kind === "weekly" && !(s.weekdays ?? []).length) return "请至少选择一个运行日";
  } else if (s.kind === "interval") {
    const n = Number(s.everyMinutes);
    if (!Number.isFinite(n) || n < 1 || n > 1440) return "间隔分钟需在 1–1440 之间";
  } else {
    return "未知调度类型";
  }
  return null;
}

export class AutomationService {
  private tasks: AutomationDef[] = [];
  private runs: AutomationRunRecord[] = [];
  private file: string;
  private timer: NodeJS.Timeout | null = null;
  private runningId: string | null = null;

  constructor(private deps: AutomationServiceDeps) {
    this.file = path.join(deps.home, "automations.json");
  }

  async init(): Promise<void> {
    try {
      const data = JSON.parse(await fsp.readFile(this.file, "utf-8"));
      this.tasks = Array.isArray(data.tasks) ? data.tasks : [];
      this.runs = Array.isArray(data.runs) ? data.runs : [];
    } catch {
      // 首次启动无文件：空清单起步
    }
    if (!this.deps.selfTest) this.timer = setInterval(() => void this.tick(), TICK_MS);
  }

  dispose(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private async persist(): Promise<void> {
    const tmp = `${this.file}.tmp`;
    await fsp.writeFile(tmp, JSON.stringify({ tasks: this.tasks, runs: this.runs.slice(0, RUN_HISTORY_CAP) }, null, 2), "utf-8");
    await fsp.rename(tmp, this.file);
  }

  list(): AutomationView[] {
    return this.tasks.map((t) => ({
      ...t,
      scheduleText: scheduleText(t.schedule),
      nextRunAt: t.enabled ? (nextRunOf(t)?.toISOString() ?? null) : null,
    }));
  }

  runsOf(taskId: string): AutomationRunRecord[] {
    return this.runs.filter((r) => r.taskId === taskId).slice(0, PER_TASK_RUNS);
  }

  async create(input: CreateAutomationInput): Promise<AutomationDef> {
    const name = String(input?.name ?? "").trim();
    const prompt = String(input?.prompt ?? "").trim();
    if (!name || name.length > 40) throw new Error("任务名需 1–40 字");
    if (!prompt || prompt.length > 4000) throw new Error("任务指令需 1–4000 字");
    if (!this.deps.expertExists(String(input?.expertId ?? ""))) throw new Error("未知专家，请重新选择");
    const wsId = String(input?.wsId || "default");
    if (!this.deps.workspaceOf(wsId)) throw new Error("未知工作目录，请重新选择");
    const scheduleErr = validateSchedule(input?.schedule ?? {});
    if (scheduleErr) throw new Error(scheduleErr);
    const def: AutomationDef = {
      id: `auto-${randomUUID().slice(0, 8)}`,
      name,
      prompt,
      expertId: String(input.expertId),
      wsId,
      schedule: normalizeSchedule(input.schedule),
      preAuth: [...new Set((input.preAuth ?? []).map(String))],
      enabled: true,
      createdAt: new Date().toISOString(),
      runCount: 0,
    };
    this.tasks.push(def);
    await this.persist();
    this.deps.audit.append({ event: "automation_create", task: def.name, schedule: scheduleText(def.schedule), preAuth: def.preAuth, wsId });
    return def;
  }

  async update(id: string, patch: Partial<Pick<AutomationDef, "name" | "prompt" | "expertId" | "wsId" | "schedule" | "preAuth">>): Promise<AutomationDef> {
    const task = this.tasks.find((t) => t.id === id);
    if (!task) throw new Error(`任务不存在: ${id}`);
    if (this.runningId === id) throw new Error("任务正在运行，请稍后再编辑");
    if (patch.name !== undefined) {
      const name = String(patch.name).trim();
      if (!name || name.length > 40) throw new Error("任务名需 1–40 字");
      task.name = name;
    }
    if (patch.prompt !== undefined) {
      const prompt = String(patch.prompt).trim();
      if (!prompt || prompt.length > 4000) throw new Error("任务指令需 1–4000 字");
      task.prompt = prompt;
    }
    if (patch.expertId !== undefined) {
      if (!this.deps.expertExists(String(patch.expertId))) throw new Error("未知专家，请重新选择");
      task.expertId = String(patch.expertId);
    }
    if (patch.wsId !== undefined && patch.wsId !== "") {
      if (!this.deps.workspaceOf(String(patch.wsId))) throw new Error("未知工作目录，请重新选择");
      task.wsId = String(patch.wsId);
    }
    if (patch.schedule !== undefined) {
      const scheduleErr = validateSchedule(patch.schedule);
      if (scheduleErr) throw new Error(scheduleErr);
      task.schedule = normalizeSchedule(patch.schedule);
    }
    if (patch.preAuth !== undefined) task.preAuth = [...new Set(patch.preAuth.map(String))];
    await this.persist();
    this.deps.audit.append({ event: "automation_update", task: task.name, schedule: scheduleText(task.schedule), preAuth: task.preAuth });
    return task;
  }

  async setEnabled(id: string, enabled: boolean): Promise<boolean> {
    const task = this.tasks.find((t) => t.id === id);
    if (!task) throw new Error(`任务不存在: ${id}`);
    if (task.enabled === enabled) return true;
    task.enabled = enabled;
    await this.persist();
    this.deps.audit.append({ event: "automation_toggle", task: task.name, enabled });
    return true;
  }

  async remove(id: string): Promise<void> {
    const task = this.tasks.find((t) => t.id === id);
    if (!task) throw new Error(`任务不存在: ${id}`);
    if (this.runningId === id) throw new Error("任务正在运行，无法删除");
    this.tasks = this.tasks.filter((t) => t.id !== id);
    this.runs = this.runs.filter((r) => r.taskId !== id);
    await this.persist();
    this.deps.audit.append({ event: "automation_delete", task: task.name });
  }

  /** 手动触发一次（“立即运行”/自测）：与定时触发共用同一条串行通道 */
  async runNow(id: string, trigger: "timer" | "manual"): Promise<AutomationRunRecord> {
    const task = this.tasks.find((t) => t.id === id);
    if (!task) throw new Error(`任务不存在: ${id}`);
    if (this.runningId) {
      const busy = this.tasks.find((t) => t.id === this.runningId);
      throw new Error(`「${busy?.name ?? this.runningId}」正在运行，请稍候`);
    }
    this.runningId = id;
    try {
      return await this.execute(task, trigger);
    } finally {
      this.runningId = null;
    }
  }

  /** 定时扫描：到期的启用任务逐个执行（一次一个，未跑完的下个 tick 继续） */
  async tick(): Promise<number> {
    if (this.runningId) return 0;
    const now = Date.now();
    let n = 0;
    for (const t of this.tasks) {
      if (!t.enabled) continue;
      const next = nextRunOf(t);
      if (!next || next.getTime() > now) continue;
      await this.runNow(t.id, "timer").catch(() => {});
      n++;
    }
    return n;
  }

  private async execute(task: AutomationDef, trigger: "timer" | "manual"): Promise<AutomationRunRecord> {
    const started = Date.now();
    let res: AutomationRunnerResult;
    try {
      res = await this.deps.run(task, trigger);
    } catch (e) {
      res = { ok: false, summary: "", error: String((e as any)?.message ?? e) };
    }
    const record: AutomationRunRecord = {
      id: randomUUID(),
      taskId: task.id,
      taskName: task.name,
      trigger,
      startedAt: new Date(started).toISOString(),
      durationMs: Date.now() - started,
      ok: res.ok,
      summary: (res.summary || "").slice(0, 500),
      error: res.error,
      sessionId: res.sessionId,
    };
    task.lastRunAt = record.startedAt;
    task.lastStatus = res.ok ? "ok" : "error";
    task.lastSummary = record.summary || record.error || "";
    task.lastSessionId = res.sessionId;
    task.runCount++;
    this.runs.unshift(record);
    this.runs = this.runs.slice(0, RUN_HISTORY_CAP);
    await this.persist();
    this.deps.audit.append({
      event: "automation_run",
      task: task.name,
      trigger,
      ok: res.ok,
      durationMs: record.durationMs,
      sessionId: res.sessionId,
      error: res.error,
    });
    this.deps.onRun?.(task, record);
    return record;
  }
}
