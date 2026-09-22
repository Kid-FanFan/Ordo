// 对话流组件构建（§4 核心组件）——纯建 DOM，不持有全局状态；指针与状态机在 app.js
import { icon } from "./icons.js";
import { renderMarkdown } from "./markdown.js";
import { durText, toolMeta, argSummary, truncate } from "./format.js";

// ===== js/ui.js =====
// 对话流组件构建（§4 核心组件）——纯建 DOM，不持有全局状态；指针与状态机在 app.js

export function el(tag, cls, html) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (html != null) n.innerHTML = html;
  return n;
}

/* ---------- 附件分类与类型徽标（composer 与消息气泡共用） ---------- */
export function attKind(a) {
  return /^image\//.test(a.file?.type || "") || /\.(png|jpe?g|webp|gif)$/i.test(a.name || "") ? "image" : "file";
}

export function attBadge(a) {
  const ext = (String(a.name).split(".").pop() || "").toLowerCase();
  const cat = ["pdf"].includes(ext) ? "pdf" : ["doc", "docx", "rtf", "odt"].includes(ext) ? "doc" : ["xls", "xlsx", "csv"].includes(ext) ? "xls" : ["ppt", "pptx"].includes(ext) ? "ppt" : ["zip", "rar", "7z", "gz", "tar"].includes(ext) ? "zip" : ["md", "txt", "json", "log", "xml", "yaml", "yml", "js", "ts", "py", "html", "css"].includes(ext) ? "code" : "other";
  const b = el("span", "att-badge");
  b.dataset.cat = cat;
  b.textContent = ext.slice(0, 4).toUpperCase() || "文件";
  return b;
}

/* ---------- 用户消息（可带附件：图片缩略图点击放大，文件类型徽标 chip） ---------- */
export function addUserMsg(text, atts) {
  const n = el("div", "msg-user");
  if (Array.isArray(atts) && atts.length) {
    const row = el("div", "msg-user-atts");
    for (const a of atts) {
      if (a.kind === "image" && a.url) {
        const img = el("img", "u-att-img");
        img.src = a.url;
        img.alt = a.name || "图片";
        img.title = `${a.name || "图片"}（点击放大）`;
        row.appendChild(img);
      } else {
        const chip = el("span", "u-att");
        chip.appendChild(attBadge(a));
        const nm = el("span", "u-att-name");
        nm.textContent = a.name || "附件";
        nm.title = a.size != null ? `${a.name}（${a.size} 字节）` : a.name || "附件";
        chip.appendChild(nm);
        row.appendChild(chip);
      }
    }
    n.appendChild(row);
  }
  if (text) {
    const body = el("div", "msg-user-text");
    body.textContent = text;
    n.appendChild(body);
  }
  return n;
}

/* ---------- 思考块（§4.1）：流式自动展开 → 完成自动收拢为“已深度思考 Ns” ---------- */
export function createThinking() {
  const startTs = Date.now();
  const node = el("div", "thinking open");
  const head = el("button", "thinking-head");
  head.innerHTML = `${icon("sparkles", 13)}<span class="t-label shimmer">正在深度思考…</span><span class="secs hidden"></span>${icon("chevDown", 13, "chev")}`;
  const body = el("div", "thinking-body");
  node.append(head, body);
  const setLabel = () => {
    const secs = node.querySelector(".secs");
    secs.textContent = ` ${durText(Date.now() - startTs)}`;
    secs.classList.remove("hidden");
  };
  const stream = (delta) => {
    body.textContent += delta;
    body.scrollTop = body.scrollHeight;
  };
  const finish = () => {
    node.classList.remove("open");
    node.querySelector(".t-label").classList.remove("shimmer");
    node.querySelector(".t-label").textContent = "已深度思考";
    setLabel();
  };
  head.addEventListener("click", () => node.classList.toggle("open"));
  return { node, stream, finish };
}

// 历史：无时长信息，静态收拢
export function createThinkingStatic() {
  const node = el("div", "thinking");
  const head = el("button", "thinking-head");
  head.innerHTML = `${icon("sparkles", 13)}<span class="t-label">已深度思考</span>${icon("chevDown", 13, "chev")}`;
  const body = el("div", "thinking-body");
  node.append(head, body);
  head.addEventListener("click", () => node.classList.toggle("open"));
  return { node, body };
}

