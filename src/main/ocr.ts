// 图片 OCR（Tesseract.js，纯 WASM 零外部运行时）：供非多模态模型提取图片中的文字。
// 边界如实：只能提取文字（文档/表格/字幕类截图效果好），不理解图像语义/图表含义。
// 语言数据（chi_sim+eng，LSTM best_int 版共约 2.7MB）**随安装包内置**（tessdata/ → extraResources），
// 内网离线零下载零镜像依赖；包内缺失时回落 jsDelivr CDN 下载并缓存 ~/.ordo/ocr-cache。
// worker 进程内复用（同语言二次调用秒级）。全程超时守卫：初始化/识别悬挂即拒绝、逐出并终止
// 迟到的 worker，避免毒化缓存（发图无文字提示语不含 OCR——是否调用由 agent 自主决定）。
import * as fsp from "node:fs/promises";
import * as fsSync from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

type OcrWorker = { recognize(image: string): Promise<{ data: { text: string } }>; terminate(): Promise<void> };

const OCR_INIT_TIMEOUT_MS = 60_000; // 首次初始化（本地数据秒级；回落 CDN 时含下载）
const OCR_RECOGNIZE_TIMEOUT_MS = 120_000; // 大图识别上限

const workers = new Map<string, Promise<OcrWorker>>();

function cachePath(): string {
  return path.join(os.homedir(), ".ordo", "ocr-cache");
}

/** 内置语言数据目录：打包形态 extraResources/tessdata；开发形态仓库 tessdata/。缺失返回 null（回落 CDN） */
export function ocrLangPath(): string | null {
  const candidates = process.resourcesPath
    ? [path.join(process.resourcesPath, "tessdata"), path.join(__dirname, "../../tessdata")]
    : [path.join(__dirname, "../../tessdata")];
  for (const dir of candidates) {
    try {
      if (fsSync.existsSync(path.join(dir, "chi_sim.traineddata.gz")) && fsSync.existsSync(path.join(dir, "eng.traineddata.gz"))) return dir;
    } catch {
      /* continue */
    }
  }
  return null;
}

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} 超时（${Math.round(ms / 1000)}s）`)), ms);
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}

/** 逐出并终止指定语言的 worker（初始化/识别悬挂后调用，下次调用重建干净实例） */
async function evictWorker(lang: string, creating?: Promise<OcrWorker>): Promise<void> {
  if (creating && workers.get(lang) === creating) workers.delete(lang);
  const w = await creating?.catch(() => null);
  if (w) await w.terminate().catch(() => {});
}

async function getWorker(lang: string): Promise<OcrWorker> {
  const existing = workers.get(lang);
  if (existing) return existing;
  const creating = (async () => {
    const { createWorker } = require("tesseract.js");
    const opts: Record<string, unknown> = { cachePath: cachePath() };
    const local = ocrLangPath();
    if (local) opts.langPath = local; // 内置数据：本地目录直读（Node 端支持），离线可用
    return (await createWorker(lang, 1, opts)) as OcrWorker;
  })();
  workers.set(lang, creating);
  // 初始化守卫：超时/失败 → 逐出缓存 + 终止迟到的 worker（否则一次网络悬挂会毒化后续所有调用）
  const guarded = withTimeout(creating, OCR_INIT_TIMEOUT_MS, "OCR 初始化（含语言数据下载）");
  guarded.catch(() => evictWorker(lang, creating));
  return guarded;
}

/** OCR 一张图片：返回识别文本（trim 后）；失败抛含原因的 Error（CDN 回落下载失败给出预置指引） */
export async function ocrImage(abs: string): Promise<string> {
  await fsp.access(abs);
  const worker = await getWorker("chi_sim+eng");
  try {
    const r = await withTimeout(worker.recognize(abs), OCR_RECOGNIZE_TIMEOUT_MS, "OCR 识别");
    return String(r?.data?.text ?? "").trim();
  } catch (e) {
    await evictWorker("chi_sim+eng", Promise.resolve(worker)); // 识别悬挂 = worker 状态不可信，重建
    const msg = String((e as Error)?.message ?? e);
    throw /download|network|fetch|net::/i.test(msg)
      ? new Error(`OCR 语言数据未内置且 CDN 回落下载失败（可手动预置 ${cachePath()}）。原始错误：${msg}`)
      : e;
  }
}
