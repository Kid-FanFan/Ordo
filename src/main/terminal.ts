// 用户侧终端（方案 §6）：主进程 node-pty（Windows 接 PowerShell）+ 渲染端 xterm.js
// 范围界定：只做查看/操作，工作目录跟随当前工作区；agent 的 shell 命令执行工具涉及
// 破坏性命令边界，按 L2 策略后续单独立项（不随本轮）
import * as nodePty from "node-pty";
import type { IPty } from "node-pty";
import type { Audit } from "./audit";

export class TerminalHost {
  private proc: IPty | null = null;
  private openSeq = 0;

  constructor(
    private opts: {
      audit: Audit;
      onEvent: (ev: Record<string, unknown>) => void;
    }
  ) {}

  get active(): boolean {
    return !!this.proc;
  }

  get cwdSnapshot(): string {
    return this.openedCwd;
  }
  private openedCwd = "";

  /** 打开（或复用）终端；cwd = 当前工作区根目录（跟随工作区切换：已开的进程不动，新开取新根） */
  open(cwd: string): { id: string; cols: number; rows: number; reused: boolean } {
    if (this.proc) return { id: "term", cols: this.proc.cols, rows: this.proc.rows, reused: true };
    this.openedCwd = cwd;
    this.proc = nodePty.spawn("powershell.exe", ["-NoProfile"], {
      name: "xterm-256color",
      cols: 80,
      rows: 24,
      cwd,
      env: process.env as Record<string, string>,
    });
    this.openSeq += 1;
    const seq = this.openSeq;
    this.opts.audit.append({ event: "term_open", cwd, seq });
    this.proc.onData((data) => this.opts.onEvent({ type: "term_data", data, seq }));
    this.proc.onExit(({ exitCode }) => {
      this.opts.onEvent({ type: "term_exit", exitCode, seq });
      this.proc = null;
      this.opts.onEvent({ type: "term_state_changed" });
    });
    this.opts.onEvent({ type: "term_state_changed" });
    return { id: "term", cols: this.proc.cols, rows: this.proc.rows, reused: false };
  }

  write(data: string): boolean {
    if (!this.proc) return false;
    this.proc.write(data);
    return true;
  }

  resize(cols: number, rows: number): boolean {
    if (!this.proc) return false;
    try {
      this.proc.resize(Math.max(2, cols | 0), Math.max(2, rows | 0));
      return true;
    } catch {
      return false; // 进程退出竞态：忽略
    }
  }

  close(): boolean {
    if (!this.proc) return false;
    this.opts.audit.append({ event: "term_close", cwd: this.openedCwd });
    try {
      this.proc.kill();
    } catch {
      /* 已退出 */
    }
    this.proc = null;
    this.opts.onEvent({ type: "term_state_changed" });
    return true;
  }
}