/* ---------- 活动组（§4.2）已随 B 方案取消：工具步骤行直接流式（见 createToolRow） ---------- */


/* ---------- 工具步骤行（B 方案：无组卡）——流式期间行独立出现，回合结束统一收进回合折叠行 ---------- */
export function createToolRow(name, args, l2, preDone = false) {
  const meta = toolMeta(name);
  const node = el("div", "tool-row" + (l2 ? " l2" : "") + (preDone ? " done" : ""));
  node.innerHTML =
    `<span class="t-icon">${icon(meta.icon, 14)}</span>` +
    `<span class="t-name">${meta.label}</span>` +
    `<span class="t-target" title=""></span>` +
    `<span class="t-status">${icon(preDone ? "check" : "loader", 13, preDone ? "" : "spinner")}</span>` +
    `<span class="t-dur"></span>`;
  const target = node.querySelector(".t-target");
  const summary = argSummary(args);
  target.textContent = summary;
  target.title = summary;
  // 过程输出（run_command 等长任务流式回传）：尾部 2000 字符，完成前常显、完成后收进行内可点开
  let outEl = null;
  const row = {
    node,
    meta,
    name,
    status: preDone ? "done" : "running",
    startTs: Date.now(),
    rejected: false,
    confirmPath: null,
    targetPath: null,
    appendOutput(text) {
      if (!text) return;
      if (!outEl) {
        outEl = el("div", "t-output");
        node.appendChild(outEl);
      }
      const cur = (outEl.textContent || "") + text;
      outEl.textContent = cur.length > 2000 ? "…\n" + cur.slice(-2000) : cur;
      outEl.scrollTop = outEl.scrollHeight;
    },
    end(rejected) {
      if (this.status !== "running") return;
      this.status = rejected ? "rejected" : "done";
      this.rejected = rejected;
      this.dur = Date.now() - this.startTs;
      node.classList.add(rejected ? "rejected" : "done");
      node.querySelector(".t-status").innerHTML = icon(rejected ? "x" : "check", 13);
      node.querySelector(".t-dur").textContent = rejected ? "" : durText(this.dur);
      if (outEl) node.classList.add("has-output"); // 完成后折叠为单行，点击展开
    },
  };
  node.addEventListener("click", (e) => {
    if (!node.classList.contains("has-output")) return;
    if (e.target.closest(".t-output")) return;
    node.classList.toggle("output-open");
  });
  return row;
}

/* ---------- 回合过程折叠：回合结束后把过程件（工具步骤行/思考/中间文字/确认卡）收进一行，
   工具组已取消（B 方案拍平）——点开一步到位看到全部步骤；头部只报总耗时 ---------- */
export function createTurnFold() {
  const node = el("div", "group turn-fold");
  const head = el("button", "group-head");
  const list = el("div", "group-list");
  node.append(head, list);
  head.addEventListener("click", () => node.classList.toggle("open"));
  return {
    node,
    list,
    // durationMs>0 显示总耗时；error=true 用错误图标（历史回放无耗时只显示“执行过程”）
    paint(durationMs = 0, error = false) {
      const label = durationMs > 0 ? `执行过程 · ${durText(durationMs)}` : "执行过程";
      head.innerHTML =
        `${icon(error ? "xCircle" : "checkCircle", 14)}<span class="g-label">${label}</span>` + icon("chevDown", 14, "chev");
    },
  };
}

