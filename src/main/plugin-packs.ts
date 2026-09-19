// 插件包服务（M5，方案 §12.4）：目录拉取 → 安装（下载→sha256 复核→解压→原子落盘→manifest→current 指针→GC）
// → 注册 overlay（技能目录注入 SkillStore）→ required 包自动安装 → 含 CLI 制品的包跑 --version 冒烟。
// 仅 admin.baseUrl 非空时激活；失败静默（4.6 降级：本地无包照常，内置兜底）。
// 定性口径（2026-09-07）：officecli 为内置引擎不经插件包下发；CLI 制品供技能以绝对路径引用，不接管 Office 引擎。
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import AdmZip from "adm-zip";
import { adminFetchJson, authHeaders } from "./admin-link";
import type { Workspace } from "./workspace";
import type { Audit } from "./audit";

export interface PackItem {
  kind: "skill" | "mcp" | "cli" | "asset";
  entry?: string;
  sha256: string;
  filename: string;
  size: number;
  platform: string;
}

export interface PackCatalogEntry {
  id?: number;
  name: string;
  title: string | null;
  version: string;
  description: string;
  status: string;
  required: boolean;
  items: PackItem[];
}

export interface InstalledPack {
  name: string;
  version: string;
  installedAt: string;
}

const AREA_OF: Record<PackItem["kind"], string> = { skill: "skills", mcp: "mcp", cli: "cli", asset: "asset" };

function platform(): string {
  return process.platform === "win32" ? "win" : process.platform === "darwin" ? "darwin" : "linux";
}

export class PluginPackService {
  private registryFile: string;

  constructor(
    private opts: {
      base: string;
      workspace: Workspace;
      audit: Audit;
      /** 安装/卸载后回调（技能重扫 + 预览链路） */
      onChanged: () => Promise<void>;
      /** mcp_pkg 安装冒烟：本地子进程握手 + tools/list，返回工具数（index.ts 注入 localMcp.ensure） */
      mcpSmoke?: (name: string) => Promise<number>;
      /** mcp_pkg 卸载：停掉该包的本地子进程（若有） */
      mcpStop?: (name: string) => void;
    }
  ) {
    this.registryFile = path.join(opts.workspace.dirs.config, "plugin-packs.json");
  }

  private get managedRoot(): string {
    return this.opts.workspace.dirs.managed;
  }

  async catalog(): Promise<PackCatalogEntry[]> {
    try {
      const items = await adminFetchJson<PackCatalogEntry[]>(this.opts.base, `/api/v1/catalog/plugin-packs?platform=${platform()}`);
      // officecli 已定性客户端内置引擎（2026-09-07）：目录层拒绝识别——旧服务端数据库可能仍发布该包
      // （required 还会被 syncRequired 自动重装），面板与 required 同步同源，此处过滤即两处全断
      return items.filter((p) => p.name !== "officecli");
    } catch {
      return [];
    }
  }

  async listInstalled(): Promise<Record<string, InstalledPack>> {
    try {
      return JSON.parse(await fsp.readFile(this.registryFile, "utf-8"));
    } catch {
      return {};
    }
  }

  private async saveInstalled(reg: Record<string, InstalledPack>): Promise<void> {
    await fsp.mkdir(path.dirname(this.registryFile), { recursive: true });
    await fsp.writeFile(this.registryFile, JSON.stringify(reg, null, 2), "utf-8");
  }

  /** 供 SkillStore 扫描的 managed 技能目录（每包每版本一个根，loadSkills 按目录扫 SKILL.md） */
  managedSkillDirs(): string[] {
    const out: string[] = [];
    const skillsRoot = path.join(this.managedRoot, "skills");
    for (const pack of safeList(skillsRoot)) {
      if (!pack.isDirectory()) continue;
      for (const ver of safeList(path.join(skillsRoot, pack.name))) {
        const dir = path.join(skillsRoot, pack.name, ver.name);
        if (ver.isDirectory() && fs.existsSync(path.join(dir, "SKILL.md"))) out.push(dir);
      }
    }
    return out;
  }

  async install(name: string): Promise<void> {
    const pack = (await this.catalog()).find((p) => p.name === name);
    if (!pack) throw new Error(`插件包目录中没有「${name}」`);
    await this.installPack(pack);
  }

