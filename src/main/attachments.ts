// 输入引用（v6）：用户给 agent 的输入文件 = 引用，不是副本。
// - 拖拽/选择的磁盘文件：渲染层经 webUtils 拿到原始绝对路径，直接引用（零副本，天然去重）；
// - 无路径输入（剪贴板粘贴截图、IM 传来的字节）：落到产品域按工作区隔离的暂存目录
//   ~/.ordo/workspaces/<wsId>/tmp/uploads/<日期>/，文件名带内容哈希前缀（同字节天然去重）；
// - 引用与暂存文件对 agent 只读（围栏保证），处理产出必须另存新文件（提示词约定）。
// 旧 <工作区>/.inbox/（v5 前的附件目录）原地保留不再使用，不做迁移不删除。
import * as fsp from "node:fs/promises";
import * as fsSync from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";
import type { Audit } from "./audit";

export interface AttachmentInput {
  name: string;
  size?: number;
  /** 磁盘文件的原始绝对路径（拖拽/选择；有此字段则零副本直接引用） */
  path?: string;
  /** 无路径输入的字节（粘贴/远端传输）；落产品域暂存，内容哈希去重 */
  dataBase64?: string;
}

/** prompt 末尾附件块：引用语义——只读输入，产出另存新文件 */
export function attachmentBlock(refs: string[]): string {
  if (!refs.length) return "";
  return `\n\n[用户输入引用]（可直接 read_file 读取；只读，禁止修改或覆盖原件；处理产出请另存为新文件到工作区）：\n${refs.map((r) => `- ${r}`).join("\n")}`;
}

/** 附件名净化：剥路径与控制字符（防目录穿越），空名兜底 */
export function safeAttachmentName(raw: string): string {
  const base = path.basename(String(raw ?? "")).replace(/[\x00-\x1f]/g, "").trim();
  return base || "attachment.bin";
}

/**
 * 输入引用解析：path 条目原样返回（存在性校验，不存在降级报错）；字节条目落暂存（哈希去重）。
 * 返回绝对引用路径列表（进 prompt 附件块 + 自动读授权）。
 */
export async function resolveInputReferences(
  tempRoot: string,
  atts: AttachmentInput[],
  audit?: Audit
): Promise<{ refs: string[]; errors: string[] }> {
  const day = new Date().toISOString().slice(0, 10);
  const refs: string[] = [];
  const errors: string[] = [];
  for (const a of atts) {
    const safe = safeAttachmentName(a.name);
    if (a.path) {
      const abs = path.resolve(String(a.path));
      if (!fsSync.existsSync(abs)) {
        errors.push(`${safe}（文件不存在）`);
        continue;
      }
      refs.push(abs);
      audit?.append({ event: "attachment_ref", name: path.basename(abs), rel: abs });
      continue;
    }
    if (typeof a.dataBase64 === "string" && a.dataBase64.length) {
      const bytes = Buffer.from(a.dataBase64, "base64");
      const dir = path.join(tempRoot, "uploads", day);
      await fsp.mkdir(dir, { recursive: true });
      const hash = createHash("sha256").update(bytes).digest("hex").slice(0, 12);
      const dst = path.join(dir, `${hash}-${safe}`);
      if (!fsSync.existsSync(dst)) await fsp.writeFile(dst, bytes); // 同字节同名 → 已存在即跳过（去重）
      refs.push(dst);
      audit?.append({ event: "attachment_materialize", name: path.basename(dst), bytes: bytes.length, rel: dst });
      continue;
    }
    errors.push(`${safe}（既无路径也无内容）`);
  }
  return { refs, errors };
}

/** 启动清理：~/.ordo/workspaces 下各工作区 tmp/ 内超过 TTL 的条目删除（前台暂存 TTL 兜底，回收站同款机制） */
export async function sweepWorkspacesTemp(home: string, ttlMs = 72 * 3600_000): Promise<void> {
  const wsRoot = path.join(home, "workspaces");
  let entries: fsSync.Dirent[];
  try {
    entries = fsSync.readdirSync(wsRoot, { withFileTypes: true });
  } catch {
    return;
  }
  const now = Date.now();
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const tmp = path.join(wsRoot, e.name, "tmp");
    let items: fsSync.Dirent[];
    try {
      items = fsSync.readdirSync(tmp, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const it of items) {
      const full = path.join(tmp, it.name);
      try {
        const st = await fsp.stat(full);
        if (now - st.mtimeMs > ttlMs) await fsp.rm(full, { recursive: true, force: true });
      } catch {
        /* 单条失败不阻断 */
      }
    }
  }
}
