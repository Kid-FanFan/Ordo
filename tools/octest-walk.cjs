// 复现主进程 getWorkspaceFiles 遍历逻辑（打印错误，不静默）
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const root = path.join(os.homedir(), ".ordo", "workspace");
console.log("root:", root, "存在:", fs.existsSync(root));
const out = [];
const walk = (dir, depth) => {
  if (depth > 3 || out.length >= 500) return;
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (e) {
    console.log("readdir 失败:", dir, String(e.message).slice(0, 80));
    return;
  }
  for (const e of entries) {
    if (out.length >= 500) return;
    if (e.name.startsWith(".")) continue;
    const abs = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === "node_modules" || e.name === "__pycache__") continue;
      walk(abs, depth + 1);
    } else {
      out.push(path.relative(root, abs).split(path.sep).join("/"));
    }
  }
};
walk(root, 0);
console.log("walk 结果:", out.length, "个");
console.log(out.join("\n"));