  private async installPack(pack: PackCatalogEntry): Promise<void> {
    const staging = path.join(this.managedRoot, ".staging", `${pack.name}-${pack.version}-${Date.now()}`);
    await fsp.rm(staging, { recursive: true, force: true }).catch(() => {});
    await fsp.mkdir(staging, { recursive: true });
    const manifest: Record<string, unknown> = { name: pack.name, version: pack.version, installedAt: new Date().toISOString(), items: [] };

    for (const item of pack.items) {
      const res = await fetch(`${this.opts.base}/api/v1/artifacts/${item.sha256}`, { headers: authHeaders() });
      if (!res.ok) throw new Error(`制品下载失败 ${item.sha256.slice(0, 8)}…（HTTP ${res.status}）`);
      const bytes = Buffer.from(await res.arrayBuffer());
      const sha = createHash("sha256").update(bytes).digest("hex");
      if (sha !== item.sha256) throw new Error(`制品校验不符：${item.filename}（拒装，防篡改）`);
      const area = path.join(staging, AREA_OF[item.kind], pack.name);
      if (item.kind === "cli") {
        const rel = item.entry ?? item.filename;
        const dest = path.join(area, pack.version, rel);
        await fsp.mkdir(path.dirname(dest), { recursive: true });
        await fsp.writeFile(dest, bytes);
        try {
          await fsp.chmod(dest, 0o755);
        } catch {
          /* Windows 无需 */
        }
      } else {
        // zip 制品：解包到版本目录
        const dest = path.join(area, pack.version);
        new AdmZip(bytes).extractAllTo(dest, true);
      }
      (manifest.items as Array<Record<string, unknown>>).push({ kind: item.kind, sha256: item.sha256, filename: item.filename, entry: item.entry ?? null });
    }

    // 原子提交：逐区 staging → 正式位
    for (const area of fs.readdirSync(staging).filter((d) => fs.statSync(path.join(staging, d)).isDirectory())) {
      const srcRoot = path.join(staging, area);
      for (const packDir of safeList(srcRoot)) {
        const dest = path.join(this.managedRoot, area, packDir.name);
        await fsp.mkdir(path.dirname(dest), { recursive: true });
        await fsp.rm(dest, { recursive: true, force: true }).catch(() => {});
        await fsp.rename(path.join(srcRoot, packDir.name), dest);
      }
    }
    await fsp.rm(staging, { recursive: true, force: true }).catch(() => {});
    this.gcOldVersions(pack.name);
    await fsp.mkdir(path.join(this.managedRoot, "manifests"), { recursive: true });
    await fsp.writeFile(path.join(this.managedRoot, "manifests", `${pack.name}.json`), JSON.stringify(manifest, null, 2) + "\n", "utf-8");
    // current 指针（cli 区）：officeBinary 等按此解析当前版二进制
    const cliItem = pack.items.find((i) => i.kind === "cli");
    if (cliItem) {
      await fsp.writeFile(
        path.join(this.managedRoot, "cli", pack.name, "current.json"),
        JSON.stringify({ version: pack.version, bin: (cliItem.entry ?? cliItem.filename).split("\\").join("/") }, null, 2),
        "utf-8"
      );
    }
    const reg = await this.listInstalled();
    reg[pack.name] = { name: pack.name, version: pack.version, installedAt: manifest.installedAt as string };
    await this.saveInstalled(reg);
    this.opts.audit.append({ event: "plugin_pack_install", name: pack.name, version: pack.version });
    await this.opts.onChanged();
  }

  /** 旧版 GC：各 area 下保留当前版 + 上一版（回退位） */
  private gcOldVersions(packName: string): void {
    for (const area of ["skills", "mcp", "cli", "asset"]) {
      const root = path.join(this.managedRoot, area, packName);
      const versions = safeList(root).filter((v) => v.isDirectory()).map((v) => v.name).sort();
      while (versions.length > 2) {
        const old = versions.shift()!;
        fs.rmSync(path.join(root, old), { recursive: true, force: true });
      }
    }
  }

