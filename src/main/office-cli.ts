// OfficeCLI 引擎封装（agent Office 工具族底层）：直调官方单二进制（--json），
// 超时/结构化错误/autoUpdate 关死。二进制定位：打包后在 extraResources，开发态在 node_modules。
// 跨平台：vendor 目录内按平台取 officecli(.exe)；无原生依赖、无外部进程链。
// 定性口径（2026-09-07）：officecli 是内置引擎，随安装包分发、随客户端发版更新——
// 插件包通道不再承载 officecli；officeBinary 不读 managed 目录（防无关 CLI 包劫持 Office 引擎）。
import { spawn } from "node:child_process";
import * as fsSync from "node:fs";
import * as path from "node:path";

const BIN_TIMEOUT_MS = 90_000;

let cachedBin: string | null | undefined;

/** officecli 包根候选：打包形态 extraResources 整目录；开发形态 node_modules */
function officeRootCandidates(): string[] {
  const roots: string[] = [];
  if (process.resourcesPath) roots.push(path.join(process.resourcesPath, "officecli"));
  roots.push(path.join(__dirname, "../../node_modules/@officecli/officecli"));
  return roots;
}

/** 定位内置 officecli 二进制（唯一来源）；找不到返回 null（工具调用时如实报错，不静默降级） */
export function officeBinary(): string | null {
  if (cachedBin !== undefined) return cachedBin;
  const exeName = process.platform === "win32" ? "officecli.exe" : "officecli";
  for (const root of officeRootCandidates()) {
    const c = path.join(root, "vendor", exeName);
    try {
      if (fsSync.existsSync(c)) {
        cachedBin = c;
        return c;
      }
    } catch {
      /* continue */
    }
  }
  cachedBin = null;
  return null;
}

/** 内置引擎版本（读包根 package.json；插件包面板「内置」卡与启动健康标记用） */
export function officeBuiltinVersion(): string | null {
  for (const root of officeRootCandidates()) {
    try {
      const pj = JSON.parse(fsSync.readFileSync(path.join(root, "package.json"), "utf-8")) as { version?: string };
      if (pj?.version) return String(pj.version);
    } catch {
      /* continue */
    }
  }
  return null;
}

export function officeAvailable(): boolean {
  return !!officeBinary();
}

let updateDisabled = false;

/** 执行 officecli 命令（自动补 --json），返回解析后的 JSON；失败抛含 stderr 摘要的 Error */
export async function officeRun(args: string[], cwd: string): Promise<any> {
  const bin = officeBinary();
  if (!bin) throw new Error("OfficeCLI 未安装（打包应内置；开发环境需 npm install 后置于 node_modules）");
  if (!updateDisabled) {
    // 内网环境：首次使用即关后台自动更新（且每次调用都带 OFFICECLI_SKIP_UPDATE=1 双保险）
    updateDisabled = true;
    await new Promise<void>((resolve) => {
      const c = spawn(bin, ["config", "autoUpdate", "false"], { cwd, windowsHide: true });
      c.on("error", () => resolve());
      c.on("close", () => resolve());
    });
  }
  return await new Promise<any>((resolve, reject) => {
    const child = spawn(bin, [...args, "--json"], {
      cwd,
      windowsHide: true,
      env: { ...process.env, OFFICECLI_SKIP_UPDATE: "1" },
    });
    let out = "";
    let err = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, BIN_TIMEOUT_MS);
    child.stdout?.on("data", (d) => {
      if (out.length < 2_000_000) out += d.toString();
    });
    child.stderr?.on("data", (d) => {
      if (err.length < 50_000) err += d.toString();
    });
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(new Error(`OfficeCLI 启动失败：${e.message}`));
    });
    child.on("close", () => {
      clearTimeout(timer);
      if (timedOut) {
        reject(new Error(`OfficeCLI 超时（${BIN_TIMEOUT_MS / 1000}s），已终止`));
        return;
      }
      const start = out.indexOf("{");
      if (start < 0) {
        reject(new Error(`OfficeCLI 输出无法解析${err ? `：${err.slice(0, 300)}` : ""}`));
        return;
      }
      try {
        const j = JSON.parse(out.slice(start));
        if (j && j.success === false) {
          const e: any = j.error ?? {};
          const detail = typeof e === "string" ? e : [e.error, e.message].filter(Boolean).join(" ") || JSON.stringify(j).slice(0, 400);
          reject(new Error(`OfficeCLI ${e.code ?? "error"}：${String(detail).slice(0, 400)}`));
        } else resolve(j);
      } catch (e) {
        reject(new Error(`OfficeCLI JSON 解析失败：${String(e && (e as Error).message ? (e as Error).message : e).slice(0, 200)}`));
      }
    });
  });
}

/** 批量操作（每项 {command, ...}）后落盘关驻留（close 幂等，失败不阻断） */
export async function officeBatch(absFile: string, commands: Array<Record<string, unknown>>): Promise<any> {
  const r = await officeRun(["batch", absFile, "--commands", JSON.stringify(commands)], path.dirname(absFile));
  try {
    await officeRun(["close", absFile], path.dirname(absFile));
  } catch {
    /* close 失败不阻断：batch 独立模式本身已是一次 open/save 循环 */
  }
  return r;
}

/** query 选择器（CSS 式）→ results 数组（text 为文本内容，preview 为元素显示名——sheet 名等取这个） */
export async function officeQuery(absFile: string, selector: string): Promise<Array<{ path: string; text?: string; preview?: string; type?: string }>> {
  const r = await officeRun(["query", absFile, selector], path.dirname(absFile));
  const d = r?.data?.results;
  return Array.isArray(d) ? d : [];
}