/* ---------- 内联确认卡（§4.3）：分级概念不暴露给用户，只说"做什么、动哪些文件" ---------- */
export function createConfirm(ev, { onDecide }) {
  const args = ev.args || {};
  const card = el("div", "confirm-card pending");
  const head = el("div", "confirm-head");
  head.innerHTML = `${icon("shield", 15)}<span>需要你的确认</span><span class="c-tool">${escapeText(ev.tool)}</span>`;
  card.appendChild(head);

  if (Array.isArray(args.files) && args.files.length) {
    // save_skill：技能包多文件清单 + 每个文件内容预览
    const sec = el("div", "confirm-sec");
    sec.innerHTML = `<div class="c-label">将保存为个人技能「${escapeText(String(args.name ?? ""))}」（${args.files.length} 个文件）</div><div class="c-path">${escapeText(String(args.description ?? ""))}</div>`;
    card.appendChild(sec);
    for (const f of args.files) {
      const fs2 = el("div", "confirm-sec");
      fs2.innerHTML = `<div class="c-label">${escapeText(String(f?.path ?? ""))}</div>`;
      const pre = el("div", "c-preview");
      pre.textContent = truncate(String(f?.content ?? ""), 2000);
      fs2.appendChild(pre);
      card.appendChild(fs2);
    }
  } else if (args.command != null) {
    // run_command（方案 C）：白名单外命令需确认，卡上完整展示命令原文（不截断）
    const sec = el("div", "confirm-sec");
    sec.innerHTML = `<div class="c-label">将执行命令（只读白名单之外）</div>`;
    const pre = el("div", "c-preview");
    pre.textContent = String(args.command);
    sec.appendChild(pre);
    card.appendChild(sec);
  } else {
    const rel = String(args.path ?? "-");
    const secTarget = el("div", "confirm-sec");
    secTarget.innerHTML = `<div class="c-label">目标</div><div class="c-path">${escapeText(rel)}</div><div class="c-abs">${escapeText(args.absolute ?? "")}</div>`;
    card.appendChild(secTarget);

    if (args.content != null) {
      const secPrev = el("div", "confirm-sec");
      secPrev.innerHTML = `<div class="c-label">内容预览</div>`;
      const pre = el("div", "c-preview");
      pre.textContent = truncate(String(args.content), 2000);
      secPrev.appendChild(pre);
      card.appendChild(secPrev);
    }
  }

  const actions = el("div", "confirm-actions");
  actions.innerHTML = `<span class="esc-hint">Esc 拒绝</span>`;
  const denyBtn = el("button", "btn btn-ghost", "拒绝");
  const okBtn = el("button", "btn btn-ink", "同意执行");
  actions.append(denyBtn, okBtn);
  card.appendChild(actions);

  const decide = (approved) => {
    if (!card.classList.contains("pending")) return;
    card.classList.remove("pending");
    actions.remove();
    const verdict = el("div", "confirm-verdict " + (approved ? "ok" : "deny"));
    verdict.innerHTML = approved ? `${icon("checkCircle", 13)} 已同意执行` : `${icon("xCircle", 13)} 已拒绝`;
    card.prepend(verdict);
    onDecide(approved);
  };
  denyBtn.addEventListener("click", () => decide(false));
  okBtn.addEventListener("click", () => decide(true));

  return { node: card, decide, isPending: () => card.classList.contains("pending") };
}

/* ---------- 系统提示 chip（§4.4） ---------- */
export function createChip(text, iconName = "swap") {
  return el("div", "chip", `${icon(iconName, 12)}<span>${escapeText(text)}</span>`);
}

/* ---------- 上下文压缩卡（§4.5） ---------- */
export function createCompaction(ev) {
  const node = el("div", "compaction");
  const head = el("button", "compaction-head");
  // live 事件带前后 tokens；历史消息仅有 tokensBefore（契约 §7）
  const tokens = ev.tokensAfter != null
    ? `（${fmtK(ev.tokensBefore)} → ${fmtK(ev.tokensAfter)} tokens）`
    : ev.tokensBefore != null
      ? `（压缩前约 ${fmtK(ev.tokensBefore)} tokens）`
      : "";
  head.innerHTML =
    `${icon("archive", 14)}<span>上下文已压缩：${ev.messagesBefore ?? "-"} → ${ev.messagesAfter ?? "-"} 条${tokens}</span>${icon("chevDown", 13, "chev")}`;
  const body = el("div", "compaction-body");
  body.textContent = ev.summary || "";
  node.append(head, body);
  head.addEventListener("click", () => node.classList.toggle("open"));
  return node;
}

