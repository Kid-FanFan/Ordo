// ===== js/theme.js =====
// 主题引擎：4 内置主题 + 自定义主题扫描/导入/删除 + 主题页 UI + 预览
import { icon } from "./icons.js";

const BUILTIN_THEMES = [
  {
    id: "light", name: "浅色", builtin: true,
    colors: {
      "--bg": "#f7f6f3", "--panel": "#ffffff", "--panel-soft": "#f1efe9",
      "--text": "#21201c", "--text-soft": "#5f5b52", "--text-faint": "#98938a",
      "--line": "#e6e3db", "--line-strong": "#d8d4c9",
      "--ink": "#26251f", "--ink-hover": "#3a3830",
      "--accent": "#a84b38", "--accent-soft": "rgba(168,75,56,0.1)",
      "--ok": "#1d8a4e", "--ok-soft": "rgba(29,138,78,0.1)",
      "--warn": "#b36205", "--warn-soft": "#fdf6ec", "--warn-line": "#ecd9b7",
      "--danger": "#a12d2d", "--danger-soft": "#fbf0ef",
      "--code-bg": "#26251f", "--code-text": "#e9e7e0",
    },
    titleBar: { color: "#f7f6f3", symbolColor: "#5f5b52" },
  },
  {
    id: "dark", name: "深色", builtin: true,
    colors: {
      "--bg": "#1a1a1e", "--panel": "#2a2a2e", "--panel-soft": "#333338",
      "--text": "#e4e4e7", "--text-soft": "#a0a0a8", "--text-faint": "#6b6b73",
      "--line": "#3a3a40", "--line-strong": "#4a4a52",
      "--ink": "#e4e4e7", "--ink-hover": "#ffffff",
      "--accent": "#d97a5f", "--accent-soft": "rgba(217,122,95,0.15)",
      "--ok": "#34d399", "--ok-soft": "rgba(52,211,153,0.12)",
      "--warn": "#fbbf24", "--warn-soft": "rgba(251,191,36,0.1)", "--warn-line": "#6b5c1e",
      "--danger": "#f87171", "--danger-soft": "rgba(248,113,113,0.12)",
      "--code-bg": "#111114", "--code-text": "#d4d4d8",
    },
    titleBar: { color: "#1a1a1e", symbolColor: "#a0a0a8" },
  },
  {
    id: "sky", name: "蓝天", builtin: true,
    colors: {
      "--bg": "#e8f0fe", "--panel": "#ffffff", "--panel-soft": "#d6e6fc",
      "--text": "#1a365d", "--text-soft": "#4a6fa5", "--text-faint": "#7c9cc7",
      "--line": "#bdd0f0", "--line-strong": "#a3bde6",
      "--ink": "#1e40af", "--ink-hover": "#1e3a8a",
      "--accent": "#2563eb", "--accent-soft": "rgba(37,99,235,0.1)",
      "--ok": "#16a34a", "--ok-soft": "rgba(22,163,74,0.1)",
      "--warn": "#d97706", "--warn-soft": "#fef9ee", "--warn-line": "#d4c095",
      "--danger": "#dc2626", "--danger-soft": "#fef2f2",
      "--code-bg": "#1e293b", "--code-text": "#e2e8f0",
    },
    titleBar: { color: "#e8f0fe", symbolColor: "#4a6fa5" },
  },

  {
    id: "ocean", name: "深海", builtin: true,
    colors: {
      "--bg": "#0d1b2a", "--panel": "#1b2838", "--panel-soft": "#162232",
      "--text": "#c8d6e5", "--text-soft": "#8899aa", "--text-faint": "#5a6f82",
      "--line": "#233548", "--line-strong": "#2e4458",
      "--ink": "#c8d6e5", "--ink-hover": "#e8eff7",
      "--accent": "#4dabf7", "--accent-soft": "rgba(77,171,247,0.15)",
      "--ok": "#38d9a9", "--ok-soft": "rgba(56,217,169,0.12)",
      "--warn": "#fcc419", "--warn-soft": "rgba(252,196,25,0.1)", "--warn-line": "#5c4e1a",
      "--danger": "#ff6b6b", "--danger-soft": "rgba(255,107,107,0.12)",
      "--code-bg": "#070f18", "--code-text": "#a8c4dc",
    },
    titleBar: { color: "#0d1b2a", symbolColor: "#8899aa" },
  },
];

