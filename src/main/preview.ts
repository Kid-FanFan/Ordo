// 工作台文件预览（契约扩展 readFilePreview）：工作区围栏内、按扩展名分流
// text=Markdown 文本 / html=沙箱渲染 / image=dataURL / pdf=内嵌查看器
// office=docx/xlsx/pptx 二进制透传（base64），解析与渲染在渲染端（方案 §2.1）
import * as path from "node:path";
import { officeRun } from "./office-cli";
import * as fs from "node:fs";
import type { Workspace } from "./workspace";

export type PreviewResult =
  | { kind: "text"; content: string }
  | { kind: "html"; content: string }
  | { kind: "image"; mime: string; dataUrl: string; bytes: number }
  | { kind: "pdf"; dataUrl: string; bytes: number }
  | { kind: "office"; format: "docx" | "xlsx" | "pptx"; dataUrl: string; bytes: number; html?: string };

const TEXT_EXTS = new Set([
  ".md", ".txt", ".csv", ".json", ".log", ".xml", ".yaml", ".yml",
  ".ini", ".conf", ".js", ".ts", ".css", ".py", ".sql",
]);

const IMAGE_MIME: Record<string, string> = {
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
  ".gif": "image/gif", ".webp": "image/webp", ".bmp": "image/bmp",
  ".ico": "image/x-icon", ".svg": "image/svg+xml",
};

const TEXT_MAX = 1024 * 1024; // 文本：1MB，超 256K 字符截断
const HTML_MAX = 1024 * 1024; // HTML：整文件渲染，不截断（截断会破坏 DOM）
const IMAGE_MAX = 10 * 1024 * 1024;
const PDF_MAX = 20 * 1024 * 1024;
const OFFICE_MAX = 20 * 1024 * 1024; // Office：对齐 PDF 上限（方案 §2.1）

// OOXML 新格式；.doc/.xls 老二进制无可靠纯 JS 解析器，不走此通道（界面如实提示转存）
const OFFICE_FORMATS: Record<string, { format: "docx" | "xlsx" | "pptx"; mime: string }> = {
  ".docx": { format: "docx", mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" },
  ".xlsx": { format: "xlsx", mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" },
  ".pptx": { format: "pptx", mime: "application/vnd.openxmlformats-officedocument.presentationml.presentation" },
};

function toDataUrl(mime: string, buf: Buffer): string {
  return `data:${mime};base64,${buf.toString("base64")}`;
}

export async function readFilePreview(ws: Workspace, relPath: string): Promise<PreviewResult | null> {
  const abs = ws.resolveInside(relPath); // 预览围栏：仅工作区内
  const ext = path.extname(abs).toLowerCase();
  const stat = await fs.promises.stat(abs).catch(() => null);
  if (!stat || !stat.isFile()) return null;

  if (ext === ".html" && stat.size <= HTML_MAX) {
    const content = await fs.promises.readFile(abs, "utf-8").catch(() => null);
    if (content == null) return null;
    return { kind: "html", content };
  }
  if (IMAGE_MIME[ext] && stat.size <= IMAGE_MAX) {
    const buf = await fs.promises.readFile(abs).catch(() => null);
    if (buf == null) return null;
    const mime = IMAGE_MIME[ext];
    return { kind: "image", mime, dataUrl: toDataUrl(mime, buf), bytes: stat.size };
  }
  if (ext === ".pdf" && stat.size <= PDF_MAX) {
    const buf = await fs.promises.readFile(abs).catch(() => null);
    if (buf == null) return null;
    return { kind: "pdf", dataUrl: toDataUrl("application/pdf", buf), bytes: stat.size };
  }
  const office = OFFICE_FORMATS[ext];
  if (office && stat.size <= OFFICE_MAX) {
    const buf = await fs.promises.readFile(abs).catch(() => null);
    if (buf == null) return null;
    // 保真预览主路径：OfficeCLI view html（单文件 HTML，含版式/字体/公式计算结果）；
    // 剥除内嵌脚本后进渲染端无脚本沙箱。失败/缺引擎时 html 缺省，渲染端走降级链。
    let html: string | undefined;
    try {
      const r = await officeRun(["view", abs, "html"], path.dirname(abs));
      const raw = String(r?.data ?? "");
      if (raw.includes("<")) html = raw.replace(/<script[\s\S]*?<\/script>/gi, "");
    } catch {
      /* 引擎不可用/渲染失败：降级链兜底 */
    }
    return { kind: "office", format: office.format, dataUrl: toDataUrl(office.mime, buf), bytes: stat.size, ...(html ? { html } : {}) };
  }
  if (TEXT_EXTS.has(ext) && stat.size <= TEXT_MAX) {
    const text = await fs.promises.readFile(abs, "utf-8").catch(() => null);
    if (text == null) return null;
    return { kind: "text", content: text.length > 262144 ? text.slice(0, 262144) + "\n\n…（预览已截断）" : text };
  }
  return null; // 不支持的扩展名或超过大小上限
}