/* ---------- 错误卡（§4.6）：发生了什么 / 原因 / 下一步 ---------- */
export function createError({ title, why, next }) {
  const node = el("div", "error-card");
  node.innerHTML =
    `<div class="e-title">${icon("alert", 14)}<span>${escapeText(title)}</span></div>` +
    (why ? `<div class="e-row"><b>原因</b>　${escapeText(why)}</div>` : "") +
    (next ? `<div class="e-row"><b>下一步</b>　${escapeText(next)}</div>` : "");
  return node;
}

/* ---------- 文件交付卡片（PRD 3.1 文件卡片；对齐 WorkBuddy/千问办公的交付导向） ---------- */
const FILE_EXTS = "md|txt|csv|json|log|html?|xlsx|xls|docx?|pptx?|pdf|png|jpe?g";

// 从正文中提取被写入文件的路径（仅认反引号包裹的相对路径，保守匹配）
export function extractWrittenPath(text) {
  const m = String(text || "").match(new RegExp("`([^`\\n]+?\\.(" + FILE_EXTS + "))`", "i"));
  return m ? m[1] : null;
}

export function createFileCard(path, onPreview, onReveal) {
  const name = String(path).split(/[\\/]/).pop() || String(path);
  const extM = name.match(/\.([a-z0-9]+)$/i);
  const ext = extM ? extM[1].toUpperCase() : "FILE";
  const node = el("div", "file-card");
  node.innerHTML =
    `<span class="f-icon">${icon("fileText", 18)}</span>` +
    `<span class="f-main"><span class="f-row"><span class="f-name"></span><span class="f-badge">${escapeText(ext)}</span></span>` +
    `<span class="f-path">${escapeText(path)}</span></span>` +
    `<span class="f-actions"></span>`;
  node.querySelector(".f-name").textContent = name;
  const actions = node.querySelector(".f-actions");
  if (onPreview) {
    const pv = el("button", "f-copy", `${icon("eye", 12)}预览`);
    pv.addEventListener("click", () => onPreview(path));
    actions.appendChild(pv);
  }
  // 「打开位置」取代旧"复制路径"：系统文件管理器定位（Electron shell API，跨平台）
  if (onReveal) {
    const rv = el("button", "f-copy", `${icon("folderOpen", 12)}打开位置`);
    rv.title = "在系统文件管理器中定位该文件";
    rv.addEventListener("click", () => onReveal(path));
    actions.appendChild(rv);
  }
  return node;
}

/** 紧凑文件行（汇总卡内用）：图标 + 文件名 + 类型徽标 + 行内预览/打开位置 */
export function createFileRow(path, onPreview, onReveal) {
  const name = String(path).split(/[\\/]/).pop() || String(path);
  const extM = name.match(/\.([a-z0-9]+)$/i);
  const ext = extM ? extM[1].toUpperCase() : "FILE";
  const node = el("div", "file-row");
  node.innerHTML =
    `<span class="f-icon">${icon("fileText", 15)}</span>` +
    `<span class="f-main"><span class="f-name"></span><span class="f-badge">${escapeText(ext)}</span></span>` +
    `<span class="f-actions"></span>`;
  node.querySelector(".f-name").textContent = name;
  node.title = String(path);
  const actions = node.querySelector(".f-actions");
  if (onPreview) {
    const pv = el("button", "f-copy", `${icon("eye", 12)}预览`);
    pv.addEventListener("click", () => onPreview(path));
    actions.appendChild(pv);
  }
  if (onReveal) {
    const rv = el("button", "f-copy", `${icon("folderOpen", 12)}打开位置`);
    rv.addEventListener("click", () => onReveal(path));
    actions.appendChild(rv);
  }
  return node;
}