let api = null;
let currentThemeId = "light";
let allThemes = [...BUILTIN_THEMES];

export function initTheme(sdApi) { api = sdApi; }

export async function loadSavedTheme() {
  if (!api) return;
  try {
    const customs = (await api.listThemes?.()) || [];
    allThemes = [...BUILTIN_THEMES, ...customs];
    const pref = await api.getThemePreference?.();
    if (pref && pref !== "light") {
      const t = allThemes.find((t) => t.id === pref);
      if (t) applyTheme(t);
    }
  } catch { /* 降级浅色 */ }
}

let iconOverrides = {};

/** 主题底色明暗判定（color-scheme 用）：支持 #rgb/#rrggbb，感知亮度 < 0.5 判暗 */
function isDarkColor(css) {
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(String(css).trim());
  if (!m) return false;
  const h = m[1].length === 3 ? [...m[1]].map((c) => c + c).join("") : m[1];
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255 < 0.5;
}

export function applyTheme(theme) {
  currentThemeId = theme.id;
  const root = document.documentElement;
  const body = document.body;

  // 色值
  if (theme.colors) {
    for (const [k, v] of Object.entries(theme.colors)) root.style.setProperty(k, v);
  }
  if (theme.font) root.style.setProperty("--sans", theme.font);

  // 原生控件明暗（滚动条兜底等）：按 --bg 亮度自动判定，内置与自定义主题一并覆盖
  root.style.colorScheme = isDarkColor(theme.colors?.["--bg"] ?? "#f7f6f3") ? "dark" : "light";

  // 背景图
  if (theme.background && theme.background.image) {
    body.classList.add("has-bg-image");
    root.style.setProperty("--theme-bg-image", `url("${theme.background.image}")`);
    root.style.setProperty("--theme-bg-opacity", String(theme.background.opacity ?? 0.25));
    root.style.setProperty("--theme-bg-blur", `${theme.background.blur ?? 0}px`);
  } else {
    body.classList.remove("has-bg-image");
    root.style.removeProperty("--theme-bg-image");
  }

  // 图标覆盖（PNG 替换 SVG）
  clearIconOverrides();
  iconOverrides = {};
  if (theme.icons && theme._iconBaseUrl) {
    for (const [name, file] of Object.entries(theme.icons)) {
      iconOverrides[name] = `${theme._iconBaseUrl}/${file}`;
    }
    applyIconOverrides();
  }

  // 主题风格覆盖（边框/光效等）
  let styleEl = document.getElementById("theme-style-override");
  if (styleEl) styleEl.remove();
  if (theme.style) {
    styleEl = document.createElement("style");
    styleEl.id = "theme-style-override";
    const s = theme.style;
    let css = "";
    if (s.sidebarBorder) css += `#sidebar { border-right: ${s.sidebarBorder}; }\n`;
    if (s.cardGlow) css += `.mk-card, .theme-card:hover, .theme-preview { box-shadow: ${s.cardGlow}; }\n`;
    if (s.accentGradient) {
      css += `.tp-accent-line, .theme-card.active { border-image: ${s.accentGradient} 1; }\n`;
      css += `#send-btn { background: ${s.accentGradient}; }\n`;
      css += `.side-nav button.active svg { filter: drop-shadow(0 0 4px var(--accent)); }\n`;
    }
    // OW 风格：侧栏分割线发光 + 顶栏底部发光线
    css += `body[data-theme="overwatch"] #sidebar { border-right: 1px solid rgba(249,158,26,0.25); }\n`;
    css += `body[data-theme="overwatch"] #topbar { border-bottom: 1px solid rgba(249,158,26,0.15); box-shadow: 0 1px 8px rgba(249,158,26,0.08); }\n`;
    css += `body[data-theme="overwatch"] #new-session { border-color: rgba(249,158,26,0.3); }\n`;
    css += `body[data-theme="overwatch"] #new-session:hover { border-color: #f99e1a; box-shadow: 0 0 10px rgba(249,158,26,0.2); }\n`;
    css += `body[data-theme="overwatch"] .side-nav button.active { background: rgba(249,158,26,0.1); }\n`;
    css += `body[data-theme="overwatch"] .composer { border: 1px solid rgba(249,158,26,0.2); }\n`;
    css += `body[data-theme="overwatch"] .composer:focus-within { border-color: rgba(249,158,26,0.5); box-shadow: 0 0 12px rgba(249,158,26,0.1); }\n`;
    css += `body[data-theme="overwatch"] .side-nav-divider { background: rgba(249,158,26,0.15); }\n`;
    css += `body[data-theme="overwatch"] .side-foot { border-top: 1px solid rgba(249,158,26,0.15); }\n`;
    css += `body[data-theme="overwatch"] #module-page { border-left: 1px solid rgba(249,158,26,0.1); }\n`;
    styleEl.textContent = css;
    document.head.appendChild(styleEl);
  }
  body.removeAttribute("data-theme");
  body.setAttribute("data-theme", theme.id);

  // 标题栏
  if (theme.titleBar && api?.setTitleBarOverlay) {
    api.setTitleBarOverlay(theme.titleBar.color, theme.titleBar.symbolColor);
  }

  // 持久化
  api?.setThemePreference?.(theme.id);
}

