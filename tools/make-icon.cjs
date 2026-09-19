// 生成 build/icon.ico（多尺寸 PNG-in-ICO）与 build/icon.png（256 预览）
// 资产：build/brand/ordo-logo-2048.png（标准版）+ ordo-logo-32.png（简化版）
// 规则：16/24/32 用简化版（小尺寸可辨），48 及以上用标准版（细节质感）；统一 20% 圆角
// 用法：node tools/make-icon.cjs   （需要 PowerShell：System.Drawing 缩放与圆角蒙版）
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const buildDir = path.join(__dirname, "..", "build");
const srcDir = path.join(buildDir, "brand");
const outDir = path.join(buildDir, "icon-src");
fs.mkdirSync(outDir, { recursive: true });

// [尺寸, 源图]：小尺寸走 32px 简化版，大尺寸走 2048 标准版
const PLAN = [
  [16, "ordo-logo-32.png"],
  [24, "ordo-logo-32.png"],
  [32, "ordo-logo-32.png"],
  [48, "ordo-logo-2048.png"],
  [64, "ordo-logo-2048.png"],
  [128, "ordo-logo-2048.png"],
  [256, "ordo-logo-2048.png"],
];
const ps1 = path.join(__dirname, "brand-icon.ps1");
for (const [size, src] of PLAN) {
  execFileSync("powershell", [
    "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", ps1,
    "-src", path.join(srcDir, src),
    "-out", path.join(outDir, `icon-${size}.png`),
    "-size", String(size),
    "-radiusRatio", "0.2",
  ], { stdio: "inherit" });
}

// ---- ICO 容器（PNG 载荷多尺寸条目，Vista+）----
const pngs = PLAN.map(([size]) => fs.readFileSync(path.join(outDir, `icon-${size}.png`)));
const header = Buffer.alloc(6);
header.writeUInt16LE(0, 0); // reserved
header.writeUInt16LE(1, 2); // 类型：图标
header.writeUInt16LE(PLAN.length, 4); // 条目数
const dirEntries = [];
let offset = 6 + PLAN.length * 16;
PLAN.forEach(([size], i) => {
  const e = Buffer.alloc(16);
  e.writeUInt8(size >= 256 ? 0 : size, 0); // 宽（0 = 256）
  e.writeUInt8(size >= 256 ? 0 : size, 1); // 高
  e.writeUInt8(0, 2); // 调色板数
  e.writeUInt8(0, 3); // 保留
  e.writeUInt16LE(1, 4); // planes
  e.writeUInt16LE(32, 6); // bpp
  e.writeUInt32LE(pngs[i].length, 8); // 数据长度
  e.writeUInt32LE(offset, 12); // 数据偏移
  offset += pngs[i].length;
  dirEntries.push(e);
});
const ico = Buffer.concat([header, ...dirEntries, ...pngs]);
fs.writeFileSync(path.join(buildDir, "icon.ico"), ico);
fs.copyFileSync(path.join(outDir, "icon-256.png"), path.join(buildDir, "icon.png"));
console.log(`icon 生成完成：build/icon.ico (${ico.length} B, ${PLAN.map(([s]) => s).join("/")}) + build/icon.png (256 预览)`);