  async uninstall(name: string): Promise<void> {
    this.opts.mcpStop?.(name); // mcp 包：先停本地子进程再删目录（Windows 句柄）
    for (const area of ["skills", "mcp", "cli", "asset"]) {
      await fsp.rm(path.join(this.managedRoot, area, name), { recursive: true, force: true }).catch(() => {});
    }
    await fsp.rm(path.join(this.managedRoot, "manifests", `${name}.json`), { force: true }).catch(() => {});
    const reg = await this.listInstalled();
    delete reg[name];
    await this.saveInstalled(reg);
    this.opts.audit.append({ event: "plugin_pack_uninstall", name });
    await this.opts.onChanged();
  }

  /** 历史遗留清理：已装的 officecli 插件包启动即卸载（登记 + managed 目录齐清）；配合 catalog() 过滤永不复装 */
  async cleanupLegacy(): Promise<void> {
    const reg = await this.listInstalled();
    if (!reg["officecli"]) return;
    await this.uninstall("officecli");
    console.log("[ADMIN-PACK] 遗留 officecli 插件包已清理（内置引擎不再经插件包分发）");
  }

  /** required 包自动安装/升级（企业强制下发；启动 + 每 30 分钟） */
  async syncRequired(): Promise<string[]> {
    const installed: string[] = [];
    const reg = await this.listInstalled();
    for (const pack of await this.catalog()) {
      if (!pack.required) continue;
      if (reg[pack.name]?.version === pack.version) continue;
      try {
        await this.installPack(pack);
        installed.push(`${pack.name}@${pack.version}`);
        console.log(`[ADMIN-PACK] installed ${pack.name}@${pack.version} → ${this.managedRoot}`);
        if (pack.items.some((i) => i.kind === "mcp")) {
          console.log(`[ADMIN-PACK] mcp-ready ${pack.name}（连接器页可挂载，本地子进程运行）`);
          await this.mcpSmokeCheck(pack.name);
        }
        await this.cliSmoke(pack);
      } catch (e) {
        this.opts.audit.append({ event: "plugin_pack_install_failed", name: pack.name, reason: String((e as Error)?.message ?? e).slice(0, 200) });
      }
    }
    return installed;
  }

  /** mcp_pkg 安装冒烟：真实起本地子进程握手 + tools/list（e2e 验收标记；失败只记日志不阻断） */
  private async mcpSmokeCheck(packName: string): Promise<void> {
    if (!this.opts.mcpSmoke) return;
    try {
      const n = await this.opts.mcpSmoke(packName);
      console.log(`[ADMIN-PACK] mcp-smoke ${packName} tools=${n}`);
    } catch (e) {
      console.log(`[ADMIN-PACK] mcp-smoke-error ${packName} ${String((e as Error)?.message ?? e).slice(0, 120)}`);
    }
  }

  /** 含 CLI 制品的包安装后跑一次 managed 二进制 --version 冒烟（e2e 验收标记；任意 CLI 包通用） */
  private async cliSmoke(pack: PackCatalogEntry): Promise<void> {
    const cliItem = pack.items.find((i) => i.kind === "cli");
    if (!cliItem) return;
    const rel = cliItem.entry ?? cliItem.filename;
    const bin = path.join(this.managedRoot, "cli", pack.name, pack.version, ...rel.split(/[\\/]/));
    if (!fs.existsSync(bin)) return;
    try {
      const v = await new Promise<string>((resolve) => {
        const p = spawn(bin, ["--version"], { cwd: os.tmpdir(), windowsHide: true });
        let out = "";
        p.stdout.on("data", (d) => (out += d));
        p.stderr.on("data", (d) => (out += d));
        p.on("error", () => resolve(""));
        p.on("close", () => resolve(out.trim()));
      });
      console.log(`[ADMIN-PACK] cli-ready ${pack.name}@${pack.version}${v ? ` ${v.slice(0, 60)}` : ""}`);
    } catch (e) {
      console.log(`[ADMIN-PACK] cli-smoke-error ${pack.name} ${String((e as Error)?.message ?? e).slice(0, 120)}`);
    }
  }
}

function safeList(dir: string): Array<{ name: string; isDirectory: () => boolean }> {
  try {
    return fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}