/** 多文件汇总卡（方案 A，≥3 个时收拢）：头行「产出 N 个文件 · 类型统计」，默认铺前 3 行，可展开全部 */
export function createFileGroup(paths, onPreview, onReveal) {
  const all = [...new Set(paths.map(String))]; // 去重保序：并行多写同一文件只留一张
  const node = el("div", "file-group");
  const PREVIEW_N = 3;
  const counts = new Map();
  for (const p of all) {
    const m = String(p).split(/[\\/]/).pop().match(/\.([a-z0-9]+)$/i);
    const ext = (m ? m[1] : "file").toUpperCase();
    counts.set(ext, (counts.get(ext) || 0) + 1);
  }
  const statText = [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([e, n]) => `${n}×${e}`).join(" · ");
  const head = el("button", "fg-head");
  head.innerHTML = `${icon("package", 15)}<span class="fg-title"></span><span class="fg-stat"></span>${icon("chevDown", 13, "chev")}`;
  head.querySelector(".fg-title").textContent = `产出 ${all.length} 个文件`;
  head.querySelector(".fg-stat").textContent = statText;
  const body = el("div", "fg-body");
  for (const p of all) body.appendChild(createFileRow(p, onPreview, onReveal));
  const foot = el("button", "fg-foot");
  const paintFoot = () => {
    foot.textContent = node.classList.contains("open") ? "收起" : `展开全部 ${all.length} 个`;
  };
  foot.addEventListener("click", () => {
    node.classList.toggle("open");
    paintFoot();
  });
  node.append(head, body);
  if (all.length > PREVIEW_N) {
    node.append(foot);
    node.classList.add("limited"); // 只铺前 3 行，其余展开后显示
    paintFoot();
  }
  head.addEventListener("click", () => {
    if (!node.classList.contains("limited")) return; // ≤3 个无折叠条：头行仅作展示
    node.classList.toggle("open");
    paintFoot();
  });
  return node;
}

/* ---------- 计划 / Todo 卡（PRD 3.7 Plan-first；对齐 Kimi Todo / ZCode 计划展示） ----------
   契约扩展事件演示：{ type:"plan_update", steps:[{text,status:"pending"|"running"|"done"}] }
   契约未扩展前主进程不发送该事件，UI 自然不出现（向后兼容） */
export function createPlan() {
  const startTs = Date.now();
  const node = el("div", "plan open");
  const head = el("button", "plan-head");
  const list = el("div", "plan-list");
  node.append(head, list);
  let steps = [];
  const ICONS = { pending: "circle", running: "loader", done: "checkCircle" };

  const paintHead = () => {
    const done = steps.filter((s) => s.status === "done").length;
    const running = steps.some((s) => s.status === "running");
    const total = durText(Date.now() - startTs);
    if (!running && done === steps.length && steps.length) {
      head.innerHTML = `${icon("listTodo", 14)}<span class="p-label">计划 · ${steps.length} 步全部完成 · ${total}</span>${icon("chevDown", 13, "chev")}`;
    } else {
      head.innerHTML =
        `${icon("listTodo", 14)}` +
        `<span class="p-label shimmer">计划 · ${done}/${steps.length}${running ? " · 执行中" : ""}</span>` +
        `<span class="p-secs">${total}</span>${icon("chevDown", 13, "chev")}`;
    }
  };
  const paintList = () => {
    list.innerHTML = "";
    for (const s of steps) {
      const row = el("div", "plan-step " + s.status);
      row.innerHTML =
        `<span class="ps-icon">${icon(s.status === "running" ? "loader" : ICONS[s.status] || "circle", 13, s.status === "running" ? "spinner" : "")}</span>` +
        `<span class="ps-text"></span>`;
      row.querySelector(".ps-text").textContent = s.text;
      list.appendChild(row);
    }
  };
  let timer = null;
  const ensureTimer = () => {
    if (!timer) timer = setInterval(() => paintHead(), 1000);
  };
  head.addEventListener("click", () => node.classList.toggle("open"));

  return {
    node,
    update(next) {
      steps = next.slice();
      paintList();
      paintHead();
      const allDone = steps.length && steps.every((s) => s.status === "done");
      node.classList.toggle("open", !allDone); // 流式自动展开，完成自动收拢
      if (allDone) {
        clearInterval(timer);
        timer = null;
      } else {
        ensureTimer();
      }
    },
  };
}

/* ---------- 右侧抽屉（产出预览 / 交付物看板 / 技能 / 自动化 共用壳） ---------- */
export function createDrawer(title, { onClose } = {}) {
  const backdrop = el("div", "drawer-backdrop");
  const node = el("aside", "drawer");
  const head = el("div", "drawer-head");
  head.innerHTML = `<span class="d-title"></span>`;
  head.querySelector(".d-title").textContent = title;
  const closeBtn = el("button", "d-close");
  closeBtn.innerHTML = icon("close", 16);
  head.appendChild(closeBtn);
  const body = el("div", "drawer-body");
  node.append(head, body);
  const close = () => {
    backdrop.remove();
    node.remove();
    onClose?.();
  };
  closeBtn.addEventListener("click", close);
  backdrop.addEventListener("click", close);
  document.body.append(backdrop, node);
  return { node, body, close };
}