function applyIconOverrides() {
  document.querySelectorAll("[data-icon]").forEach((el) => {
    const name = el.dataset.icon;
    if (iconOverrides[name]) {
      el.dataset.originalSvg = el.innerHTML;
      el.innerHTML = `<img src="${iconOverrides[name]}" style="width:16px;height:16px;object-fit:contain;vertical-align:middle;" alt="${name}" />`;
      el.classList.add("icon-overridden");
    }
  });
  // logo 特殊处理（更大尺寸）
  document.querySelectorAll(".logo-mark.icon-overridden img").forEach((img) => {
    img.style.width = "20px";
    img.style.height = "20px";
  });
}

function clearIconOverrides() {
  document.querySelectorAll(".icon-overridden").forEach((el) => {
    if (el.dataset.originalSvg) {
      el.innerHTML = el.dataset.originalSvg;
      delete el.dataset.originalSvg;
    }
    el.classList.remove("icon-overridden");
  });
}


function buildPreview(theme) {
  const c = theme.colors || {};
  const bg = c["--bg"] || "#f7f6f3";
  const panel = c["--panel"] || "#fff";
  const panelSoft = c["--panel-soft"] || "#f1efe9";
  const text = c["--text"] || "#21201c";
  const textFaint = c["--text-faint"] || "#98938a";
  const line = c["--line"] || "#e6e3db";
  const lineStrong = c["--line-strong"] || "#d8d4c9";
  const accent = c["--accent"] || "#a84b38";
  const accentSoft = c["--accent-soft"] || "rgba(78,110,242,0.1)";
  const ink = c["--ink"] || "#26251f";
  const danger = c["--danger"] || "#a12d2d";
  const warn = c["--warn"] || "#b36205";
  const ok = c["--ok"] || "#1d8a4e";
  const hasBg = theme.background && theme.background.image;
  const bgUrl = hasBg ? theme.background.image : "";
  const bgOpacity = hasBg ? (theme.background.opacity ?? 0.25) : 0;

  const wrap = document.createElement("div");
  wrap.className = "theme-preview";

  // 守望先锋等自定义主题的橙色发光边框
  const glowStyle = theme.style?.cardGlow ? `box-shadow:${theme.style.cardGlow};` : "";
  const borderAccent = theme.style?.sidebarBorder ? `border:1px solid ${accent}33;` : "";

  // logo 图标：优先使用 PNG 覆盖
  const logoUrl = (theme.icons?.logo && theme._iconBaseUrl) ? `${theme._iconBaseUrl}/${theme.icons.logo}` : null;
  const logoHtml = logoUrl
    ? `<img src="${logoUrl}" style="width:28px;height:28px;object-fit:contain;" />`
    : `<div class="tp-logo" style="background:${accent}"></div>`;

  // 侧栏导航点 — 如果有图标覆盖，显示缩略图标
  const navIcons = ["layers", "plug", "clock", "book"];
  const navDotsHtml = navIcons.map((n, i) => {
    if (theme.icons?.[n] && theme._iconBaseUrl) {
      const url = `${theme._iconBaseUrl}/${theme.icons[n]}`;
      return `<div class="tp-nav-dot${i === 0 ? " active" : ""}" style="background:${i === 0 ? accentSoft : panelSoft};display:flex;align-items:center;justify-content:center;height:20px;">
        <img src="${url}" style="width:14px;height:14px;object-fit:contain;opacity:0.8;" />
      </div>`;
    }
    return `<div class="tp-nav-dot${i === 0 ? " active" : ""}" style="background:${i === 0 ? accentSoft : panelSoft}"></div>`;
  }).join("");

  wrap.innerHTML = `
    <div class="theme-preview-window" style="background:${bg};position:relative;${glowStyle}${borderAccent}">
      ${hasBg ? `<div style="position:absolute;inset:0;background:url('${bgUrl}') center/cover;opacity:${bgOpacity};filter:blur(${theme.background.blur ?? 0}px);z-index:0;"></div>` : ""}
      <div class="tp-sidebar" style="background:color-mix(in srgb, ${bg} 88%, ${panel});border-right:1px solid ${line};position:relative;z-index:1;${theme.style?.sidebarBorder ? `border-right:${theme.style.sidebarBorder};` : ""}">
        ${logoHtml}
        ${navDotsHtml}
      </div>
      <div class="tp-content" style="position:relative;z-index:1;">
        <div class="tp-topbar" style="background:color-mix(in srgb, ${bg} 92%, ${panel});border-bottom:1px solid ${line};">
          <div class="tp-topbar-title" style="background:${textFaint}"></div>
          <div class="tp-dots">
            <div class="tp-dot min" style="background:${warn}"></div>
            <div class="tp-dot max" style="background:${ok}"></div>
            <div class="tp-dot close" style="background:${danger}"></div>
          </div>
        </div>
        <div class="tp-chat" style="background:transparent;">
          <div class="tp-bubble user" style="background:${accent};color:#fff">你好，帮我整理一下项目文档</div>
          <div class="tp-bubble ai" style="background:${panel};color:${text};border:1px solid ${line}">好的，我来帮你整理文档结构并生成目录索引。</div>
        </div>
        <div class="tp-composer" style="border-color:${lineStrong};background:${panel}">
          <div class="tp-composer-placeholder" style="background:${textFaint}"></div>
          <div class="tp-composer-btn" style="background:${ink}"></div>
        </div>
      </div>
      <div class="tp-accent-line" style="background:linear-gradient(90deg,${accent},${accentSoft},transparent)"></div>
    </div>`;
  return wrap;
}


