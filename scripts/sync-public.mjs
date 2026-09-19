// 公开发布同步：私有库客户端 → 公开库 ordo（gitee.com/kidzyf/ordo）脱敏快照
// 流程：按私有库 git 清单复制客户端到 ../ordo-public → 脱敏 config.mock.json → 密钥扫描 → git 提交
// 用法：node scripts/sync-public.mjs [--push]   （默认只同步+扫描；--push 才 commit + push）
// 隐私红线见 docs/Ordo_Release.md：真实模型 key 永不进公开库；管理端/内部 docs 不在同步清单
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const clientRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pubRoot = path.resolve(clientRoot, "..", "ordo-public");
const PUSH = process.argv.includes("--push");
const VERSION = JSON.parse(fs.readFileSync(path.join(clientRoot, "package.json"), "utf-8")).version;

const git = (args, cwd = clientRoot) => execFileSync("git", args, { cwd, encoding: "utf-8" }).trim();
const inRepo = () => fs.existsSync(path.join(pubRoot, ".git"));

// 1) 清单：以私有库 git 为准（未跟踪/已忽略文件一律不同步）
const files = git(["ls-files", "."]).split("\n").filter(Boolean);
console.log(`[sync] 私有库清单：${files.length} 个文件`);

// 2) 复制（保留 pubRoot/.git）
fs.mkdirSync(pubRoot, { recursive: true });
for (const rel of files) {
  const dest = path.join(pubRoot, rel);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(path.join(clientRoot, rel), dest);
}
const deletedHint = inRepo() ? git(["status", "--porcelain"], pubRoot).split("\n").filter((l) => l.startsWith(" D") || l.startsWith("D")).length : 0;

// 3) 脱敏：config.mock.json 的 model.apiKey → 占位符（mock 自测不校验 key）
const cfgPath = path.join(pubRoot, "config.mock.json");
const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf-8"));
const realKey = cfg.model?.apiKey ?? "";
cfg.model.apiKey = "sk-replace-with-your-own-key";
fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2) + "\n", "utf-8");

// 4) 密钥扫描：真实 key 的精确串 + 通用 sk- 长密钥模式，命中即中止（不 push）
const scanSkip = new Set([".git", "node_modules"]);
const hits = [];
const walk = (dir) => {
  for (const name of fs.readdirSync(dir)) {
    if (scanSkip.has(name)) continue;
    const p = path.join(dir, name);
    const st = fs.statSync(p);
    if (st.isDirectory()) walk(p);
    else if (st.size < 8 * 1024 * 1024) {
      const text = fs.readFileSync(p, "utf-8");
      if (realKey && text.includes(realKey)) hits.push(`${path.relative(pubRoot, p)}: 含真实模型 key`);
      else if (/sk-[A-Za-z0-9]{20,}/.test(text) && p !== cfgPath) hits.push(`${path.relative(pubRoot, p)}: 疑似 sk- 密钥`);
    }
  }
};
walk(pubRoot);
if (hits.length) {
  console.error("[sync] ❌ 密钥扫描命中，已中止：");
  for (const h of hits) console.error("  -", h);
  process.exit(1);
}
console.log("[sync] ✅ 密钥扫描通过（真实 key 零出现）");

// 5) git 提交
if (!inRepo()) {
  git(["init", "-b", "master"], pubRoot);
  git(["remote", "add", "origin", "https://gitee.com/kidzyf/ordo.git"], pubRoot);
  console.log("[sync] 已初始化公开库仓库并关联 origin");
}
git(["add", "-A"], pubRoot);
const staged = git(["status", "--porcelain"], pubRoot);
if (!staged) {
  console.log(`[sync] 公开库已与私有库一致（v${VERSION}），无需提交`);
} else if (PUSH) {
  git(["commit", "-m", `Ordo v${VERSION} — 企业级 AI Agent 桌面工作台（客户端）`], pubRoot);
  git(["push", "-u", "origin", "master"], pubRoot);
  console.log(`[sync] ✅ 已提交并推送公开库（v${VERSION}，${files.length} 文件）`);
} else {
  console.log(`[sync] 已同步 ${files.length} 文件（含 ${deletedHint} 个删除）到 ordo-public/，未提交。确认后加 --push 推送`);
}
