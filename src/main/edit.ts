// 用户侧文件编辑（方案 §2.3 第一层：纯客户端）：md/txt/csv 文本 + xlsx 值回写
// 保存 = 用户显式动作：只审计（user_edit）不再二次弹确认（与 agent 的 L2 write_file 相区别）
import * as path from "node:path";
import * as fs from "node:fs";
import type { Workspace } from "./workspace";

const TEXT_EDIT_MAX = 1024 * 1024; // 与文本预览上限一致
const BINARY_EDIT_MAX = 20 * 1024 * 1024; // 与 Office 预览上限一致

const TEXT_EDIT_EXTS = new Set([".md", ".txt", ".csv"]);
const BINARY_EDIT_EXTS = new Set([".xlsx"]); // docx/pptx 编辑依赖二期 office 服务（方案 D5）

export type EditPayload = { text: string } | { base64: string };

/** audit 传入则随写随记（user_edit）：审计内嵌而非留在 IPC 层，保证任何调用路径都留痕 */
export async function saveUserEdit(
  ws: Workspace,
  relPath: string,
  payload: EditPayload,
  audit?: { append(record: Record<string, unknown>): void }
): Promise<{ bytes: number }> {
  const abs = ws.resolveInside(relPath); // 编辑围栏：仅工作区内
  const ext = path.extname(abs).toLowerCase();
  await fs.promises.mkdir(path.dirname(abs), { recursive: true });
  let bytes: number;
  if ("text" in payload) {
    if (!TEXT_EDIT_EXTS.has(ext)) throw new Error(`文本编辑仅支持 ${[...TEXT_EDIT_EXTS].join("/")}（当前 ${ext || "无扩展名"}）`);
    if (Buffer.byteLength(payload.text, "utf-8") > TEXT_EDIT_MAX) throw new Error("内容超过 1MB 文本编辑上限");
    await fs.promises.writeFile(abs, payload.text, "utf-8");
    bytes = Buffer.byteLength(payload.text, "utf-8");
  } else {
    if (!BINARY_EDIT_EXTS.has(ext)) throw new Error(`二进制回写仅支持 ${[...BINARY_EDIT_EXTS].join("/")}（当前 ${ext || "无扩展名"}）`);
    const buf = Buffer.from(payload.base64, "base64");
    if (buf.length === 0) throw new Error("空内容");
    if (buf.length > BINARY_EDIT_MAX) throw new Error("文件超过 20MB 编辑上限");
    await fs.promises.writeFile(abs, buf);
    bytes = buf.length;
  }
  audit?.append({ event: "user_edit", path: relPath, bytes });
  return { bytes };
}
