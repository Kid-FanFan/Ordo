// 知识库（PRD 4.5）：企业库经管理端检索（代理模式，原型 = config.mock.json 声明式目录与内容）；
// 个人库为客户端真实现——本地文档入 ~/.ordo/rag/<id>/docs/，检索为本地关键词混合
// （分块 + 词频打分；语义/向量化等 Python sidecar 就绪后接入，接口不变）。个人库内容管理端不可见，检索仍审计。
import * as fsp from "node:fs/promises";
import * as fsSync from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { adminFetchJson } from "./admin-link";
import type { Workspace } from "./workspace";
import type { Audit } from "./audit";

export interface KbDocChunk {
  text: string;
  /** 段落/小节定位（引用溯源用：文档名 + 位置） */
  section?: string;
}

export interface KbCatalogEntry {
  id: string;
  name: string;
  description: string;
  /** 企业库的文档数/更新时间由管理端维护；个人库由本地扫描得出 */
  docCount?: number;
  updatedAt?: string;
}

export interface KbSearchHit {
  kb: string;
  scope: "enterprise" | "personal";
  doc: string;
  section?: string;
  snippet: string;
  score: number;
}

export interface KnowledgeProvider {
  /** 按当前用户权限过滤后的企业库目录（未授权的不可见，PRD 4.5） */
  catalog(): Promise<Array<KbCatalogEntry & { docs: Array<{ name: string; chunks: KbDocChunk[] }> }>>;
  /** 可选：服务端代理检索（M4 RAG：向量+关键词混合）。实现方失败时应抛错，由调用方降级本地关键词。 */
  search?(query: string, opts?: { kbId?: string; limit?: number }): Promise<KbSearchHit[]>;
}

/** M6：单机/锁定态数据源——企业知识库目录恒空（个人库走 PersonalKbStore 本地实现） */
export class EmptyKnowledgeProvider implements KnowledgeProvider {
  async catalog() {
    return [];
  }
}

/** 管理端数据源（M1）：目录走 HTTP；失败返回空目录（对齐 Mock 降级语义） */
export class HttpKnowledgeProvider implements KnowledgeProvider {
  constructor(private base: string) {}

  async catalog() {
    try {
      return await adminFetchJson<Array<KbCatalogEntry & { docs: Array<{ name: string; chunks: KbDocChunk[] }> }>>(
        this.base,
        "/api/v1/catalog/kb"
      );
    } catch {
      return [];
    }
  }

  /** M4：服务端混合检索（向量+关键词 RRF）。失败抛错 → AgentHost 降级本地关键词打分 */
  async search(query: string, opts?: { kbId?: string; limit?: number }): Promise<KbSearchHit[]> {
    const p = new URLSearchParams({ q: query, k: String(opts?.limit ?? 4) });
    if (opts?.kbId) p.set("kb", opts.kbId);
    return adminFetchJson<KbSearchHit[]>(this.base, `/api/v1/kb/search?${p.toString()}`);
  }
}

// ---------- 检索打分（企业与个人共用；一期关键词混合，语义检索留 sidecar 接口） ----------
const CHUNK_TARGET = 600;
const CHUNK_OVERLAP = 120;

/** 段落聚合分块：按空行切段，聚合成 ~600 字窗口，相邻块重叠 ~120 字（不拆段落中部除非超长） */
export function chunkText(text: string): KbDocChunk[] {
  const paras = text.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  const chunks: KbDocChunk[] = [];
  let buf = "";
  let startPara = 0;
  let paraIdx = 0;
  for (const p of paras) {
    if (buf && buf.length + p.length > CHUNK_TARGET) {
      chunks.push({ text: buf, section: firstHeading(paras[startPara]) });
      buf = buf.slice(-CHUNK_OVERLAP) + "\n" + p; // 重叠窗口保持上下文连续
      startPara = paraIdx;
    } else {
      buf = buf ? `${buf}\n${p}` : p;
    }
    paraIdx++;
  }
  if (buf.trim()) chunks.push({ text: buf.trim(), section: firstHeading(paras[startPara]) });
  return chunks.length ? chunks : [{ text: "" }];
}

function firstHeading(para?: string): string | undefined {
  const m = para ? /^#{1,6}\s+(.+)$/m.exec(para) : null;
  return m ? m[1].trim() : undefined;
}