function buildThemeCard(theme, isActive, onSelect, onDelete) {
  const c = theme.colors || {};
  const bg = c["--bg"] || "#f7f6f3";
  const panel = c["--panel"] || "#fff";
  const panelSoft = c["--panel-soft"] || "#f1efe9";
  const text = c["--text"] || "#21201c";
  const line = c["--line"] || "#e6e3db";
  const accent = c["--accent"] || "#a84b38";
  const ink = c["--ink"] || "#26251f";
  const hasBg = theme.background && theme.background.image;
  const bgUrl = hasBg ? theme.background.image : "";
  const bgOpacity = hasBg ? (theme.background.opacity ?? 0.25) : 0;

  const card = document.createElement("div");
  card.className = `theme-card${isActive ? " active" : ""}`;
  card.innerHTML = `
    <div class="theme-card-preview" style="background:${bg};position:relative;overflow:hidden;">
      ${hasBg ? `<div style="position:absolute;inset:0;background:url('${bgUrl}') center/cover;opacity:${Math.min(bgOpacity + 0.15, 0.5)};z-index:0;"></div>` : ""}
      <div class="tcp-sidebar" style="background:color-mix(in srgb, ${bg} 88%, ${panel});position:relative;z-index:1;"></div>
      <div class="tcp-main" style="position:relative;z-index:1;">
        <div class="tcp-topbar" style="background:${panelSoft}"></div>
        <div class="tcp-bubble" style="background:${accent}"></div>
        <div class="tcp-bubble r" style="background:${panel};border:1px solid ${line}"></div>
        <div class="tcp-input" style="background:${panel};border-color:${line}"></div>
      </div>
    </div>
    <div class="theme-card-info">
      <span class="theme-card-name" style="color:${text}">${theme.name}</span>
      ${theme.builtin ? `<span class="theme-card-badge">内置</span>` : `<button class="theme-card-delete" title="删除主题">${icon("trash", 14)}</button>`}
    </div>`;
  card.addEventListener("click", (e) => {
    if (e.target.closest(".theme-card-delete")) {
      e.stopPropagation();
      onDelete?.(theme);
      return;
    }
    onSelect(theme);
  });
  return card;
}

