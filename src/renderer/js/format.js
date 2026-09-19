// ===== js/format.js =====
// 展示格式化：相对时间 / 耗时 / 参数摘要 / 工具名映射 —— 对应设计文档 §4.2 / §6.2

export function relTime(iso) {
  if (!iso) return "";
  const t = new Date(iso).getTime();
  const m = Math.floor((Date.now() - t) / 60000);
  if (m < 1) return "刚刚";
  if (m < 60) return `${m} 分钟前`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} 小时前`;
  if (h < 48) return "昨天";
  const d = Math.floor(h / 24);
  if (d < 7) return `${d} 天前`;
  return new Date(iso).toLocaleDateString("zh-CN", { month: "2-digit", day: "2-digit" });
}

export function sessionGroup(iso) {
  const t = new Date(iso).getTime();
  const now = new Date();
  const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  if (t >= startOfDay) return "今天";
  if (t >= startOfDay - 86400000) return "昨天";
  if (t >= startOfDay - 6 * 86400000) return "7 天内";
  return "更早";
}

export function durText(ms) {
  if (ms == null) return "";
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  const m = Math.floor(ms / 60000);
  return `${m}m${Math.round((ms % 60000) / 1000)}s`;
}

// 工具名 → 中文名称与图标
const TOOL_META = {
  read_file: { label: "读取文件", icon: "fileText" },
  write_file: { label: "写入文件", icon: "filePlus" },
  list_files: { label: "列出文件", icon: "folder" },
  list_dir: { label: "列出目录", icon: "folder" },
  run_code: { label: "运行代码", icon: "terminal" },
  search: { label: "检索", icon: "search" },
};

export function toolMeta(name) {
  const meta = TOOL_META[name];
  if (meta) return meta;
  return { label: name, icon: "terminal" };
}

const SUMMARY_KEYS = ["path", "file", "dir", "query", "q", "keyword", "url", "command", "code", "target", "name", "id"];

// 参数 → 一行目标摘要（取第一个可读的字符串参数）
export function argSummary(args) {
  if (!args || typeof args !== "object") return "";
  for (const k of SUMMARY_KEYS) {
    if (typeof args[k] === "string" && args[k]) return args[k];
  }
  for (const v of Object.values(args)) {
    if (typeof v === "string" && v) return v.length > 60 ? v.slice(0, 60) + "…" : v;
  }
  return "";
}

export function truncate(s, n) {
  s = String(s ?? "");
  return s.length > n ? s.slice(0, n) + "…" : s;
}

export function greeting() {
  const h = new Date().getHours();
  if (h < 6) return "夜深了";
  if (h < 12) return "上午好";
  if (h < 18) return "下午好";
  return "晚上好";
}
