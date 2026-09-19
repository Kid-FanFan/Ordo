// 一次性同步工具：从 prototype/index.html（单文件定稿）切回 src/renderer 模块结构
// 用法：node scripts/sync-from-prototype.mjs
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const proto = readFileSync(path.join(root, "prototype", "index.html"), "utf8");
const lines = proto.split("\n");

const marker = (s) => lines.findIndex((l) => l.includes(s));
const idx = {
  tokens: marker("/* ===== tokens.css ===== */"),
  layout: marker("/* ===== layout.css ===== */"),
  chat: marker("/* ===== chat.css ===== */"),
  mdcss: marker("/* ===== markdown.css ===== */"),
  drawerCss: marker("/* ===== demo/drawer.css ===== */"),
  icons: marker("// ===== js/icons.js ====="),
  format: marker("// ===== js/format.js ====="),
  mdjs: marker("// ===== js/markdown.js ====="),
  ui: marker("// ===== js/ui.js ====="),
  app: marker("// ===== js/app.js ====="),
  engine: marker("// ===== demo/engine.js ====="),
  bootstrap: marker("// ===== 引导 ====="),
};
for (const [k, v] of Object.entries(idx)) {
  if (v < 0) throw new Error(`marker 未找到: ${k}`);
}
const slice = (a, b) => lines.slice(lines[a].trim() === "" ? a + 1 : a, b).join("\n").trim() + "\n";

const R = (p) => path.join(root, "src", "renderer", p);

// ---------- CSS ----------
writeFileSync(R("styles/tokens.css"), slice(idx.tokens, idx.layout));
writeFileSync(R("styles/layout.css"), slice(idx.layout, idx.chat));
writeFileSync(R("styles/chat.css"), slice(idx.chat, idx.mdcss));
writeFileSync(R("styles/markdown.css"), slice(idx.mdcss, idx.drawerCss));

// ---------- JS ----------
writeFileSync(R("js/icons.js"), slice(idx.icons, idx.format).replace(/^function icon\(/m, "export function icon("));

writeFileSync(
  R("js/format.js"),
  slice(idx.format, idx.mdjs)
    .replace(/^function relTime\(/m, "export function relTime(")
    .replace(/^function sessionGroup\(/m, "export function sessionGroup(")
    .replace(/^function durText\(/m, "export function durText(")
    .replace(/^function toolMeta\(/m, "export function toolMeta(")
    .replace(/^function argSummary\(/m, "export function argSummary(")
    .replace(/^function truncate\(/m, "export function truncate(")
    .replace(/^function greeting\(/m, "export function greeting(")
);

writeFileSync(
  R("js/markdown.js"),
  slice(idx.mdjs, idx.ui)
    .replace(/^function renderMarkdown\(/m, "export function renderMarkdown(")
    .replace(/^function bindMarkdownActions\(/m, "export function bindMarkdownActions(")
);

writeFileSync(
  R("js/ui.js"),
  `// 对话流组件构建（§4 核心组件）——纯建 DOM，不持有全局状态；指针与状态机在 app.js
import { icon } from "./icons.js";
import { renderMarkdown } from "./markdown.js";
import { durText, toolMeta, argSummary, truncate } from "./format.js";

` +
    slice(idx.ui, idx.app)
      .replace(/^(function (?:el|addUserMsg|createThinking|createThinkingStatic|createGroup|createGroupStatic|createConfirm|createChip|createCompaction|createError|extractWrittenPath|createFileCard|createPlan|createDrawer|createTyping|createTextBlock|createTextStatic)\()/gm, "export $1")
);

{
  let app = slice(idx.app, idx.engine);
  app = app.replace(
    /^\/\/ 应用装配.*$/m,
    `// 应用装配：状态机 + UiEvent→组件映射（§6）+ composer/侧栏/菜单/键盘/滚动 + 会话/工作区/市场/设置
// 通过 window.ordo 通信（§7 锁定契约）；契约扩展项均以 ?. 调用优雅降级（见文档 §7 扩展提案）`
  );
  app =
    `import { icon } from "./icons.js";
import { relTime, greeting } from "./format.js";
import { renderMarkdown, bindMarkdownActions } from "./markdown.js";
import {
  addUserMsg, createThinking, createThinkingStatic, createGroup, createGroupStatic,
  createConfirm, createChip, createCompaction, createError, createTyping, createTextBlock, createTextStatic, el,
  createFileCard, extractWrittenPath, createPlan,
} from "./ui.js";

` + app.replace(/^async function boot\(mockApi\) \{$/m, "export async function boot(mockApi) {").replace(/\n$/, "\n\nexport { handleEvent, setStatus };\n");
  writeFileSync(R("js/app.js"), app);
}

// ---------- index.html ----------
{
  const bodyStart = proto.indexOf('<div id="app">');
  const bodyEnd = proto.indexOf("<script>", bodyStart);
  if (bodyStart < 0 || bodyEnd < 0) throw new Error("body 未找到");
  const body = proto.slice(bodyStart, bodyEnd).trimEnd();
  const html = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <title>Ordo</title>
  <link rel="stylesheet" href="styles/tokens.css" />
  <link rel="stylesheet" href="styles/layout.css" />
  <link rel="stylesheet" href="styles/chat.css" />
  <link rel="stylesheet" href="styles/markdown.css" />
</head>
<body>
  ${body}

  <script type="module">
    import { boot } from "./js/app.js";
    import { icon } from "./js/icons.js";

    document.querySelectorAll("[data-icon]").forEach((n) => {
      n.innerHTML = icon(n.dataset.icon, n.classList.contains("logo-mark") ? 20 : 16);
    });

    // Electron：preload 注入 window.ordo（契约见 docs §7，锁定；扩展提案以 ?. 降级）
    boot(window.ordo ?? null);
  </script>
</body>
</html>
`;
  writeFileSync(R("index.html"), html);
}

console.log("sync-from-prototype: 完成");
for (const f of ["index.html", "js/icons.js", "js/format.js", "js/markdown.js", "js/ui.js", "js/app.js", "styles/tokens.css", "styles/layout.css", "styles/chat.css", "styles/markdown.css"]) {
  const n = readFileSync(R(f), "utf8").split("\n").length;
  console.log(`  ${f}: ${n} 行`);
}