function buildTutorial() {
  const tut = document.createElement("div");
  tut.className = "theme-tutorial";
  tut.innerHTML = `
    <div class="theme-tutorial-head">${icon("chevDown", 14)}自定义主题制作教程</div>
    <div class="theme-tutorial-body">
      <h4>主题结构</h4>
      <p>一个主题是一个文件夹，包含 <code>theme.json</code> 和可选的资源文件（背景图、图标）。制作完成后，将文件夹打包为 zip 即可通过"导入主题"按钮安装。</p>

      <h4>基础 theme.json</h4>
      <pre>{
  "id": "my-theme",
  "name": "我的主题",
  "author": "作者名",
  "description": "主题简介",
  "colors": {
    "--bg": "#1a1a2e",
    "--panel": "#16213e",
    "--panel-soft": "#1a2744",
    "--text": "#e0e0e0",
    "--text-soft": "#a0a0b0",
    "--text-faint": "#6a6a7a",
    "--line": "#2a3a5a",
    "--line-strong": "#3a4a6a",
    "--ink": "#e0e0e0",
    "--ink-hover": "#ffffff",
    "--accent": "#e94560",
    "--accent-soft": "rgba(233,69,96,0.15)",
    "--ok": "#38d9a9",
    "--warn": "#fcc419",
    "--danger": "#ff6b6b",
    "--code-bg": "#0a0a1a",
    "--code-text": "#c0c0d0"
  },
  "titleBar": {
    "color": "#1a1a2e",
    "symbolColor": "#a0a0b0"
  }
}</pre>

      <h4>色值说明</h4>
      <p><b>--bg</b> 全局背景 &nbsp; <b>--panel</b> 卡片/面板 &nbsp; <b>--text</b> 主文字 &nbsp; <b>--accent</b> 强调色（按钮/链接）</p>
      <p><b>--ink</b> 深色按钮（发送键等） &nbsp; <b>--line</b> 分割线 &nbsp; <b>--code-bg/--code-text</b> 代码块</p>
      <p><b>titleBar.color</b> 窗口右上角按钮区背景，<b>symbolColor</b> 按钮图标颜色（建议与 --bg 和 --text-soft 一致）。</p>

      <h4>高级功能 1：背景图</h4>
      <p>将背景图片（jpg/png/webp）放入主题文件夹，在 theme.json 中添加：</p>
      <pre>"background": {
  "image": "bg.jpg",
  "opacity": 0.2,
  "blur": 8
}</pre>
      <p><b>opacity</b> 控制透明度（0~1，推荐 0.15~0.3），<b>blur</b> 控制模糊度（像素，推荐 4~12）。背景图会显示在整个窗口后方，软件界面叠加在上面。</p>

      <h4>高级功能 2：图标覆盖</h4>
      <p>用自定义 PNG 图标替换侧栏按钮图标。准备若干 64×64 透明底 PNG 图片（推荐尺寸），放入主题文件夹，在 theme.json 中添加：</p>
      <pre>"icons": {
  "logo": "my-logo.png",
  "layers": "skill-icon.png",
  "plug": "connector-icon.png",
  "clock": "automation-icon.png",
  "book": "knowledge-icon.png",
  "user": "expert-icon.png",
  "slash": "command-icon.png",
  "archive": "package-icon.png",
  "palette": "theme-icon.png",
  "settings": "settings-icon.png",
  "plus": "new-icon.png"
}</pre>
      <p>每个键名对应一个侧栏按钮，值为图片文件名。可以只覆盖部分图标（不需要全部提供）。示例：守望先锋主题使用橙色光标风格图标替换了所有按钮。</p>

      <h4>高级功能 3：风格覆盖</h4>
      <p>自定义边框、光效和渐变。在 theme.json 中添加：</p>
      <pre>"style": {
  "sidebarBorder": "1px solid rgba(249,158,26,0.3)",
  "cardGlow": "0 0 12px rgba(249,158,26,0.2)",
  "accentGradient": "linear-gradient(135deg, #f99e1a, #ff6b2b)"
}</pre>
      <p><b>sidebarBorder</b> 侧栏右侧边框样式（发光边框效果）</p>
      <p><b>cardGlow</b> 卡片和预览的阴影光晕（box-shadow）</p>
      <p><b>accentGradient</b> 发送按钮等强调元素的渐变背景</p>

      <h4>完整示例：Minecraft 主题</h4>
      <p>假设你要做一个《我的世界》主题，文件夹结构：</p>
      <pre>minecraft/
  ├── theme.json
  ├── bg.jpg           (方块世界背景)
  ├── logo.png         (MC 草方块图标)
  ├── pickaxe.png      (镐子图标用于某个按钮)
  ├── sword.png        (剑图标用于另一个按钮)
  └── ...其他图标</pre>
      <p>在 theme.json 中配置深绿+棕色配色、方块背景图、像素风图标覆盖、方块边框样式，打包为 minecraft.zip，通过"导入主题"安装即可。</p>

      <h4>字体</h4>
      <p>font 字段可指定自定义字体族（需系统已安装）。例如：<code>"font": "'Minecraft', 'Microsoft YaHei', sans-serif"</code></p>

      <h4>打包与分享</h4>
      <p>将主题文件夹压缩为 zip 格式，确保 theme.json 在 zip 根目录或唯一子文件夹内。用户通过"导入主题"按钮选择 zip 文件即可安装。主题文件会自动复制到软件数据目录，重启软件后依然保留。</p>
    </div>`;
  tut.querySelector(".theme-tutorial-head").addEventListener("click", () => tut.classList.toggle("open"));
  return tut;
}