/* ---------- 打字动画 ---------- */
export function createTyping() {
  const node = el("div", "md-text");
  node.innerHTML = `<span class="typing"><span></span><span></span><span></span></span>`;
  return node;
}

/* ---------- AI 正文块：流式追加 + 光标 ---------- */
export function createTextBlock() {
  const node = el("div", "md-text");
  let raw = "";
  const cursor = el("span", "cursor");
  const paint = () => {
    node.innerHTML = renderMarkdown(raw);
    node.appendChild(cursor);
  };
  return {
    node,
    append(delta) {
      raw += delta;
      paint();
    },
    finalize() {
      node.innerHTML = renderMarkdown(raw);
    },
    get raw() {
      return raw;
    },
  };
}

/* ---------- 历史正文块 ---------- */
export function createTextStatic(text) {
  const node = el("div", "md-text");
  node.innerHTML = renderMarkdown(text);
  return node;
}

/* ---------- 消息操作条（回合结束挂最终回答下）：复制 / 重新生成 / 赞 / 踩；多版本时带 ‹ n/N › 切换 ---------- */
export function createMsgActions(text, handlers = {}, versions = null) {
  const bar = el("div", "msg-actions");
  const mkBtn = (iconName, title, fn, cls = "") => {
    const b = el("button", "ma-btn" + (cls ? " " + cls : ""));
    b.type = "button";
    b.innerHTML = icon(iconName, 13);
    b.title = title;
    b.addEventListener("click", (e) => {
      e.stopPropagation();
      fn(b);
    });
    return b;
  };
  // 版本切换（重新生成的历次回答，仅渲染层保留不进模型上下文）：‹ n/N ›
  if (versions && versions.list.length > 1) {
    const mkArrow = (label, disabled, fn) => {
      const b = el("button", "ma-btn ma-ver");
      b.type = "button";
      b.textContent = label;
      b.disabled = disabled;
      b.addEventListener("click", (e) => {
        e.stopPropagation();
        fn();
      });
      return b;
    };
    const cnt = el("span", "ma-ver-cnt");
    cnt.textContent = `${versions.idx + 1}/${versions.list.length}`;
    cnt.title = "重新生成的历次版本（仅浏览，模型上下文只保留最新）";
    bar.append(
      mkArrow("‹", versions.idx <= 0, () => versions.onSwitch(versions.idx - 1)),
      cnt,
      mkArrow("›", versions.idx >= versions.list.length - 1, () => versions.onSwitch(versions.idx + 1))
    );
    const sep = el("span", "ma-sep");
    bar.appendChild(sep);
  }
  bar.appendChild(
    mkBtn("copy", "复制回答", (b) => {
      if (navigator.clipboard) navigator.clipboard.writeText(text);
      handlers.onCopied?.(b);
    })
  );
  if (handlers.onRegen) bar.appendChild(mkBtn("refresh", "重新生成", () => handlers.onRegen()));
  if (handlers.onFeedback) {
    bar.appendChild(
      mkBtn(
        "thumbUp",
        "有用",
        (b) => {
          const on = b.classList.toggle("on");
          bar.querySelector(".ma-down")?.classList.remove("on");
          handlers.onFeedback(on ? "up" : null);
        },
        "ma-up"
      )
    );
    bar.appendChild(
      mkBtn(
        "thumbDown",
        "没用",
        (b) => {
          const on = b.classList.toggle("on");
          bar.querySelector(".ma-up")?.classList.remove("on");
          handlers.onFeedback(on ? "down" : null);
        },
        "ma-down"
      )
    );
  }
  return bar;
}

function fmtK(n) {
  if (n == null) return "-";
  if (n >= 1000) return (n / 1000).toFixed(1) + "k";
  return String(n);
}

function escapeText(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