/** 关键词打分：整句匹配 ×3 + 分词匹配 ×1，按块长度归一；中文以整句/子串为主，分词按空白切 */
export function scoreChunk(text: string, query: string): number {
  if (!text || !query) return 0;
  const hay = text.toLowerCase();
  const q = query.toLowerCase().trim();
  if (!q) return 0;
  let score = 0;
  let idx = hay.indexOf(q);
  while (idx !== -1) {
    score += 3;
    idx = hay.indexOf(q, idx + q.length);
  }
  for (const tok of q.split(/[\s,，。;；、]+/).filter((t) => t.length >= 2)) {
    let i = hay.indexOf(tok);
    while (i !== -1) {
      score += 1;
      i = hay.indexOf(tok, i + tok.length);
    }
  }
  return score / Math.sqrt(Math.max(text.length, 1));
}

export function searchChunks(
  kbName: string,
  scope: "enterprise" | "personal",
  docName: string,
  chunks: KbDocChunk[],
  query: string,
  limitPerDoc = 2
): KbSearchHit[] {
  const hits: KbSearchHit[] = [];
  for (const c of chunks) {
    const s = scoreChunk(c.text ?? "", query);
    if (s > 0) hits.push({ kb: kbName, scope, doc: docName, section: c.section, snippet: c.text.slice(0, 400), score: s });
  }
  return hits.sort((a, b) => b.score - a.score).slice(0, limitPerDoc);
}

// ---------- 个人知识库（本地真实现；内容管理端不可见，PRD 4.5） ----------
const TEXT_EXT = new Set([".md", ".txt", ".csv", ".json", ".log", ".html", ".xml", ".yaml", ".yml", ".docx", ".xlsx", ".pdf"]);

export interface PersonalKbMeta {
  id: string;
  name: string;
  createdAt: string;
}

export interface PersonalKbDeps {
  workspace: Workspace;
  audit: Audit;
}

export class PersonalKbStore {
  constructor(private deps: PersonalKbDeps) {}

  private ragDir(): string {
    return this.deps.workspace.dirs.rag;
  }