/** 主题内容渲染（设置页「主题」节复用）：预览 + 内置/自定义主题卡 + 导入 + 教程，渲染进任意容器 */
export async function renderThemeContent(container) {
  const render = async () => {
    try {
      const customs = (await api?.listThemes?.()) || [];
      allThemes = [...BUILTIN_THEMES, ...customs];
    } catch { allThemes = [...BUILTIN_THEMES]; }

    container.innerHTML = "";

    // 预览区
    const activeTheme = allThemes.find((t) => t.id === currentThemeId) || BUILTIN_THEMES[0];
    container.appendChild(buildPreview(activeTheme));

    // 内置主题区
    const s1 = document.createElement("div");
    s1.className = "theme-section-title";
    s1.textContent = "内置主题";
    container.appendChild(s1);

    const grid1 = document.createElement("div");
    grid1.className = "theme-grid";
    for (const t of BUILTIN_THEMES) {
      grid1.appendChild(buildThemeCard(t, t.id === currentThemeId, (theme) => {
        applyTheme(theme);
        render();
      }, null));
    }
    container.appendChild(grid1);

    // 自定义主题区
    const customs = allThemes.filter((t) => !t.builtin);
    const s2 = document.createElement("div");
    s2.className = "theme-section-title";
    s2.textContent = "自定义主题";
    container.appendChild(s2);

    if (customs.length) {
      const grid2 = document.createElement("div");
      grid2.className = "theme-grid";
      for (const t of customs) {
        grid2.appendChild(buildThemeCard(t, t.id === currentThemeId, (theme) => {
          applyTheme(theme);
          render();
        }, async (theme) => {
          if (!confirm(`确定删除主题「${theme.name}」？`)) return;
          await api?.deleteTheme?.(theme.id);
          if (currentThemeId === theme.id) applyTheme(BUILTIN_THEMES[0]);
          render();
        }));
      }
      container.appendChild(grid2);
    } else {
      const empty = document.createElement("div");
      empty.style.cssText = "color:var(--text-faint);font-size:12px;margin-bottom:12px;";
      empty.textContent = "还没有自定义主题，点击下方按钮导入";
      container.appendChild(empty);
    }

    // 导入按钮
    const importRow = document.createElement("div");
    importRow.className = "theme-import-row";
    const importBtn = document.createElement("button");
    importBtn.className = "theme-import-btn";
    importBtn.type = "button";
    importBtn.innerHTML = `${icon("upload", 14)}导入主题（zip 压缩包或文件夹）`;
    importBtn.addEventListener("click", async () => {
      const result = await api?.importTheme?.();
      if (result) render();
    });
    importRow.appendChild(importBtn);
    container.appendChild(importRow);

    // 教程区
    container.appendChild(buildTutorial());
  };
  await render();
}