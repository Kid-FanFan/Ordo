// 用户消息中的外部路径提取（提及即授权，v6）：纯函数，selftest 直测。
// 提及 = 用户亲口给出的路径，即同意——按会话登记读授权；已存在的目录额外给写授权（用户指定的输出目标）。
// 只登记真实存在的路径（fsSync 校验），天然过滤 URL/代码片段等误匹配。
import * as fsSync from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export type GrantKind = "read" | "writeDir";
export interface ExternalPathHit {
  raw: string;
  abs: string;
  kind: GrantKind;
}

// 各平台绝对路径形态：Windows 盘符 / UNC；POSIX 根路径；~ 家目录。引号与中文标点截断。
const WIN_DRIVE = /(?:[A-Za-z]:[\\\/][^\s"'`<>|，。；：）]+)/g;
const WIN_UNC = /\\\\[^\s"'`<>|，。；：）]+/g;
const POSIX_ABS = /(?<![\w:])(\/(?:[\w.@+-]+\/)*[\w.@+-]+(?:\/)?)(?![\w.])/g;
const HOME_TILDE = /~(?:[\/\\][^\s"'`<>|，。；：）]+)?/g;

function trimTrailing(raw: string): string {
  return raw.replace(/[.,;:!?、，。；：）】」』]+$/u, "");
}

/** 从用户文本提取真实存在的外部路径。cwd 仅用于无关路径的解析基准，结果恒为绝对路径。 */
export function extractExternalPaths(text: string, platform: NodeJS.Platform = process.platform): ExternalPathHit[] {
  const raw = String(text ?? "");
  if (!raw) return [];
  const out = new Map<string, ExternalPathHit>();
  const consider = (candidate: string) => {
    const abs = candidate.startsWith("~") ? path.join(os.homedir(), candidate.slice(1)) : path.resolve(candidate);
    let st: fsSync.Stats | null = null;
    try {
      st = fsSync.statSync(abs);
    } catch {
      return; // 不存在：不登记（误匹配防护的核心）
    }
    const kind: GrantKind = st.isDirectory() ? "writeDir" : "read";
    const key = `${abs}::${kind}`;
    if (!out.has(key)) out.set(key, { raw: candidate, abs, kind });
  };
  for (const m of raw.matchAll(WIN_DRIVE)) consider(trimTrailing(m[0]));
  for (const m of raw.matchAll(WIN_UNC)) consider(trimTrailing(m[0]));
  if (platform !== "win32") {
    for (const m of raw.matchAll(POSIX_ABS)) consider(trimTrailing(m[0]));
  }
  for (const m of raw.matchAll(HOME_TILDE)) consider(trimTrailing(m[0]));
  return [...out.values()];
}

/** 文本中是否引用了授权范围外的路径（run_command 分级用：引用外部路径的命令一律 L2，堵白名单侧门） */
export function referencesPathOutsideFence(
  text: string,
  fenceRoots: string[],
  grants: Iterable<string>,
  platform: NodeJS.Platform = process.platform
): boolean {
  const raw = String(text ?? "");
  if (!raw) return false;
  const cands: string[] = [];
  for (const m of raw.matchAll(WIN_DRIVE)) cands.push(trimTrailing(m[0]));
  for (const m of raw.matchAll(WIN_UNC)) cands.push(trimTrailing(m[0]));
  for (const m of raw.matchAll(POSIX_ABS)) cands.push(trimTrailing(m[0]));
  for (const m of raw.matchAll(HOME_TILDE)) cands.push(trimTrailing(m[0]));
  const granted = new Set([...grants].map((g) => path.resolve(g)));
  const inFence = (abs: string) => {
    const p = path.resolve(abs);
    return fenceRoots.some((r) => p === r || p.startsWith(path.resolve(r) + path.sep)) || granted.has(p);
  };
  for (const c of cands) {
    const abs = c.startsWith("~") ? path.join(os.homedir(), c.slice(1)) : path.resolve(c);
    if (!inFence(abs)) return true; // 引用了围栏外路径即按 L2（无需存在性校验——存在与否都不该静默放行）
  }
  return false;
}
