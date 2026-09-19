// 附件收件（composer 附件真实链路）：base64 → 工作区 .inbox/<日期>/ 去重落盘 + prompt 附件块拼接。
// 附件存入工作区即天然走既有围栏/审计（agent 用 read_file / 相应工具直接处理），不引入新权限面。
import * as fsp from "node:fs/promises";
import * as fsSync from "node:fs";
import * as path from "node:path";
import type { Audit } from "./audit";

export interface AttachmentInput {
  name: string;
  dataBase64: string;
}

/** prompt 末尾附件块：告知 agent 附件已在工作区（用什么工具处理由 agent 自主决定） */
export function attachmentBlock(rels: string[]): string {
  if (!rels.length) return "";
  return `\n\n[用户附件]（已存入当前工作区，可直接用 read_file / 相应工具处理）：\n${rels.map((r) => `- ${r}`).join("\n")}`;
}

/** 附件名净化：剥路径与控制字符（防目录穿越），空名兜底 */
export function safeAttachmentName(raw: string): string {
  const base = path.basename(String(raw ?? "")).replace(/[\x00-\x1f]/g, "").trim();
  return base || "attachment.bin";
}

/** 落盘：.inbox/<日期>/ 下重名自动 (n) 序号；返回工作区相对路径（/ 分隔，prompt 引用用） */
export async function saveAttachments(root: string, atts: AttachmentInput[], audit?: Audit): Promise<string[]> {
  const day = new Date().toISOString().slice(0, 10);
  const inbox = path.join(root, ".inbox", day);
  await fsp.mkdir(inbox, { recursive: true });
  const saved: string[] = [];
  for (const a of atts) {
    const bytes = Buffer.from(String(a.dataBase64 ?? ""), "base64");
    const safe = safeAttachmentName(a.name);
    let dst = path.join(inbox, safe);
    let n = 1;
    while (fsSync.existsSync(dst)) {
      const ext = path.extname(safe);
      dst = path.join(inbox, `${path.basename(safe, ext) || safe}(${n++})${ext}`);
    }
    await fsp.writeFile(dst, bytes);
    const rel = path.relative(root, dst).split(path.sep).join("/");
    saved.push(rel);
    audit?.append({ event: "attachment_save", name: path.basename(dst), bytes: bytes.length, rel });
  }
  return saved;
}