  async list(): Promise<Array<KbCatalogEntry & { docCount: number; updatedAt: string }>> {
    const root = this.ragDir();
    await fsp.mkdir(root, { recursive: true });
    const out = [];
    for (const e of await fsp.readdir(root, { withFileTypes: true })) {
      if (!e.isDirectory()) continue;
      try {
        const meta: PersonalKbMeta = JSON.parse(await fsp.readFile(path.join(root, e.name, "meta.json"), "utf-8"));
        const docs = await fsp.readdir(path.join(root, e.name, "docs")).catch(() => [] as string[]);
        out.push({ id: meta.id, name: meta.name, description: "本地个人库 · 仅本机可用", docCount: docs.length, updatedAt: meta.createdAt });
      } catch {
        // 脏目录跳过（无 meta.json）
      }
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }

  async create(name: string): Promise<PersonalKbMeta> {
    const clean = String(name ?? "").trim().slice(0, 30);
    if (!clean) throw new Error("知识库名称不能为空");
    const existing = await this.list();
    if (existing.some((k) => k.name === clean)) throw new Error(`已存在同名个人知识库: ${clean}`);
    const meta: PersonalKbMeta = { id: `kb-${randomUUID().slice(0, 8)}`, name: clean, createdAt: new Date().toISOString() };
    await fsp.mkdir(path.join(this.ragDir(), meta.id, "docs"), { recursive: true });
    await fsp.writeFile(path.join(this.ragDir(), meta.id, "meta.json"), JSON.stringify(meta, null, 2), "utf-8");
    this.deps.audit.append({ event: "kb_create", id: meta.id, name: clean });
    return meta;
  }

  /** 上传文档：拷入 docs/（文本直读；docx/xlsx/pdf 检索时解析为文本；扫描件解析后续版本接入） */
  async addDocs(kbId: string, srcPaths: string[]): Promise<{ added: string[]; skipped: string[] }> {
    const kbDir = path.join(this.ragDir(), String(kbId));
    if (!fsSync.existsSync(path.join(kbDir, "meta.json"))) throw new Error(`知识库不存在: ${kbId}`);
    const added: string[] = [];
    const skipped: string[] = [];
    for (const src of srcPaths) {
      const base = path.basename(String(src));
      if (!TEXT_EXT.has(path.extname(base).toLowerCase())) {
        skipped.push(`${base}（支持文本 / Office（docx/xlsx）/ PDF：${[...TEXT_EXT].join(" ")}）`);
        continue;
      }
      const dst = await this.dedupeName(path.join(kbDir, "docs"), base);
      await fsp.copyFile(String(src), dst);
      added.push(path.basename(dst));
    }
    if (added.length) this.deps.audit.append({ event: "kb_doc_add", kb: kbId, added });
    return { added, skipped };
  }

  private async dedupeName(dir: string, base: string): Promise<string> {
    let target = path.join(dir, base);
    let i = 2;
    while (fsSync.existsSync(target)) {
      const ext = path.extname(base);
      target = path.join(dir, `${base.slice(0, base.length - ext.length)}-${i}${ext}`);
      i++;
    }
    return target;
  }

  async listDocs(kbId: string): Promise<Array<{ name: string; size: number }>> {
    const docsDir = path.join(this.ragDir(), String(kbId), "docs");
    const entries = await fsp.readdir(docsDir, { withFileTypes: true }).catch(() => []);
    const out = [];
    for (const e of entries) {
      if (!e.isFile()) continue;
      const stat = await fsp.stat(path.join(docsDir, e.name)).catch(() => null);
      out.push({ name: e.name, size: stat?.size ?? 0 });
    }
    return out;
  }

  async removeDoc(kbId: string, docName: string): Promise<void> {
    const file = path.join(this.ragDir(), String(kbId), "docs", path.basename(String(docName)));
    if (!fsSync.existsSync(file)) throw new Error(`文档不存在: ${docName}`);
    await fsp.rm(file, { force: true });
    this.deps.audit.append({ event: "kb_doc_remove", kb: kbId, doc: path.basename(String(docName)) });
  }

  /** 删除整库 → 回收站留痕（PRD 3.8） */
  async remove(kbId: string): Promise<void> {
    const kbDir = path.join(this.ragDir(), String(kbId));
    if (!fsSync.existsSync(path.join(kbDir, "meta.json"))) throw new Error(`知识库不存在: ${kbId}`);
    const recycleDir = path.join(this.deps.workspace.dirs.recycle, `kb-${path.basename(kbDir)}-${Date.now()}`);
    await fsp.mkdir(this.deps.workspace.dirs.recycle, { recursive: true });
    await fsp.rename(kbDir, recycleDir);
    this.deps.audit.append({ event: "kb_delete", id: kbId, recycled: recycleDir });
  }

  /** 个人库检索：扫描 docs/ 现读现切（文档量小；增量索引二期随 sidecar 向量化一起做） */
  async search(kbId: string, query: string, limit = 4): Promise<KbSearchHit[]> {
    const meta: PersonalKbMeta = JSON.parse(await fsp.readFile(path.join(this.ragDir(), String(kbId), "meta.json"), "utf-8"));
    const docs = await this.listDocs(kbId);
    const hits: KbSearchHit[] = [];
    for (const d of docs) {
      const raw = await this.readDocText(path.join(this.ragDir(), String(kbId), "docs", d.name));
      hits.push(...searchChunks(meta.name, "personal", d.name, chunkText(raw), query));
    }
    return hits.sort((a, b) => b.score - a.score).slice(0, limit);
  }

  /** 文档取文本：文本格式直读；docx 走 mammoth 抽正文；xlsx 逐表转 CSV（表名作小节标题，供分块归段） */
  private async readDocText(abs: string): Promise<string> {
    const buf = await fsp.readFile(abs).catch(() => Buffer.alloc(0));
    const lower = abs.toLowerCase();
    if (lower.endsWith(".docx")) {
      const mammoth = require("mammoth");
      const r = await mammoth.extractRawText({ buffer: buf });
      return String(r?.value ?? "");
    }
    if (lower.endsWith(".xlsx")) {
      const XLSX = require("xlsx");
      const wb = XLSX.read(buf, { type: "buffer" });
      return wb.SheetNames.map((n: string) => `# 表：${n}\n${XLSX.utils.sheet_to_csv(wb.Sheets[n])}`).join("\n\n");
    }
    if (lower.endsWith(".pdf")) {
      // pdf-parse v2 类 API：new PDFParse({data}).getText()；用毕 destroy 释放 worker
      const { PDFParse } = require("pdf-parse");
      const parser = new PDFParse({ data: new Uint8Array(buf) });
      try {
        const r = await parser.getText();
        return String(r?.text ?? "");
      } finally {
        await parser.destroy().catch(() => {});
      }
    }
    return buf.toString("utf-8");
  }
}
