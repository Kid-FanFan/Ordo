import { icon } from "./icons.js";
import { relTime, greeting } from "./format.js";
import { renderMarkdown, bindMarkdownActions } from "./markdown.js";
import { initTheme, loadSavedTheme, renderThemeContent } from "./theme.js";
import {
  addUserMsg, createThinking, createThinkingStatic, createToolRow, createTurnFold,
  createConfirm, createChip, createCompaction, createError, createTyping, createTextBlock, createTextStatic, el,
  createFileCard, createFileGroup, createPlan, createMsgActions, attKind, attBadge,
} from "./ui.js";

// ===== js/app.js =====
// 应用装配：状态机 + UiEvent→组件映射（§6）+ composer/侧栏/菜单/键盘/滚动 + 会话/工作区/市场/设置
// 通过 window.ordo 通信（§7 锁定契约）；契约扩展项均以 ?. 调用优雅降级（见文档 §7 扩展提案）

// 管理端总开关（PRD 5.1；原型默认值，正式版由管理端策略下发）
const MARKET_POLICY = { personalSkills: true, personalKb: true }; // 个人专家无此概念（专家由管理端统一定义，PRD 3.10）

const $ = (id) => document.getElementById(id);
const thread = $("thread");
const scroller = $("scroller");
const composerWrap = $("composer-wrap");
const composerStack = $("composer-stack"); // 常驻引用：脱离文档树后 getElementById 会找不到
const composer = $("composer");
const input = $("input");
const sendBtn = $("send-btn");
const jumpBtn = $("jump-bottom");
const expertBtn = $("expert-btn");
const thinkingBtn = $("thinking-btn");
const confirmModeBtn = $("confirm-mode-btn");
const sessionList = $("session-list");

const state = {
  status: "idle", // idle | streaming | awaiting_confirm
  runStart: 0,
  statusTimer: null,
  turn: null,          // 当前回合容器
  textBlock: null,     // 流式正文指针
  runningRows: [],     // 进行中的工具步骤行（B 方案：无组卡，行独立流式）
  queueItems: [],      // 运行中消息队列（queue_changed 事件驱动；输入框右上方，发送即默认排队）
  thinking: null,      // 思考块指针
  typing: null,
  pendingConfirm: null, // { id, card }
  pendingFiles: [],    // 本回合待渲染交付卡的目标路径（write_file / Office 五件成功后置入，assistant_done 消费）
  plan: null,           // 计划卡指针（plan_update 契约扩展事件；未扩展时恒为 null）
  drawer: null,         // 右侧抽屉（技能/自动化管理面共用）
  wb: { open: false, preview: null, resolution: null, newTab: null }, // 右侧预览面板（方案 D4：去工作台化，纯预览容器）；newTab = 新标签页 { view }
  bubble: { steps: [], runActive: false, error: false, ranOnce: false }, // 悬浮浮标（方案 §3：计划进度）
  artifacts: new Map(), // 会话内交付物：path -> {name}
  wsLocked: false,      // 会话锚定工作区后为 true（首条消息发出时锁定）
  activeSessionId: null,
  experts: null,
  thinkingState: null,
  // 当前回合的回答版本（方案 B）：历次重新生成的答案都在，仅渲染层浏览；模型上下文只保留最新（regenerate 截断重问）
  answerVersions: [],
  answerIdx: 0,
  answerNode: null,
};

/* ============ 滚动策略（§4.7） ============ */
let stick = true;
scroller.addEventListener("scroll", () => {
  const gap = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight;
  stick = gap < 48;
  jumpBtn.classList.toggle("hidden", stick);
  if (!jumpBtn.classList.contains("hidden")) {
    jumpBtn.style.bottom = composerWrap.offsetHeight + 16 + "px";
  }
});
function scrollBottom(force = false) {
  if (stick || force) {
    scroller.scrollTop = scroller.scrollHeight;
    jumpBtn.classList.add("hidden");
  }
}
jumpBtn.addEventListener("click", () => { stick = true; scrollBottom(true); });

/* ============ 顶栏状态（§3.3，已并入悬浮浮标：状态圆盘二合一） ============ */
function setStatus(next) {
  state.status = next;
  clearInterval(state.statusTimer);
  state.statusTimer = null;
  if (next === "streaming") {
    state.runStart = Date.now();
    state.statusTimer = setInterval(() => refreshBubble(), 1000); // 执行中秒数由浮标呈现
  }
  refreshBubble();
  composer.classList.toggle("disabled", next === "awaiting_confirm");
  input.disabled = next === "awaiting_confirm";
  // 运行中消息：输入框保持可用（placeholder 提示按模式生效），排队区（模式条+条目）显隐随状态
  if (next === "streaming") {
    input.placeholder = "任务运行中：发送将排队执行，发出后可切「引导」插入当前任务";
  } else {
    input.placeholder = "给 Ordo 下达任务…（@文件 /命令 $技能，可拖拽/粘贴文件）";
  }
  renderQueueArea();
  updateSendBtn();
}

function updateSendBtn() {
  const busy = state.status === "streaming";
  const canCancel = busy && typeof api?.cancel === "function"; // 契约扩展（cancel）已实装时可打断
  sendBtn.disabled = state.status === "awaiting_confirm" || (!input.value.trim() && !attachments.length && !busy);
  sendBtn.innerHTML = busy ? icon("square", 14) : icon("arrowUp", 15);
  sendBtn.title = busy ? (canCancel ? "停止（打断当前任务）" : "运行中") : "发送（Enter）";
  if (busy) sendBtn.disabled = !canCancel;
}

/* ============ 运行中消息：排队区（输入框右上方，发送即默认排队） ============ */
function renderQueueArea() {
  const area = $("queue-area");
  if (!area) return;
  area.classList.toggle("hidden", state.status !== "streaming" || state.queueItems.length === 0);
  const box = $("queue-items");
  if (!box) return;
  box.innerHTML = "";
  for (const it of state.queueItems) {
    const row = document.createElement("div");
    row.className = "queue-item";
    const k = document.createElement("span");
    k.className = "qk";
    k.textContent = it.kind === "steer" ? "⤴ 已插入" : "⏭ 排队中";
    k.title = it.kind === "steer" ? "引导：当前步骤完成后插入当前任务（不打断）" : "排队：当前任务结束后执行";
    const t = document.createElement("span");
    t.className = "qt";
    t.textContent = it.text || "";
    t.title = it.text || "";
    // 模式切换：排队 ⇄ 引导（撤旧入新，消息本体不变）
    const sw = document.createElement("button");
    sw.className = "qsw";
    if (it.kind === "steer") {
      sw.textContent = "切排队";
      sw.title = "改回排队：当前任务结束后执行";
    } else {
      sw.textContent = "切引导";
      sw.title = "切换为引导：当前步骤完成后插入当前任务";
    }
    sw.onclick = () => api.switchQueued?.(it.entryId, it.kind === "steer" ? "followUp" : "steer").catch((e) => toast(String((e && e.message) || e)));
    const edit = document.createElement("button");
    edit.className = "qedit";
    edit.title = "撤回到输入框编辑";
    edit.textContent = "✎";
    edit.onclick = async () => {
      try {
        await api.cancelQueued?.(it.entryId);
        input.value = it.text || "";
        input.focus();
        input.dispatchEvent(new Event("input"));
      } catch (e) { toast(String((e && e.message) || e)); }
    };
    const del = document.createElement("button");
    del.className = "qdel";
    del.title = "删除（不执行）";
    del.textContent = "✕";
    del.onclick = () => api.cancelQueued?.(it.entryId).catch((e) => toast(String((e && e.message) || e)));
    row.append(k, t, sw, edit, del);
    box.appendChild(row);
  }
}

sendBtn.addEventListener("click", () => {
  if (state.status === "streaming") {
    api.cancel?.().catch(() => {});
    return;
  }
  send();
});

/* ============ 回合与指针（§3.4） ============ */
function ensureTurn() {
  if (!state.turn || !state.turn.isConnected) {
    state.turn = el("div", "turn");
    thread.appendChild(state.turn);
  }
  return state.turn;
}
function append(node) {
  ensureTurn().appendChild(node);
  scrollBottom();
}

function removeTyping() {
  if (state.typing && state.typing.isConnected) state.typing.remove();
  state.typing = null;
}
function closeTextBlock() {
  if (state.textBlock) {
    state.textBlock.finalize();
    state.textBlock = null;
  }
}
function closeThinking() {
  if (state.thinking) {
    state.thinking.finish();
    state.thinking = null;
  }
}

// 回合结束：本回合的过程件（工具组/思考/中间文字/确认卡）收进一行折叠，只留最终回答与结果卡。
// 区间 = 最后一条用户消息之后（turn 容器跨回合复用）；单个已收拢的行不再包一层
function foldTurnProcess() {
  const turn = state.turn;
  if (!turn || !turn.isConnected) return;
  const kids = [...turn.children];
  let start = 0;
  kids.forEach((n, i) => {
    if (n.classList.contains("msg-user")) start = i + 1;
  });
  const exchange = kids.slice(start);
  const texts = exchange.filter((n) => n.classList.contains("md-text"));
  const lastText = texts[texts.length - 1] || null; // 最终回答 = 最后一个正文块
  // B 方案拍平：工具步骤行（.tool-row）与思考/计划/确认卡/中间文字直接收进折叠行，无组外壳
  const foldables = exchange.filter(
    (n) =>
      n !== lastText &&
      !n.classList.contains("turn-fold") && // 已收拢的折叠行不再套娃
      (n.classList.contains("thinking") || n.classList.contains("tool-row") || n.classList.contains("confirm-card") || n.classList.contains("plan") || n.classList.contains("md-text"))
  );
  const hasHidden = foldables.some((n) => n.classList.contains("md-text") || n.classList.contains("confirm-card"));
  if (!foldables.length || (!hasHidden && foldables.length <= 1)) return;
  const fold = createTurnFold();
  turn.insertBefore(fold.node, foldables[0]);
  for (const n of foldables) fold.list.appendChild(n);
  // 头部只报总耗时（run_start→run_end 墙钟，与浮标同源）；出错用错误图标
  const durMs = state.runStart ? Date.now() - state.runStart : 0;
  fold.paint(durMs, state.bubble.error);
  // 兜底：异常中断未收到 tool_end 的行强制落状态，避免永久转圈
  for (const r of state.runningRows) if (r.status === "running") r.end(false);
  state.runningRows = [];
}

// 回答版本操作条（方案 B 原位替换）：挂载/重挂（切版本、新回合共用）；复制的是当前展示版本
function mountAnswerActions() {
  const turn = state.turn;
  if (!turn?.isConnected) return;
  turn.querySelectorAll(".msg-actions").forEach((n) => n.remove());
  const text = state.answerVersions[state.answerIdx] ?? "";
  turn.appendChild(
    createMsgActions(
      text,
      {
        onCopied: () => toast("回答已复制"),
        onRegen: async () => {
          if (state.status !== "idle") {
            toast("当前有任务在运行，请先停止");
            return;
          }
          clearCurrentAnswerVisuals(); // 原位替换：旧回答（及旧过程折叠/操作条）先撤，新回答流式顶上
          try {
            await api.regenerate?.();
          } catch (e) {
            toast(String((e && e.message) || e));
          }
        },
        onFeedback: (value) => {
          if (value) api.feedback?.(value);
        },
      },
      state.answerVersions.length > 1
        ? { idx: state.answerIdx, list: state.answerVersions, onSwitch: (i) => switchAnswerVersion(i) }
        : null
    )
  );
  scrollBottom();
}

/** 切换浏览版本：只换渲染与操作条，不动模型上下文（上下文恒为最新版） */
function switchAnswerVersion(i) {
  state.answerIdx = Math.max(0, Math.min(state.answerVersions.length - 1, i));
  if (state.answerNode) state.answerNode.innerHTML = renderMarkdown(state.answerVersions[state.answerIdx] ?? "");
  mountAnswerActions();
}

/** 原位替换的视觉清理：只清当前这轮问答区间（最后一条用户消息之后）的回答正文/折叠行/操作条；交付卡保留 */
function clearCurrentAnswerVisuals() {
  const turn = state.turn;
  if (!turn?.isConnected) return;
  const kids = [...turn.children];
  let start = 0;
  kids.forEach((n, i) => {
    if (n.classList.contains("msg-user")) start = i + 1;
  });
  for (const n of kids.slice(start)) {
    if (n.classList.contains("md-text") || n.classList.contains("turn-fold") || n.classList.contains("msg-actions")) n.remove();
  }
  state.answerNode = null;
}

function hideEmpty() {
  if (emptyEl && emptyEl.isConnected) {
    emptyEl.remove();
    emptyEl = null;
    thread.classList.remove("is-empty");
    composerWrap.appendChild(composerStack); // 空态居中的输入区（含工作区选项行）落回底部
    input.focus();
    stick = true;
  }
}

/* ============ 事件映射（§6.2） ============ */
function handleEvent(ev) {
  if (ev && ev.type === "auth_expired") {
    handleAuthExpired();
    return;
  }
  switch (ev.type) {
    case "run_start":
      hideEmpty(); // 回合开始即收起欢迎空态（输入框链路 send() 已收，此处覆盖主进程直驱 prompt 的注入链路）
      if (ev.prompt && !state.userBubbleShown) {
        ensureTurn().appendChild(addUserMsg(ev.prompt)); // 自测/e2e 从主进程注入提示词时不经过 send()，补画用户气泡
      }
      state.userBubbleShown = true;
      state.pendingFiles = [];
      state.plan = null;
      state.lastAnswerRaw = ""; // 新回合清空上一轮回答缓存
      state.bubble.steps = [];
      state.bubble.runActive = true;
      state.bubble.error = false;
      refreshBubble();
      setStatus("streaming");
      removeTyping();
      state.typing = createTyping();
      append(state.typing);
      refreshSessions(); // 侧栏当前会话卡片 → 运行中
      break;

    case "thinking_delta":
      removeTyping();
      if (!state.thinking) {
        state.thinking = createThinking();
        append(state.thinking.node);
      }
      state.thinking.stream(ev.text);
      scrollBottom();
      break;

    case "text_delta":
      removeTyping();
      closeThinking();
      if (!state.textBlock) {
        state.textBlock = createTextBlock();
        append(state.textBlock.node);
      }
      state.textBlock.append(ev.text);
      scrollBottom();
      break;

    case "plan_update":
      // 契约扩展事件：主进程未扩展时不发送，UI 自然不出现
      removeTyping();
      if (!state.plan || !state.plan.node.isConnected) {
        state.plan = createPlan();
        const anchor = state.turn?.querySelector(":scope > .md-text, :scope > .tool-row, :scope > .turn-fold, :scope > .typing");
        if (anchor) anchor.before(state.plan.node);
        else append(state.plan.node);
      }
      state.plan.update(ev.steps || []);
      state.bubble.steps = ev.steps || [];
      refreshBubble(); // 计划入口归浮标（方案 D4），不再自动展开面板
      scrollBottom();
      break;

    case "assistant_done":
      removeTyping();
      closeThinking();
      // 捕获最终回答原文（消息操作条用）：assistant_done 先于 run_end，run_end 时 textBlock 已关闭
      state.lastAnswerRaw = state.textBlock ? state.textBlock.raw : "";
      // 文件交付卡：write_file / Office 五件成功后展示成果物。
      // 单槽改回合级集合：并行多写不再丢卡（原 pendingFile 只留第一个）；≥3 个收成汇总卡（方案 A）
      if (state.pendingFiles.length) {
        const uniqPaths = [...new Set(state.pendingFiles.map(String))];
        for (const p of uniqPaths) registerArtifact(p);
        const cards =
          uniqPaths.length >= 3
            ? [createFileGroup(uniqPaths, openArtifactPreview, revealArtifact)]
            : uniqPaths.map((p) => createFileCard(p, openArtifactPreview, revealArtifact));
        for (const card of cards) {
          if (state.textBlock) state.textBlock.node.after(card);
          else ensureTurn().appendChild(card);
        }
        scrollBottom();
        state.pendingFiles = [];
      }
      closeTextBlock();
      break;

    case "tool_start":
      removeTyping();
      closeThinking();
      closeTextBlock();
      // B 方案：无组卡，工具步骤行独立流式出现；回合结束统一收进折叠行
      {
        const row = createToolRow(ev.name, ev.args || {}, ev.level === "L2");
        row.targetPath = ev.path || null; // 写文件类工具的目标相对路径（主进程自 tool args 转发，任何确认模式都有）
        append(row.node);
        state.runningRows.push(row);
        state.lastToolRow = row;
      }
      scrollBottom();
      break;

    case "tool_end": {
      const row = state.runningRows.filter((r) => r.status === "running").pop();
      if (row) {
        row.end(row.rejected);
        // 写文件成功 → 待渲染交付卡（路径来自 tool_start 转发，确认卡参数兜底；被拒绝则不渲染）
        if (row.name === "write_file" && !row.rejected) {
          const p = row.targetPath || row.confirmPath;
          if (p) state.pendingFiles.push(String(p));
        }
      }
      break;
    }

    case "notice":
      if (/失败|错误|error/i.test(ev.text || "")) {
        state.bubble.error = true;
        refreshBubble();
        append(createError({ title: "执行出现问题", why: ev.text, next: "可重试发送，或换一种描述" }));
      } else {
        append(createChip(ev.text, "msg"));
      }
      break;

    case "browser_navigate":
      // 桥请求导航（agent browser_open 或 ＋ 菜单）：建/激活浏览器标签并由 webview 加载
      navigateBrowserTab(ev.url || "");
      break;

    case "browser_state_changed":
      refreshBrowserPanel(); // 刷新工具条 URL 与控制台；标签存在性由 browser_navigate/browser_stop 驱动
      break;

    case "browser_stop":
      closeBrowserTab(true);
      renderWorkbench();
      break;

    case "browser_console_append":
      refreshBrowserPanel();
      break;

    case "term_data":
      // pty 输出直写 xterm（未挂载则缓冲；主进程未扩展时不发送）
      termWriteToView(ev.data || "");
      break;

    case "term_exit":
      termState.exited = true;
      termState.term = null; // 进程已亡：置空以便「重新打开」重建 xterm
      termWriteToView(`\r\n\x1b[90m（进程已退出，代码 ${ev.exitCode ?? 0}）\x1b[0m\r\n`);
      {
        const pane = wbPanes.get("terminal");
        if (pane) {
          pane.dataset.built = ""; // 重建为「已退出 + 重新打开」态
          renderTerminalPanel();
        }
      }
      break;

    case "term_state_changed":
      api.termState?.().then((st) => {
        termState.active = !!(st && st.active);
        if (st && st.cwd) termState.cwd = st.cwd;
        renderWorkbench();
      });
      break;

    case "artifact_added":
      // 交付物登记：浏览器截图等只进浮层清单；Office 五件（带 tool 标记）同时进当轮交付卡
      registerArtifact(ev.path, true);
      if (ev.tool) state.pendingFiles.push(String(ev.path));
      break;

    case "confirm_request": {
      removeTyping();
      setStatus("awaiting_confirm");
      const anchorRow = state.lastToolRow;
      // 契约中 tool_start 无 args/level；L2 标识与目标摘要只能由 confirm_request.args 反推（P1 扩展前 live L1 行无摘要）
      if (anchorRow) {
        anchorRow.node.classList.add("l2");
        const target = anchorRow.node.querySelector(".t-target");
        if (!target.textContent && ev.args?.path) {
          target.textContent = ev.args.path;
          target.title = ev.args.path;
        }
      }
      const card = createConfirm(ev, {
        onDecide: (approved) => {
          state.pendingConfirm = null;
          refreshBubble();
          if (anchorRow) {
            if (!approved) anchorRow.rejected = true;
            // 同意后记住目标路径，供 write_file 完成后的交付卡使用
            else if (approved && ev.args?.path) anchorRow.confirmPath = String(ev.args.path);
          }
          setStatus("streaming");
          api.respondConfirm(ev.id, approved).catch(() => {});
        },
      });
      state.pendingConfirm = { id: ev.id, card };
      refreshBubble(); // 有待确认操作：浮标高亮呼吸（方案 §3）
      append(card.node); // B 方案无组卡：确认卡与工具行同层，紧随其后
      stick = true;
      scrollBottom(true);
      break;
    }

    case "expert_switched":
      // 切换不进对话流，状态在 composer 按钮上呈现
      if (state.experts) {
        state.experts.currentId = ev.id;
        paintExpertBtn();
      }
      break;

    case "thinking_switched":
      if (state.thinkingState) {
        state.thinkingState.currentId = ev.id;
        paintThinkingBtn();
      }
      break;

    case "run_end":
      removeTyping();
      closeThinking();
      closeTextBlock();
      {
        const answerRaw = state.lastAnswerRaw || ""; // assistant_done 时缓存的最终回答原文（run_end 时 textBlock 已关）
        foldTurnProcess(); // 过程拍平收进折叠行（B 方案），只留最终回答（交付卡/错误卡保留在外）
        // 消息操作条（方案 B 原位替换 + 版本切换）：成功回答入版本表并挂操作条；
        // 重新生成失败的兜底——旧回答已按原位替换移除时，恢复显示最后版本，不让回答凭空消失
        if (answerRaw && !state.bubble.error && state.turn?.isConnected) {
          state.answerVersions.push(answerRaw);
          state.answerIdx = state.answerVersions.length - 1;
          state.answerNode =
            [...state.turn.children].filter((n) => n.classList.contains("md-text")).pop() ?? null;
          mountAnswerActions();
        } else if (state.bubble.error && state.answerVersions.length && state.turn?.isConnected && !state.answerNode) {
          state.answerNode = el("div", "md-text");
          state.answerNode.innerHTML = renderMarkdown(state.answerVersions[state.answerVersions.length - 1]);
          state.turn.appendChild(state.answerNode);
          mountAnswerActions();
        }
      }
      state.pendingFiles = [];
      state.bubble.runActive = false;
      if (!state.bubble.error) state.bubble.ranOnce = true;
      state.userBubbleShown = false; // 回合收束：下一回合（含主进程直驱）重新判定补画
      refreshBubble();
      if (state.plan?.node?.isConnected) state.plan.node.classList.remove("open");
      state.plan = null;
      setStatus("idle");
      refreshSessions(); // 侧栏当前会话卡片 → 恢复最近更新时间
      break;

    case "session_saved":
      state.activeSessionId = ev.id;
      setSessionTitle(ev.title);
      refreshSessions();
      break;

    case "session_loaded":
      renderHistory(ev.messages || []);
      state.activeSessionId = ev.id;
      state.answerVersions = []; // 版本表为会话内内存态：加载/切换会话即重置（回放只显示最终版本）
      state.answerIdx = 0;
      state.answerNode = null;
      state.bubble.steps = [];
      state.bubble.runActive = false;
      state.bubble.error = false;
      state.bubble.ranOnce = false;
      state.userBubbleShown = false; // 历史回放已含用户气泡（renderHistory 画）；下一回合重新判定
      refreshBubble();
      state.activeSessionId = ev.id;
      setSessionTitle(ev.title);
      lockWs(); // 历史会话已锚定
      refreshSessions();
      if (state.experts) {
        state.experts.currentId = ev.expert;
        paintExpertBtn();
      }
      break;

    case "context_compacted":
      append(createCompaction(ev));
      break;

    case "queue_changed":
      state.queueItems = ev.items || [];
      renderQueueArea();
      break;

    case "mounts_changed":
      // 挂载集以主进程为准：新建/续接会话清空、跨端变化时徽标立即归零，不留下“看着挂了其实没有”的假状态
      selectedKBs = new Set(ev.kbs || []);
      selectedConns = new Set(ev.connectors || []);
      paintBadge($("kb-btn").querySelector(".pill-badge"), selectedKBs.size);
      paintBadge($("conn-btn").querySelector(".pill-badge"), selectedConns.size);
      break;

    case "skills_changed":
      // 技能集变化（对话内沉淀 / 后台同步 / 安装卸载）：市场页开着才刷新，其余场景无需打扰
      if (activeModule === "skills" && ev.reason !== "skill_toggle") state.moduleRerender?.();
      break;

    case "automation_run":
      // 本地型定时任务一次无人值守运行结束：提醒 + 刷新侧栏（新会话可点开回看）；不抢占当前会话
      toast(`⏰ 自动化「${ev.name}」${ev.ok ? "已完成" : "运行失败"}${ev.summary ? "：" + String(ev.summary).slice(0, 60) : ""}`);
      refreshSessions();
      if (activeModule === "automations") state.moduleRerender?.();
      break;

    case "im_channels":
      // IM 通道状态推送（钉钉/飞书长连接）：设置页开着才重绘；手机来过消息则刷侧栏（IM 会话可回看）
      if (ev.touchedSessionId) {
        refreshSessions();
      } else if (activeModule === "settings" && settingsSection === "im") {
        // 正在输入时不重绘（避免打字被连接状态变化打断）；失焦后下次事件会补上
        const ae = document.activeElement;
        if (!(ae && ae.closest && ae.closest(".settings-page"))) state.moduleRerender?.();
      }
      break;
  }
}

/* ============ 历史渲染（§6.2 底部规则） ============ */
function textOf(m) {
  const c = m && m.content;
  if (typeof c === "string") return c;
  return (c || []).filter((x) => x && x.type === "text").map((x) => x.text || "").join("");
}

function renderHistory(messages) {
  state.artifacts.clear();
  state.wb.preview = null;
  thread.querySelectorAll(".turn").forEach((n) => n.remove());
  state.turn = null;
  state.textBlock = null;
  state.runningRows = [];
  state.thinking = null;
  hideEmpty();
  // 缓冲式渲染：过程件（工具步骤行/思考/中间文字）先进 foldBuf，最终回答与交付卡留外；回合结束统一收拢（B 方案拍平）
  let foldBuf = [];
  let answerEl = null;
  let fileBuf = [];
  const demoteAnswer = () => {
    // 过程件出现在正文之后 → 该正文是中间说明，收进折叠
    if (answerEl) {
      foldBuf.push(answerEl);
      answerEl = null;
    }
  };
  const flushFold = () => {
    if (!foldBuf.length && !answerEl && !fileBuf.length) return;
    const hasHidden = foldBuf.some((n) => n.classList.contains("md-text") || n.classList.contains("confirm-card"));
    if (foldBuf.length && (hasHidden || foldBuf.length > 1)) {
      const fold = createTurnFold();
      for (const n of foldBuf) fold.list.appendChild(n);
      fold.paint(0, false); // 历史无耗时记录：头部只显示「执行过程」
      ensureTurn().appendChild(fold.node);
    } else {
      for (const n of foldBuf) ensureTurn().appendChild(n);
    }
    if (answerEl) ensureTurn().appendChild(answerEl);
    for (const f of fileBuf) ensureTurn().appendChild(f);
    foldBuf = [];
    answerEl = null;
    fileBuf = [];
  };
  for (const m of messages || []) {
    if (m.role === "user") {
      flushFold(); // 上一回合收尾
      ensureTurn().appendChild(addUserMsg(textOf(m)));
    } else if (m.role === "compactionSummary") {
      flushFold();
      ensureTurn().appendChild(createCompaction({ messagesBefore: m.messagesBefore, messagesAfter: m.messagesAfter, tokensBefore: m.tokensBefore, summary: m.summary || m.text || "" }));
    } else if (m.role === "assistant") {
      // 写文件类工具（write_file + Office 五件）的产出/改动：与实况回合同一口径出交付卡
      const written = (m.content || [])
        .filter((c) => c && c.type === "toolCall" && DELIVERY_TOOLS.has(c.name) && c.arguments?.path)
        .map((c) => String(c.arguments.path));
      for (const c of m.content || []) {
        if (c.type === "thinking") {
          demoteAnswer();
          const t = createThinkingStatic();
          t.body.textContent = c.thinking || "";
          foldBuf.push(t.node);
        } else if (c.type === "toolCall") {
          demoteAnswer();
          // B 方案拍平：历史工具调用直接生成步骤行（无组外壳）
          foldBuf.push(createToolRow(c.name, c.arguments || {}, c.level === "L2", true).node);
        } else if (c.type === "text" && c.text) {
          if (answerEl) foldBuf.push(answerEl); // 前一段正文降级为中间说明
          answerEl = createTextStatic(c.text);
        }
      }
      // 交付卡：历史中写入文件的成果物（quiet：加载历史不自动弹工作台）；留在折叠外；≥3 个收汇总卡
      if (written.length) {
        const uniq = [...new Set(written)];
        for (const p of uniq) registerArtifact(p, true);
        if (uniq.length >= 3) fileBuf.push(createFileGroup(uniq, openArtifactPreview, revealArtifact));
        else for (const p of uniq) fileBuf.push(createFileCard(p, openArtifactPreview, revealArtifact));
      }
    } else if (m.role === "toolResult") {
      // 结果摘要已并入工具行；不渲染
    }
  }
  flushFold();
  // 最终回答挂操作条（复制/重新生成/反馈）：续接历史 / 离开会话面板再返回 / 重启恢复，都与实况回合一致
  // 仅当最后一条消息是 assistant（完整回合收尾）才挂：被打断的运行（尾部是 toolResult）不给操作条
  const lastMsg = (messages || [])[messages.length - 1];
  if (lastMsg?.role === "assistant") {
    const texts = (lastMsg.content || []).filter((c) => c?.type === "text" && c.text);
    const answerText = texts[texts.length - 1]?.text || "";
    const turns = thread.querySelectorAll(".turn");
    const turn = turns[turns.length - 1];
    if (answerText && turn) {
      state.turn = turn;
      const mdTexts = [...turn.querySelectorAll(".md-text")].filter((n) => !n.closest(".turn-fold"));
      state.answerNode = mdTexts[mdTexts.length - 1] || null;
      state.answerVersions = [answerText];
      state.answerIdx = 0;
      mountAnswerActions();
    }
  }
  if (state.wb.open) renderWorkbench();
  if (!thread.querySelector(".turn")) showEmpty();
  stick = true;
  scrollBottom(true);
}

function showEmpty() {
  ensureEmptyState();
}

/* ============ 空状态（§3.6） ============ */
let emptyEl = null;
function ensureEmptyState() {
  if (emptyEl && emptyEl.isConnected) return;
  emptyEl = el("div");
  emptyEl.id = "empty-state";
  emptyEl.innerHTML = `
    <div class="hero-mark">${icon("logo", 32)}</div>
    <h1>${greeting()}</h1>
    <p class="sub">你的企业助手 · 已连接内网模型</p>
    <div class="suggest">
      <button class="suggest-card" data-q="请读取 data/sales.txt，生成本周销售周报，并写入 out/weekly-report.md">
        ${icon("filePlus", 16)}<span><span class="sc-t">生成销售周报</span><br/><span class="sc-d">读取数据文件，产出周报文档</span></span>
      </button>
      <button class="suggest-card" data-q="列出工作区的文件结构，并简要说明每部分用途">
        ${icon("folder", 16)}<span><span class="sc-t">浏览工作区</span><br/><span class="sc-d">查看文件结构与用途说明</span></span>
      </button>
      <button class="suggest-card" data-q="读取 data/sales.txt，对数字做一致性核对，输出核对表">
        ${icon("checkCircle", 16)}<span><span class="sc-t">数据核对演示</span><br/><span class="sc-d">核对数据一致性并输出报告</span></span>
      </button>
    </div>`;
  thread.appendChild(emptyEl);
  thread.classList.add("is-empty");
  emptyEl.querySelectorAll(".suggest-card").forEach((b) =>
    b.addEventListener("click", () => send(b.dataset.q))
  );
  emptyEl.appendChild(composerStack); // 输入区 + 工作区选项行一起移入空态居中
  input.focus();
}

/* ============ 发送（§6.1） ============ */
async function send(preset) {
  const text = (preset ?? input.value).trim();
  // 运行中：按模式条所选入队（排队/插入当前任务），不打断当前任务；带附件暂不支持入队
  if (state.status === "streaming") {
    if (!text) return;
    if (attachments.length) { toast("运行中发送暂不支持附件：请等任务完成后再发，或去掉附件"); return; }
    try {
      await api.queueFollowUp(text); // 发送即默认排队；条目上可切「引导」
      input.value = "";
      input.dispatchEvent(new Event("input"));
    } catch (e) {
      toast(String((e && e.message) || e));
    }
    return;
  }
  if ((!text && !attachments.length) || state.status !== "idle") return;
  // M6-B：单机模式未配置大模型 → 引导去设置（联机模型由管理端下发，不做此检查）
  if (api.getAuthState && api.getLocalModel) {
    try {
      const st = await api.getAuthState();
      if (st && st.mode === "standalone" && !(await api.getLocalModel())) {
        confirmModal(
          "尚未配置大模型",
          "单机模式需自行配置一个大模型 API（OpenAI 兼容接口）后才能对话。是否现在前往设置？",
          "去设置",
          () => openSettings()
        );
        return;
      }
    } catch {
      /* 契约缺失不拦截发送 */
    }
  }
  hideEmpty();
  state.answerVersions = []; // 新用户消息 = 新问答：版本表重置
  state.answerIdx = 0;
  state.answerNode = null;
  // 附件先转 base64（读取失败保留输入与附件原样，不丢用户内容）
  let atts = [];
  if (attachments.length) {
    try {
      for (const a of attachments) atts.push({ name: a.name, size: a.size, dataBase64: await fileToBase64(a.file) });
    } catch (e) {
      toast(String((e && e.message) || e));
      return;
    }
  }
  const sentAtts = attachments.map((a) => ({ name: a.name, size: a.size, kind: attKind(a), url: a.url }));
  clearAttachments();
  input.value = "";
  autoResize();
  updateSendBtn();
  state.userBubbleShown = false; // 清上一轮可能的残留（发送失败未到 run_end）
  ensureTurn().appendChild(addUserMsg(text, sentAtts));
  state.userBubbleShown = true; // send() 已画气泡：run_start 到达时不重复补画
  lockWs(); // 首条消息发出即锚定工作区
  stick = true;
  scrollBottom(true);
  try {
    await api.prompt(text || "请查看并处理我发送的附件。", atts.length ? atts : undefined);
  } catch (e) {
    append(createError({
      title: "任务未能开始",
      why: (e && e.message) || String(e),
      next: "检查模型服务连接后重新发送",
    }));
    setStatus("idle");
  }
}

input.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    send();
  }
});
input.addEventListener("input", () => {
  autoResize();
  updateSendBtn();
});
function autoResize() {
  input.style.height = "auto";
  input.style.height = Math.min(input.scrollHeight, 160) + "px";
}

/* ============ 工作台（进度 / 交付物 / 预览）—— 对话+工作台双栏，对齐豆包/千问/Kimi ============ */
const workbench = $("workbench");

const wbBody = $("wb-body");
const wbTabs = $("wb-tabs");

/* ---- 右侧预览面板（标签化容器）：文件 / 终端 / 浏览器 各占一标签，＋菜单新建，标签小 × 关闭 ---- */
const WB_WIDTH_KEY = "sd.preview.width";
window.addEventListener("resize", () => {
  // 窗口缩小时把持久宽度夹回上限，避免面板吃掉整个窗口
  const cur = workbench.getBoundingClientRect().width;
  const max = Math.round(window.innerWidth * 0.5);
  if (state.wb.open && cur > max) workbench.style.width = `${max}px`;
});
(function initWbResizer() {
  const handle = $("wb-resizer");
  let dragging = false;
  handle.addEventListener("pointerdown", (e) => {
    dragging = true;
    workbench.classList.add("dragging");
    try {
      handle.setPointerCapture(e.pointerId); // 合成/失效指针下可能抛错，不阻断拖拽状态
    } catch {}
    e.preventDefault();
  });
  handle.addEventListener("pointermove", (e) => {
    if (!dragging) return;
    const max = Math.round(window.innerWidth * 0.5);
    const w = Math.min(Math.max(Math.round(window.innerWidth - e.clientX), 280), max);
    workbench.style.width = `${w}px`;
  });
  handle.addEventListener("pointerup", (e) => {
    if (!dragging) return;
    dragging = false;
    workbench.classList.remove("dragging");
    try { handle.releasePointerCapture(e.pointerId); } catch {}
    localStorage.setItem(WB_WIDTH_KEY, String(Math.round(workbench.getBoundingClientRect().width)));
  });
})();

function openWorkbench() {
  state.wb.open = true;
  workbench.classList.add("open");
  wbApplyWidth(); // 展开时应用持久化宽度（内联宽度会盖住 CSS，收起时必须清掉）
  renderWorkbench();
}
function closeWorkbench() {
  state.wb.open = false;
  workbench.classList.remove("open");
  workbench.style.width = ""; // 清内联宽度：否则它盖过 CSS 的 width:0，面板关不掉
}
function wbApplyWidth() {
  const saved = Number(localStorage.getItem(WB_WIDTH_KEY));
  if (saved >= 280) {
    const max = Math.round(window.innerWidth * 0.5);
    workbench.style.width = `${Math.min(saved, max)}px`;
  }
}
function resetWorkbench() {
  state.wb.open = false;
  state.wb.preview = null;
  state.wb.activeTab = null;
  state.wb.newTab = null;
  closeBrowserTab(false); // 会话重置：标签容器一并清
  closeTerminalTab(false);
  workbench.classList.remove("open");
}
$("wb-collapse").addEventListener("click", () => closeWorkbench());
$("wb-toggle").addEventListener("click", () => (state.wb.open ? closeWorkbench() : openWorkbench()));

// ---- 标签清单（存在性由各状态推导） ----
function wbTabList() {
  const tabs = [];
  if (state.wb.preview) tabs.push({ id: "file", label: String(state.wb.preview).split(/[\\/]/).pop(), title: state.wb.preview });
  if (termState.active) tabs.push({ id: "terminal", label: "终端", title: termState.cwd || "跟随工作区" });
  if (browserTab.open) tabs.push({ id: "browser", label: browserTab.host || "浏览器", title: browserTab.url });
  if (state.wb.newTab) tabs.push({ id: "newtab", label: "新标签页", title: "新建：终端 / 预览文件 / 浏览器" });
  return tabs;
}
function wbActiveTab() {
  const tabs = wbTabList();
  if (!tabs.length) return null;
  return tabs.some((t) => t.id === state.wb.activeTab) ? state.wb.activeTab : tabs[0].id;
}
function renderTabs() {
  wbTabs.innerHTML = "";
  const tabs = wbTabList();
  const active = wbActiveTab();
  for (const t of tabs) {
    const chip = el("button", "wb-tabchip" + (t.id === active ? " active" : ""));
    chip.title = t.title || t.label;
    const label = el("span", "wb-tabchip-label", t.label);
    const x = el("span", "wb-tabchip-x", "×");
    x.title = "关闭" + (t.id === "file" ? "预览" : t.id === "terminal" ? "终端" : t.id === "newtab" ? "新标签页" : "浏览器标签");
    x.addEventListener("click", (e) => {
      e.stopPropagation();
      closeTab(t.id);
    });
    chip.append(label, x);
    chip.addEventListener("click", () => {
      state.wb.activeTab = t.id;
      renderWorkbench();
    });
    wbTabs.appendChild(chip);
  }
}
function closeTab(id) {
  if (id === "file") {
    state.wb.preview = null;
    state.wb.resolution = null;
  } else if (id === "terminal") {
    closeTerminalTab(true);
  } else if (id === "newtab") {
    closeNewTab();
  } else if (id === "browser") {
    api.browserStop?.().catch(() => {}); // 主进程审计 + 广播 browser_stop → closeBrowserTab
  }
  renderWorkbench();
}

// ---- 面板主体：每标签一块常驻 pane（display 切换，xterm/webview/iframe 状态不丢） ----
const wbPanes = new Map(); // id -> element
function wbPane(id) {
  if (!wbPanes.has(id)) {
    const pane = el("div", "wb-pane");
    wbBody.appendChild(pane);
    wbPanes.set(id, pane);
  }
  return wbPanes.get(id);
}
function renderWorkbench() {
  renderTabs();
  // 空态卡片先清再按需重建：否则每次回到空态都追加一份，在标签下方无限堆叠（面板被越顶越长）
  for (const e of [...wbBody.querySelectorAll(".wb-empty")]) e.remove();
  // 清掉已不存在标签的 pane
  const tabs = wbTabList().map((t) => t.id);
  for (const [id, pane] of wbPanes) {
    if (!tabs.includes(id)) {
      pane.remove();
      wbPanes.delete(id);
    }
  }
  const active = wbActiveTab();
  for (const [id, pane] of wbPanes) pane.classList.toggle("hidden", id !== active);
  wbBody.classList.toggle("has-tabs", !!active);
  if (active === "file") return renderWbPreview(state.wb.preview);
  if (active === "terminal") return renderTerminalPanel();
  if (active === "browser") return renderBrowserTab();
  if (active === "newtab") return renderNewTabPage();
  // 空态：三个入口卡片
  for (const [id, pane] of wbPanes) pane.classList.add("hidden");
  const empty = el("div", "wb-empty");
  const mk = (ic, title, desc, fn) => {
    const card = el("button", "wb-entry-card");
    card.innerHTML = `${icon(ic, 18)}<span class="we-title"></span><span class="we-desc"></span>`;
    card.querySelector(".we-title").textContent = title;
    card.querySelector(".we-desc").textContent = desc;
    card.addEventListener("click", fn);
    return card;
  };
  empty.append(
    mk("terminal", "终端", "跟随工作区的 PowerShell", async () => openTerminalTab()),
    mk("fileText", "预览文件", "从工作区选择文件", () => openNewTab("file")),
    mk("panelRight", "浏览器", "受控打开内网页面", () => openNewTab("browser"))
  );
  wbBody.appendChild(empty);
}

/* ---- 新标签页（＋）：入口三卡片 → 文件选择 / 网址输入；选定后本标签"就地变身"（终端/文件/浏览器），不另开空标签 ---- */
function openNewTab(view = "home") {
  state.wb.newTab = { view };
  state.wb.activeTab = "newtab";
  if (!state.wb.open) openWorkbench();
  else renderWorkbench();
}
function closeNewTab() {
  state.wb.newTab = null;
  if (state.wb.activeTab === "newtab") state.wb.activeTab = null;
  renderWorkbench();
}
function fmtSize(n) {
  if (!Number.isFinite(n) || n <= 0) return "";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
function renderNewTabPage() {
  const pane = wbPane("newtab");
  const view = state.wb.newTab ? state.wb.newTab.view : "home";
  if (pane.dataset.view === view && pane.childElementCount) return; // 同视图不重建：保住搜索词/输入焦点
  pane.dataset.view = view;
  pane.innerHTML = "";
  if (view === "file") return buildFilePick(pane);
  if (view === "browser") return buildUrlPage(pane);
  const wrap = el("div", "wb-newtab home");
  wrap.appendChild(el("div", "wb-nt-heading", "打开新内容"));
  const cards = el("div", "wb-nt-cards");
  const mk = (ic, title, desc, fn) => {
    const card = el("button", "wb-entry-card");
    card.innerHTML = `${icon(ic, 18)}<span class="we-title"></span><span class="we-desc"></span>`;
    card.querySelector(".we-title").textContent = title;
    card.querySelector(".we-desc").textContent = desc;
    card.addEventListener("click", fn);
    return card;
  };
  cards.append(
    mk("terminal", "终端", "跟随工作区的 PowerShell", () => {
      closeNewTab();
      openTerminalTab();
    }),
    mk("fileText", "文件", "预览工作区文件", () => {
      state.wb.newTab.view = "file";
      renderNewTabPage();
    }),
    mk("panelRight", "浏览器", "受控打开内网页面", () => {
      state.wb.newTab.view = "browser";
      renderNewTabPage();
    })
  );
  wrap.append(cards, el("div", "wb-nt-hint", "Esc 关闭本标签"));
  pane.appendChild(wrap);
}
// 文件选择页：按目录分组 + 大小 + 搜索过滤（占满面板，替代旧浮层清单）
function buildFilePick(pane) {
  const wrap = el("div", "wb-newtab pick");
  const bar = el("div", "wb-nt-subbar");
  const back = el("button", "wb-nt-back", "‹ 返回");
  back.title = "返回入口页（Esc）";
  back.addEventListener("click", () => {
    state.wb.newTab.view = "home";
    renderNewTabPage();
  });
  const search = el("input", "wb-nt-search");
  search.type = "search";
  search.placeholder = "搜索文件…";
  bar.append(back, search);
  const list = el("div", "wb-filepick");
  list.appendChild(el("div", "wb-plus-empty", "加载中…"));
  wrap.append(bar, list);
  pane.appendChild(wrap);
  api.getWorkspaceFiles?.().then((files) => {
    if (!list.isConnected) return; // 视图已切走，丢弃过期结果
    // 兼容 string[]（旧桩）与 {path,size}[]（现行主进程）两种返回
    const items = (files || [])
      .map((f) => (typeof f === "string" ? { path: f, size: 0 } : f))
      .filter((f) => f && f.path && !f.path.endsWith("/"))
      .sort((a, b) => a.path.localeCompare(b.path));
    list.innerHTML = "";
    if (!items.length) {
      list.appendChild(el("div", "wb-plus-empty", "工作区暂无文件"));
      return;
    }
    const groups = new Map(); // 目录 -> 文件[]
    for (const f of items) {
      const i = f.path.lastIndexOf("/");
      const dir = i < 0 ? "" : f.path.slice(0, i);
      if (!groups.has(dir)) groups.set(dir, []);
      groups.get(dir).push(f);
    }
    for (const [dir, group] of groups) {
      const sec = el("div", "wb-nt-groupsec");
      sec.appendChild(el("div", "wb-nt-group", dir ? `📁 ${dir}/` : "📁 工作区根目录"));
      for (const f of group) {
        const it = el("button", "wb-file-item");
        const name = f.path.slice(f.path.lastIndexOf("/") + 1);
        it.innerHTML = `${icon("fileText", 13)}<span class="wb-file-name"></span><span class="wb-file-size"></span>`;
        it.querySelector(".wb-file-name").textContent = name;
        it.querySelector(".wb-file-size").textContent = fmtSize(f.size);
        it.title = f.path;
        it.dataset.path = f.path;
        it.addEventListener("click", () => {
          closeNewTab();
          openArtifactPreview(f.path);
        });
        sec.appendChild(it);
      }
      list.appendChild(sec);
    }
    search.addEventListener("input", () => {
      const q = search.value.trim().toLowerCase();
      for (const sec of list.querySelectorAll(".wb-nt-groupsec")) {
        let hit = 0;
        for (const it of sec.querySelectorAll(".wb-file-item")) {
          const ok = !q || it.dataset.path.toLowerCase().includes(q);
          it.classList.toggle("hidden", !ok);
          if (ok) hit++;
        }
        sec.classList.toggle("hidden", hit === 0);
      }
    });
    search.focus();
  });
}
// 网址页：输入即开（用户显式动作，免 L2）+ 最近访问快捷项
function buildUrlPage(pane) {
  const wrap = el("div", "wb-newtab url");
  const bar = el("div", "wb-nt-subbar");
  const back = el("button", "wb-nt-back", "‹ 返回");
  back.title = "返回入口页（Esc）";
  back.addEventListener("click", () => {
    state.wb.newTab.view = "home";
    renderNewTabPage();
  });
  bar.appendChild(back);
  const box = el("div", "wb-nt-urlbox");
  const input = el("input", "wb-nt-url");
  input.type = "text";
  input.placeholder = "输入网址，回车打开（受控）";
  input.spellcheck = false;
  const go = el("button", "wb-edit-btn primary", "打开");
  const err = el("div", "wb-nt-err");
  box.append(input, go);
  wrap.append(bar, box, err);
  const submit = async () => {
    const url = normalizeUrlInput(input.value);
    err.textContent = "";
    if (!url) return;
    try {
      await api.browserOpenUser?.(url);
      recordRecentUrl(url);
      closeNewTab(); // browser_navigate 事件到达后浏览器标签接管面板
    } catch (e) {
      // 剥掉 IPC 包装（"Error invoking remote method 'ordo:…': "），只给用户看人话
      const msg = String(e && e.message ? e.message : e).replace(/^Error invoking remote method '[^']+':\s*/, "");
      err.textContent = msg || "打开失败，请检查网址"; // 打开失败：留在本页，输入不丢
    }
  };
  go.addEventListener("click", submit);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") submit();
  });
  const recents = readRecentUrls();
  if (recents.length) {
    const quick = el("div", "wb-nt-quick");
    quick.appendChild(el("div", "wb-nt-quick-title", "最近访问"));
    for (const u of recents) {
      const chip = el("button", "wb-nt-chip", u.replace(/^https?:\/\//, ""));
      chip.title = u;
      chip.addEventListener("click", () => {
        input.value = u;
        submit();
      });
      quick.appendChild(chip);
    }
    wrap.appendChild(quick);
  }
  pane.appendChild(wrap);
  setTimeout(() => input.focus(), 50);
}
const RECENT_URLS_KEY = "sd.browser.recent";
// 无协议头的裸域名默认按 https 处理（主进程 safeUrl 同规则兜底，含 agent 侧传入）
function normalizeUrlInput(raw) {
  const s = String(raw || "").trim();
  if (!s) return s;
  return /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(s) ? s : `https://${s}`;
}
function readRecentUrls() {
  try {
    const v = JSON.parse(localStorage.getItem(RECENT_URLS_KEY) || "[]");
    return Array.isArray(v) ? v.filter((x) => typeof x === "string").slice(0, 5) : [];
  } catch {
    return [];
  }
}
function recordRecentUrl(url) {
  const list = [url, ...readRecentUrls().filter((u) => u !== url)].slice(0, 5);
  try {
    localStorage.setItem(RECENT_URLS_KEY, JSON.stringify(list));
  } catch {
    /* 存储满/禁用时静默降级 */
  }
}
$("wb-plus").addEventListener("click", () => {
  if (state.wb.newTab) {
    state.wb.newTab.view = "home"; // 已开着就回到入口页复用，不叠开
    state.wb.activeTab = "newtab";
    renderWorkbench();
  } else {
    openNewTab("home");
  }
});

/* ---- 用户侧终端（方案 §6）：node-pty(主进程) + xterm.js 懒加载；cwd 跟随当前工作区 ---- */
const termState = {
  active: false,
  cwd: "",
  term: null,
  fit: null,
  buffer: [],
  exited: false,
};
// app.js 位于 src/renderer/js/，模块相对 node_modules 需三层；以 import.meta.url 显式解析防再错位
const XTERM_URL = new URL("../../../node_modules/@xterm/xterm/lib/xterm.mjs", import.meta.url).href;
const XTERM_FIT_URL = new URL("../../../node_modules/@xterm/addon-fit/lib/addon-fit.mjs", import.meta.url).href;
function termWriteToView(data) {
  if (termState.term) termState.term.write(data);
  else {
    termState.buffer.push(data); // xterm 未就绪时先缓冲，挂载后回放
    if (termState.buffer.length > 200) termState.buffer.shift();
  }
}
async function openTerminalTab() {
  try {
    await api.termOpen?.();
    termState.active = true;
    termState.exited = false;
    state.wb.newTab = null; // 终端接管面板：新标签页就地变身（不叠标签）
    state.wb.activeTab = "terminal";
    if (!state.wb.open) openWorkbench();
    else renderWorkbench();
  } catch {
    termState.active = false;
    renderWorkbench();
  }
}
function closeTerminalTab(callApi) {
  if (callApi) api.termClose?.().catch(() => {});
  termState.active = false;
  termState.exited = false;
  termState.term = null;
  termState.buffer = [];
  if (state.wb.activeTab === "terminal") state.wb.activeTab = null;
}
async function renderTerminalPanel() {
  const pane = wbPane("terminal");
  if (pane.dataset.built === "1" && termState.term) return; // 常驻 pane 只建一次
  pane.dataset.built = "1";
  pane.innerHTML = "";
  const bar = el("div", "wb-tabbar");
  const cwdEl = el("span", "wb-tabbar-path", termState.cwd || "跟随工作区");
  cwdEl.title = termState.cwd || "打开后显示工作区路径";
  const clearBtn = el("button", "wb-icon-btn", icon("refresh", 13));
  clearBtn.title = "清屏";
  clearBtn.addEventListener("click", () => {
    if (termState.term) termState.term.clear();
  });
  const closeBtn = el("button", "wb-icon-btn", icon("close", 13));
  closeBtn.title = "关闭终端";
  closeBtn.addEventListener("click", () => closeTab("terminal"));
  bar.append(cwdEl, clearBtn, closeBtn);
  const mount = el("div", "term-mount");
  pane.append(bar, mount);
  if (termState.exited) {
    const exited = el("div", "term-exited");
    exited.appendChild(el("div", "term-exited-text", "终端已退出"));
    const reopen = el("button", "wb-edit-btn primary", "重新打开");
    reopen.addEventListener("click", async () => {
      termState.exited = false;
      pane.dataset.built = "";
      await openTerminalTab();
    });
    exited.appendChild(reopen);
    mount.appendChild(exited);
    return;
  }
  // 懒加载 xterm（首次约 300KB，不进启动路径）
  let TerminalCtor = window.__xtermCtor || null;
  if (!TerminalCtor) {
    const mod = await import(XTERM_URL);
    TerminalCtor = mod.Terminal;
    window.__xtermCtor = TerminalCtor;
  }
  if (!window.__xtermFitCtor) {
    const fitMod = await import(XTERM_FIT_URL);
    window.__xtermFitCtor = fitMod.FitAddon;
  }
  if (!mount.isConnected) return; // 等待懒加载期间 pane 被后续渲染重建：让位给新容器，避免 xterm 挂进脱离文档的旧节点（假空白）
  if (termState.term || !termState.active) return; // 已挂载或标签已关
  const term = new TerminalCtor({
    cursorBlink: true,
    fontSize: 12,
    fontFamily: "ui-monospace, Consolas, monospace",
    theme: { background: "#1e1e1e", cursor: "#178351", selection: "rgba(23, 131, 81, 0.28)" },
    convertEol: false,
  });
  const fit = new window.__xtermFitCtor();
  term.loadAddon(fit);
  term.open(mount);
  try {
    fit.fit();
  } catch {
    /* 容器尚无尺寸时跳过 */
  }
  termState.term = term;
  termState.fit = fit;
  for (const d of termState.buffer) term.write(d);
  termState.buffer = [];
  term.onData((d) => api.termWrite?.(d));
  term.focus();
  const syncSize = () => {
    if (!mount.offsetParent) return; // 标签隐藏时容器无布局，跳过（避免 ResizeObserver 循环告警）
    try {
      fit.fit();
      api.termResize?.(term.cols, term.rows);
    } catch {
      /* ignore */
    }
  };
  syncSize();
  if (!termState.ro) {
    termState.ro = new ResizeObserver(() => {
      if (termState.term && mount.isConnected) syncSize();
    });
  }
  termState.ro.observe(mount);
  api.termState?.().then((st) => {
    if (st && st.cwd) {
      termState.cwd = st.cwd;
      cwdEl.textContent = st.cwd;
      cwdEl.title = st.cwd;
    }
  });
}

/* ---- 浏览器标签（方案 §5 内嵌 webview）：页面 + 工具条（急停/控制台开关）+ 控制台子面板 ---- */
const browserTab = {
  open: false,
  url: "",
  host: "",
  view: null, // <webview> 常驻节点（标签间切换不重建）
  consoleOpen: true,
};
function ensureBrowserView() {
  if (browserTab.view && browserTab.view.isConnected) return browserTab.view;
  const view = document.createElement("webview");
  view.className = "wb-webview";
  view.setAttribute("partition", "persist:ordo-browser");
  view.setAttribute("allowpopups", "no");
  view.addEventListener("dom-ready", () => {
    try {
      api.browserAttach?.(view.getWebContentsId()).catch(() => {});
    } catch {
      /* getWebContentsId 未就绪时忽略 */
    }
  });
  browserTab.view = view;
  return view;
}
function closeBrowserTab(keepMainState) {
  browserTab.open = false;
  browserTab.url = "";
  browserTab.host = "";
  if (browserTab.view) {
    browserTab.view.__resObs?.disconnect();
    browserTab.view.remove();
    browserTab.view = null;
  }
  if (state.wb.activeTab === "browser") state.wb.activeTab = null;
  if (!keepMainState) renderWorkbench();
}
function navigateBrowserTab(url) {
  let host = "";
  try {
    host = new URL(url).host || "";
  } catch {
    host = "";
  }
  browserTab.open = true;
  browserTab.url = url;
  browserTab.host = host;
  state.wb.newTab = null; // 浏览器接管面板：新标签页就地变身（不叠标签）
  state.wb.activeTab = "browser"; // 导航即聚焦浏览器标签
  if (!state.wb.open) openWorkbench();
  else renderWorkbench();
  const view = ensureBrowserView();
  const pane = wbPane("browser");
  // renderBrowserTab 已建容器；此处仅在实际导航时挂 view 并设 src
  const holder = pane.querySelector(".wb-webview-holder");
  if (holder && !view.isConnected) {
    holder.appendChild(view);
    observeWbHolderResize(holder, view); // webview 不总跟随 flex 容器缩放：显式同步像素尺寸
  }
  if (view.getAttribute("src") !== url) view.setAttribute("src", url);
}

// 面板拖宽/收起/控制台开合时 holder 尺寸变化 → 显式回写 webview 尺寸（部分 Electron 版本 flex 不触发 webview 内部重排）
function observeWbHolderResize(holder, view) {
  if (view.__resObs) view.__resObs.disconnect();
  const ro = new ResizeObserver(() => {
    view.style.width = holder.clientWidth + "px";
    view.style.height = holder.clientHeight + "px";
  });
  ro.observe(holder);
  view.__resObs = ro;
}
function renderBrowserTab() {
  const pane = wbPane("browser");
  if (pane.dataset.built === "1") {
    refreshBrowserToolbar(pane);
    return;
  }
  pane.dataset.built = "1";
  pane.innerHTML = "";
  const bar = el("div", "wb-tabbar");
  const urlEl = el("span", "wb-tabbar-path", browserTab.url || "（未打开）");
  urlEl.title = browserTab.url;
  const consoleBtn = el("button", "wb-icon-btn", icon("listTodo", 13));
  consoleBtn.title = "显示/隐藏控制台";
  consoleBtn.addEventListener("click", () => {
    browserTab.consoleOpen = !browserTab.consoleOpen;
    const c = pane.querySelector(".wb-console");
    if (c) c.classList.toggle("hidden", !browserTab.consoleOpen);
  });
  const stopBtn = el("button", "wb-icon-btn danger", icon("xCircle", 13));
  stopBtn.title = "急停：关闭受控页面并重置批准源（已审计）";
  stopBtn.addEventListener("click", () => {
    api.browserStop?.().catch(() => {}); // 主进程审计 + browser_stop 广播 → closeBrowserTab
  });
  bar.append(urlEl, consoleBtn, stopBtn);
  const holder = el("div", "wb-webview-holder");
  pane.append(bar, holder);
  // 控制台子面板
  const consoleWrap = el("div", "wb-console" + (browserTab.consoleOpen ? "" : " hidden"));
  pane.append(holder, consoleWrap);
  refreshBrowserConsole(pane);
  api.browserConsoleTail?.(50).then((rows) => {
    browserState.consoleRows = rows || [];
    refreshBrowserConsole(pane);
  });
}
function refreshBrowserToolbar(pane) {
  const urlEl = pane.querySelector(".wb-tabbar-path");
  if (urlEl) {
    urlEl.textContent = browserTab.url || "（未打开）";
    urlEl.title = browserTab.url;
  }
}
function refreshBrowserConsole(pane) {
  const wrap = pane ? pane.querySelector(".wb-console") : wbPanes.get("browser")?.querySelector(".wb-console");
  if (!wrap) return;
  wrap.innerHTML = "";
  const rows = browserState.consoleRows || [];
  if (!rows.length) {
    wrap.appendChild(el("div", "wb-console-empty", "暂无输出（页面 console 与错误会实时出现在这里）"));
    return;
  }
  for (const c of rows.slice(-50).reverse()) {
    const row = el("div", "wb-console-row " + String(c.kind || "log"));
    const time = String(c.at || "").slice(11, 19);
    row.innerHTML = `<span class="wc-time"></span><span class="wc-kind"></span><span class="wc-text"></span>`;
    row.querySelector(".wc-time").textContent = time;
    row.querySelector(".wc-kind").textContent = String(c.kind || "log");
    row.querySelector(".wc-text").textContent = String(c.text || "");
    row.title = String(c.text || "");
    wrap.appendChild(row);
  }
}
const browserState = {
  active: false,
  url: "",
  consoleRows: [],
};
async function refreshBrowserPanel() {
  try {
    const st = await api.browserState?.();
    browserState.active = !!(st && st.open);
    browserState.url = st ? st.url : "";
    browserState.consoleRows = (await api.browserConsoleTail?.(50)) || [];
  } catch {
    /* 主进程未扩展时静默降级 */
  }
  refreshBrowserConsole(wbPanes.get("browser"));
}

/* ---- HTML 预览分辨率预设（方案 §4 v1）：iframe 宽度真实（媒体查询如实生效），等比缩放塞入面板 ---- */
const WB_RESOLUTIONS = [375, 768, 1280, 1920];
function applyResolution(holder, frame, resBar) {
  const width = state.wb.resolution; // null = 自适应面板宽
  holder.querySelectorAll(".wb-res-btn").forEach((b) => b.classList.toggle("active", Number(b.dataset.w) === (width ?? 0) || (b.dataset.w === "fit" && width == null)));
  const scaler = holder.querySelector(".wb-res-scaler");
  if (!scaler) return;
  if (width == null) {
    scaler.style.width = "";
    scaler.style.transform = "";
    frame.style.height = "";
    const label = holder.querySelector(".wb-res-label");
    if (label) label.textContent = ""; // 自适应：清掉上一次预设残留的「宽 · %」
    return;
  }
  const avail = scaler.parentElement.clientWidth - 2; // 边框余量
  if (avail <= 0) {
    // 面板不可见/零宽（最小化、隐藏窗口测量）：不缩放（等价自适应），避免负/零 scale 把内容算没
    scaler.style.width = "";
    scaler.style.transform = "";
    frame.style.height = "";
    return;
  }
  const scale = Math.min(1, avail / width);
  scaler.style.width = `${width}px`;
  scaler.style.transform = `scale(${scale})`;
  scaler.style.transformOrigin = "top left";
  // 高度补偿：iframe 按面板可视高度 / 缩放比 撑满，避免缩放后下方留白
  const availH = scaler.parentElement.clientHeight - 2;
  frame.style.height = `${Math.round(availH / scale)}px`;
  const label = holder.querySelector(".wb-res-label");
  if (label) label.textContent = `${width}px · ${Math.round(scale * 100)}%`;
}
function buildResBar(holder, frame) {
  const bar = el("div", "wb-res-bar");
  for (const w of WB_RESOLUTIONS) {
    const b = el("button", "wb-res-btn", String(w));
    b.dataset.w = String(w);
    b.title = `${w}px 等比缩放塞入面板（媒体查询按真实宽度生效）`;
    b.addEventListener("click", () => {
      state.wb.resolution = w;
      applyResolution(holder, frame, bar);
    });
    bar.appendChild(b);
  }
  const fit = el("button", "wb-res-btn active", "自适应");
  fit.dataset.w = "fit";
  fit.title = "跟随面板宽度";
  fit.addEventListener("click", () => {
    state.wb.resolution = null;
    applyResolution(holder, frame, bar);
  });
  bar.appendChild(fit);
  const custom = el("input", "wb-res-input");
  custom.type = "number";
  custom.min = "200";
  custom.max = "3840";
  custom.placeholder = "自定义";
  custom.title = "自定义宽度（px）";
  custom.addEventListener("change", () => {
    const v = Number(custom.value);
    if (v >= 200 && v <= 3840) {
      state.wb.resolution = Math.round(v);
      applyResolution(holder, frame, bar);
    }
  });
  bar.appendChild(custom);
  bar.appendChild(el("span", "wb-res-label", ""));
  return bar;
}

function renderWbPreview(path) {
  const pane = wbPane("file");
  if (pane.dataset.path === String(path)) return; // 同一文件：保留已有预览状态（iframe/编辑器/滚动位置）
  pane.dataset.path = String(path);
  pane.innerHTML = "";
  const holder = el("div", "wb-preview-body", "加载中…");
  pane.appendChild(holder);
  Promise.resolve(api.readFilePreview?.(path) ?? null)
    .then((r) => {
      holder.innerHTML = "";
      if (!r) {
        const lower = String(path).toLowerCase();
        const msg = /\.(doc|xls)$/.test(lower)
          ? "老版二进制格式（.doc/.xls）暂不支持预览，请转存为新格式（.docx/.xlsx）后重试。"
          : "该文件类型暂不支持预览（或超过大小上限）。支持：文本/Markdown、HTML、图片（png/jpg/gif/webp/bmp/ico/svg）、PDF、Office（docx/xlsx/pptx）。";
        holder.appendChild(el("div", "md-text", msg));
        return;
      }
      if (r.kind === "text") {
        renderTextPreview(holder, path, r.content);
      } else if (r.kind === "html") {
        const bar = el("div", "wb-preview-tabs");
        const btnEff = el("button", "wb-preview-tab active", "效果");
        const btnSrc = el("button", "wb-preview-tab", "源码");
        const btnBr = el("button", "wb-preview-tab", "在浏览器打开");
        btnBr.title = "在浏览器标签完整渲染：脚本与外部网络全放开（用户显式动作视为授权；本地文件，注意内容来源可信）";
        btnBr.addEventListener("click", async () => {
          try {
            const info = await Promise.resolve(api.getWorkspaceInfo?.() ?? null);
            const root = String(info?.root ?? "").replace(/\\/g, "/").replace(/\/+$/, "");
            const rel = String(path).replace(/\\/g, "/").replace(/^\.\//, "").replace(/^\/+/, "");
            navigateBrowserTab(`file:///${root}/${rel}`);
            toast("已在浏览器标签打开（完整脚本与网络）");
          } catch (e) {
            toast(String((e && e.message) || e));
          }
        });
        bar.append(btnEff, btnSrc, btnBr);
        holder.append(bar, el("div", "wb-preview-hint", "沙箱交互渲染：脚本已启用（无站点权限，与主窗口隔离）；外部网络资源仍被拦截"));
        const frame = document.createElement("iframe");
        frame.className = "wb-preview-frame";
        // allow-scripts 且绝不给 allow-same-origin：opaque 源沙箱——脚本可跑（交互式产物），
        // 但无 cookie/localStorage/父窗口 DOM 访问（无站点权限）；top-navigation/popups/表单默认仍禁
        frame.setAttribute("sandbox", "allow-scripts");
        // CSP：放行内联脚本与样式（交互渲染），外部网络资源仍全部掐断（CDN 脚本/图片/字体不可达）
        frame.srcdoc = withPreviewCsp(r.content);
        const resBar = buildResBar(holder, frame);
        const scalerWrap = el("div", "wb-res-wrap");
        const scaler = el("div", "wb-res-scaler");
        scaler.appendChild(frame);
        scalerWrap.appendChild(scaler);
        const src = el("div", "md-text wb-preview-src hidden");
        src.innerHTML = renderMarkdown("```html\n" + r.content + "\n```");
        holder.append(resBar, scalerWrap, src);
        requestAnimationFrame(() => applyResolution(holder, frame, resBar));
        pane.__wbResObs?.disconnect(); // 面板拖宽/收起时重算等比缩放
        pane.__wbResObs = new ResizeObserver(() => applyResolution(holder, frame, resBar));
        pane.__wbResObs.observe(scalerWrap);
        const showEff = () => { btnEff.classList.add("active"); btnSrc.classList.remove("active"); scalerWrap.classList.remove("hidden"); src.classList.add("hidden"); };
        const showSrc = () => { btnSrc.classList.add("active"); btnEff.classList.remove("active"); src.classList.remove("hidden"); scalerWrap.classList.add("hidden"); };
        btnEff.addEventListener("click", showEff);
        btnSrc.addEventListener("click", showSrc);
      } else if (r.kind === "image") {
        const img = document.createElement("img");
        img.className = "wb-preview-img";
        img.src = r.dataUrl; // SVG 经 <img> 加载不执行脚本
        img.alt = String(path).split(/[\\/]/).pop();
        holder.append(img, el("div", "wb-preview-hint", `${r.mime} · ${formatSize(r.bytes)}`));
      } else if (r.kind === "pdf") {
        const frame = document.createElement("iframe");
        frame.className = "wb-preview-frame";
        frame.src = r.dataUrl; // Chromium 内置 PDF 查看器，data: 无脚本风险
        holder.append(frame, el("div", "wb-preview-hint", `PDF · ${formatSize(r.bytes)}`));
      } else if (r.kind === "office") {
        // Office 预览为只读渲染：手工细调给「用系统应用打开」兜底（方案 A 边界）
        const bar = el("div", "wb-preview-tabs");
        const openSys = el("button", "wb-preview-tab", "用系统应用打开");
        openSys.title = "调用系统默认关联程序编辑（Word/WPS 等）";
        openSys.addEventListener("click", () => api.openPath?.(path).catch(() => {}));
        bar.appendChild(openSys);
        holder.appendChild(bar);
        renderOfficePreview(holder, path, r);
      }    })
    .catch(() => {
      holder.innerHTML = "";
      holder.appendChild(el("div", "md-text", "预览加载失败"));
    });
}

/* ---- HTML/Office 预览公共：CSP 与沙箱容器（方案 §1/§2.1，§8 不可信内容只进沙箱） ---- */
// HTML 交互渲染：脚本放行（内联），外联仍全禁（无任何远程源）；样式/图片限内联与 data
const PREVIEW_CSP = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:";
// Office 渲染产物可能带内嵌字体/图片，放宽 font/blob（仍无任何外联与脚本）
const OFFICE_CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:";
// 注入位置：有 <head> 进 head，否则 <html> 后，再否则文档头（CSP meta 需在触发加载的内容之前）
function withCsp(html, csp) {
  const meta = `<meta http-equiv="Content-Security-Policy" content="${csp}">`;
  if (/<head[^>]*>/i.test(html)) return html.replace(/<head[^>]*>/i, (m) => m + meta);
  if (/<html[^>]*>/i.test(html)) return html.replace(/<html[^>]*>/i, (m) => m + meta);
  return meta + html;
}
function withPreviewCsp(html) {
  return withCsp(html, PREVIEW_CSP);
}

/* ---- Office 预览（方案 §2.1）：docx=docx-preview（沙箱 iframe）+mammoth 降级 / xlsx=SheetJS 自渲染 / pptx=pptx-viewer（沙箱 iframe，全部幻灯片纵向排布） ---- */
const OFFICE_LIBS = {
  docx: ["docx-preview/dist/docx-preview.min.js", "mammoth/mammoth.browser.min.js"],
  xlsx: ["xlsx/dist/xlsx.full.min.js"],
  pptx: ["pptx-viewer/dist/pptx-viewer.umd.js"],
};
const OFFICE_META = {
  docx: { label: "Word 文档", note: "常规版式预览；复杂元素保真受限" },
  xlsx: { label: "Excel 工作簿", note: "值网格预览" },
  pptx: { label: "PPT 幻灯片", note: "版式预览；SmartArt/嵌入图表等保真受限" },
};
const officeLibCache = new Map();
function loadOfficeScripts(format) {
  const jobs = (OFFICE_LIBS[format] || []).map((rel) => {
    if (!officeLibCache.has(rel)) {
      officeLibCache.set(
        rel,
        new Promise((resolve, reject) => {
          const s = document.createElement("script");
          s.src = `../../node_modules/${rel}`;
          s.onload = () => resolve();
          s.onerror = () => {
            officeLibCache.delete(rel);
            reject(new Error(rel));
          };
          document.head.appendChild(s);
        })
      );
    }
    return officeLibCache.get(rel);
  });
  return Promise.all(jobs);
}
function dataUrlBytes(dataUrl) {
  const b64 = String(dataUrl).split(",")[1] || "";
  const bin = atob(b64);
  const u8 = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
  return u8;
}
function bytesToB64(u8) {
  let s = "";
  const CH = 0x8000; // 分块避免 String.fromCharCode 参数上限
  for (let i = 0; i < u8.length; i += CH) s += String.fromCharCode.apply(null, u8.subarray(i, i + CH));
  return btoa(s);
}

/* ---- 文本编辑器（方案 §2.3 第一层：md/txt/csv；保存=显式动作，审计 user_edit，不二次弹确认） ---- */
const TEXT_EDITABLE = /\.(md|txt|csv)$/i;
function renderTextPreview(holder, path, content) {
  const bar = el("div", "wb-edit-bar");
  const btnEdit = el("button", "wb-edit-btn", `${icon("pencil", 12)}编辑`);
  const status = el("span", "wb-edit-status");
  bar.append(btnEdit, status);
  const view = el("div", "md-text");
  view.innerHTML = renderMarkdown(content);
  holder.append(bar, view);
  if (!TEXT_EDITABLE.test(String(path))) {
    btnEdit.disabled = true;
    btnEdit.title = "编辑仅支持 md/txt/csv";
    return;
  }
  btnEdit.addEventListener("click", () => {
    const ta = document.createElement("textarea");
    ta.className = "wb-edit-area";
    ta.value = content;
    ta.spellcheck = false;
    const btnSave = el("button", "wb-edit-btn primary", `${icon("check", 12)}保存`);
    const btnCancel = el("button", "wb-edit-btn", "取消");
    const bar2 = el("div", "wb-edit-bar");
    bar2.append(btnSave, btnCancel, el("span", "wb-edit-hint", "保存直接写入文件并记审计（user_edit）"));
    view.classList.add("hidden");
    holder.append(bar2, ta);
    btnCancel.addEventListener("click", () => {
      bar2.remove();
      ta.remove();
      view.classList.remove("hidden");
    });
    btnSave.addEventListener("click", async () => {
      btnSave.disabled = true;
      try {
        await api.saveFileEdit?.(String(path), { text: ta.value });
        content = ta.value;
        status.textContent = `已保存 · ${new Date().toLocaleTimeString()}`;
        view.innerHTML = renderMarkdown(content);
        btnCancel.click();
      } catch (e) {
        status.textContent = "保存失败：" + String(e && e.message ? e.message : e);
        btnSave.disabled = false;
      }
    });
  });
}
function makeOfficeFrame() {
  const frame = document.createElement("iframe");
  frame.className = "wb-preview-frame wb-office-frame";
  // 与 HTML 预览同策略：allow-same-origin 仅为父页注入渲染产物；永不加 allow-scripts
  frame.setAttribute("sandbox", "allow-same-origin");
  frame.srcdoc = withCsp(
    `<!doctype html><html><head></head><body></body></html>`,
    OFFICE_CSP
  ).replace("</head>", "<style>html,body{margin:0}body{padding:14px;overflow:auto}</style></head>");
  return frame;
}
function frameDocReady(frame) {
  // 必须等 load：iframe 初始就有一个带 body 的空文档，srcdoc 加载会整体换新文档，
  // 提前返回会把渲染产物写进随即被丢弃的旧文档（表现为沙箱空白）
  return new Promise((resolve) => {
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      resolve(frame.contentDocument);
    };
    frame.addEventListener("load", done, { once: true });
    setTimeout(done, 2000); // 兜底：load 竞态时不悬挂
  });
}
async function renderOfficePreview(holder, path, r) {
  holder.innerHTML = "";
  const meta = OFFICE_META[r.format] || { label: r.format, note: "" };
  holder.appendChild(el("div", "wb-preview-hint", `${meta.label} · ${formatSize(r.bytes)}${meta.note ? " · " + meta.note : ""}`));
  const body = el("div", "wb-office-body", "解析中…");
  holder.appendChild(body);
  // 保真主路径：OfficeCLI view html 的单文件产物（主进程已剥脚本）——直接进无脚本沙箱，
  // 版式/字体/表格/公式计算结果都在；引擎不可用/失败时 r.html 缺省走下方降级链
  if (r.html) {
    body.innerHTML = "";
    const frame = document.createElement("iframe");
    frame.className = "wb-preview-frame wb-office-frame";
    frame.setAttribute("sandbox", "allow-same-origin"); // 永不加 allow-scripts
    frame.srcdoc = withCsp(r.html, OFFICE_CSP);
    body.appendChild(frame);
    return;
  }
  try {
    await loadOfficeScripts(r.format);
  } catch (e) {
    body.innerHTML = "";
    body.appendChild(el("div", "md-text", `预览组件加载失败（${String(e && e.message ? e.message : e)}），请重试或联系管理员。`));
    return;
  }
  const bytes = dataUrlBytes(r.dataUrl);
  try {
    if (r.format === "docx") await renderDocxPreview(body, bytes);
    else if (r.format === "xlsx") renderXlsxPreview(body, bytes, path);
    else await renderPptxPreview(body, bytes);
  } catch (e) {
    body.innerHTML = "";
    body.appendChild(el("div", "md-text", `该文件解析失败，无法预览（${String(e && e.message ? e.message : "格式异常")}）。`));
  }
}
async function renderDocxPreview(body, bytes) {
  const frame = makeOfficeFrame();
  body.innerHTML = "";
  body.appendChild(frame);
  const doc = await frameDocReady(frame);
  if (!doc || !doc.body) throw new Error("沙箱容器未就绪");
  try {
    await window.docx.renderAsync(bytes, doc.body, doc.head, { inWrapper: true });
  } catch {
    // docx-preview 保真渲染失败 → mammoth 语义化 HTML 降级（方案 §2.1；仍渲染在沙箱内）
    doc.body.innerHTML = "";
    const res = await window.mammoth.convertToHtml({ arrayBuffer: bytes.buffer });
    doc.body.innerHTML = res.value || "（文档无文本内容）";
  }
}
function renderXlsxPreview(body, bytes) {
  // 只读值网格（降级链用；主路径为 OfficeCLI 保真 HTML）：页签切换 + 合并单元格展示，无编辑交互
  const XLSX = window.XLSX;
  const wb = XLSX.read(bytes, { type: "array" });
  const names = wb.SheetNames || [];
  if (!names.length) throw new Error("无工作表");
  body.innerHTML = "";
  const tabsBar = el("div", "wb-sheet-bar");
  const tabs = el("div", "wb-sheet-tabs");
  tabsBar.appendChild(tabs);
  const grid = el("div", "wb-sheet-grid");
  body.append(tabsBar, grid, el("div", "wb-preview-hint", "只读预览（修改请交给 agent，或用系统应用打开）"));
  let active = 0;
  const draw = () => {
    grid.innerHTML = "";
    const sheet = wb.Sheets[names[active]];
    const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: false, defval: "" });
    const merges = sheet["!merges"] || [];
    const covered = new Set();
    for (const m of merges) {
      for (let rr = m.s.r; rr <= m.e.r; rr++) {
        for (let cc = m.s.c; cc <= m.e.c; cc++) {
          if (rr !== m.s.r || cc !== m.s.c) covered.add(rr + "," + cc);
        }
      }
    }
    const table = document.createElement("table");
    rows.forEach((row, ri) => {
      const tr = document.createElement("tr");
      row.forEach((_v, ci) => {
        if (covered.has(ri + "," + ci)) return; // 合并覆盖格不渲染
        const td = document.createElement("td");
        const merge = merges.find((m) => m.s.r === ri && m.s.c === ci);
        if (merge) {
          if (merge.e.r > merge.s.r) td.rowSpan = merge.e.r - merge.s.r + 1;
          if (merge.e.c > merge.s.c) td.colSpan = merge.e.c - merge.s.c + 1;
        }
        td.textContent = String(row[ci] ?? "");
        td.title = XLSX.utils.encode_cell({ r: ri, c: ci });
        tr.appendChild(td);
      });
      table.appendChild(tr);
    });
    if (!rows.length) table.appendChild(document.createElement("tr"));
    grid.appendChild(table);
    [...tabs.children].forEach((b, i) => b.classList.toggle("active", i === active));
  };
  names.forEach((n, i) => {
    const b = el("button", "wb-sheet-tab" + (i === 0 ? " active" : ""), n);
    b.addEventListener("click", () => {
      active = i;
      draw();
    });
    tabs.appendChild(b);
  });
  draw();
}
async function renderPptxPreview(body, bytes) {
  const frame = makeOfficeFrame();
  body.innerHTML = "";
  body.appendChild(frame);
  const doc = await frameDocReady(frame);
  if (!doc || !doc.body) throw new Error("沙箱容器未就绪");
  // 自渲染 API 逐页画进沙箱（纵向排布，滚动即翻页）——不用 viewer 自带控件：沙箱内脚本禁用，控件事件不会触发
  const presentation = await window.PPTXViewer.loadPresentation(bytes.buffer);
  const slides = presentation.slides || [];
  if (!slides.length) throw new Error("无幻灯片");
  for (let i = 0; i < slides.length; i++) {
    const slide = doc.createElement("div");
    slide.className = "wb-pptx-slide";
    doc.body.appendChild(slide);
    window.PPTXViewer.renderSlideToElement(presentation, i, slide);
  }
}
function registerArtifact(_path, _quiet) {
  // 交付物入口归浮标浮层（方案 D4）：只登记，不自动展开面板、不再有角标
  const name = String(_path).split(/[\\/]/).pop();
  state.artifacts.set(String(_path), { name });
  if (bubblePop) renderBubblePop(); // 浮层开着时同步清单
}
// 交付卡/浮层「预览」入口：打开右侧预览面板
function openArtifactPreview(path) {
  state.wb.preview = path;
  state.wb.resolution = null; // 新文件重置分辨率预设
  state.wb.newTab = null; // 文件接管面板：新标签页就地变身（不叠标签）
  state.wb.activeTab = "file"; // 打开交付物即聚焦文件标签
  openWorkbench();
}
// 「打开位置」：系统文件管理器定位（主进程 shell.showItemInFolder，跨平台）。
// ok:false = 文件与所在目录都已不存在（历史卡片的常见场景：暂存目录已被后续操作清理/搬走）——明示，不静默
async function revealArtifact(path) {
  try {
    const r = await api.revealFile?.(path);
    if (r && r.ok === false) toast(`文件已不在原位置（可能已被后续操作移动或清理）：${path}`);
  } catch {}
}

/* ============ 悬浮进度浮标（方案 §3，D3 语义：计划进度，非工具步骤） ============
   收缩态：计划 done/total · 当前项；待确认时呼吸高亮；无计划任务泛化状态；空闲小圆点。
   展开浮层：计划清单（✓/▸/○）+ 交付物（点击进预览）；不放工具时间线（保留在对话流折叠组）。 */
const bubbleEl = $("progress-bubble");
let bubblePop = null;
function bubbleCurrentText(steps) {
  const running = steps.find((s) => s.status === "running");
  if (running) return running.text;
  const next = steps.find((s) => s.status === "pending");
  if (next) return next.text;
  const last = steps[steps.length - 1];
  return last ? last.text : "";
}
function refreshBubble() {
  const b = state.bubble;
  const total = b.steps.length;
  const done = b.steps.filter((s) => s.status === "done").length;
  const status = state.status || "idle"; // 顶栏状态已并入：就绪/执行中/等待确认
  let mode = "idle";
  let label = "";
  let tip = "就绪";
  if (status === "awaiting_confirm") {
    mode = b.error ? "error" : "running";
    label = total ? `计划 ${done}/${total} · 等待确认` : "等待确认";
    tip = "等待确认";
  } else if (status === "streaming") {
    const secs = state.runStart ? Math.round((Date.now() - state.runStart) / 1000) : 0;
    mode = b.error ? "error" : "running";
    if (total) label = `计划 ${done}/${total} · ${bubbleCurrentText(b.steps)}`;
    else label = b.error ? "任务出错" : `执行中 ${secs}s`;
    tip = label;
  } else if (b.error) {
    mode = "error";
    label = total ? `计划 ${done}/${total} · 出错` : "任务出错";
    tip = label;
  } else if (total) {
    mode = "done";
    label = `计划 ${done}/${total} · 已完成`;
    tip = label;
  } else if (b.ranOnce) {
    mode = "done";
    label = "已完成";
    tip = label;
  } else {
    mode = "idle"; // 空闲：与其他状态同构的安静胶囊（绿点静止 + 「就绪」）
    label = "就绪";
  }
  bubbleEl.className = mode + (state.pendingConfirm || status === "awaiting_confirm" ? " confirm" : "");
  bubbleEl.querySelector(".pb-label").textContent = label;
  bubbleEl.title = tip;
  if (bubblePop) renderBubblePop(); // 浮层开着时同步清单
}
function renderBubblePop() {
  if (!bubblePop) return;
  bubblePop.innerHTML = "";
  if (state.bubble.steps.length) {
    bubblePop.appendChild(el("div", "pb-pop-title", "计划"));
    for (const s of state.bubble.steps) {
      const row = el("div", "pb-step " + s.status);
      row.innerHTML =
        `<span class="ps-icon">${icon(s.status === "running" ? "loader" : s.status === "done" ? "checkCircle" : "circle", 13, s.status === "running" ? "spinner" : "")}</span>` +
        `<span class="ps-text"></span>`;
      row.querySelector(".ps-text").textContent = s.text;
      bubblePop.appendChild(row);
    }
  } else {
    bubblePop.appendChild(el("div", "pb-pop-empty", state.bubble.ranOnce ? "本任务无计划清单" : "任务开始后显示计划进度"));
  }
  bubblePop.appendChild(el("div", "pb-pop-title", `交付物 · ${state.artifacts.size}`));
  if (!state.artifacts.size) {
    bubblePop.appendChild(el("div", "pb-pop-empty", "暂无交付物"));
  } else {
    for (const [p, it] of state.artifacts) {
      const item = el("button", "pb-file");
      item.innerHTML = `${icon("fileText", 14)}<span class="f-main"><span class="f-name"></span><span class="f-path"></span></span>`;
      item.querySelector(".f-name").textContent = it.name;
      item.querySelector(".f-path").textContent = p;
      item.addEventListener("click", (e) => {
        e.stopPropagation(); // 阻断到浮标本体的切换逻辑（否则关了又立刻重开）
        closeBubblePop();
        openArtifactPreview(p); // 交付物入口归浮层（方案 D4）
      });
      bubblePop.appendChild(item);
    }
  }
}
function closeBubblePop() {
  if (bubblePop) {
    bubblePop.remove();
    bubblePop = null;
  }
}
bubbleEl.addEventListener("click", (e) => {
  e.stopPropagation();
  if (bubblePop) return closeBubblePop();
  bubblePop = el("div", "pb-pop");
  renderBubblePop();
  bubbleEl.appendChild(bubblePop);
});
document.addEventListener("click", (e) => {
  if (bubblePop && !bubbleEl.contains(e.target)) closeBubblePop();
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && bubblePop) closeBubblePop();
});

function closeDrawer() {
  if (state.drawer) {
    state.drawer.close();
    state.drawer = null;
    return true;
  }
  return false;
}

/* ============ 企业管控市场（技能市场 / 自动化 / 知识库 / 专家） ============
   调研对齐：WorkBuddy 技能市场（「市场推荐 + 已安装」分区、启停不卸载、AI 创建 / 上传导入、
   非官方来源安全警示）、M365 Copilot Agent Store（企业内仅管理端批准项可见）、
   钉钉 / 企业微信 / 飞书（可见范围、员工自建需审核、企业总开关管控）。
   展示形态：侧栏内视图切换（VS Code 扩展视图 / WorkBuddy 侧栏板块同款），不用浮层抽屉。
   Ordo 映射：企业市场 = 管理端统一下发（员工仅可启停）；我的 = 员工个人自建（受管理端总开关管控，
   上架共享需管理员审核）。契约扩展演示：setResourceEnabled(module, id, enabled)。 */
let activeModule = null;
let moduleCtx = null;

function setNavActive(key) {
  for (const b of document.querySelectorAll(".side-nav button")) {
    b.classList.toggle("active", b.dataset.module === key);
  }
}

function closeModuleView() {
  activeModule = null;
  moduleCtx = null;
  state.moduleRerender = null;
  $("module-page").classList.add("hidden");
  $("chat-pane").classList.remove("hidden");
  $("workbench").classList.remove("hidden");
  setNavActive(null);
}

function toggleModule(key) {
  if (activeModule === key) {
    closeModuleView(); // 再点同一模块返回对话（GPT 商店同款关闭语义）
  } else {
    openModules[key]();
  }
}

function rebuildModule() {
  if (!moduleCtx) return;
  const { key, title, noteText, builder, opts } = moduleCtx;
  showModuleView(key, title, noteText, builder, opts);
}

function showModuleView(key, title, noteText, builder, opts = {}) {
  activeModule = key;
  moduleCtx = { key, title, noteText, builder, opts };
  state.moduleRerender = rebuildModule;
  $("chat-pane").classList.add("hidden");
  $("workbench").classList.add("hidden");
  $("module-page").classList.remove("hidden");
  setNavActive(key);
  $("mv-title").textContent = title;
  // 返回按钮：默认图标+悬浮提示「返回对话」；opts.backTitle 时显示文字标签（设置页=返回工作区）
  const backLabel = $("mv-back-label");
  backLabel.textContent = opts.backTitle ?? "";
  $("mv-back").classList.toggle("has-label", !!opts.backTitle);
  $("mv-back").title = opts.backTitle ?? "返回对话";
  const body = $("mv-body");
  body.innerHTML = "";
  const searchWrap = $("mkp-search");
  searchWrap.innerHTML = "";
  let input = null;
  if (opts.search !== false) {
    input = document.createElement("input");
    input.type = "text";
    input.placeholder = "搜索…";
    input.autocomplete = "off";
    searchWrap.appendChild(input);
  }
  const foot = $("mv-foot");
  foot.innerHTML = "";
  foot.style.display = noteText ? "" : "none"; // 设置页无页脚说明，整条隐藏
  // 页脚只保留说明文案：原「向管理员申请」按钮是无上下文的演示占位（点击谎称已发送），
  // 等管理端就绪后按设计稿做成资源卡片级的真申请流（申请使用某技能/连接器）再上
  const apply = el("div", "mk-apply");
  const note = document.createElement("span");
  note.textContent = noteText;
  apply.appendChild(note);
  foot.appendChild(apply);
  builder(body, input);
}

$("mv-back").addEventListener("click", closeModuleView);

function mkSection(label, hint) {
  const s = el("div", "mk-section");
  s.textContent = label;
  if (hint) {
    const h = el("span", "mk-hint");
    h.textContent = hint;
    s.appendChild(h);
  }
  return s;
}

function mkGrid(parent) {
  const g = el("div", "mk-grid");
  parent.appendChild(g);
  return g;
}

function mkCard(cfg) {
  // cfg: { module, id, icon, title, desc, mine, version, enabled, adminDisabled, perms, permsLabel, noSwitch, stateText, onClick, onDelete }
  const off = cfg.enabled === false;
  const item = el("div", "mk-card" + (off || cfg.adminDisabled ? " off" : "") + (cfg.onClick ? " clickable" : ""));
  const tags = [];
  if (cfg.adminDisabled) tags.push(`<span class="tag-off">管理员已停用</span>`);
  if (cfg.tag) tags.push(`<span class="tag-ent">${cfg.tag}</span>`);
  else tags.push(cfg.mine ? `<span class="tag-mine">个人</span>` : `<span class="tag-ent">企业</span>`);
  if (cfg.version) tags.push(`<span class="tag-ver">${cfg.version}</span>`);
  item.innerHTML =
    `<div class="mk-top">` +
    `<span class="mk-ic">${icon(cfg.icon, 16)}</span>` +
    `<span class="r-name"></span>` +
    `<span class="r-tags">${tags.join("")}</span>` +
    `</div>` +
    `<div class="mk-desc"></div>` +
    (cfg.perms ? `<div class="mk-perms"></div>` : "") +
    `<div class="mk-foot">` +
    `<span class="mk-state">${cfg.stateText ?? (cfg.adminDisabled ? "管理员已停用" : off ? "已停用 · 本机不调用" : "已启用")}</span>` +
    `<span class="mk-foot-r">` +
    ((cfg.mine || cfg.onDelete) ? `<span class="mk-ops"><button class="del" type="button" title="${cfg.mine ? "删除" : "卸载"}">${icon("trash", 13)}</button></span>` : "") +
    (cfg.noSwitch ? "" : `<button class="switch${off ? "" : " on"}" type="button" ${cfg.adminDisabled ? "disabled" : ""}></button>`) +
    `</span></div>`;
  item.querySelector(".r-name").textContent = cfg.title;
  item.querySelector(".mk-top").title = [cfg.desc, cfg.perms ? (cfg.permsLabel ?? "所需权限：") + cfg.perms : ""].filter(Boolean).join("\n");
  item.querySelector(".mk-desc").textContent = cfg.desc || "";
  if (cfg.perms) item.querySelector(".mk-perms").textContent = (cfg.permsLabel ?? "所需权限：") + cfg.perms;
  const sw = item.querySelector(".switch");
  if (sw) {
    sw.title = off ? "已停用（本机不调用，点击启用）" : "已启用（点击停用）";
    if (!cfg.adminDisabled) {
      sw.addEventListener("click", async () => {
        const next = !cfg.enabled;
        try {
          await api.setResourceEnabled?.(cfg.module, cfg.id, next);
        } catch {}
        toast(next ? `已启用「${cfg.title}」` : `已停用「${cfg.title}」，本机不再调用`);
        state.moduleRerender?.();
      });
    }
  }
  if (cfg.onClick) {
    item.title = item.title || "点击查看详情";
    item.addEventListener("click", (e) => {
      if (e.target.closest("button")) return; // 开关/删除等操作不触发详情
      cfg.onClick();
    });
  }
  if (cfg.mine || cfg.onDelete) {
    const del = item.querySelector(".mk-ops .del");
    if (cfg.onDelete) {
      del.addEventListener("click", () => cfg.onDelete());
    } else {
      del.addEventListener("click", () => {
        toast(`「${cfg.title}」为个人项；删除需契约扩展 deleteResource（P2）`);
      });
    }
  }
  return item;
}

function mkFilterQ(input) {
  return (input.value || "").trim().toLowerCase();
}
function mkHit(it, q, fields) {
  if (!q) return true;
  return fields.some((f) => String(it[f] || "").toLowerCase().includes(q));
}

/* ============ 技能市场：企业市场 / 已安装 / 我的技能（PRD 4.2/4.3） ============ */
let skillsTab = "market"; // 页签记忆（会话内）
let lastMarketSync = 0; // 打开市场页节流触发后台同步（无感对版）

const SUBMIT_BADGE = {
  submitted: { text: "已提交审核", cls: "tag-ver" },
  reviewing: { text: "审核中", cls: "tag-ver" },
  approved: { text: "已发布", cls: "tag-mine" },
  rejected: { text: "已驳回", cls: "tag-off" },
};
const SYNC_BADGE = {
  current: "已同步",
  offline: "离线未校验",
  removed: "已移除",
  pendingUpdate: "待更新",
  unknown: "待同步",
};

function openSkillsModule() {
  showModuleView("skills", "技能市场", "企业技能经管理端审核发布；版本更新与下架由后台自动同步（PRD 4.2/4.3）", (listBox, input) => {
    const tabs = el("div", "mk-tabs");
    for (const t of [
      { id: "market", label: "企业市场" },
      { id: "installed", label: "已安装" },
      { id: "mine", label: "我的技能" },
    ]) {
      const b = el("button", "mk-tab" + (skillsTab === t.id ? " on" : ""), t.label);
      b.type = "button";
      b.addEventListener("click", () => {
        if (skillsTab === t.id) return;
        skillsTab = t.id;
        state.moduleRerender?.();
      });
      tabs.appendChild(b);
    }
    listBox.appendChild(tabs);
    const body = el("div", "");
    listBox.appendChild(body);

    const render = async () => {
      body.innerHTML = "";
      const q = mkFilterQ(input);
      if (skillsTab === "market") await renderSkillMarketTab(body, q);
      else if (skillsTab === "installed") await renderSkillInstalledTab(body, q);
      else await renderSkillMineTab(body, q);
    };
    input.addEventListener("input", () => void render());
    void render();
  });
}

// 企业市场：目录（管理端按权限过滤）+ 安装；打开时顺手触发一次后台同步
async function renderSkillMarketTab(box, q) {
  if (!api.skillMarket) {
    box.appendChild(el("div", "drawer-empty", "企业市场需主进程契约扩展（skillMarket）后可用"));
    return;
  }
  if (Date.now() - lastMarketSync > 15000) {
    lastMarketSync = Date.now();
    api.syncSkills?.().then((r) => {
      if (r && ((r.updated && r.updated.length) || (r.removed && r.removed.length))) state.moduleRerender?.();
    }).catch(() => {});
  }
  const items = (await api.skillMarket()) || [];
  const hit = items.filter((s) => mkHit(s, q, ["name", "description"]));
  box.appendChild(mkSection("企业市场", "管理端统一下发 · 可见范围由权限控制 · 安装后自动保持最新"));
  if (!hit.length) {
    box.appendChild(el("div", "drawer-empty", "暂无可安装的企业技能（目录为空或无匹配）"));
    return;
  }
  const grid = mkGrid(box);
  for (const s of hit) {
    const card = el("div", "mk-card");
    card.innerHTML =
      `<div class="mk-top"><span class="mk-ic">${icon("layers", 16)}</span><span class="r-name"></span>` +
      `<span class="r-tags"><span class="tag-ent">企业</span><span class="tag-ver">v${s.version}</span></span></div>` +
      `<div class="mk-desc"></div>` +
      `<div class="mk-foot"><span class="mk-state">${s.installed ? `已安装 v${s.localVersion ?? s.version}` : "未安装"}</span>` +
      `<span class="mk-foot-r"><button class="mini install-btn" type="button"></button></span></div>`;
    card.querySelector(".r-name").textContent = s.name;
    card.querySelector(".mk-desc").textContent = s.description || "";
    const btn = card.querySelector(".install-btn");
    if (s.installed) {
      btn.textContent = "已安装";
      btn.disabled = true;
    } else {
      btn.textContent = "安装";
      btn.addEventListener("click", async () => {
        btn.disabled = true;
        btn.textContent = "安装中…";
        try {
          await api.installSkill(s.name);
          toast(`已安装「${s.name}」v${s.version}，即已生效`);
          state.moduleRerender?.();
        } catch (e) {
          btn.disabled = false;
          btn.textContent = "安装";
          toast(String(e?.message ?? e));
        }
      });
    }
    grid.appendChild(card);
  }
}

// 已安装：本地缓存的企业技能 + 版本 + 同步状态；可启停（本机开关）、卸载（删缓存进回收站）
async function renderSkillInstalledTab(box, q) {
  const records = (await Promise.resolve(api.skillInstalled?.() ?? [])) || [];
  const allSkills = (await Promise.resolve(api.listSkills?.() ?? [])) || [];
  const localEnt = allSkills.filter((s) => s.scope === "企业");
  const byRecord = new Map(records.map((r) => [r.name, r]));
  // 记录为准；本地存在但无记录（如手工放入）标待同步
  const merged = [
    ...records.map((r) => ({ ...r, loaded: localEnt.some((s) => s.name === r.name) })),
    ...localEnt.filter((s) => !byRecord.has(s.name)).map((s) => ({ name: s.name, version: "-", state: "unknown", lastSyncedAt: "", loaded: true })),
  ];
  const hit = merged.filter((s) => mkHit(s, q, ["name"]));
  box.appendChild(mkSection("已安装的企业技能", "版本由后台自动同步 · 卸载仅删本地缓存，可随时重装"));
  if (!hit.length) {
    box.appendChild(el("div", "drawer-empty", "尚未安装企业技能（去「企业市场」安装，或从对话里沉淀个人技能）"));
    return;
  }
  const grid = mkGrid(box);
  for (const s of hit) {
    grid.appendChild(
      mkCard({
        module: "skill",
        id: s.name,
        icon: "layers",
        title: s.name,
        desc: `v${s.version} · ${SYNC_BADGE[s.state] ?? s.state ?? ""}${s.lastSyncedAt ? ` · 同步于 ${new Date(s.lastSyncedAt).toLocaleString()}` : ""}`,
        enabled: allSkills.find((x) => x.name === s.name)?.enabled !== false,
        mine: false,
        onDelete: () => confirmUninstallSkill(s.name),
      })
    );
  }
  // 企业卡片的删除按钮用作卸载入口：mkCard 的 onDelete 走 .del 图标，这里语义即卸载
}

async function confirmUninstallSkill(name) {
  if (!api.uninstallSkill) {
    toast("卸载需主进程契约扩展（uninstallSkill）");
    return;
  }
  confirmModal(`卸载技能 · ${name}`, `仅删除本地缓存（移入回收站，可随时从市场重装），不影响你的授权。确定卸载「${name}」？`, "卸载", async () => {
    await api.uninstallSkill(name);
    toast(`「${name}」已卸载`);
    state.moduleRerender?.();
  });
}

// 我的技能：个人技能列表（沉淀/导入而来）+ 上传技能包 + 审核状态徽标
async function renderSkillMineTab(box, q) {
  if (!MARKET_POLICY.personalSkills) {
    box.appendChild(el("div", "drawer-empty", "管理员已停用「个人技能」（企业总开关，PRD 5.1）"));
    return;
  }
  const skills = (await Promise.resolve(api.listSkills?.() ?? [])) || [];
  const subs = (await Promise.resolve(api.skillSubmissions?.() ?? [])) || [];
  // 最新一条提交状态（按提交时间倒序后的第一条）
  const latest = new Map();
  for (const s of subs) if (!latest.has(s.name)) latest.set(s.name, s);
  const mine = skills.filter((s) => s.mine && mkHit(s, q, ["name", "desc"]));
  box.appendChild(mkSection("我的技能", "从对话沉淀（让助手把流程做成技能）或上传技能包 · 上架共享需管理员审核"));
  if (!mine.length) {
    box.appendChild(el("div", "drawer-empty", "还没有个人技能：完成任务后对助手说「把刚才的流程做成技能」，或上传技能包"));
  }
  const grid = mkGrid(box);
  for (const s of mine) {
    const sub = latest.get(s.name);
    const badge = sub ? `（${SUBMIT_BADGE[sub.status]?.text ?? sub.status}${sub.status === "rejected" && sub.reviewerNote ? "：" + sub.reviewerNote : ""}）` : "";
    grid.appendChild(
      mkCard({ module: "skill", id: s.id ?? s.name, icon: "layers", title: s.name, desc: `${s.desc || ""}${badge}`, enabled: s.enabled, mine: true, onClick: () => openSkillDetail(s.name), onDelete: () => confirmDeleteSkill(s) })
    );
  }
  const add = el("div", "mk-addrow");
  const up = el("button", "", `${icon("paperclip", 13)}上传技能包`);
  up.type = "button";
  up.addEventListener("click", importSkillFlow);
  add.appendChild(up);
  box.appendChild(add);
}

/* ============ 技能生命周期闭环（PRD 4.3：创建 / 详情 / 编辑 / 删除→回收站 / 导入） ============ */
let skillModalEl = null;
function closeSkillModal() {
  skillModalEl?.remove();
  skillModalEl = null;
}
function openSkillModal(title) {
  closeSkillModal();
  const ov = el("div", "modal-overlay");
  ov.innerHTML = `
    <div class="modal" role="dialog" aria-label="${title}">
      <div class="m-head"><span></span><button class="m-close" type="button">${icon("close", 16)}</button></div>
      <div class="m-body"></div>
    </div>`;
  ov.querySelector(".m-head span").textContent = title;
  ov.querySelector(".m-close").addEventListener("click", closeSkillModal);
  ov.addEventListener("click", (e) => {
    if (e.target === ov) closeSkillModal();
  });
  document.body.appendChild(ov);
  skillModalEl = ov;
  return ov.querySelector(".m-body");
}

// 通用确认弹窗（危险操作两步确认；个人技能删除等）
function confirmModal(title, text, okLabel, onOk) {
  const body = openSkillModal(title);
  body.appendChild(el("div", "m-sec", ""));
  const p = el("div", "");
  p.style.cssText = "font-size:12.5px;line-height:1.7;color:var(--text-soft);padding:4px 0 2px";
  p.textContent = text;
  body.appendChild(p);
  const bar = el("div", "m-footbar");
  const cancel = el("button", "mini", "取消");
  cancel.type = "button";
  cancel.addEventListener("click", closeSkillModal);
  const ok = el("button", "mini danger", okLabel || "确认");
  ok.type = "button";
  ok.addEventListener("click", async () => {
    ok.disabled = true;
    try {
      await onOk();
      closeSkillModal();
    } catch (e) {
      ok.disabled = false;
      toast(String(e?.message ?? e));
    }
  });
  bar.append(cancel, ok);
  body.appendChild(bar);
}

// 编辑表单（仅个人技能维护用；技能的诞生走对话内沉淀或上传技能包，不走表单创建）
function openSkillEditor(prefill) {
  const pre = prefill || {};
  const body = openSkillModal(`编辑技能 · ${pre.name}`);

  const form = el("div", "m-form");
  const nameRow = el("div", "f-row");
  nameRow.innerHTML = `<div class="f-label">技能名（$ 引用时使用；改名 = 删除后重新沉淀）</div>`;
  const name = document.createElement("input");
  name.type = "text";
  name.spellcheck = false;
  name.value = pre.name || "";
  name.disabled = true; // 名称即目录：编辑不改名
  nameRow.appendChild(name);
  form.appendChild(nameRow);

  const descRow = el("div", "f-row");
  descRow.innerHTML = `<div class="f-label">描述（模型靠它判断何时使用，写给模型看）</div>`;
  const desc = document.createElement("input");
  desc.type = "text";
  desc.value = pre.description || "";
  descRow.appendChild(desc);
  form.appendChild(descRow);

  const contentRow = el("div", "f-row");
  contentRow.innerHTML = `<div class="f-label">内容（Markdown：流程 / 输出结构 / 数据口径）</div>`;
  const content = document.createElement("textarea");
  content.className = "sk-content";
  content.value = pre.content || "";
  contentRow.appendChild(content);
  form.appendChild(contentRow);
  body.appendChild(form);

  const bar = el("div", "m-footbar");
  const cancel = el("button", "mini", "取消");
  cancel.type = "button";
  cancel.addEventListener("click", closeSkillModal);
  const save = el("button", "mini primary", "保存");
  save.type = "button";
  save.addEventListener("click", async () => {
    try {
      await api.updateSkill(pre.name, { description: desc.value, content: content.value });
      toast(`「${pre.name}」已保存`);
      closeSkillModal();
      state.moduleRerender?.();
    } catch (e) {
      toast(String(e?.message ?? e));
    }
  });
  bar.append(cancel, save);
  body.appendChild(bar);
  content.focus();
}

// 详情：企业技能只读；个人技能可编辑 / 删除 / 打开目录
async function openSkillDetail(skillName) {
  if (!api.readSkill) {
    toast("技能详情需主进程契约扩展（readSkill）");
    return;
  }
  let s;
  try {
    s = await api.readSkill(skillName);
  } catch (e) {
    toast(String(e?.message ?? e));
    return;
  }
  const body = openSkillModal(`技能 · ${s.name}`);
  const meta = el("div", "m-sec", "");
  meta.innerHTML =
    `${s.mine ? '<span class="tag-mine">个人</span>' : '<span class="tag-ent">企业</span>'}` +
    `<span class="mk-state" style="margin-left:6px">${s.enabled ? "已启用" : "已停用 · 本机不调用"}</span>`;
  body.appendChild(meta);
  const desc = el("div", "");
  desc.style.cssText = "font-size:12.5px;color:var(--text-soft);padding:2px 0";
  desc.textContent = s.description || "（无描述）";
  body.appendChild(desc);
  const pathRow = mRow("文件位置", s.mine ? "个人区，本机可管理" : "企业区，管理端管控", `<span class="m-mono">${s.filePath}</span>`);
  pathRow.style.cssText = "align-items:flex-start";
  body.appendChild(pathRow);
  if (s.mine && api.skillSubmissions) {
    const subs = (await Promise.resolve(api.skillSubmissions())) || [];
    const sub = subs.find((x) => x.name === s.name);
    const subRow = mRow(
      "上架审核",
      "提交管理员审核，通过后发布到企业市场",
      sub ? `<span class="tag-ver">${SUBMIT_BADGE[sub.status]?.text ?? sub.status}</span>` : `<span class="m-mono">未提交</span>`
    );
    if (sub?.reviewerNote) subRow.querySelector(".m-actions").title = sub.reviewerNote;
    body.appendChild(subRow);
  }
  const pre = el("pre", "sk-pre");
  pre.textContent = s.content || "(空)";
  body.appendChild(pre);

  const bar = el("div", "m-footbar");
  if (s.mine) {
    const openDir = el("button", "mini", "打开目录");
    openDir.type = "button";
    openDir.addEventListener("click", async () => {
      try {
        await api.openSkillDir?.(s.name);
      } catch (e) {
        toast(String(e?.message ?? e));
      }
    });
    const edit = el("button", "mini", "编辑");
    edit.type = "button";
    edit.addEventListener("click", () => openSkillEditor(s));
    const submit = el("button", "mini", "提交审核上架");
    submit.type = "button";
    submit.title = "提交给管理员审核，通过后发布到企业市场（PRD 4.3/5.1）";
    submit.addEventListener("click", async () => {
      submit.disabled = true;
      try {
        await api.submitSkill?.(s.name);
        toast(`「${s.name}」已提交审核（进度见卡片徽标）`);
        closeSkillModal();
        state.moduleRerender?.();
      } catch (e) {
        submit.disabled = false;
        toast(String(e?.message ?? e));
      }
    });
    const del = el("button", "mini danger", "删除");
    del.type = "button";
    del.addEventListener("click", () => confirmDeleteSkill(s));
    bar.append(openDir, edit, submit, del);
  } else {
    const hint = el("span", "");
    hint.style.cssText = "font-size:11px;color:var(--text-faint);margin-right:auto";
    hint.textContent = "企业技能由管理端统一更新与回收（PRD 4.2/4.3）";
    bar.appendChild(hint);
  }
  body.appendChild(bar);
}

function confirmDeleteSkill(s) {
  if (!api.deleteSkill) {
    toast("删除需主进程契约扩展（deleteSkill）");
    return;
  }
  confirmModal(`删除技能 · ${s.name}`, `将移入回收站（~/.ordo/recycle），本机不再注入该技能。确定删除「${s.name}」？`, "删除", async () => {
    await api.deleteSkill(s.name);
    toast(`「${s.name}」已删除（回收站可恢复）`);
    closeSkillModal(); // 详情弹窗（若开着）一并关闭
    state.moduleRerender?.();
  });
}

async function importSkillFlow() {
  if (!api.pickSkillFolder || !api.importSkill) {
    toast("技能包导入需主进程契约扩展（pickSkillFolder / importSkill）");
    return;
  }
  const p = await api.pickSkillFolder();
  if (!p) return;
  try {
    const s = await api.importSkill(p);
    toast(`技能包已导入：「${s.name}」`);
    state.moduleRerender?.();
  } catch (e) {
    toast(String(e?.message ?? e));
  }
}

/* ============ 自动化（PRD 3.7 本地型定时任务）：仅用户自建、仅本机运行；管理端编排的任务不进客户端 ============ */
function openAutomationsModule() {
  showModuleView("automations", "自动化任务", "本地型定时任务：仅本机运行、结果可回看；管理端编排的任务不在此展示（PRD 3.7）", (listBox, input) => {
    const render = async () => {
      const items = (await Promise.resolve(api.listAutomations?.() ?? null)) || null;
      listBox.innerHTML = "";
      if (!items) {
        listBox.appendChild(el("div", "drawer-empty", "自动化需主进程契约扩展（listAutomations）后可用"));
        return;
      }
      const q = mkFilterQ(input);
      const mine = items.filter((t) => mkHit(t, q, ["name", "prompt", "scheduleText"]));
      if (mine.length) {
        listBox.appendChild(mkSection("我的自动化", "个人自建 · 仅本机定时运行，管理端不可见"));
        const grid = mkGrid(listBox);
        for (const t of mine) {
          grid.appendChild(
            mkCard({
              module: "automation",
              id: t.id,
              icon: "clock",
              title: t.name,
              desc: autoCardDesc(t),
              enabled: t.enabled,
              mine: true,
              onClick: () => openAutomationDetail(t),
              onDelete: () => confirmDeleteAutomation(t),
            })
          );
        }
      } else if (!q) {
        listBox.appendChild(el("div", "drawer-empty", "还没有自动化任务：新建一个，把重复工作定时跑（如每天 09:00 汇总日报），完成后桌面通知"));
      }
      if (!mine.length && q) listBox.appendChild(el("div", "drawer-empty", "没有匹配的任务"));
      if (!q) {
        const add = el("div", "mk-addrow");
        const nb = el("button", "", `${icon("plus", 13)}新建自动化任务`);
        nb.type = "button";
        nb.addEventListener("click", () => openAutomationEditor(null));
        add.appendChild(nb);
        listBox.appendChild(add);
      }
    };
    input.addEventListener("input", () => void render());
    void render();
  });
}

function autoCardDesc(t) {
  const parts = [t.scheduleText || ""];
  if (t.enabled !== false && t.nextRunAt) parts.push(`下次 ${fmtAutoTime(t.nextRunAt)}`);
  if (t.wsName) parts.push(`目录 ${t.wsName}`);
  if (t.lastRunAt) parts.push(t.lastStatus === "error" ? "上次运行失败" : `已运行 ${t.runCount || 1} 次`);
  return parts.filter(Boolean).join(" · ");
}

function fmtAutoTime(iso) {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  const hm = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  return d.toDateString() === new Date().toDateString() ? `今天 ${hm}` : `${d.getMonth() + 1}月${d.getDate()}日 ${hm}`;
}

async function openAutomationEditor(existing) {
  if (!api.createAutomation || !api.updateAutomation) {
    toast("自动化编辑需主进程契约扩展（createAutomation / updateAutomation）");
    return;
  }
  let experts = [];
  let l2 = [];
  let wsItems = [];
  let wsCurrentId = "default";
  try {
    const ex = await api.listExperts?.();
    experts = ex?.items || [];
    l2 = (await api.automationCatalog?.()) || [];
    const wsr = await api.listWorkspaces?.();
    wsItems = wsr?.items || [];
    if (wsr?.currentId) wsCurrentId = wsr.currentId;
  } catch {}
  const body = openSkillModal(existing ? `编辑自动化 · ${existing.name}` : "新建自动化任务");
  const form = el("div", "m-form");
  const mkLabel = (t) => {
    const d = el("div", "f-label");
    d.textContent = t;
    return d;
  };

  const nameRow = el("div", "f-row");
  nameRow.appendChild(mkLabel("任务名称"));
  const name = document.createElement("input");
  name.type = "text";
  name.placeholder = "如：每日晨报汇总";
  name.value = existing?.name || "";
  nameRow.appendChild(name);
  form.appendChild(nameRow);

  const promptRow = el("div", "f-row");
  promptRow.appendChild(mkLabel("任务指令（到点后交给 Agent 执行的完整指令）"));
  const prompt = document.createElement("textarea");
  prompt.rows = 4;
  prompt.placeholder = "如：读取 data 目录下最新销售数据，生成当日晨报写入 out/daily.md，并用一句话总结异常项。";
  prompt.value = existing?.prompt || "";
  promptRow.appendChild(prompt);
  form.appendChild(promptRow);

  const expertRow = el("div", "f-row");
  expertRow.appendChild(mkLabel("执行专家（创建时锁定，每次运行用它）"));
  const expertSel = document.createElement("select");
  for (const e of experts) {
    const o = document.createElement("option");
    o.value = e.id;
    o.textContent = e.name;
    expertSel.appendChild(o);
  }
  expertSel.value = existing?.expertId || experts[0]?.id || "";
  expertRow.appendChild(expertSel);
  form.appendChild(expertRow);

  // 工作目录（PRD 3.8）：任务读写与产物锚定该目录，运行会话也归属它；新建默认选当前工作区
  const wsRow = el("div", "f-row");
  wsRow.appendChild(mkLabel("工作目录（任务在此目录下读写，产物与会话都归属该目录）"));
  const wsSel = document.createElement("select");
  if (!wsItems.length) {
    const o = document.createElement("option");
    o.value = "default";
    o.textContent = "默认工作区";
    wsSel.appendChild(o);
  }
  for (const w of wsItems) {
    const o = document.createElement("option");
    o.value = w.id;
    o.textContent = w.label || w.id;
    wsSel.appendChild(o);
  }
  wsSel.value = existing?.wsId || (wsItems.some((w) => w.id === wsCurrentId) ? wsCurrentId : wsItems[0]?.id || "default");
  const syncWsTitle = () => {
    const w = wsItems.find((x) => x.id === wsSel.value);
    wsSel.title = w?.root || "";
  };
  wsSel.addEventListener("change", syncWsTitle);
  syncWsTitle();
  wsRow.appendChild(wsSel);
  form.appendChild(wsRow);

  const schRow = el("div", "f-row");
  schRow.appendChild(mkLabel("运行时间"));
  const schCtrl = el("div", "");
  schCtrl.style.cssText = "display:flex;flex-direction:column;gap:6px";
  const schLine = el("div", "");
  schLine.style.cssText = "display:flex;gap:6px;align-items:center;flex-wrap:wrap";
  const kindSel = document.createElement("select");
  for (const [v, label] of [["daily", "每天"], ["weekly", "每周"], ["interval", "固定间隔"]]) {
    const o = document.createElement("option");
    o.value = v;
    o.textContent = label;
    kindSel.appendChild(o);
  }
  const timeIn = document.createElement("input");
  timeIn.type = "time";
  const everyIn = document.createElement("input");
  everyIn.type = "number";
  everyIn.min = "1";
  everyIn.max = "1440";
  everyIn.style.width = "86px";
  const everyLbl = el("span", "", "分钟");
  everyLbl.style.cssText = "font-size:11px;color:var(--text-faint)";
  schLine.append(kindSel, timeIn, everyIn, everyLbl);
  const dayWrap = el("div", "");
  dayWrap.style.cssText = "display:flex;gap:4px;flex-wrap:wrap";
  const WEEK = ["", "一", "二", "三", "四", "五", "六", "日"];
  const dayChips = [];
  for (let d = 1; d <= 7; d++) {
    const c = el("button", "seg-chip", `周${WEEK[d]}`);
    c.type = "button";
    c.addEventListener("click", () => c.classList.toggle("on"));
    dayChips.push({ d, c });
    dayWrap.appendChild(c);
  }
  schCtrl.append(schLine, dayWrap);
  schRow.appendChild(schCtrl);
  form.appendChild(schRow);

  const kind0 = existing?.schedule?.kind || "daily";
  kindSel.value = kind0;
  timeIn.value = existing?.schedule?.time || "09:00";
  everyIn.value = String(existing?.schedule?.everyMinutes ?? 30);
  for (const { d, c } of dayChips) {
    if ((existing?.schedule?.weekdays || []).includes(d)) c.classList.add("on");
  }
  const syncSch = () => {
    const k = kindSel.value;
    timeIn.style.display = k === "interval" ? "none" : "";
    everyIn.style.display = everyLbl.style.display = k === "interval" ? "" : "none";
    dayWrap.style.display = k === "weekly" ? "flex" : "none";
  };
  kindSel.addEventListener("change", syncSch);
  syncSch();

  const paRow = el("div", "f-row");
  paRow.appendChild(mkLabel("预授权的敏感操作（无人值守时自动放行；未勾选的会在运行中被拒绝并记录）"));
  const paWrap = el("div", "");
  paWrap.style.cssText = "display:flex;flex-direction:column;gap:4px";
  if (!l2.length) {
    const none = el("div", "f-label", "（当前没有可预授权的敏感操作）");
    paWrap.appendChild(none);
  }
  const paChecks = l2.map((a) => {
    const lab = document.createElement("label");
    lab.style.cssText = "display:flex;gap:6px;align-items:center;font-size:12px;color:var(--text-soft);cursor:pointer";
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = (existing?.preAuth || []).includes(a.id);
    lab.append(cb, document.createTextNode(a.label));
    paWrap.appendChild(lab);
    return { id: a.id, cb };
  });
  paRow.appendChild(paWrap);
  form.appendChild(paRow);
  body.appendChild(form);

  const bar = el("div", "m-footbar");
  const hint = el("span", "");
  hint.style.cssText = "font-size:11px;color:var(--text-faint);margin-right:auto";
  hint.textContent = "到点在本机自动运行；结果生成会话可回看，完成桌面通知";
  const cancel = el("button", "mini", "取消");
  cancel.type = "button";
  cancel.addEventListener("click", closeSkillModal);
  const ok = el("button", "mini primary", existing ? "保存" : "创建");
  ok.type = "button";
  ok.addEventListener("click", async () => {
    const nameV = name.value.trim();
    const promptV = prompt.value.trim();
    if (!nameV) {
      toast("请填写任务名称");
      return;
    }
    if (!promptV) {
      toast("请填写任务指令");
      return;
    }
    const k = kindSel.value;
    const schedule =
      k === "daily"
        ? { kind: k, time: timeIn.value || "09:00" }
        : k === "weekly"
          ? { kind: k, time: timeIn.value || "09:00", weekdays: dayChips.filter((x) => x.c.classList.contains("on")).map((x) => x.d) }
          : { kind: k, everyMinutes: Math.max(1, Number(everyIn.value) || 30) };
    if (k === "weekly" && !schedule.weekdays.length) {
      toast("请至少选择一个运行日");
      return;
    }
    const payload = {
      name: nameV,
      prompt: promptV,
      expertId: expertSel.value,
      wsId: wsSel.value,
      schedule,
      preAuth: paChecks.filter((x) => x.cb.checked).map((x) => x.id),
    };
    ok.disabled = true;
    try {
      if (existing) await api.updateAutomation(existing.id, payload);
      else await api.createAutomation(payload);
      toast(existing ? `「${nameV}」已保存` : `「${nameV}」已创建，将按计划自动运行`);
      closeSkillModal();
      state.moduleRerender?.();
    } catch (e) {
      ok.disabled = false;
      toast(String(e?.message ?? e));
    }
  });
  bar.append(hint, cancel, ok);
  body.appendChild(bar);
  name.focus();
}

async function openAutomationDetail(t) {
  if (!api.automationRuns) {
    toast("自动化详情需主进程契约扩展（automationRuns）");
    return;
  }
  let runs = [];
  try {
    runs = (await api.automationRuns(t.id)) || [];
  } catch (e) {
    toast(String(e?.message ?? e));
    return;
  }
  const body = openSkillModal(`自动化 · ${t.name}`);
  const meta = el("div", "m-sec", "");
  meta.innerHTML =
    `<span class="tag-mine">个人</span>` +
    `<span class="mk-state" style="margin-left:6px">${t.scheduleText || ""} · ${t.expertName || t.expertId} · ${t.enabled === false ? "已停用" : "已启用"}</span>`;
  body.appendChild(meta);
  const wsLine = el("div", "f-label", `工作目录：${t.wsName || t.wsId || "默认工作区"}（任务在此目录下读写，运行会话归属该目录）`);
  wsLine.style.marginTop = "4px";
  body.appendChild(wsLine);
  const paLine = el("div", "f-label", t.preAuthLabels?.length ? `预授权：${t.preAuthLabels.join("、")}` : "预授权：无（运行中的敏感操作会被拒绝并记录）");
  paLine.style.marginTop = "2px";
  body.appendChild(paLine);

  const promptSec = el("div", "m-sec", "任务指令");
  body.appendChild(promptSec);
  const pre = el("div", "sk-pre");
  pre.textContent = t.prompt || "";
  body.appendChild(pre);

  const runSec = el("div", "m-sec", `运行记录（近 ${runs.length} 次）`);
  body.appendChild(runSec);
  const list = el("div", "");
  list.style.cssText = "margin-top:6px;display:flex;flex-direction:column;gap:6px";
  if (!runs.length) {
    list.appendChild(el("div", "drawer-empty", "还没有运行记录：可点「立即运行」试跑一次"));
  }
  for (const r of runs) {
    const row = el("div", "auto-run");
    const head = el("div", "auto-run-head");
    const time = new Date(r.startedAt);
    const hm = `${time.getMonth() + 1}月${time.getDate()}日 ${String(time.getHours()).padStart(2, "0")}:${String(time.getMinutes()).padStart(2, "0")}`;
    const badge = el("span", "run-badge " + (r.ok ? "ok" : "err"), r.ok ? "完成" : "失败");
    const info = el("span", "auto-run-time", `${hm} · ${(r.durationMs / 1000).toFixed(1)}s · ${r.trigger === "timer" ? "定时" : "手动"}`);
    head.append(badge, info);
    if (r.sessionId) {
      const open = el("button", "mini", "打开会话");
      open.type = "button";
      open.addEventListener("click", async () => {
        closeSkillModal();
        closeModuleView();
        try {
          await api.loadSession(r.sessionId);
        } catch (e) {
          toast(String(e?.message ?? e));
        }
      });
      head.append(open);
    }
    row.append(head);
    const sum = el("div", "auto-run-sum");
    sum.textContent = r.ok ? r.summary || "（无输出）" : r.error || r.summary || "运行失败";
    row.append(sum);
    list.appendChild(row);
  }
  body.appendChild(list);

  const bar = el("div", "m-footbar");
  const edit = el("button", "mini", "编辑");
  edit.type = "button";
  edit.addEventListener("click", () => openAutomationEditor(t));
  const run = el("button", "mini primary", "立即运行");
  run.type = "button";
  run.addEventListener("click", async () => {
    if (!api.runAutomation) {
      toast("需主进程契约扩展（runAutomation）");
      return;
    }
    run.disabled = true;
    run.textContent = "运行中…";
    try {
      const rec = await api.runAutomation(t.id);
      closeSkillModal();
      toast(rec.ok ? `「${t.name}」本次运行完成` : `「${t.name}」运行失败：${(rec.error || rec.summary || "").slice(0, 60)}`);
      state.moduleRerender?.();
    } catch (e) {
      run.disabled = false;
      run.textContent = "立即运行";
      toast(String(e?.message ?? e));
    }
  });
  bar.append(edit, run);
  body.appendChild(bar);
}

function confirmDeleteAutomation(t) {
  if (!api.deleteAutomation) {
    toast("删除需主进程契约扩展（deleteAutomation）");
    return;
  }
  confirmModal(`删除自动化 · ${t.name}`, `将删除任务及其运行记录；已生成的会话不受影响，仍可在会话列表回看。确定删除「${t.name}」？`, "删除", async () => {
    try {
      await api.deleteAutomation(t.id);
      toast(`「${t.name}」已删除`);
      closeSkillModal();
      state.moduleRerender?.();
    } catch (e) {
      toast(String(e?.message ?? e));
    }
  });
}

function openKnowledgeModule() {
  showModuleView("kb", "知识库", "企业库经管理端代理检索；个人库本地存储与检索，内容管理端不可见；挂载后对话即可检索（PRD 4.5）", (listBox, input) => {
    const render = async () => {
      const kbs = (await Promise.resolve(api.listKnowledgeBases?.() ?? null)) || null;
      listBox.innerHTML = "";
      if (!kbs) {
        listBox.appendChild(el("div", "drawer-empty", "知识库列表需主进程契约扩展（listKnowledgeBases）后可用"));
        return;
      }
      const q = mkFilterQ(input);
      const ent = kbs.filter((k) => !k.mine && mkHit(k, q, ["name", "desc"]));
      const mine = kbs.filter((k) => k.mine && mkHit(k, q, ["name", "desc"]));
      if (ent.length) {
        listBox.appendChild(mkSection("企业知识库", "管理端配置 · 输入框挂载后可检索，未授权的不可见"));
        const grid = mkGrid(listBox);
        for (const k of ent) {
          grid.appendChild(
            mkCard({
              module: "kb",
              id: k.id,
              icon: "book",
              title: k.name,
              desc: `${k.desc || ""}${k.docCount ? ` · ${k.docCount} 篇文档` : ""}${k.attached ? " · 本会话已挂载" : ""}`,
              enabled: k.enabled,
              adminDisabled: k.adminDisabled,
              mine: false,
            })
          );
        }
      }
      if (MARKET_POLICY.personalKb) {
        listBox.appendChild(mkSection("我的知识库", "本地存储与检索 · 内容管理端不可见，检索仍审计"));
        const grid = mkGrid(listBox);
        for (const k of mine) {
          grid.appendChild(
            mkCard({
              module: "kb",
              id: k.id,
              icon: "book",
              title: k.name,
              desc: `${k.desc || ""}${k.docCount ? ` · ${k.docCount} 篇文档` : ""}${k.attached ? " · 本会话已挂载" : ""}`,
              enabled: k.enabled,
              mine: true,
              onClick: () => openKbDetail(k),
              onDelete: () => confirmDeleteKb(k),
            })
          );
        }
        if (!mine.length && !q) {
          listBox.appendChild(el("div", "drawer-empty", "还没有个人知识库：新建一个，把常用文档丢进去，对话里挂载即可检索"));
        }
        if (!q) {
          const add = el("div", "mk-addrow");
          const nb = el("button", "", `${icon("plus", 13)}新建个人知识库`);
          nb.type = "button";
          nb.addEventListener("click", promptCreateKb);
          add.appendChild(nb);
          listBox.appendChild(add);
        }
      } else if (!q) {
        listBox.appendChild(el("div", "drawer-empty", "管理员已停用「个人知识库」（企业总开关，PRD 5.1）"));
      }
      if (!listBox.children.length) {
        listBox.appendChild(el("div", "drawer-empty", "没有匹配的知识库"));
      }
    };
    input.addEventListener("input", () => void render());
    void render();
  });
}

/* ============ 个人知识库管理（建库 / 文档上传与移除 / 删除→回收站） ============ */
function promptCreateKb() {
  if (!api.createKb) {
    toast("个人知识库需主进程契约扩展（createKb）");
    return;
  }
  const body = openSkillModal("新建个人知识库");
  const form = el("div", "m-form");
  const row = el("div", "f-row");
  row.innerHTML = `<div class="f-label">名称（如：项目文档 / 部门规范）</div>`;
  const name = document.createElement("input");
  name.type = "text";
  name.placeholder = "我的文档库";
  row.appendChild(name);
  form.appendChild(row);
  const hint = el("div", "f-label", "本地存储（~/.ordo/rag），仅本机可用，内容管理端不可见。支持文本（md/txt/csv/json 等）与 Office（docx/xlsx，检索时解析为文本）；扫描件解析后续版本接入。");
  form.appendChild(hint);
  body.appendChild(form);
  const bar = el("div", "m-footbar");
  const cancel = el("button", "mini", "取消");
  cancel.type = "button";
  cancel.addEventListener("click", closeSkillModal);
  const ok = el("button", "mini primary", "创建");
  ok.type = "button";
  ok.addEventListener("click", async () => {
    try {
      await api.createKb(name.value);
      toast(`知识库「${name.value.trim()}」已创建，可以上传文档了`);
      closeSkillModal();
      state.moduleRerender?.();
    } catch (e) {
      toast(String(e?.message ?? e));
    }
  });
  bar.append(cancel, ok);
  body.appendChild(bar);
  name.focus();
}

async function openKbDetail(kb) {
  if (!api.listKbDocs) {
    toast("知识库详情需主进程契约扩展（listKbDocs）");
    return;
  }
  let docs = [];
  try {
    docs = (await api.listKbDocs(kb.id)) || [];
  } catch (e) {
    toast(String(e?.message ?? e));
    return;
  }
  const body = openSkillModal(`知识库 · ${kb.name}`);
  const meta = el("div", "m-sec", "");
  meta.innerHTML = `<span class="tag-mine">个人</span><span class="mk-state" style="margin-left:6px">${docs.length} 篇文档 · 检索走本机，内容不出域</span>`;
  body.appendChild(meta);
  const list = el("div", "");
  list.style.cssText = "margin-top:8px";
  if (!docs.length) {
    list.appendChild(el("div", "drawer-empty", "还没有文档，点击下方「上传文档」入库"));
  }
  for (const d of docs) {
    const r = mRow(d.name, "", `<span class="m-mono">${d.size < 1024 ? d.size + "B" : (d.size / 1024).toFixed(0) + "KB"}</span><button class="mini" type="button">移除</button>`);
    r.querySelector(".mini").addEventListener("click", async () => {
      try {
        await api.removeKbDoc?.(kb.id, d.name);
        toast(`已移除「${d.name}」`);
        closeSkillModal();
        state.moduleRerender?.();
      } catch (e) {
        toast(String(e?.message ?? e));
      }
    });
    list.appendChild(r);
  }
  body.appendChild(list);
  const bar = el("div", "m-footbar");
  const up = el("button", "mini primary", `${icon("paperclip", 12)} 上传文档`);
  up.type = "button";
  up.addEventListener("click", async () => {
    if (!api.pickKbFiles || !api.addKbDocs) {
      toast("上传文档需主进程契约扩展（pickKbFiles / addKbDocs）");
      return;
    }
    const paths = await api.pickKbFiles();
    if (!paths?.length) return;
    try {
      const r = await api.addKbDocs(kb.id, paths);
      toast(r.added.length ? `已入库 ${r.added.length} 篇：${r.added.join("、")}` : "没有可入库的文档（仅支持文本格式）");
      if (r.skipped?.length) toast(`跳过：${r.skipped.join("；")}`);
      closeSkillModal();
      state.moduleRerender?.();
    } catch (e) {
      toast(String(e?.message ?? e));
    }
  });
  const del = el("button", "mini danger", "删除知识库");
  del.type = "button";
  del.addEventListener("click", () => confirmDeleteKb(kb));
  bar.append(up, del);
  body.appendChild(bar);
}

function confirmDeleteKb(kb) {
  if (!api.deleteKb) {
    toast("删除需主进程契约扩展（deleteKb）");
    return;
  }
  confirmModal(`删除知识库 · ${kb.name}`, `将移入回收站（连同已入库文档），检索不再覆盖此库。确定删除「${kb.name}」？`, "删除", async () => {
    await api.deleteKb(kb.id);
    toast(`「${kb.name}」已删除（回收站可恢复）`);
    closeSkillModal();
    state.moduleRerender?.();
  });
}


/* ============ 专家（PRD 3.10）：管理端统一定义 = 人设 + 技能/连接器/知识库白名单 ============ */
function expertScopeText(e2) {
  // 白名单语义：null = 全部已启用；[] = 不挂；数组 = 仅列出的
  const one = (v) => (v == null ? "全部" : v.length ? `${v.length} 项` : "不挂");
  return `技能 ${one(e2.skillWhitelist)} · 连接器 ${one(e2.mcpWhitelist)} · 知识库 ${one(e2.kbWhitelist)}`;
}

function openExpertsModule() {
  showModuleView("experts", "专家团队", "专家 = 人设 + 技能/连接器/知识库白名单（管理端统一定义，PRD 3.10）；基础工具能力各专家一致，专家随会话锁定——点卡片新建会话使用", (listBox, input) => {
    const render = () => {
      const items = state.experts?.items || [];
      const q = mkFilterQ(input);
      listBox.innerHTML = "";
      const curId = state.experts?.currentId;
      const hit = items.filter((x) => mkHit(x, q, ["name", "description"]));
      if (hit.length) {
        listBox.appendChild(mkSection("专家", "管理端统一定义 · 点卡片查看人设与资源范围"));
        const grid = mkGrid(listBox);
        for (const e2 of hit) {
          grid.appendChild(
            mkCard({
              module: "expert",
              id: e2.id,
              icon: "user",
              title: e2.name,
              desc: e2.description || "",
              perms: expertScopeText(e2),
              permsLabel: "资源范围：",
              // 专家没有启停语义（PRD 3.10 全量可用，选择发生在新建会话时），卡片不放开关
              noSwitch: true,
              stateText: e2.id === curId ? "当前会话使用中" : "点卡片查看",
              mine: false,
              onClick: () => openExpertDetail(e2),
            })
          );
        }
      } else if (!q) {
        listBox.appendChild(el("div", "drawer-empty", "专家清单为空（由管理端统一下发，PRD 3.10）"));
      }
      if (!hit.length && q) listBox.appendChild(el("div", "drawer-empty", "没有匹配的专家"));
    };
    input.addEventListener("input", render);
    render();
  });
}

async function openExpertDetail(e2) {
  // 白名单解析为可读名字：技能按名、连接器按名、知识库按 id；清单现拉（未装的显示原名）
  let skills = [];
  let conns = [];
  let kbs = [];
  try {
    skills = (await api.listSkills?.()) || [];
  } catch {}
  try {
    conns = (await api.listConnectors?.()) || [];
  } catch {}
  try {
    kbs = (await api.listKnowledgeBases?.()) || [];
  } catch {}
  const scopeLine = (wl, list, key, label) => {
    if (wl == null) return "全部已启用";
    if (!wl.length) return "不挂";
    return wl.map((x) => {
      const hit = list.find((y) => y[key] === x);
      return hit ? hit[label] : x;
    }).join("、");
  };
  const body = openSkillModal(`专家 · ${e2.name}`);
  const meta = el("div", "m-sec", "");
  meta.innerHTML =
    `<span class="tag-ent">管理端定义</span>` +
    (e2.id === state.experts?.currentId ? `<span class="tag-mine" style="margin-left:6px">当前会话</span>` : "");
  body.appendChild(meta);
  const descSec = el("div", "m-sec", "人设（角色提示词）");
  body.appendChild(descSec);
  const pre = el("div", "sk-pre");
  pre.textContent = e2.description || "（无描述）";
  body.appendChild(pre);
  const resSec = el("div", "m-sec", "资源范围（生效 = 挂载 ∩ 启用 ∩ 白名单；个人知识库不受限）");
  body.appendChild(resSec);
  const mkLine = (label, text) => {
    const d = el("div", "f-label", `${label}：${text}`);
    d.style.marginTop = "4px";
    return d;
  };
  body.appendChild(mkLine("技能", scopeLine(e2.skillWhitelist, skills, "name", "name")));
  body.appendChild(mkLine("连接器", scopeLine(e2.mcpWhitelist, conns, "name", "displayName")));
  body.appendChild(mkLine("知识库", scopeLine(e2.kbWhitelist, kbs, "id", "name")));
  const note = el("div", "f-label", "基础工具（读/写/列目录等）各专家完全一致，差异只在人设与资源范围");
  note.style.marginTop = "8px";
  body.appendChild(note);

  const bar = el("div", "m-footbar");
  const hint = el("span", "");
  hint.style.cssText = "font-size:11px;color:var(--text-faint);margin-right:auto";
  hint.textContent = "专家随会话锁定：换专家 = 新建会话（PRD 3.10）";
  const close = el("button", "mini", "关闭");
  close.type = "button";
  close.addEventListener("click", closeSkillModal);
  const use = el("button", "mini primary", e2.id === state.experts?.currentId ? "新建会话（当前专家）" : "新建会话并使用");
  use.type = "button";
  use.addEventListener("click", async () => {
    try {
      await api.newSession?.();
      if (e2.id !== state.experts?.currentId) await api.switchExpert(e2.id);
      closeSkillModal();
      closeModuleView();
      toast(`已新建会话，使用专家「${e2.name}」`);
    } catch (err) {
      toast(String(err?.message ?? err));
    }
  });
  bar.append(hint, close, use);
  body.appendChild(bar);
}

/* ============ 插件包（M5，方案 §12.4）：CLI+技能+MCP 成套下发；安装到 managed 目录 ============ */
function openPacksModule() {
  showModuleView("packs", "插件包", "内置组件随客户端发版；管理端成套下发 CLI / 技能 / MCP 组合（sha256 校验原子落盘 managed 目录，同名技能管理端下发优先）", async (listBox, input) => {
    const render = async () => {
      const data = (await Promise.resolve(api.pluginPacks?.() ?? null)) || { catalog: [], installed: {} };
      listBox.innerHTML = "";
      const q = mkFilterQ(input);
      // 内置组件区（静态恒显，无安装/卸载动作）：officecli 等随安装包分发的引擎，三态显示一致
      const builtin = Array.isArray(data.builtin) ? data.builtin.filter((b) => mkHit(b, q, ["name", "title", "note"])) : [];
      if (builtin.length) {
        listBox.appendChild(mkSection("内置组件", "随客户端安装包内置 · 开箱即用 · 随客户端发版更新"));
        const grid0 = mkGrid(listBox);
        for (const b of builtin) {
          grid0.appendChild(
            mkCard({
              module: "pack",
              id: "builtin-" + b.name,
              icon: "archive",
              title: b.title || b.name,
              desc: b.note || "",
              version: b.version ? "v" + b.version : "",
              tag: "内置",
              noSwitch: true,
              stateText: "开箱即用",
            })
          );
        }
      }
      const hit = data.catalog.filter((p) => mkHit(p, q, ["name", "title", "description"]));
      listBox.appendChild(mkSection("插件包目录", "管理端发布 · required 包自动安装 · 含 MCP 包时经本地 MCP 宿主运行（子进程 stdio）"));
      if (!hit.length) {
        // 空态按模式分流：联机目录为空不能说「未接管理端」（officecli 遗留包过滤后也会走到这里）
        let emptyText = "没有匹配的插件包";
        if (!data.catalog.length) {
          let online = false;
          try { online = (api.getAuthState ? await api.getAuthState() : null)?.mode === "online"; } catch { /* 契约缺失按离线文案 */ }
          emptyText = online ? "管理端目录暂无插件包" : "暂无可用插件包（未接管理端，或管理端未发布）";
        }
        listBox.appendChild(el("div", "drawer-empty", emptyText));
      }
      const grid = mkGrid(listBox);
      for (const p of hit) {
        const inst = data.installed[p.name];
        const kindLabel = [...new Set(p.items.map((i) => ({ cli: "CLI", skill: "技能", mcp: "MCP 包", asset: "资产" })[i.kind] || i.kind))].join("+");
        const card = mkCard({
          module: "pack",
          id: p.name,
          icon: "archive",
          title: p.title || p.name,
          desc: p.description || "",
          version: kindLabel,
          noSwitch: true,
          stateText: inst ? (inst.version === p.version ? "已安装 v" + inst.version : "v" + inst.version + " → 可更新 v" + p.version) : p.required ? "企业必装 · 待安装" : "未安装",
        });
        const foot = card.querySelector(".mk-foot-r");
        const btn = el("button", "btn");
        btn.style.cssText = "padding:4px 12px;font-size:12px";
        btn.textContent = !inst ? "安装" : inst.version === p.version ? "卸载" : "更新";
        btn.onclick = async () => {
          btn.disabled = true;
          btn.textContent = "处理中…";
          try {
            if (inst && inst.version === p.version) await api.pluginPackUninstall(p.name);
            else await api.pluginPackInstall(p.name);
          } catch (e) {
            alert("插件包操作失败：" + String((e && e.message) || e));
          }
          void render();
        };
        foot.appendChild(btn);
        grid.appendChild(card);
      }
      const orphan = Object.entries(data.installed || {}).filter(([name]) => !data.catalog.some((p) => p.name === name));
      if (orphan.length) {
        listBox.appendChild(mkSection("已装（目录不可达或已下架）", "离线降级可见"));
        const grid2 = mkGrid(listBox);
        for (const [name, info] of orphan) {
          const card = mkCard({ module: "pack", id: name, icon: "archive", title: name, desc: "v" + info.version + " · 安装于 " + String(info.installedAt || "").slice(0, 10), noSwitch: true, stateText: "离线" });
          const btn = el("button", "btn");
          btn.style.cssText = "padding:4px 12px;font-size:12px";
          btn.textContent = "卸载";
          btn.onclick = async () => {
            btn.disabled = true;
            try { await api.pluginPackUninstall(name); } catch (e) { alert(String((e && e.message) || e)); }
            void render();
          };
          card.querySelector(".mk-foot-r").appendChild(btn);
          grid2.appendChild(card);
        }
      }
    };
    input.addEventListener("input", () => void render());
    void render();
  });
}

const openModules = {
  skills: openSkillsModule,
  connectors: openConnectorsModule,
  automations: openAutomationsModule,
  kb: openKnowledgeModule,
  experts: openExpertsModule,
  commands: openCommandsModule,
  packs: openPacksModule,
  requests: openRequestsModule,
};

/* ============ 连接器市场（PRD 4.4 远程 MCP：管理端配置端点与授权；员工启停 + 会话挂载） ============ */
function openConnectorsModule() {
  showModuleView("connectors", "连接器", "企业连接器经管理端配置与授权（HTTP 真执行）；个人连接器可自行添加远端 MCP（端点 + 请求头）；会话挂载在输入框连接器按钮", async (listBox, input) => {
    const render = async () => {
      const conns = (await Promise.resolve(api.listConnectors?.() ?? null)) || null;
      listBox.innerHTML = "";
      if (!conns) {
        listBox.appendChild(el("div", "drawer-empty", "连接器列表需主进程契约扩展（listConnectors）后可用"));
        return;
      }
      const q = mkFilterQ(input);
      const hit = conns.filter((c) => mkHit(c, q, ["name", "displayName", "desc"]));
      // 个人连接器区（自添加）：添加 = 真连通测试（initialize + tools/list）成功才落库
      const personalBtn = el("button", "btn", "＋ 添加个人连接器");
      personalBtn.style.cssText = "padding:4px 12px;font-size:12px;margin-bottom:8px";
      personalBtn.addEventListener("click", () => openAddPersonalConnector(render));
      listBox.appendChild(mkSection("我的连接器", "自行添加的远端 MCP（HTTP）· 默认全部需确认（L2）· 本机存储不出本机"));
      listBox.appendChild(personalBtn);
      const mine = hit.filter((c) => c.personal);
      if (!mine.length) {
        listBox.appendChild(el("div", "drawer-empty", hit.length ? "没有匹配的个人连接器" : "还没有个人连接器（点上方按钮添加，如本地部署的 MCP HTTP 服务）"));
      }
      const myGrid = mkGrid(listBox);
      for (const c of mine) {
        const card = mkCard({
          module: "connector",
          id: c.name,
          icon: "plug",
          title: c.displayName || c.name,
          desc: [c.desc || "", c.endpoint ? `端点 ${c.endpoint}` : "", c.tools?.length ? `工具：${c.tools.join(" / ")}` : ""].filter(Boolean).join(" · "),
          enabled: c.enabled,
          mine: false,
        });
        const rm = el("button", "btn", "删除");
        rm.style.cssText = "padding:4px 12px;font-size:12px";
        rm.addEventListener("click", async () => {
          try {
            await api.removePersonalConnector?.(c.id);
            toast("已删除个人连接器");
          } catch (e) {
            toast(String((e && e.message) || e));
          }
          void render();
        });
        card.querySelector(".mk-foot-r").appendChild(rm);
        myGrid.appendChild(card);
      }
      listBox.appendChild(mkSection("企业连接器", "管理端统一下发 · 授权过滤 · 启停即时生效 · 会话挂载在输入框连接器按钮"));
      const ent = hit.filter((c) => !c.personal);
      if (!ent.length) {
        listBox.appendChild(el("div", "drawer-empty", "暂无企业连接器（管理端配置后经授权下发）"));
        return;
      }
      const grid = mkGrid(listBox);
      for (const c of ent) {
        grid.appendChild(
          mkCard({
            module: "connector",
            id: c.name,
            icon: "plug",
            title: c.displayName || c.name,
            desc: [c.desc || "", c.endpoint ? `端点 ${c.endpoint}` : "", c.tools?.length ? `工具：${c.tools.join(" / ")}` : ""].filter(Boolean).join(" · "),
            enabled: c.enabled,
            mine: false,
          })
        );
      }
    };
    input.addEventListener("input", () => void render());
    void render();
  });
}

/* 添加个人连接器：小表单模态（HTTP 端点 / 本地 stdio 进程 二选一）→ 测试连通 + 落库 */
function openAddPersonalConnector(onDone) {
  const body = openSkillModal("添加个人连接器（MCP）");
  const note = el(
    "div",
    "m-sec",
    "HTTP = MCP Streamable HTTP 端点（JSON/SSE 自适应）；本地进程 = 本机 stdio MCP 服务（命令在你自己的机器上执行，工具默认全部需确认）"
  );
  note.style.cssText = "font-weight:400;letter-spacing:0;margin-bottom:10px";
  body.appendChild(note);
  const form = el("div", "m-form");
  const mkLabel = (t) => {
    const d = el("div", "f-label");
    d.textContent = t;
    return d;
  };
  const mkRow = (labelText, tag, ph) => {
    const row = el("div", "f-row");
    row.appendChild(mkLabel(labelText));
    const i = document.createElement(tag);
    if (tag === "input") i.type = "text";
    i.placeholder = ph;
    row.appendChild(i);
    form.appendChild(row);
    return i;
  };
  const nameI = mkRow("名称（用于挂载与工具前缀）", "input", "如：本机 Jira MCP");
  const typeRow = el("div", "f-row");
  typeRow.appendChild(mkLabel("类型"));
  const typeSel = document.createElement("select");
  typeSel.innerHTML = `<option value="http">HTTP 端点（远端 / 本机 HTTP 服务）</option><option value="stdio">本地进程（stdio 命令）</option>`;
  typeRow.appendChild(typeSel);
  form.appendChild(typeRow);
  const epI = mkRow("端点 URL", "input", "http://127.0.0.1:8000/mcp");
  const hdI = mkRow("请求头 JSON（可选，如 {\"Authorization\": \"Bearer xxx\"}）", "textarea", "");
  const cmdI = mkRow("启动命令", "input", "如：node / python / npx -y @scope/mcp-server 或 C:\\srv\\jira.exe");
  const argI = mkRow("启动参数（可选，空格分隔；路径含空格用 JSON 数组 [\"a b\",\"c\"]）", "input", "--port 8080 --verbose");
  const envI = mkRow("环境变量 JSON（可选，如 {\"API_KEY\": \"xxx\"}）", "textarea", "");
  const cwdI = mkRow("工作目录（可选）", "input", "C:\\servers\\jira-mcp");
  const httpFields = [epI, hdI];
  const stdioFields = [cmdI, argI, envI, cwdI];
  const syncVis = () => {
    const stdio = typeSel.value === "stdio";
    for (const row of httpFields) row.style.display = stdio ? "none" : "";
    for (const row of stdioFields) row.style.display = stdio ? "" : "none";
  };
  typeSel.addEventListener("change", syncVis);
  body.appendChild(form);
  syncVis();
  const bar = el("div", "m-footbar");
  const cancel = el("button", "mini", "取消");
  cancel.type = "button";
  cancel.addEventListener("click", closeSkillModal);
  const ok = el("button", "mini primary", "测试并添加");
  ok.type = "button";
  ok.addEventListener("click", async () => {
    ok.disabled = true;
    ok.textContent = "连接测试中…";
    try {
      const payload = { displayName: nameI.value, transport: typeSel.value };
      if (typeSel.value === "stdio") {
        payload.command = cmdI.value;
        payload.argsText = argI.value;
        payload.envJson = envI.value;
        payload.cwd = cwdI.value;
      } else {
        payload.endpoint = epI.value;
        payload.headersJson = hdI.value;
      }
      const r = await api.addPersonalConnector?.(payload);
      toast(`已添加「${r.name}」（${r.tools} 个工具，默认需确认）`);
      closeSkillModal();
      onDone?.();
    } catch (e) {
      ok.disabled = false;
      ok.textContent = "测试并添加";
      toast(String((e && e.message) || e));
    }
  });
  bar.append(cancel, ok);
  body.appendChild(bar);
  nameI.focus();
}

/* ============ composer 输入符号：@文件 / 常用任务模板 / $技能（ZCode 式） ============ */
let symbolMenuEl = null;
let symbolToken = 0; // 异步竞态防护：列表晚到时（用户已退格/空格跳过）不再渲染过期的菜单
function closeSymbolMenu() {
  symbolToken++;
  if (symbolMenuEl) {
    symbolMenuEl.remove();
    symbolMenuEl = null;
    return true;
  }
  return false;
}

function showSymbolMenu(symbol) {
  closeSymbolMenu();
  const token = symbolToken;
  if (symbol === "@") {
    Promise.resolve(api.getWorkspaceFiles?.() ?? null).then((files) => {
      if (token === symbolToken && files && files.length) {
        // getWorkspaceFiles 返回 {path,size}[]（旧桩为 string[]）：统一取路径
        const paths = files.map((f) => (typeof f === "string" ? f : f && f.path)).filter(Boolean);
        if (paths.length) renderSymbolMenu(paths.map((p) => ({ label: "@" + p, desc: "工作区文件" })));
      }
    });
    return;
  }
  if (symbol === "/") {
    Promise.resolve(api.listTemplates?.() ?? null).then((tpls) => {
      if (token !== symbolToken) return;
      const items = (tpls || []).map((t) => ({
        label: `/${t.name}`,
        desc: t.description || "",
        insert: t.text, // 模板 = 提示词正文：插入后可再编辑（对齐 Cursor /commands）
      }));
      if (api.createTemplate) items.push({ label: "管理模板…", desc: "新建、编辑、删除常用任务", onPick: () => $("nav-commands").click() });
      if (items.length) renderSymbolMenu(items);
    });
    return;
  }
  if (symbol === "$") {
    Promise.resolve(api.listSkills?.() ?? null).then((skills) => {
      if (token !== symbolToken) return;
      // 只列当前可用技能（启用 ∩ 当前专家白名单）；$ 引用会在主进程展开注入
      const active = (skills || []).filter((s) => s.active !== false && s.enabled !== false);
      if (active.length) renderSymbolMenu(active.map((s) => ({ label: `$${s.name}`, desc: `${s.desc || ""}（${s.scope || "企业"}技能）` })));
    });
    return;
  }
}

function renderSymbolMenu(items) {
  const menu = el("div", "menu symbol-menu");
  for (const it of items) {
    const item = el("button", "menu-item");
    item.innerHTML = `<span class="mi-main"><span class="mi-name"></span><span class="mi-desc"></span></span>`;
    item.querySelector(".mi-name").textContent = it.label;
    item.querySelector(".mi-desc").textContent = it.desc || "";
    item.addEventListener("mousedown", (e) => {
      e.preventDefault(); // 保持输入框焦点
      if (it.onPick) {
        it.onPick();
      } else {
        input.value = input.value.replace(/[@/$]$/, (it.insert ?? it.label) + " ");
        autoResize();
        updateSendBtn();
        input.focus();
      }
      closeSymbolMenu();
    });
    menu.appendChild(item);
  }
  document.body.appendChild(menu);
  const r = composer.getBoundingClientRect();
  menu.style.left = r.left + 16 + "px";
  menu.style.top = r.top - menu.offsetHeight - 8 + "px";
  symbolMenuEl = menu;
}

input.addEventListener("input", () => {
  autoResize();
  updateSendBtn();
  const v = input.value;
  const last = v.slice(-1);
  const prev = v.slice(-2, -1);
  if ((last === "@" || last === "/" || last === "$") && (v.length === 1 || prev === " " || prev === "\n")) {
    showSymbolMenu(last);
  } else if (last !== "@" && last !== "/" && last !== "$") {
    closeSymbolMenu(); // 无条件关：既关已开的菜单，也使在途的异步渲染失效（敲符号后立刻退格/空格跳过）
  }
});

// 点击菜单外（非输入框）收起：菜单不该在失去关注后一直挂着
document.addEventListener("mousedown", (e) => {
  if (symbolMenuEl && !e.target.closest(".symbol-menu") && e.target !== input) closeSymbolMenu();
});

/* ============ 快捷命令（/ 常用任务模板）管理页：侧栏模块，与市场页同构 ============ */
function openCommandsModule() {
  showModuleView("commands", "快捷命令", "模板 = 可复用的提示词：输入 / 选中即插入输入框，可再编辑再发送（对齐 Cursor /commands 与 Claude 自定义命令）", (listBox, input) => {
    const render = async () => {
      let tpls = null;
      try {
        tpls = (await Promise.resolve(api.listTemplates?.() ?? null)) || null;
      } catch {}
      listBox.innerHTML = "";
      if (!tpls) {
        listBox.appendChild(el("div", "drawer-empty", "快捷命令需主进程契约扩展（listTemplates）后可用"));
        return;
      }
      const q = mkFilterQ(input);
      const hit = tpls.filter((t) => mkHit(t, q, ["name", "description", "text"]));
      if (hit.length) {
        listBox.appendChild(mkSection("我的模板", "输入 / 快速插入 · 选中后可再编辑再发送"));
        const grid = mkGrid(listBox);
        for (const t of hit) {
          grid.appendChild(
            mkCard({
              module: "template",
              id: t.id,
              icon: "slash",
              title: `/${t.name}`,
              desc: t.description || "",
              perms: (t.text || "").slice(0, 60),
              permsLabel: "",
              // 模板没有启停语义（纯提示词片段），卡片不放开关；点卡片即编辑
              noSwitch: true,
              stateText: t.builtin ? "内置 · 可编辑" : "自定义",
              mine: true,
              onClick: () => openTemplateEditor(t, () => state.moduleRerender?.()),
              onDelete: () => {
                confirmModal(`删除模板 · ${t.name}`, `确定删除模板「${t.name}」？输入 / 时将不再出现。`, "删除", async () => {
                  try {
                    await api.deleteTemplate(t.id);
                    toast(`模板「${t.name}」已删除`);
                    state.moduleRerender?.();
                  } catch (e) {
                    toast(String(e?.message ?? e));
                  }
                });
              },
            })
          );
        }
      } else if (!q) {
        listBox.appendChild(el("div", "drawer-empty", "还没有模板：新建一个，把常用的指令存成一键插入（如每日晨报、周核对）"));
      }
      if (!hit.length && q) listBox.appendChild(el("div", "drawer-empty", "没有匹配的模板"));
      if (!q) {
        const add = el("div", "mk-addrow");
        const nb = el("button", "", `${icon("plus", 13)}新建模板`);
        nb.type = "button";
        nb.addEventListener("click", () => openTemplateEditor(null, () => state.moduleRerender?.()));
        add.appendChild(nb);
        listBox.appendChild(add);
      }
    };
    input.addEventListener("input", () => void render());
    void render();
  });
}

function openTemplateEditor(existing, onSaved) {
  const body = openSkillModal(existing ? `编辑模板 · ${existing.name}` : "新建任务模板");
  const form = el("div", "m-form");
  const mkLabel = (t) => {
    const d = el("div", "f-label");
    d.textContent = t;
    return d;
  };
  const nameRow = el("div", "f-row");
  nameRow.appendChild(mkLabel("模板名（输入 / 触发，如：周报）"));
  const name = document.createElement("input");
  name.type = "text";
  name.placeholder = "周报";
  name.value = existing?.name || "";
  nameRow.appendChild(name);
  form.appendChild(nameRow);
  const descRow = el("div", "f-row");
  descRow.appendChild(mkLabel("一句话说明（菜单里显示）"));
  const desc = document.createElement("input");
  desc.type = "text";
  desc.placeholder = "读取销售数据生成本周周报";
  desc.value = existing?.description || "";
  descRow.appendChild(desc);
  form.appendChild(descRow);
  const textRow = el("div", "f-row");
  textRow.appendChild(mkLabel("模板内容（选中后插入输入框的提示词，可再编辑）"));
  const text = document.createElement("textarea");
  text.rows = 5;
  text.placeholder = "请读取 data/sales.txt，生成本周销售周报，并写入 out/weekly-report.md";
  text.value = existing?.text || "";
  textRow.appendChild(text);
  form.appendChild(textRow);
  body.appendChild(form);
  const bar = el("div", "m-footbar");
  const cancel = el("button", "mini", "取消");
  cancel.type = "button";
  cancel.addEventListener("click", () => {
    closeSkillModal();
    onSaved?.(); // 取消也回列表（弹窗为单例，编辑器关闭后重开管理列表）
  });
  const ok = el("button", "mini primary", existing ? "保存" : "创建");
  ok.type = "button";
  ok.addEventListener("click", async () => {
    const nameV = name.value.trim();
    const textV = text.value.trim();
    if (!nameV) {
      toast("请填写模板名");
      return;
    }
    if (!textV) {
      toast("请填写模板内容");
      return;
    }
    ok.disabled = true;
    try {
      if (existing) await api.updateTemplate(existing.id, { name: nameV, description: desc.value.trim(), text: textV });
      else await api.createTemplate({ name: nameV, description: desc.value.trim(), text: textV });
      toast(existing ? `模板「${nameV}」已保存` : `模板「${nameV}」已创建，输入 / 即可使用`);
      closeSkillModal();
      onSaved?.();
    } catch (e) {
      ok.disabled = false;
      toast(String(e?.message ?? e));
    }
  });
  bar.append(cancel, ok);
  body.appendChild(bar);
  name.focus();
}

/* ============ 工作区选择（输入框下方选项行；仅新建会话/空状态可见，首条消息发出即锚定隐藏） ============
   对齐千问办公（输入框下方可选项）/ WorkBuddy（任务配置区）；锚定规则按 PRD 3.8：默认上次使用，创建后锁定。
   锚定后：选项行隐藏，右下角显示当前工作路径（只读）。 */
let wsState = { currentId: "default", items: [] };

async function loadWorkspaces() {
  const wss = await Promise.resolve(api.listWorkspaces?.() ?? null).catch(() => null);
  if (!wss || !wss.items?.length) {
    $("ws-option-row").classList.add("hidden"); // 契约未扩展（listWorkspaces）时隐藏，不造假入口
    return;
  }
  wsState.currentId = wss.currentId || wsState.currentId;
  wsState.items = wss.items;
  paintWsBtn();
  syncWsSurfaces();
}

function wsCurrent() {
  return wsState.items.find((w) => w.id === wsState.currentId);
}

let wsRoot = ""; // 当前工作区根路径（资源管理器打开用）
function syncWsSurfaces() {
  const cur = wsCurrent();
  wsRoot = cur?.root || wsRoot;
}

/* 原型演示 toast（Electron 实装为真实打开资源管理器） */
function toast(text) {
  document.getElementById("ordo-toast")?.remove();
  const t = el("div", null, `${icon("folder", 14)}<span></span>`);
  t.id = "ordo-toast";
  t.querySelector("span:last-child").textContent = text;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 2600);
}

function paintWsBtn() {
  const cur = wsCurrent();
  const btn = $("ws-btn");
  btn.innerHTML = `${icon("folder", 13)}<span>${cur ? cur.label || cur.root : "工作区"}</span>${icon("chevDown", 12, "chev")}`;
  btn.title = `选择工作区（会话创建后锚定）\n${cur?.root || ""}`;
}

function lockWs() {
  if (!state.wsLocked) {
    state.wsLocked = true;
    $("ws-option-row").classList.add("hidden"); // 锚定后选项行整体隐藏
  }
}
function unlockWs() {
  state.wsLocked = false;
  $("ws-option-row").classList.remove("hidden");
  paintWsBtn();
}

// 浏览本地目录：优先主进程原生目录选择器（pickWorkspace；webkitdirectory 在 Electron file:// 下不可用）
async function browseWorkspace() {
  if (typeof api.pickWorkspace === "function") {
    try {
      const entry = await api.pickWorkspace();
      if (!entry) return; // 用户取消
      if (!wsState.items.some((w) => w.id === entry.id)) wsState.items.push(entry);
      wsState.currentId = entry.id;
      paintWsBtn();
      syncWsSurfaces();
      toast(`已切换工作区：${entry.root}`);
    } catch (e) {
      toast(`切换工作区失败：${(e && e.message) || e}`);
    }
    return;
  }
  wsDirInput.click(); // 无原生选择器时的降级（浏览器原型预览）
}

// 绑定新的本地目录：原型用 webkitdirectory 选择器模拟（Electron 实装为 dialog.showOpenDialog，契约扩展项）
const wsDirInput = Object.assign(document.createElement("input"), { type: "file", webkitdirectory: true });
wsDirInput.style.display = "none";
document.body.appendChild(wsDirInput);
wsDirInput.addEventListener("change", () => {
  const f = wsDirInput.files?.[0];
  wsDirInput.value = "";
  if (!f) return;
  const name = (f.webkitRelativePath || f.name).split("/")[0];
  const id = "picked-" + Date.now();
  const root = "C:\\Users\\demo\\" + name; // 真实路径由主进程目录选择器返回
  wsState.items.push({ id, label: name, root, tag: "新" });
  wsState.currentId = id;
  api.switchWorkspace?.(id, root)?.catch?.(() => {});
  paintWsBtn();
  syncWsSurfaces();
});

$("ws-btn").addEventListener("click", () => {
  if (state.wsLocked || !wsState.items.length) return; // 锚定后选项行整体隐藏
  showMenu(
    $("ws-btn"),
    [
      ...wsState.items.map((w) => ({ id: w.id, name: w.label || w.root, desc: w.root, tag: w.tag })),
      { id: "__browse", name: "打开本地目录…", desc: "选择一个目录作为工作空间", tag: "浏览" },
    ],
    wsState.currentId,
    async (it) => {
      if (it.id === "__browse") {
        await browseWorkspace();
        return;
      }
      if (it.id === wsState.currentId) return;
      try {
        await api.switchWorkspace?.(it.id);
        wsState.currentId = it.id;
        paintWsBtn();
        syncWsSurfaces();
      } catch {}
    }
  );
});

/* ============ 会话标题（顶栏） ============ */
function setSessionTitle(t) {
  $("session-title").textContent = t || "新会话";
  $("session-title").title = t || "";
}

/* ============ composer 资源选择器：附件 / 技能 / 知识库 / 连接器 ============
   附件：真实实现（发送时 base64 经 ordo:prompt 交主进程收进工作区 .inbox，prompt 末尾附路径清单）；
   限流同主进程：单文件 ≤25MB、总量 ≤60MB、个数 ≤10。支持选择/拖拽/粘贴三种入口。
   技能：PRD 3.5 手动触发优先；知识库：PRD 4.5；连接器：PRD 4.4 MCP 真执行 */
let selectedKBs = new Set();
let selectedConns = new Set();
let attachments = [];

const ATT_MAX_COUNT = 10;
const ATT_MAX_FILE = 25 * 1024 * 1024;
const ATT_MAX_TOTAL = 60 * 1024 * 1024;

function addAttachment(name, size, file) {
  if (!name) name = "attachment.bin";
  if (attachments.length >= ATT_MAX_COUNT) {
    toast(`附件最多 ${ATT_MAX_COUNT} 个`);
    return;
  }
  if (size > ATT_MAX_FILE) {
    toast(`「${name}」超过单文件 25MB 上限`);
    return;
  }
  if (attachments.reduce((s, a) => s + a.size, 0) + size > ATT_MAX_TOTAL) {
    toast("附件总大小超过 60MB 上限");
    return;
  }
  const item = { file, name, size };
  if (attKind(item) === "image") item.url = URL.createObjectURL(file); // 缩略图（输入区与气泡共用）
  attachments.push(item);
  renderAttachRow();
}

function renderAttachRow() {
  const row = $("attach-row");
  row.innerHTML = "";
  row.classList.toggle("hidden", !attachments.length);
  updateSendBtn();
  for (let i = 0; i < attachments.length; i++) {
    const a = attachments[i];
    const chip = el("span", "attach-chip" + (attKind(a) === "image" ? " is-img" : ""));
    if (attKind(a) === "image") {
      const img = document.createElement("img");
      img.className = "att-thumb";
      img.src = a.url;
      img.alt = a.name;
      chip.appendChild(img);
      const nm = el("span", "a-name");
      nm.textContent = a.name;
      chip.appendChild(nm);
    } else {
      chip.appendChild(attBadge(a));
      const nm = el("span", "a-name");
      nm.textContent = a.name;
      nm.title = a.name;
      chip.appendChild(nm);
      const sz = el("span", "a-size");
      sz.textContent = a.size != null ? formatSize(a.size) : "";
      chip.appendChild(sz);
    }
    const x = document.createElement("button");
    x.type = "button";
    x.className = "a-x";
    x.innerHTML = icon("x", 11);
    x.addEventListener("click", () => {
      if (a.url) URL.revokeObjectURL(a.url);
      attachments.splice(i, 1);
      renderAttachRow();
    });
    chip.appendChild(x);
    row.appendChild(chip);
  }
}

function clearAttachments() {
  attachments = [];
  renderAttachRow();
}

function fileToBase64(f) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(",")[1] || "");
    r.onerror = () => reject(new Error(`读取「${f.name}」失败`));
    r.readAsDataURL(f);
  });
}

const attachInput = Object.assign(document.createElement("input"), { type: "file", multiple: true });
attachInput.style.display = "none";
document.body.appendChild(attachInput);
attachInput.addEventListener("change", () => {
  for (const f of attachInput.files || []) addAttachment(f.name, f.size, f);
  attachInput.value = "";
});
$("attach-btn").addEventListener("click", () => attachInput.click());

// 拖拽/粘贴收文件（与选择入口同一限流管线；全局拦截 drop 防止窗口被拖放导航）
const composerEl = $("composer");
window.addEventListener("dragover", (e) => e.preventDefault());
window.addEventListener("drop", (e) => e.preventDefault());
composerEl.addEventListener("dragover", (e) => {
  e.preventDefault();
  composerEl.classList.add("dragging");
});
composerEl.addEventListener("dragleave", () => composerEl.classList.remove("dragging"));
composerEl.addEventListener("drop", (e) => {
  e.preventDefault();
  composerEl.classList.remove("dragging");
  for (const f of e.dataTransfer?.files || []) addAttachment(f.name, f.size, f);
});
input.addEventListener("paste", (e) => {
  const files = Array.from(e.clipboardData?.files || []);
  if (!files.length) return;
  e.preventDefault();
  for (const f of files) addAttachment(f.name || `clipboard-${Date.now()}.bin`, f.size, f);
});

/* 附件灯箱：点击气泡缩略图放大，点击遮罩任意处关闭 */
document.addEventListener("click", (e) => {
  if (!(e.target instanceof Element)) return;
  const thumb = e.target.closest(".u-att-img");
  if (thumb instanceof HTMLImageElement) {
    let lb = document.getElementById("att-lightbox");
    if (!lb) {
      lb = el("div");
      lb.id = "att-lightbox";
      document.body.appendChild(lb);
    }
    lb.innerHTML = "";
    const im = new Image();
    im.src = thumb.src;
    lb.appendChild(im);
    return;
  }
  if (e.target.id === "att-lightbox") e.target.remove();
});
function formatSize(n) {
  if (n < 1024) return `${n}B`;
  if (n < 1048576) return `${(n / 1024).toFixed(0)}KB`;
  return `${(n / 1048576).toFixed(1)}MB`;
}
$("attach-btn").addEventListener("click", () => attachInput.click());

$("skill-btn").addEventListener("click", async () => {
  // 只列当前可用技能（启用 ∩ 当前专家白名单）；插入 $name 引用，主进程发送时展开注入
  const skills = ((await api.listSkills?.()) || []).filter((s) => s.active !== false && s.enabled !== false);
  if (!skills.length) {
    toast(api.listSkills ? "暂无可用技能（当前专家未挂载或已全部停用）" : "技能列表需主进程契约扩展（listSkills）");
    return;
  }
  showMenu($("skill-btn"), skills.map((s) => ({ id: s.name, name: `${s.name}`, desc: `${s.desc || ""}（${s.scope || "企业"}技能 · $ 引用注入）` })), null, (it) => {
    input.value = `${input.value.replace(/\s+$/, "")} $${it.id} `;
    input.dispatchEvent(new Event("input"));
    input.focus();
  });
});

function paintBadge(badgeEl, size) {
  if (!badgeEl) return;
  badgeEl.classList.toggle("hidden", size === 0);
  badgeEl.textContent = String(size);
}

function toggleSetMenu(anchor, set, items, badgeEl, onChange) {
  showMenu(anchor, items.map((it) => ({ id: it.id, name: it.name, desc: it.desc, check: set.has(it.id) })), null, (it) => {
    set.has(it.id) ? set.delete(it.id) : set.add(it.id);
    paintBadge(badgeEl, set.size);
    onChange?.([...set]);
    // 重新打开菜单以刷新勾选态
    anchor.click();
  });
}

$("kb-btn").addEventListener("click", async () => {
  const kbs = ((await api.listKnowledgeBases?.()) || []).filter((k) => k.enabled !== false); // 未挂载/已停用的库不出现
  if (!kbs.length) {
    toast(api.listKnowledgeBases ? "暂无可用知识库（管理端未配置，可在知识库页新建个人库）" : "知识库列表需主进程契约扩展（listKnowledgeBases）");
    return;
  }
  // 同步勾选态与主进程挂载集合（挂载只影响当前会话，检索范围即挂载范围）
  const all = (await api.listKnowledgeBases?.()) || [];
  selectedKBs = new Set(all.filter((k) => k.attached).map((k) => k.id));
  toggleSetMenu(
    $("kb-btn"),
    selectedKBs,
    kbs.map((k) => ({ id: k.id, name: k.name, desc: `${k.desc || ""}${k.docCount ? " · " + k.docCount + " 篇" : ""}（${k.scope}库${k.active === false ? " · 当前专家不可用" : ""}）` })),
    $("kb-btn").querySelector(".pill-badge"),
    (ids) => {
      api.setActiveKnowledgeBases?.(ids).then((effective) => {
        // 生效集是挂载 ∩ 启用 ∩ 专家白名单：被过滤的如实提示，不静默
        const eff = new Set(effective || []);
        const blocked = ids.filter((id) => !eff.has(id)).map((id) => all.find((k) => k.id === id)?.name).filter(Boolean);
        const names = [...eff].map((id) => all.find((k) => k.id === id)?.name).filter(Boolean);
        if (blocked.length) {
          toast(`「${blocked.join("、")}」不在当前会话专家的可用范围，本次不可检索${names.length ? `；已生效：${names.join("、")}` : ""}`);
        } else {
          toast(names.length ? `已挂载知识库：${names.join("、")}（对话中可直接提问）` : "已卸载全部知识库");
        }
      }).catch(() => {});
    }
  );
});


$("conn-btn").addEventListener("click", async () => {
  const conns = ((await api.listConnectors?.()) || []).filter((c) => c.enabled !== false); // 停用的连接器不可挂载
  if (!conns.length) {
    toast(api.listConnectors ? "暂无可用连接器（管理端未配置或已停用）" : "连接器列表需主进程契约扩展（listConnectors）");
    return;
  }
  // 同步勾选态与主进程挂载集合（新会话默认不挂载，挂载只影响当前会话）
  const conns0 = (await api.listConnectors?.()) || [];
  selectedConns = new Set(conns0.filter((c) => c.attached).map((c) => c.name));
  toggleSetMenu(
    $("conn-btn"),
    selectedConns,
    conns.map((c) => ({ id: c.name, name: c.displayName || c.name, desc: `${c.desc || ""}${c.tools?.length ? " · " + c.tools.join("/") : ""}${c.active === false ? " · 当前专家不可用" : ""}` })),
    $("conn-btn").querySelector(".pill-badge"),
    (names) => {
      api.setActiveConnectors?.(names).then((effective) => {
        const eff = new Set(effective || []);
        const blocked = names.filter((n) => !eff.has(n));
        if (blocked.length) {
          toast(`「${blocked.join("、")}」不在当前会话专家的可用范围，本次不生效${eff.size ? `；已生效：${[...eff].join("、")}` : ""}`);
        } else {
          toast(names.length ? `已挂载连接器：${names.join("、")}（本会话生效）` : "已卸载全部连接器");
        }
      }).catch(() => {});
    }
  );
});

/* ============ 模型选择器（PRD 3.4：管理端统一配置，员工仅可切换已配置模型） ============ */
let modelState = null;
function paintModelBtn() {
  const btn = $("model-btn");
  if (!modelState || !modelState.items?.length) {
    btn.classList.add("hidden");
    return;
  }
  const cur = modelState.items.find((m) => m.id === modelState.currentId);
  btn.innerHTML = `${icon("cpu", 13)}<span>${cur ? cur.name : "模型"}</span>${icon("chevDown", 12, "chev")}`;
  btn.title = cur?.desc || "切换模型（契约扩展演示）";
}
async function loadModels() {
  modelState = (await api.listModels?.()) || null;
  if (modelState && !modelState.currentId && modelState.items?.length) {
    modelState.currentId = modelState.items[0].id;
  }
  paintModelBtn();
}
$("model-btn").addEventListener("click", () => {
  if (!modelState?.items?.length) return;
  showMenu(
    $("model-btn"),
    modelState.items,
    modelState.currentId,
    async (it) => {
      if (it.id === modelState.currentId) return;
      try {
        await api.switchModel?.(it.id);
        modelState.currentId = it.id;
        paintModelBtn();
      } catch {}
    }
  );
});

/* ============ 新建会话（工作区在输入框下方于新建时选定，新建本身一键直建） ============ */
function resetToEmpty() {
  closeModuleView(); // 新建会话回到对话视图
  state.activeSessionId = null;
  state.artifacts.clear();
  resetWorkbench();
  unlockWs();
  setSessionTitle("新会话");
  thread.querySelectorAll(".turn").forEach((n) => n.remove());
  state.turn = null;
  showEmpty();
  refreshSessions();
}

$("new-session").addEventListener("click", () => startNewSessionIn(null));

/* ============ 侧栏：技能市场 / 自动化 / 知识库 / 专家（主区域切换市场页） ============ */
for (const b of document.querySelectorAll(".side-nav button[data-module]")) {
  b.addEventListener("click", () => toggleModule(b.dataset.module));
}

/* ============ 侧栏底部：个人信息区 + 设置 ============
   对齐 ChatGPT / Claude 桌面端（左下角账号区 → 账号菜单；设置用模态弹窗，含通用/通知/存储/关于）。 */
/* 企业目录（管理端同步，员工只读；PRD 5.1 企业管控） */
// 档案（M6-C）：联机=登录身份（姓名/部门/工号），单机=本机标识；版本与目录来自主进程
const USER = {
  mode: "standalone",
  name: "单机用户",
  dept: "",
  emplId: "",
  mail: "",
  version: "",
  baseUrl: "",
  dataDir: "",
};

function fillUserProfile() {
  if (USER.mode === "online") {
    $("user-name").textContent = USER.name || USER.emplId;
    $("user-dept").textContent = USER.dept ? `${USER.dept} · 工号 ${USER.emplId}` : `工号 ${USER.emplId}`;
    $("user-avatar").textContent = (USER.name || USER.emplId || "?")[0];
  } else {
    $("user-name").textContent = "单机模式";
    $("user-dept").textContent = "本地使用 · 未接入企业";
    $("user-avatar").textContent = "本";
  }
}
fillUserProfile();
// 档案拉取须在 boot 内调用（api 在模块尾声明，此处访问会 TDZ 中断整个模块求值）
function initUserProfile() {
  void Promise.resolve(api.getProfile?.() ?? null).then((pf) => {
    if (!pf) return;
    USER.mode = pf.mode === "online" ? "online" : "standalone";
    USER.name = pf.user?.name ?? "";
    USER.dept = pf.user?.dept ?? "";
    USER.emplId = pf.user?.empNo ?? "";
    USER.mail = pf.user?.dept ? `${pf.user.empNo}@corp.local` : "";
    USER.version = pf.version ?? "";
    USER.baseUrl = pf.baseUrl ?? "";
    USER.dataDir = pf.dataDir ?? "";
    fillUserProfile();
  });
}

$("user-chip").addEventListener("click", (e) => {
  e.stopPropagation();
  openUserMenu();
});

function openUserMenu() {
  closeSessionMenu();
  const menu = el("div", "menu");
  const head = el("div", "menu-user-head");
  head.innerHTML = `<div class="mu-name"></div><div class="mu-mail"></div>`;
  head.querySelector(".mu-name").textContent = USER.mode === "online" ? `${USER.name} · ${USER.dept || "未分部门"}` : "单机模式 · 未接入企业";
  head.querySelector(".mu-mail").textContent = USER.mode === "online" ? USER.mail || `工号 ${USER.emplId}` : "本地技能与个人知识库可用";
  menu.appendChild(head);
  const mk = (label, ic, fn) => {
    const b = el("button", "menu-item");
    b.innerHTML = `<span class="mi-check">${icon(ic, 14)}</span><span class="mi-main"><span class="mi-name"></span></span>`;
    b.querySelector(".mi-name").textContent = label;
    b.addEventListener("click", (e) => {
      e.stopPropagation();
      closeSessionMenu();
      fn();
    });
    return b;
  };
  // M6-C：四项真接线；单机模式下检查更新提示无源、退出登录=切换联机
  const online = USER.mode === "online";
  menu.appendChild(mk("个人信息", "user", () => openProfileModal()));
  menu.appendChild(mk("我的申请", "archive", () => toggleModule("requests")));
  menu.appendChild(
    mk("检查更新", "refresh", async () => {
      if (!online) {
        toast("单机模式无统一更新源（联机后由管理端下发）");
        return;
      }
      toast("正在检查更新…");
      try {
        const r = await api.checkUpdate();
        if (r?.status === "uptodate" || r?.status === "no-source") toast(`已是最新版本（v${r.version}）`);
        else if (r?.status === "failed" || r?.status === "download-failed" || r?.status === "bad-sha")
          toast("更新检查失败，请稍后重试或联系管理员");
        // prompted/locked/downloaded：update-checker 已自行弹窗处理，此处不重复提示
      } catch (e) {
        toast(String((e && e.message) || e));
      }
    })
  );
  menu.appendChild(
    mk(online ? "退出登录" : "切换为联机模式", "close", () => {
      confirmModal(
        online ? "退出登录" : "切换为联机模式",
        online
          ? "将退出当前账号并回到模式选择页。本机的企业下发资源（技能/插件包/配置缓存）与个人数据全部保留，重新登录即可继续使用。"
          : "将回到模式选择页：可登录企业管理端（单机配置与个人数据保留，随时可再切回单机）。",
        online ? "退出登录" : "继续",
        async () => {
          try {
            await api.authLogout();
            location.reload();
          } catch (e) {
            toast(String((e && e.message) || e));
          }
        }
      );
    })
  );
  document.body.appendChild(menu);
  const r = $("user-chip").getBoundingClientRect();
  menu.style.left = Math.min(r.left, window.innerWidth - menu.offsetWidth - 12) + "px";
  menu.style.top = r.top - menu.offsetHeight - 8 + "px";
  sessionMenuEl = menu; // 复用全局「点外部关闭」
}

/* ============ 设置：一级页面（module-page 两栏：左节内子导航 + 右内容区）============
   原则：配置/浏览用页面，瞬时操作用弹窗；个人信息（原弹窗）与主题（原独立页）已并入 */
const SETTINGS_SECTIONS = [
  { id: "general", label: "通用" },
  { id: "account", label: "账号" },
  { id: "model", label: "模型" },
  { id: "memory", label: "记忆" },
  { id: "im", label: "IM 通道" },
  { id: "storage", label: "存储" },
  { id: "theme", label: "主题" },
  { id: "about", label: "关于与企业管控" },
];
let settingsSection = "general"; // 记住所在节：热登录/热退出触发 moduleRerender 时回到原处

function openSettings(section) {
  if (section) settingsSection = section;
  showModuleView("settings", "设置", "", settingsBuilder, { search: false, backTitle: "返回工作区" });
}

function settingsBuilder(container) {
  const page = el("div", "settings-page");
  const nav = el("div", "st-nav");
  const content = el("div", "st-content");
  page.append(nav, content);
  container.appendChild(page);
  const builders = { general: stGeneral, account: stAccount, model: stModel, memory: stMemory, im: stIm, storage: stStorage, theme: stTheme, about: stAbout };
  const render = () => {
    for (const b of nav.querySelectorAll(".st-nav-item")) b.classList.toggle("active", b.dataset.sec === settingsSection);
    content.innerHTML = "";
    builders[settingsSection]?.(content);
    content.scrollTop = 0;
  };
  for (const s of SETTINGS_SECTIONS) {
    const b = el("button", "st-nav-item");
    b.type = "button";
    b.dataset.sec = s.id;
    b.textContent = s.label;
    b.addEventListener("click", () => {
      settingsSection = s.id;
      render();
    });
    nav.appendChild(b);
  }
  render();
}

/* 通用：三项真实持久化（~/.ordo/config/settings.json），点击即保存并热应用 */
function stGeneral(container) {
  container.appendChild(el("div", "m-sec", "通用"));
  const genRows = [
    { key: "autoStart", label: "开机自启", sub: "登录 Windows 后自动启动 Ordo" },
    { key: "desktopNotify", label: "桌面通知", sub: "任务完成 / 待确认操作 / 自动化触发时提醒" },
    { key: "restoreLastSession", label: "启动时恢复上次会话", sub: "关闭前正在进行的会话下次启动自动打开" },
  ].map((r) => {
    const row = mRow(r.label, r.sub, mSwitch(false));
    const sw = row.querySelector(".switch");
    sw.dataset.setting = r.key;
    return row;
  });
  for (const row of genRows) container.appendChild(row);
  void Promise.resolve(api.getSettings?.() ?? null).then((st) => {
    if (!st) return;
    for (const row of genRows) {
      const sw = row.querySelector(".switch");
      sw.classList.toggle("on", st[sw.dataset.setting] !== false);
    }
  });
  for (const row of genRows) {
    row.querySelector(".switch").addEventListener("click", async (e) => {
      const sw = e.currentTarget;
      const next = !sw.classList.contains("on");
      sw.classList.toggle("on", next);
      try {
        await api.setSettings({ [sw.dataset.setting]: next });
      } catch (err) {
        sw.classList.toggle("on", !next);
        toast(String((err && err.message) || err));
      }
    });
  }
}

/* 账号：个人信息并入（原弹窗退役）；退出登录/检查更新仍在左下角用户菜单 */
function stAccount(container) {
  container.appendChild(el("div", "m-sec", "账号"));
  const online = USER.mode === "online";
  const head = el("div", "profile-head");
  head.innerHTML = `<div class="p-avatar"></div><div><div class="p-name"></div><div class="p-sub"></div></div>`;
  head.querySelector(".p-avatar").textContent = online ? (USER.name || USER.emplId || "?")[0] : "本";
  head.querySelector(".p-name").textContent = online ? USER.name || `工号 ${USER.emplId}` : "单机模式";
  head.querySelector(".p-sub").textContent = online
    ? USER.dept ? `${USER.dept} · 工号 ${USER.emplId}` : `工号 ${USER.emplId}`
    : "未接入企业管理端，使用本地能力";
  container.appendChild(head);
  if (online) container.appendChild(mRow("角色", "", `<span class="tag-ent">企业员工</span>`));
  container.appendChild(mRow("使用模式", online ? "已接入管理端，企业资源按授权下发" : "单机模式，企业资源不可用", `<span class="tag-ent">${online ? "联机" : "单机"}</span>`));
  if (online && USER.baseUrl) container.appendChild(mRow("管理端地址", "", `<span class="m-mono">${USER.baseUrl}</span>`));
  if (USER.version) container.appendChild(mRow("客户端版本", "", `<span class="m-mono">v${USER.version}</span>`));
  if (USER.dataDir) container.appendChild(mRow("数据目录", "会话/技能/审计等本机落盘位置", `<span class="m-mono">${USER.dataDir}</span>`));
}

function mRow(label, sub, controlHtml) {
  const row = el("div", "m-row");
  const main = el("div");
  const lab = el("span");
  lab.textContent = label;
  main.appendChild(lab);
  if (sub) {
    const s = el("span", "m-sub");
    s.textContent = sub;
    main.appendChild(s);
  }
  row.appendChild(main);
  if (controlHtml) {
    const c = el("div", "m-actions");
    c.innerHTML = controlHtml;
    row.appendChild(c);
  }
  return row;
}

function mSwitch(on) {
  return `<button class="switch${on ? " on" : ""}" type="button"></button>`;
}

/* IM 通道（一期：钉钉/飞书长连接直连）：手机对话桥接到本机 Agent；绑定码防他人使唤 */
const IM_HINTS = {
  dingtalk: "钉钉：开放平台 → 应用开发 → 创建应用 → 添加「机器人」能力，消息接收模式选「Stream 模式」（无需配置回调地址），把 AppKey / Client Secret 填到下面",
  feishu:
    "飞书：开放平台 → 创建企业自建应用 → 添加「机器人」能力；「事件与回调」订阅方式选「使用长连接接收事件」，添加事件「接收消息 im.message.receive_v1」；「权限管理」开通 im:message:send_as_bot（发消息）与事件提示的接收消息权限；变更后创建版本并发布才生效",
};

function stIm(container) {
  container.appendChild(el("div", "m-sec", "IM 通道"));
  container.appendChild(el("div", "m-sub", "手机上通过钉钉 / 飞书直接给 Ordo 下任务（客户端需保持运行；长连接直连，无需公网服务器）。会话在电脑端同步可见，回复自动推回手机。"));
  const box = el("div");
  container.appendChild(box);
  const imCard = (ch) => {
    const card = el("div", "m-model-form");
    card.dataset.im = ch.id;
    const connText = { off: "未连接", connecting: "连接中…", online: "已连接", error: "连接异常" }[ch.conn] || ch.conn;
    card.innerHTML = `
      <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
        <strong>${ch.label}</strong>
        <span class="tag-ent" data-role="conn" style="${ch.conn === "online" ? "" : "filter:grayscale(.6)"}"></span>
        <span class="m-sub" data-role="detail"></span>
      </div>
      <label class="gate-field">${ch.id === "dingtalk" ? "AppKey（Client ID）" : "App ID"}<input data-k="clientId" type="text" placeholder="${ch.id === "dingtalk" ? "钉钉开放平台应用 AppKey" : "cli_ 开头的应用 App ID"}" /></label>
      <label class="gate-field">${ch.id === "dingtalk" ? "Client Secret" : "App Secret"}<span class="secret-wrap"><input data-k="secret" type="password" placeholder="${ch.hasSecret ? "已保存（可点击眼睛查看；支持 $ENV:变量名）" : "支持 $ENV:变量名 引用，不落明文"}" /><button class="mini secret-eye" type="button" title="显示/隐藏">👁</button></span></label>
      <label class="gate-field">用户 ID（${ch.id === "dingtalk" ? "员工 ID senderStaffId" : "open_id，ou_ 开头"}）<input data-k="boundUser" type="text" placeholder="先给机器人发条消息，它会回复你的 ID，粘贴到这里" /></label>
      <label class="gate-field" style="flex-direction:row;align-items:center;gap:8px">
        <input data-k="autoApprove" type="checkbox" style="width:auto" />
        <span>自动确认敏感操作（等同自动化预授权全开；关闭时手机触发的敏感操作一律拒绝）</span>
      </label>
      <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
        <button class="mini" type="button" data-act="save">保存并连接</button>
        <button class="mini" type="button" data-act="toggle">${ch.enabled ? "停用" : "启用"}</button>
        <span class="m-sub" data-role="bound"></span>
      </div>
      <div class="m-sub">${IM_HINTS[ch.id] || ""}</div>
      <div class="m-sub">用法：保存用户 ID 后，单聊直接发消息，群聊需 @机器人；支持发图片/文件（≤20MB）给 Agent 处理；/get 相对路径 可取工作区文件到手机（飞书支持）；敏感操作会先发确认消息，回复【同意】/【拒绝】；消息进入「IM · ${ch.label}」会话（电脑端可回看）。</div>`;
    const val = (k) => card.querySelector(`[data-k="${k}"]`);
    val("clientId").value = ch.clientId || "";
    val("boundUser").value = ch.boundUser || "";
    val("autoApprove").checked = ch.autoApprove === true;
    // 已保存的 Secret 预填真实值（密码态显示，点眼睛可切换）：值就在本机 config/im-channels.json，遮遮掩掩反而妨碍核对
    if (ch.hasSecret && ch.secretValue) val("secret").value = ch.secretValue;
    const eyeBtn = card.querySelector(".secret-eye");
    if (!eyeBtn) console.error("[IM][DEBUG] eye missing; html=", card.innerHTML);
    else eyeBtn.addEventListener("click", () => {
      const input = val("secret");
      input.type = input.type === "password" ? "text" : "password";
    });
    card.querySelector('[data-role="conn"]').textContent = connText;
    card.querySelector('[data-role="detail"]').textContent = ch.detail || (ch.lastInboundAt ? `最近消息 ${new Date(ch.lastInboundAt).toLocaleTimeString()}` : "");
    card.querySelector('[data-role="bound"]').textContent = ch.boundUser ? `已绑定：${ch.boundName || ch.boundUser}` : "未绑定";
    const reload = async () => {
      try {
        const list = await api.imList();
        const fresh = (list || []).find((x) => x.id === ch.id);
        if (fresh && card.isConnected) {
          const next = imCard(fresh);
          card.replaceWith(next);
        }
      } catch { /* 列表失败保持原样 */ }
    };
    card.querySelector('[data-act="save"]').addEventListener("click", async (e) => {
      const btn = e.currentTarget;
      btn.disabled = true;
      try {
        await api.imSave(ch.id, {
          clientId: val("clientId").value.trim(),
          ...(val("secret").value.trim() ? { secret: val("secret").value.trim() } : {}),
          autoApprove: val("autoApprove").checked,
          enabled: true,
          boundUser: val("boundUser").value.trim(),
        });
        toast(`${ch.label} 配置已保存，正在连接…`);
      } catch (err) {
        toast(String((err && err.message) || err));
      } finally {
        btn.disabled = false;
      }
      await reload();
    });
    card.querySelector('[data-act="toggle"]').addEventListener("click", async (e) => {
      try {
        await api.imSave(ch.id, { enabled: !ch.enabled });
        toast(ch.enabled ? `${ch.label} 已停用` : `${ch.label} 已启用`);
      } catch (err) {
        toast(String((err && err.message) || err));
      }
      await reload();
    });
    return card;
  };
  void Promise.resolve(api.imList?.() ?? [])
    .then((list) => {
      if (!box.isConnected) return;
      for (const ch of list || []) box.appendChild(imCard(ch));
    })
    .catch((e) => {
      console.error("[IM] 通道卡片渲染失败", e);
      box.appendChild(el("div", "m-sub", `⚠️ 通道卡片渲染失败：${String((e && e.message) || e)}`));
    });
}

/* 模型：联机 = 管理端统一下发（只读）；单机/未配置 = 自配单个 API（保存即热生效） */
function stModel(container) {
  container.appendChild(el("div", "m-sec", "模型"));
  const modelBox = el("div");
  container.appendChild(modelBox);
  void (async () => {
    try {
      let st = null;
      try { st = api.getAuthState ? await api.getAuthState() : null; } catch { /* 契约缺失 */ }
      if (st && st.mode === "online") {
        let info = "";
        try {
          const m = await api.listModels();
          const cur = m.items.find((x) => x.id === m.currentId);
          info = cur ? `${cur.name} · 共 ${m.items.length} 个可选` : `共 ${m.items.length} 个可选`;
        } catch { /* 列表失败仍显示来源说明 */ }
        modelBox.appendChild(mRow("企业统一下发", info || "模型与网关由管理端配置", `<span class="tag-ent">联机</span>`));
        return;
      }
      let saved = null;
      try { saved = api.getLocalModel ? await api.getLocalModel() : null; } catch { /* 未配置 */ }
      const f = el("div", "m-model-form");
      f.innerHTML = `
        <label class="gate-field">接口地址（OpenAI 兼容）<input data-k="baseUrl" type="text" placeholder="https://api.deepseek.com/v1" /></label>
        <label class="gate-field">API Key<input data-k="apiKey" type="password" placeholder="sk-…" /></label>
        <label class="gate-field">模型 ID（可查询列表选择，或手填）
          <span style="display:flex;gap:6px">
            <input data-k="modelId" type="text" list="local-model-list" placeholder="deepseek-chat" style="flex:1" />
            <button class="mini" type="button" data-act="list">查询模型列表</button>
          </span>
          <datalist id="local-model-list"></datalist>
        </label>
        <label class="gate-field">模型名称（显示用，可空）<input data-k="modelName" type="text" placeholder="DeepSeek 对话模型" /></label>
        <details class="m-advanced">
          <summary>高级参数</summary>
          <div class="m-adv-body">
            <label class="gate-field">上下文窗口（tokens）<input data-k="contextWindow" type="number" placeholder="131072" /></label>
            <label class="gate-field">最大输出（tokens）<input data-k="maxTokens" type="number" placeholder="16384" /></label>
            <label class="gate-field" style="flex-direction:row;align-items:center;gap:8px">
              <input data-k="thinking" type="checkbox" style="width:auto" />
              <span>思考型模型（启用后可选档位）</span>
            </label>
            <label class="gate-field" style="flex-direction:row;align-items:center;gap:8px">
              <input data-k="vision" type="checkbox" style="width:auto" />
              <span>支持图像识别（多模态模型勾选，可直传图片）</span>
            </label>
            <label class="gate-field" data-role="thinking-level-row">默认思考档位
              <select data-k="thinkingDefault">
                <option value="off">关闭</option>
                <option value="low">低</option>
                <option value="medium" selected>中</option>
                <option value="high">高</option>
              </select>
            </label>
          </div>
        </details>
        <div style="display:flex;gap:8px">
          <button class="mini" type="button" data-act="test">测试连接</button>
          <button class="mini" type="button" data-act="save">保存</button>
          <span class="m-mono" data-role="msg" style="align-self:center"></span>
        </div>`;
      const val = (k) => f.querySelector(`[data-k="${k}"]`);
      for (const k of ["baseUrl", "apiKey", "modelId", "modelName", "contextWindow", "maxTokens"]) val(k).value = saved?.[k] ?? "";
      val("thinking").checked = saved?.thinking === true;
      val("vision").checked = saved?.vision === true;
      if (saved?.thinkingDefault) val("thinkingDefault").value = saved.thinkingDefault;
      const syncThinkingRow = () => {
        f.querySelector('[data-role="thinking-level-row"]').style.display = val("thinking").checked ? "" : "none";
      };
      val("thinking").addEventListener("change", syncThinkingRow);
      syncThinkingRow();
      const msg = f.querySelector('[data-role="msg"]');
      const collect = () => ({
        baseUrl: val("baseUrl").value.trim(),
        apiKey: val("apiKey").value.trim(),
        modelId: val("modelId").value.trim(),
        modelName: val("modelName").value.trim(),
        contextWindow: Number(val("contextWindow").value) > 0 ? Number(val("contextWindow").value) : undefined,
        maxTokens: Number(val("maxTokens").value) > 0 ? Number(val("maxTokens").value) : undefined,
        thinking: val("thinking").checked,
        thinkingDefault: val("thinking").checked ? val("thinkingDefault").value : undefined,
        vision: val("vision").checked,
      });
      // 模型列表发现（M6 增强）：/models 成功 → datalist 可选；失败提示手填
      f.querySelector('[data-act="list"]').addEventListener("click", async (e) => {
        const btn = e.currentTarget;
        btn.disabled = true;
        msg.textContent = "查询中…";
        try {
          const r = await api.listLocalModels(collect());
          const dl = f.querySelector("#local-model-list");
          dl.innerHTML = "";
          for (const id of r.models) {
            const opt = document.createElement("option");
            opt.value = id;
            dl.appendChild(opt);
          }
          msg.textContent = `发现 ${r.models.length} 个模型（输入框可下拉选择）`;
          val("modelId").focus();
        } catch (err) {
          msg.textContent = String((err && err.message) || err);
        } finally {
          btn.disabled = false;
        }
      });
      f.querySelector('[data-act="test"]').addEventListener("click", async (e) => {
        const btn = e.currentTarget;
        btn.disabled = true;
        msg.textContent = "验证中（发送一次最小对话）…";
        try {
          const result = await api.testLocalModel(collect());
          if (result && result.elapsed != null) {
            msg.textContent = `连通 OK · 用时 ${result.elapsed}ms`;
          } else {
            msg.textContent = "连通 OK";
          }
        } catch (err) {
          msg.textContent = String((err && err.message) || err);
        } finally {
          btn.disabled = false;
        }
      });
      f.querySelector('[data-act="save"]').addEventListener("click", async (e) => {
        const btn = e.currentTarget;
        btn.disabled = true;
        msg.textContent = "";
        try {
          await api.setLocalModel(collect());
          const onlineMode = USER.mode === "online";
          msg.textContent = onlineMode ? "已保存（联机模式模型由管理端下发，切单机后生效）" : "已保存并已生效";
          toast(onlineMode ? "模型配置已保存" : "模型配置已生效");
        } catch (err) {
          msg.textContent = String((err && err.message) || err);
        } finally {
          btn.disabled = false;
        }
      });
      modelBox.appendChild(f);
    } catch (e) {
      window.__modelFormErr = String((e && e.stack) || e);
      console.error("[settings-model]", window.__modelFormErr);
    }
  })();
}

/* 记忆系统：原设置弹窗记忆配置移植为设置页「记忆」节（PR #4 贡献，适配新架构：body→container） */
function stMemory(container) {
  // 记忆系统配置
  container.appendChild(el("div", "m-sec", "记忆系统"));
  const memoryBox = el("div");
  container.appendChild(memoryBox);
  void (async () => {
    try {
      const memoryConfig = await api.getMemoryConfig?.() ?? {
        bm25: { enabled: true },
        vector: {
          enabled: false,
          embeddingEndpoint: "",
          embeddingModel: "",
          embeddingDimension: 1024,
          summaryModelSource: "current"
        }
      };

      const form = el("div", "settings-form");
      form.innerHTML = `
        <style>
          .memory-section {
            background: var(--bg-alt);
            border-radius: 8px;
            padding: 16px;
            margin-bottom: 12px;
            border: 1px solid var(--border);
          }
          .memory-section-header {
            display: flex;
            align-items: center;
            justify-content: space-between;
            margin-bottom: 12px;
            padding-bottom: 12px;
            border-bottom: 1px solid var(--border);
          }
          .memory-section-title {
            font-size: 14px;
            font-weight: 600;
            color: var(--fg);
          }
          .memory-section-desc {
            font-size: 12px;
            color: var(--fg-dim);
            margin-top: 4px;
          }
          .memory-config-group {
            background: var(--bg);
            border-radius: 6px;
            padding: 12px;
            margin-top: 12px;
          }
          .memory-config-group-title {
            font-size: 13px;
            font-weight: 600;
            color: var(--fg);
            margin-bottom: 12px;
            padding-bottom: 8px;
            border-bottom: 1px solid var(--border);
          }
          .memory-input-row {
            margin-bottom: 12px;
          }
          .memory-input-row:last-child {
            margin-bottom: 0;
          }
          .memory-input-label {
            display: block;
            font-size: 12px;
            color: var(--fg-dim);
            margin-bottom: 6px;
          }
          .memory-input {
            width: 100%;
            padding: 8px 10px;
            border: 1px solid var(--border);
            border-radius: 4px;
            background: var(--bg-alt);
            color: var(--fg);
            font-size: 13px;
            font-family: inherit;
          }
          .memory-input:focus {
            outline: none;
            border-color: var(--accent);
            background: var(--bg);
          }
          .memory-toggle-row {
            display: flex;
            align-items: center;
            gap: 12px;
            padding: 8px 0;
          }
          .memory-toggle-label {
            font-size: 13px;
            color: var(--fg-dim);
          }
          .memory-test-btn {
            display: inline-flex;
            align-items: center;
            gap: 6px;
            padding: 6px 12px;
            background: var(--bg);
            border: 1px solid var(--border);
            border-radius: 4px;
            color: var(--fg);
            font-size: 12px;
            cursor: pointer;
            transition: all 0.2s;
          }
          .memory-test-btn:hover:not(:disabled) {
            background: var(--bg);
            border-color: var(--accent);
          }
          .memory-test-btn:disabled {
            opacity: 0.5;
            cursor: not-allowed;
          }
          .memory-test-result {
            display: inline-flex;
            align-items: center;
            gap: 6px;
            font-size: 12px;
            margin-left: 8px;
          }
          .memory-save-btn {
            width: 100%;
            padding: 10px;
            background: var(--accent);
            border: none;
            border-radius: 6px;
            color: white;
            font-size: 13px;
            font-weight: 600;
            cursor: pointer;
            transition: all 0.2s;
            margin-top: 16px;
          }
          .memory-save-btn:hover:not(:disabled) {
            opacity: 0.9;
          }
          .memory-save-btn:disabled {
            opacity: 0.5;
            cursor: not-allowed;
          }
        </style>

        <!-- BM25 全文检索 -->
        <div class="memory-section">
          <div class="memory-section-header">
            <div>
              <div class="memory-section-title">BM25 全文检索</div>
              <div class="memory-section-desc">基于 SQLite FTS5 的关键词检索，推荐保持开启</div>
            </div>
            <div class="switch ${memoryConfig.bm25?.enabled !== false ? 'on' : ''}" data-field="bm25"></div>
          </div>
        </div>

        <!-- 向量检索 -->
        <div class="memory-section">
          <div class="memory-section-header">
            <div>
              <div class="memory-section-title">向量检索（语义理解）</div>
              <div class="memory-section-desc">基于 Embedding 模型的语义检索，需配置向量化模型</div>
            </div>
            <div class="switch ${memoryConfig.vector?.enabled ? 'on' : ''}" data-field="vector"></div>
          </div>

          <div id="vector-settings" class="${memoryConfig.vector?.enabled ? '' : 'hidden'}">
            <!-- 总结模型配置 -->
            <div class="memory-config-group">
              <div class="memory-config-group-title">总结模型配置</div>
              <div class="memory-toggle-row">
                <span class="memory-toggle-label">使用当前对话模型</span>
                <div class="switch ${memoryConfig.vector?.summaryModelSource === 'custom' ? 'on' : ''}" data-field="summaryModelSource"></div>
                <span class="memory-toggle-label">自定义模型</span>
              </div>

              <div id="summary-custom-settings" class="${memoryConfig.vector?.summaryModelSource === 'custom' ? '' : 'hidden'}">
                <div class="memory-input-row">
                  <label class="memory-input-label">API 地址</label>
                  <input type="text" class="memory-input" data-field="summaryEndpoint" value="${memoryConfig.vector?.summaryEndpoint || ''}" placeholder="http://localhost:11434/v1" />
                </div>
                <div class="memory-input-row">
                  <label class="memory-input-label">API 密钥</label>
                  <input type="password" class="memory-input" data-field="summaryApiKey" value="${memoryConfig.vector?.summaryApiKey || ''}" placeholder="可选，本地模型可留空" />
                </div>
                <div class="memory-input-row">
                  <label class="memory-input-label">模型名称</label>
                  <input type="text" class="memory-input" data-field="summaryModel" value="${memoryConfig.vector?.summaryModel || ''}" placeholder="qwen2.5:7b" />
                </div>
              </div>

              <div style="margin-top: 12px;">
                <button type="button" class="memory-test-btn" data-act="test-summary">测试连接</button>
                <span class="memory-test-result" data-msg="summary"></span>
              </div>
            </div>

            <!-- 向量化模型配置 -->
            <div class="memory-config-group">
              <div class="memory-config-group-title">向量化模型配置</div>
              <div class="memory-input-row">
                <label class="memory-input-label">API 地址</label>
                <input type="text" class="memory-input" data-field="embeddingEndpoint" value="${memoryConfig.vector?.embeddingEndpoint || ''}" placeholder="http://localhost:11434/v1" />
              </div>
              <div class="memory-input-row">
                <label class="memory-input-label">API 密钥</label>
                <input type="password" class="memory-input" data-field="embeddingApiKey" value="${memoryConfig.vector?.embeddingApiKey || ''}" placeholder="可选，本地模型可留空" />
              </div>
              <div class="memory-input-row">
                <label class="memory-input-label">模型名称</label>
                <input type="text" class="memory-input" data-field="embeddingModel" value="${memoryConfig.vector?.embeddingModel || ''}" placeholder="bge-large-zh-v1.5" />
              </div>
              <div class="memory-input-row">
                <label class="memory-input-label">向量维度</label>
                <input type="number" class="memory-input" data-field="embeddingDimension" value="${memoryConfig.vector?.embeddingDimension || 1024}" placeholder="1024" />
              </div>

              <div style="margin-top: 12px;">
                <button type="button" class="memory-test-btn" data-act="test-embedding">测试连接</button>
                <span class="memory-test-result" data-msg="embedding"></span>
              </div>
            </div>

            <button type="button" class="memory-save-btn" data-act="save-memory">保存配置</button>
            <div class="memory-test-result" data-msg="save" style="display: block; text-align: center; margin-top: 8px;"></div>
          </div>
        </div>
      `;

      // BM25 开关
      const bm25Switch = form.querySelector('[data-field="bm25"]');
      bm25Switch.addEventListener("click", async () => {
        const enabled = !bm25Switch.classList.contains("on");
        try {
          await api.setMemoryConfig?.({ ...memoryConfig, bm25: { enabled } });
          bm25Switch.classList.toggle("on", enabled);
          memoryConfig.bm25.enabled = enabled;
          toast(enabled ? "BM25 检索已开启" : "BM25 检索已关闭");
        } catch (err) {
          toast(String(err?.message || err));
        }
      });

      // 向量检索开关
      const vectorSwitch = form.querySelector('[data-field="vector"]');
      const vectorSettings = form.querySelector('#vector-settings');
      vectorSwitch.addEventListener("click", () => {
        const enabled = !vectorSwitch.classList.contains("on");
        if (enabled) {
          // 打开配置面板，让用户配置
          vectorSwitch.classList.add("on");
          vectorSettings.classList.remove("hidden");
          memoryConfig.vector.enabled = true;
        } else {
          vectorSwitch.classList.remove("on");
          vectorSettings.classList.add("hidden");
          memoryConfig.vector.enabled = false;
          // 立即保存关闭状态
          api.setMemoryConfig?.(memoryConfig).then(() => {
            toast("向量检索已关闭");
          }).catch(err => {
            toast(String(err?.message || err));
          });
        }
      });

      // 总结模型来源切换
      const summarySourceSwitch = form.querySelector('[data-field="summaryModelSource"]');
      const summaryCustomSettings = form.querySelector('#summary-custom-settings');
      summarySourceSwitch.addEventListener("click", () => {
        const isCustom = summarySourceSwitch.classList.contains("on");
        summarySourceSwitch.classList.toggle("on");
        summaryCustomSettings.classList.toggle("hidden", isCustom);
      });

      // 测试总结模型
      form.querySelector('[data-act="test-summary"]').addEventListener("click", async (e) => {
        const btn = e.currentTarget;
        const msg = form.querySelector('[data-msg="summary"]');
        btn.disabled = true;
        msg.textContent = "⏳ 测试中...";
        msg.style.color = "var(--fg-dim)";

        const startTime = Date.now();
        try {
          const isCustom = summarySourceSwitch.classList.contains("on");
          const config = {
            summaryModelSource: isCustom ? 'custom' : 'current',
            summaryEndpoint: form.querySelector('[data-field="summaryEndpoint"]')?.value || "",
            summaryModel: form.querySelector('[data-field="summaryModel"]')?.value || "",
            summaryApiKey: form.querySelector('[data-field="summaryApiKey"]')?.value || ""
          };
          const result = await api.testMemorySummaryModel?.(config);
          const elapsed = Date.now() - startTime;

          if (result?.success) {
            msg.textContent = `✓ 连接成功 · 用时 ${elapsed}ms`;
            msg.style.color = "var(--green)";
          } else {
            msg.textContent = "✗ " + (result?.message || "测试失败");
            msg.style.color = "var(--red)";
          }
        } catch (err) {
          msg.textContent = "✗ " + String(err?.message || err);
          msg.style.color = "var(--red)";
        } finally {
          btn.disabled = false;
        }
      });

      // 测试向量模型
      form.querySelector('[data-act="test-embedding"]').addEventListener("click", async (e) => {
        const btn = e.currentTarget;
        const msg = form.querySelector('[data-msg="embedding"]');
        btn.disabled = true;
        msg.textContent = "⏳ 测试中...";
        msg.style.color = "var(--fg-dim)";

        const startTime = Date.now();
        try {
          const config = {
            embeddingEndpoint: form.querySelector('[data-field="embeddingEndpoint"]').value,
            embeddingModel: form.querySelector('[data-field="embeddingModel"]').value,
            embeddingDimension: parseInt(form.querySelector('[data-field="embeddingDimension"]').value),
            embeddingApiKey: form.querySelector('[data-field="embeddingApiKey"]')?.value || ""
          };
          const result = await api.testMemoryEmbeddingModel?.(config);
          const elapsed = Date.now() - startTime;

          if (result?.success) {
            msg.textContent = `✓ 连接成功 · 用时 ${elapsed}ms · 维度 ${result.dimension || config.embeddingDimension}`;
            msg.style.color = "var(--green)";
            // 自动更新维度
            if (result.dimension) {
              form.querySelector('[data-field="embeddingDimension"]').value = result.dimension;
            }
          } else {
            msg.textContent = "✗ " + (result?.message || "测试失败");
            msg.style.color = "var(--red)";
          }
        } catch (err) {
          msg.textContent = "✗ " + String(err?.message || err);
          msg.style.color = "var(--red)";
        } finally {
          btn.disabled = false;
        }
      });

      // 保存配置
      form.querySelector('[data-act="save-memory"]').addEventListener("click", async (e) => {
        const btn = e.currentTarget;
        const msg = form.querySelector('[data-msg="save"]');
        btn.disabled = true;
        msg.textContent = "💾 保存中...";
        msg.style.color = "var(--fg-dim)";
        try {
          const config = {
            bm25: {
              enabled: bm25Switch.classList.contains("on")
            },
            vector: {
              enabled: vectorSwitch.classList.contains("on"),
              summaryModelSource: summarySourceSwitch.classList.contains("on") ? 'custom' : 'current',
              summaryEndpoint: form.querySelector('[data-field="summaryEndpoint"]')?.value || "",
              summaryModel: form.querySelector('[data-field="summaryModel"]')?.value || "",
              summaryApiKey: form.querySelector('[data-field="summaryApiKey"]')?.value || "",
              embeddingEndpoint: form.querySelector('[data-field="embeddingEndpoint"]').value,
              embeddingModel: form.querySelector('[data-field="embeddingModel"]').value,
              embeddingDimension: parseInt(form.querySelector('[data-field="embeddingDimension"]').value),
              embeddingApiKey: form.querySelector('[data-field="embeddingApiKey"]')?.value || "",
              timeout: 5000,
              maxRetries: 2,
              failureThreshold: 3
            }
          };

          // 验证必填项
          if (config.vector.enabled) {
            if (!config.vector.embeddingEndpoint || !config.vector.embeddingModel) {
              throw new Error("请填写向量化模型的 API 地址和模型名称");
            }
            if (config.vector.summaryModelSource === 'custom') {
              if (!config.vector.summaryEndpoint || !config.vector.summaryModel) {
                throw new Error("请填写自定义总结模型的 API 地址和模型名称");
              }
            }
          }

          await api.setMemoryConfig?.(config);
          msg.textContent = "✓ 保存成功";
          msg.style.color = "var(--green)";
          toast("记忆系统配置已保存");
          Object.assign(memoryConfig, config);
        } catch (err) {
          msg.textContent = "✗ " + String(err?.message || err);
          msg.style.color = "var(--red)";
          toast(String(err?.message || err));
        } finally {
          btn.disabled = false;
        }
      });

      memoryBox.appendChild(form);
    } catch (e) {
      console.error("[settings-memory]", e);
      memoryBox.textContent = "记忆系统配置加载失败：" + String(e?.message || e);
    }
  })();
}

/* 存储：目录清单（默认工作区/个人知识库可改——重启生效、不迁移旧文件；其余固定在数据根） */
function stStorage(container) {
  container.appendChild(el("div", "m-sec", "存储"));
  const openDir = (p) => api.openPath?.(p).catch(() => {});
  // 可改目录行：路径 + 修改/打开位置/恢复默认；修改 = 选目录 → 校验可写 → 落 settings.json（重启生效）
  const dirRowActions = () => `
    <span class="m-mono"></span>
    <button class="mini" data-act="change" type="button">修改</button>
    <button class="mini" data-act="open" type="button">打开位置</button>
    <button class="mini" data-act="reset" type="button">恢复默认</button>`;
  const mkDirRow = (label, sub, key, title, currentPath, fetchEffective) => {
    const row = mRow(label, sub, dirRowActions());
    const pathEl = row.querySelector(".m-mono");
    pathEl.textContent = currentPath;
    pathEl.title = currentPath;
    let saved = ""; // 已保存的覆盖路径（异步初读；变更时同步，打开位置用）
    void Promise.resolve(api.getSettings?.() ?? {}).then(async (s) => {
      saved = String(s?.[key] ?? "");
      if (!saved && fetchEffective) saved = (await Promise.resolve(fetchEffective())) || ""; // 无覆盖时显示实际生效位置
      if (saved && pathEl.isConnected) {
        pathEl.textContent = saved;
        pathEl.title = saved;
      }
    });
    row.querySelector('[data-act="change"]').addEventListener("click", async () => {
      try {
        const dir = await api.pickDir?.(title);
        if (!dir) return;
        await api.setSettings({ [key]: dir });
        saved = dir;
        pathEl.textContent = `${dir}（重启后生效）`;
        pathEl.title = dir;
        toast("已保存：重启客户端后生效（旧文件保留在原目录）");
      } catch (e) {
        toast(String((e && e.message) || e));
      }
    });
    row.querySelector('[data-act="open"]').addEventListener("click", () => openDir(saved || currentPath));
    row.querySelector('[data-act="reset"]').addEventListener("click", async () => {
      try {
        await api.setSettings({ [key]: "" });
        saved = "";
        pathEl.textContent = currentPath;
        pathEl.title = currentPath;
        toast("已恢复默认位置：重启客户端后生效");
      } catch (e) {
        toast(String((e && e.message) || e));
      }
    });
    return row;
  };
  container.appendChild(
    mkDirRow(
      "默认工作区目录",
      "新建会话的读写根（工作区文件、out 产物、.inbox 附件）· 修改后新内容写入新目录，旧文件保留原地",
      "workspaceDir",
      "选择默认工作区目录",
      String(USER.dataDir ?? "").replace(/\\/g, "/").replace(/\/$/, "") + "/workspace",
      async () => {
        const info = await Promise.resolve(api.getWorkspaceInfo?.() ?? null);
        return info?.root ? String(info.root) : "";
      }
    )
  );
  container.appendChild(
    mkDirRow("个人知识库目录", "个人库文档（rag 分块与原文）落盘位置 · 本机私有，管理端不可见", "ragDir", "选择个人知识库目录", String(USER.dataDir ?? "") + "\\rag")
  );
  container.appendChild(mRow("其余数据目录", "会话 / 审计 / 日志 / 插件包缓存 / 配置 / 回收站固定在数据根目录（完整性考虑，不支持移动）", `<span class="m-mono">${USER.dataDir ?? ""}</span>`));
  const clearRow = mRow("清理会话缓存", "不影响会话记录与工作区文件", `<button class="mini" type="button">清理</button>`);
  clearRow.querySelector(".mini").addEventListener("click", () => toast("缓存已清理（演示）"));
  container.appendChild(clearRow);
  // 回收站：删除内容保留 30 天到期自动清理；也可手动永久清空
  const recycleRow = mRow("回收站", "删除内容保留 30 天，到期启动时自动清理", `<span class="m-mono"></span><button class="mini danger" type="button">清空</button>`);
  const statEl = recycleRow.querySelector(".m-mono");
  statEl.textContent = "…";
  const loadRecycleStats = () =>
    void Promise.resolve(api.recycleStats?.() ?? null).then((s) => {
      if (s && statEl.isConnected) {
        statEl.textContent = `${s.count} 项 · ${s.bytes < 1048576 ? `${Math.max(1, Math.round(s.bytes / 1024))}KB` : `${(s.bytes / 1048576).toFixed(1)}MB`}`;
      }
    });
  loadRecycleStats();
  recycleRow.querySelector(".mini.danger").addEventListener("click", () => {
    confirmModal("清空回收站", "将永久删除回收站里的全部内容（此后不可恢复）。确定清空？", "清空", async () => {
      try {
        const n = await api.clearRecycle();
        toast(`回收站已清空（${n} 项）`);
        loadRecycleStats();
      } catch (e) {
        toast(String(e?.message ?? e));
      }
    });
  });
  container.appendChild(recycleRow);
}

/* 主题：原独立一级页并入（预览 + 内置/自定义卡 + 导入 + 教程，复用 theme.js 渲染） */
async function stTheme(container) {
  await renderThemeContent(container);
}

/* 关于与企业管控 */
function stAbout(container) {
  container.appendChild(el("div", "m-sec", "关于与企业管控"));
  const online = USER.mode === "online";
  if (USER.version) container.appendChild(mRow("版本", "", `<span class="m-mono">v${USER.version}</span>`));
  container.appendChild(mRow("使用模式", online ? "企业技能 / 插件包 / 模型网关由管理端统一下发" : "单机使用：本地能力可用，模型自行配置", `<span class="tag-ent">${online ? "联机" : "单机"}</span>`));
  if (online) {
    if (USER.baseUrl) container.appendChild(mRow("管理端地址", "", `<span class="m-mono">${USER.baseUrl}</span>`));
    container.appendChild(mRow("管理端策略", "平台配置由管理端统一下发；本机不可修改管控项", `<span class="tag-ent">已接入</span>`));
    container.appendChild(mRow("数据边界", "推理与企业资源访问全部在企业内网完成", `<span class="tag-ent">数据不出域</span>`));
    container.appendChild(mRow("客户端更新", "新版本由管理端登记下发，低于最低版本将强制升级", `<button class="mini" type="button">检查更新</button>`));
    const upBtn = container.lastElementChild.querySelector(".mini");
    upBtn.addEventListener("click", async () => {
      upBtn.disabled = true;
      toast("正在检查更新…");
      try {
        const r = await api.checkUpdate();
        if (r?.status === "uptodate" || r?.status === "no-source") toast(`已是最新版本（v${r.version}）`);
        else if (r?.status === "failed" || r?.status === "download-failed" || r?.status === "bad-sha") toast("更新检查失败，请稍后重试或联系管理员");
      } catch (e) {
        toast(String((e && e.message) || e));
      } finally {
        upBtn.disabled = false;
      }
    });
  } else {
    container.appendChild(mRow("模型服务", "单机模式经你配置的 API 直连（见「模型」节）", `<span class="tag-ent">自配</span>`));
  }
}


/* ============ 模式与登录 gate（M6-B）：未配置=欢迎页 / 联机待登录=登录表单；成功后主进程 relaunch ============ */
let authGateReady = false;
async function initAuthGate() {
  if (authGateReady) return;
  authGateReady = true;
  const gate = document.getElementById("auth-gate");
  if (!gate || !api.getAuthState) return;
  const elWelcome = document.getElementById("gate-welcome");
  const elLogin = document.getElementById("gate-login");
  const elRestart = document.getElementById("gate-restarting");
  const elBase = document.getElementById("gate-base");
  const elEmp = document.getElementById("gate-emp");
  const elPass = document.getElementById("gate-pass");
  const elErr = document.getElementById("gate-error");
  const elSub = document.getElementById("gate-login-sub");

  const showView = (name) => {
    gate.classList.remove("hidden");
    elWelcome.classList.toggle("hidden", name !== "welcome");
    elLogin.classList.toggle("hidden", name !== "login");
    elRestart.classList.toggle("hidden", name !== "restart");
  };
  const gateError = (msg) => {
    elErr.textContent = msg || "";
    elErr.classList.toggle("hidden", !msg);
  };
  // M6-D 无重启：主进程热接完成后页面 reload（刷新身份/目录/技能等初始状态；进程不退）
  const restart = (sub) => {
    document.getElementById("gate-restart-sub").textContent = sub || "";
    showView("restart");
    setTimeout(() => {
      try {
        location.reload();
      } catch {
        showView("welcome");
      }
    }, 500);
  };

  const apply = async () => {
    try {
      const st = await api.getAuthState();
      if (!st || st.mode === "online" || st.mode === "standalone") {
        gate.classList.add("hidden");
        return;
      }
      if (st.mode === "locked") {
        elBase.value = st.baseUrl || elBase.value || "";
        elSub.textContent = "登录已过期或尚未登录，请重新登录";
        showView("login");
      } else {
        showView("welcome");
      }
    } catch {
      gate.classList.add("hidden"); // 契约缺失（旧 preload）：不拦截
    }
  };

  document.getElementById("gate-online-btn").addEventListener("click", () => {
    gateError("");
    showView("login");
    if (!elBase.value.trim()) elBase.focus();
    else elEmp.focus();
  });
  document.getElementById("gate-standalone-btn").addEventListener("click", async () => {
    try {
      await api.authStandalone();
      restart("已进入单机模式，正在加载…");
    } catch (e) {
      alert("进入单机模式失败：" + String((e && e.message) || e));
    }
  });
  document.getElementById("gate-back").addEventListener("click", () => {
    gateError("");
    showView("welcome");
  });
  const submit = async () => {
    const btn = document.getElementById("gate-submit");
    gateError("");
    btn.disabled = true;
    btn.textContent = "登录中…";
    try {
      await api.authLogin(elBase.value.trim(), elEmp.value.trim(), elPass.value);
      restart("登录成功，正在接入企业管理端…");
    } catch (e) {
      gateError(String((e && e.message) || e));
      btn.disabled = false;
      btn.textContent = "登 录";
    }
  };
  document.getElementById("gate-submit").addEventListener("click", submit);
  elPass.addEventListener("keydown", (e) => {
    if (e.key === "Enter") void submit();
  });
  await apply();
}

// 运行中 token 过期（主进程 401 事件）：锁定回登录视图
function handleAuthExpired() {
  const gate = document.getElementById("auth-gate");
  if (!gate) return;
  document.getElementById("gate-login-sub").textContent = "登录已过期，请重新登录";
  gate.classList.remove("hidden");
  document.getElementById("gate-welcome").classList.add("hidden");
  document.getElementById("gate-restarting").classList.add("hidden");
  document.getElementById("gate-login").classList.remove("hidden");
}

// 个人信息（M6-C → 设置页「账号」节）：登录身份/模式/版本/数据目录/管理端地址
function openProfileModal() {
  closeSessionMenu();
  openSettings("account");
}

// 我的申请（M6-C）：技能上架提交记录（状态/审核备注）；单机无审核流
function openRequestsModule() {
  showModuleView("requests", "我的申请", "向管理端提交的技能上架申请及审核进度（PRD 4.3/5.1）；审核通过后发布到企业市场", async (listBox, input) => {
    const render = async () => {
      listBox.innerHTML = "";
      const q = mkFilterQ(input);
      let subs = [];
      try {
        subs = (await Promise.resolve(api.skillSubmissions?.() ?? [])) || [];
      } catch {
        subs = [];
      }
      if (USER.mode !== "online") {
        listBox.appendChild(el("div", "drawer-empty", "单机模式无企业审核流：自建技能保存即用，接入管理端后可提交上架"));
        return;
      }
      const hit = subs.filter((x) => mkHit(x, q, ["name", "version", "status"]));
      listBox.appendChild(mkSection(`提交记录（${subs.length}）`, "已提交 / 审核中 / 已通过 / 已驳回"));
      if (!hit.length) {
        listBox.appendChild(el("div", "drawer-empty", subs.length ? "没有匹配的申请" : "暂无申请：在技能市场提交「审核上架」后会显示在这里"));
      }
      const grid = mkGrid(listBox);
      for (const sub of hit) {
        const badge = { submitted: ["已提交", "tag-ver"], reviewing: ["审核中", "tag-ver"], approved: ["已通过", "tag-ok"], rejected: ["已驳回", "tag-danger"] }[sub.status] ?? [sub.status, ""];
        const stamp = String(sub.submittedAt ?? "").slice(0, 16).replace("T", " ");
        const card = mkCard({
          module: "request",
          id: sub.id,
          icon: "archive",
          title: sub.name,
          desc: `v${sub.version} · 提交于 ${stamp}${sub.reviewerNote ? ` · 审核备注：${sub.reviewerNote}` : ""}`,
          version: "",
          noSwitch: true,
          stateText: badge[0],
        });
        grid.appendChild(card);
      }
    };
    input.addEventListener("input", () => void render());
    void render();
  });
}

$("open-settings").addEventListener("click", () => {
  if (activeModule === "settings") closeModuleView(); // 再点齿轮 = 返回工作区（与市场页同语义）
  else openSettings();
});

/* ============ Esc（§6.4）：弹窗 > 市场页/设置页 > 抽屉 > 符号菜单 > 选择器菜单 > 确认拒绝 ============ */
document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  if (skillModalEl) {
    closeSkillModal();
    return;
  }
  if (activeModule) {
    closeModuleView();
    return;
  }
  if (state.wb.newTab && state.wb.activeTab === "newtab") {
    // 新标签页：二级页先回入口，入口再 Esc 即丢弃
    if (state.wb.newTab.view !== "home") {
      state.wb.newTab.view = "home";
      renderNewTabPage();
    } else closeNewTab();
    return;
  }
  if (closeDrawer()) return;
  if (closeSymbolMenu()) return;
  if (closeMenu()) return;
  if (state.pendingConfirm) {
    state.pendingConfirm.card.decide(false);
  }
});

/* ============ composer 下拉菜单（§3.5） ============ */
let openMenuEl = null;
function closeMenu() {
  expertBtn.classList.remove("open");
  thinkingBtn.classList.remove("open");
  confirmModeBtn.classList.remove("open");
  if (openMenuEl) {
    openMenuEl.remove();
    openMenuEl = null;
    return true;
  }
  return false;
}
document.addEventListener("click", (e) => {
  if (openMenuEl && !openMenuEl.contains(e.target) && !e.target.closest(".pill, .ws-option")) closeMenu();
});

function showMenu(anchor, items, currentId, onPick) {
  closeMenu();
  anchor.classList.add("open");
  const menu = el("div", "menu");
  for (const it of items) {
    const desc = it.description || it.desc;
    const checked = it.check || it.id === currentId;
    const item = el("button", "menu-item");
    item.innerHTML =
      `<span class="mi-check" style="visibility:${checked ? "visible" : "hidden"}">${icon("check", 14)}</span>` +
      `<span class="mi-main"><span class="mi-name"></span>` +
      (desc ? `<span class="mi-desc"></span>` : "") +
      `</span>` +
      (it.tag ? `<span class="mi-tag">${it.tag}</span>` : "");
    item.querySelector(".mi-name").textContent = it.name ?? it.label; // 思考档契约字段为 label
    if (desc) item.querySelector(".mi-desc").textContent = desc;
    item.addEventListener("click", () => {
      closeMenu();
      onPick(it);
    });
    menu.appendChild(item);
  }
  document.body.appendChild(menu);
  const r = anchor.getBoundingClientRect();
  menu.style.left = Math.min(r.left, window.innerWidth - menu.offsetWidth - 12) + "px";
  menu.style.top = r.top - menu.offsetHeight - 8 + "px";
  openMenuEl = menu;
}

function paintExpertBtn() {
  const cur = (state.experts?.items || []).find((x) => x.id === state.experts.currentId);
  expertBtn.innerHTML = `${icon("user", 13)}<span>${cur ? cur.name : "通用助手"}</span>${icon("chevDown", 12, "chev")}`;
}
function paintThinkingBtn() {
  const cur = (state.thinkingState?.items || []).find((x) => x.id === state.thinkingState.currentId);
  if (!state.thinkingState || !state.thinkingState.items.length) {
    thinkingBtn.classList.add("hidden");
    return;
  }
  thinkingBtn.innerHTML = `${icon("brain", 13)}<span>思考 · ${cur ? cur.label : "中"}</span>${icon("chevDown", 12, "chev")}`;
}

expertBtn.addEventListener("click", () => {
  if (state.wsLocked) return; // 专家随会话锁定：仅新建会话（选项行可见）时可选
  if (!state.experts) return;
  const enabled = state.experts.items.filter((x) => x.enabled !== false); // 专家市场停用的角色不出现在选择器
  showMenu(expertBtn, enabled, enabled.find((x) => x.id === state.experts.currentId)?.id, (it) => {
    api.switchExpert(it.id).catch(() => {});
  });
});
thinkingBtn.addEventListener("click", () => {
  if (!state.thinkingState) return;
  showMenu(thinkingBtn, state.thinkingState.items, state.thinkingState.currentId, (it) => {
    api.switchThinking(it.id).catch(() => {});
  });
});

/* ============ 操作确认模式（三档；保存后当前对话的下一条消息起生效） ============ */
const DELIVERY_TOOLS = new Set(["write_file", "write_docx", "write_pptx", "edit_docx", "edit_pptx", "edit_xlsx"]);
const CONFIRM_MODES = [
  { id: "ask", name: "每次确认", desc: "所有敏感操作（写文件 / 执行命令 / 打开网页等）都弹出确认卡" },
  { id: "autoEdit", name: "自动编辑", desc: "写文件与 Word / PPT / Excel 编辑自动执行；命令、联网、保存技能、连接器仍需确认" },
  { id: "auto", name: "完全托管", desc: "全部敏感操作自动执行并逐条留审计，不再弹出确认卡" },
];
let confirmMode = "ask";
function paintConfirmModeBtn() {
  const cur = CONFIRM_MODES.find((m) => m.id === confirmMode);
  confirmModeBtn.innerHTML = `${icon("shield", 13)}<span>${cur ? cur.name : "每次确认"}</span>${icon("chevDown", 12, "chev")}`;
  confirmModeBtn.classList.toggle("mode-auto", confirmMode === "auto");
}
confirmModeBtn.addEventListener("click", () => {
  showMenu(confirmModeBtn, CONFIRM_MODES, confirmMode, async (it) => {
    if (it.id === confirmMode) return;
    if (
      it.id === "auto" &&
      !confirm("完全托管：新会话中 Agent 的所有敏感操作（写文件、执行命令、打开网页、连接器等）将自动执行，不再逐项确认（审计仍逐条留痕）。\n确定切换吗？")
    ) {
      return;
    }
    const prev = confirmMode;
    confirmMode = it.id;
    paintConfirmModeBtn();
    try {
      const st = await api.setSettings?.({ confirmMode: it.id });
      if (st && st.confirmMode) confirmMode = st.confirmMode; // 以主进程归一化结果为准
    } catch {
      confirmMode = prev; // 保存失败回滚按钮显示
    }
    paintConfirmModeBtn();
    // 生效口径在主进程（轮级锁定）：保存后当前对话的下一条消息起生效，一轮内模式恒定
    const name = (CONFIRM_MODES.find((m) => m.id === confirmMode) || {}).name || it.name;
    toast(`已保存；当前对话的下一条消息起生效（${name}）`);
  });
});

/* ============ 侧栏会话（§3.2）——WorkBuddy「空间」模式 ============
   对齐 WorkBuddy 任务列表（官方文档「任务管理」）：
   - 会话按工作空间归档分组（Ordo 会话创建即锚定工作区，PRD 3.8），分组标题吸顶、点击折叠；
   - 任务卡片三字段：标题 / 当前状态（运行中）/ 最近更新时间；
   - 任务级操作（悬停 ⋯）：置顶 / 重命名 / 打开工作区文件夹 / 删除；
   - 组级操作（悬停组头）：组内新建会话 / 打开工作空间文件夹。
   契约扩展（原型演示）：pinSession / renameSession / deleteSession（openWorkspaceDir 已有提案）。 */
let sessionQ = "";
const collapsedWs = new Set();

const sessionSearchInput = $("session-search");
sessionSearchInput.addEventListener("input", () => {
  sessionQ = sessionSearchInput.value;
  refreshSessions();
});
window.addEventListener("keydown", (e) => {
  if ((e.ctrlKey || e.metaKey) && (e.key === "k" || e.key === "K")) {
    const tag = document.activeElement?.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA") return;
    e.preventDefault();
    sessionSearchInput.focus();
    sessionSearchInput.select();
  }
});

let rsInFlight = false; // 刷新串行化：本函数有多处 await（IPC 往返），事件连发时两次渲染交错会画出重复分组
let rsAgain = false;
async function refreshSessions() {
  if (rsInFlight) {
    rsAgain = true; // 正在刷：只标记，当前轮结束后用最新数据补跑一轮
    return;
  }
  rsInFlight = true;
  try {
    do {
      rsAgain = false;
      await refreshSessionsOnce();
    } while (rsAgain);
  } finally {
    rsInFlight = false;
  }
}

async function refreshSessionsOnce() {
  let list = [];
  try {
    list = await api.listSessions();
  } catch {
    return;
  }
  sessionList.innerHTML = "";
  const seenIds = new Set();
  list = list.filter((s) => !seenIds.has(s.id) && seenIds.add(s.id)); // 会话源兜底去重（同一 id 只画一张卡）
  const q = sessionQ.trim().toLowerCase();
  const matched = q ? list.filter((s) => (s.title || "").toLowerCase().includes(q)) : list;
  if (!matched.length) {
    sessionList.appendChild(el("div", "session-empty", q ? "没有匹配的会话" : "暂无历史会话"));
    return;
  }
  let wsItems = [];
  try {
    wsItems = ((await Promise.resolve(api.listWorkspaces?.())) || {}).items || [];
  } catch {}
  const wsMap = new Map(wsItems.map((w) => [w.id, w]));
  const byWs = new Map();
  for (const s of matched) {
    const key = s.wsId && wsMap.has(s.wsId) ? s.wsId : wsItems[0]?.id || "default";
    if (!byWs.has(key)) byWs.set(key, []);
    byWs.get(key).push(s);
  }
  // 组间排序：项目工作区按最近活动在前，默认工作区（个人杂项）固定垫底
  const ts = (s) => +new Date(s.updatedAt || 0);
  const isDefaultWs = (id) => id === "default" || wsMap.get(id)?.tag === "默认";
  const ordered = [...byWs.entries()].sort((a, b) => {
    if (isDefaultWs(a[0]) !== isDefaultWs(b[0])) return isDefaultWs(a[0]) ? 1 : -1;
    return Math.max(...b[1].map(ts)) - Math.max(...a[1].map(ts));
  });
  for (const [wsId, items] of ordered) renderWsGroup(wsId, wsMap.get(wsId), items);
}

function renderWsGroup(wsId, ws, items) {
  // 组内：置顶优先，其余按最近更新倒序（WorkBuddy：置顶 = 置于列表顶端）
  items.sort((a, b) => +!!b.pinned - +!!a.pinned || +new Date(b.updatedAt || 0) - +new Date(a.updatedAt || 0));
  const wrap = el("div", "session-group" + (collapsedWs.has(wsId) ? " collapsed" : ""));
  const head = el("div", "ws-group-head");
  head.innerHTML = `<span class="chev">${icon("chevDown", 11)}</span><span class="g-name"></span><span class="g-cnt"></span>`;
  const name = ws?.label || (ws?.root || "").split("\\").pop() || "会话";
  head.querySelector(".g-name").textContent = name;
  head.querySelector(".g-name").title = ws?.root || name;
  head.querySelector(".g-cnt").textContent = items.length;
  head.addEventListener("click", () => {
    collapsedWs.has(wsId) ? collapsedWs.delete(wsId) : collapsedWs.add(wsId);
    refreshSessions();
  });
  const acts = el("span", "g-acts");
  const addBtn = document.createElement("button");
  addBtn.type = "button";
  addBtn.title = "在此工作区新建会话";
  addBtn.innerHTML = icon("plus", 13);
  addBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    startNewSessionIn(ws);
  });
  const dirBtn = document.createElement("button");
  dirBtn.type = "button";
  dirBtn.title = "打开工作区文件夹";
  dirBtn.innerHTML = icon("folderOpen", 13);
  dirBtn.addEventListener("click", async (e) => {
    e.stopPropagation();
    await openWsDir(ws?.root);
  });
  acts.append(addBtn, dirBtn);
  head.appendChild(acts);
  wrap.appendChild(head);
  for (const s of items) wrap.appendChild(buildSessionItem(s, ws));
  sessionList.appendChild(wrap);
}

async function openWsDir(root) {
  try {
    await api.openWorkspaceDir?.(root);
    toast(`已在文件资源管理器打开：${root || ""}`);
  } catch {
    toast("打开目录失败（需主进程契约扩展 openWorkspaceDir）");
  }
}

async function startNewSessionIn(ws) {
  if (state.status !== "idle") return;
  if (ws?.id && ws.id !== wsState.currentId) {
    wsState.currentId = ws.id; // 预选工作区：新会话锚定到该工作区（PRD 3.8）
    api.switchWorkspace?.(ws.id, ws.root)?.catch?.(() => {});
    paintWsBtn();
    syncWsSurfaces();
  }
  try {
    await api.newSession();
  } catch {}
  resetToEmpty();
}

function buildSessionItem(s, ws) {
  const isActive = s.id === state.activeSessionId;
  const running = isActive && state.status !== "idle";
  const item = el("div", "session-item" + (isActive ? " active" : ""));
  const t = el("div", "t");
  if (s.pinned) {
    const flag = el("span", "pin-flag", icon("pin", 11));
    t.appendChild(flag);
  }
  const tText = document.createElement("span");
  tText.textContent = s.title || "新会话";
  t.appendChild(tText);
  t.title = s.title || "";
  const d = el("div", "d");
  if (running) {
    d.innerHTML = `<span class="run-dot"></span>运行中`; // WorkBuddy 卡片字段：当前状态
  } else {
    d.textContent = relTime(s.updatedAt); // 最近更新时间
  }
  const acts = el("div", "acts");
  const more = document.createElement("button");
  more.type = "button";
  more.title = "更多操作";
  more.innerHTML = icon("more", 15);
  more.addEventListener("click", (e) => {
    e.stopPropagation();
    openSessionMenu(more, s, item, ws);
  });
  acts.appendChild(more);
  item.append(t, d, acts);
  item.addEventListener("click", () => {
    if (!item.dataset.mode) openSession(s.id);
  });
  return item;
}

/* 会话条目菜单：向下弹出（区别于 composer 的向上菜单），危险项标红 */
let sessionMenuEl = null;
function closeSessionMenu() {
  sessionMenuEl?.remove();
  sessionMenuEl = null;
}
document.addEventListener("click", (e) => {
  if (sessionMenuEl && !sessionMenuEl.contains(e.target)) closeSessionMenu();
});

function openSessionMenu(anchor, s, item, ws) {
  closeSessionMenu();
  const menu = el("div", "menu");
  const mk = (label, ic, cls, fn) => {
    const b = el("button", "menu-item" + (cls ? " " + cls : ""));
    b.innerHTML =
      `<span class="mi-check">${icon(ic, 14)}</span>` +
      `<span class="mi-main"><span class="mi-name"></span></span>`;
    b.querySelector(".mi-name").textContent = label;
    b.addEventListener("click", (e) => {
      e.stopPropagation();
      closeSessionMenu();
      fn();
    });
    return b;
  };
  menu.appendChild(
    mk(s.pinned ? "取消置顶" : "置顶", "pin", "", async () => {
      try {
        await api.pinSession?.(s.id, !s.pinned);
      } catch {}
      refreshSessions();
    })
  );
  menu.appendChild(mk("重命名", "pencil", "", () => startRename(item, s)));
  menu.appendChild(mk("打开工作区文件夹", "folderOpen", "", () => openWsDir(ws?.root)));
  menu.appendChild(mk("删除", "trash", "danger", () => startDelete(item, s)));
  document.body.appendChild(menu);
  const r = anchor.getBoundingClientRect();
  const left = Math.min(r.left, window.innerWidth - menu.offsetWidth - 12);
  let top = r.bottom + 6;
  if (top + menu.offsetHeight > window.innerHeight - 12) top = r.top - menu.offsetHeight - 6;
  menu.style.left = left + "px";
  menu.style.top = top + "px";
  sessionMenuEl = menu;
}

function startRename(item, s) {
  if (item.dataset.mode) return;
  item.dataset.mode = "rename";
  const t = item.querySelector(".t");
  const input = document.createElement("input");
  input.className = "rename";
  input.value = s.title || "";
  t.replaceWith(input);
  input.focus();
  input.select();
  let done = false;
  const finish = async (commit) => {
    if (done) return;
    done = true;
    const title = input.value.trim();
    if (commit && title && title !== s.title) {
      try {
        await api.renameSession?.(s.id, title);
      } catch {}
      if (s.id === state.activeSessionId) setSessionTitle(title);
    }
    refreshSessions();
  };
  input.addEventListener("keydown", (e) => {
    e.stopPropagation();
    if (e.key === "Enter") finish(true);
    else if (e.key === "Escape") finish(false);
  });
  input.addEventListener("blur", () => finish(true));
  input.addEventListener("click", (e) => e.stopPropagation());
}

function startDelete(item, s) {
  if (item.dataset.mode) return;
  item.dataset.mode = "delete";
  const row = el("div", "del-row");
  const tip = document.createElement("span");
  tip.textContent = "删除后不可恢复";
  const ok = el("button", "mini danger");
  ok.type = "button";
  ok.textContent = "删除";
  const cancel = el("button", "mini");
  cancel.type = "button";
  cancel.textContent = "取消";
  row.append(tip, ok, cancel);
  item.querySelectorAll(".t, .d, .acts").forEach((n) => n.remove());
  item.appendChild(row);
  ok.addEventListener("click", async (e) => {
    e.stopPropagation();
    try {
      await api.deleteSession?.(s.id);
    } catch {}
    if (s.id === state.activeSessionId) {
      state.activeSessionId = null;
      try {
        await api.newSession?.();
      } catch {}
      resetToEmpty();
    }
    refreshSessions();
  });
  cancel.addEventListener("click", (e) => {
    e.stopPropagation();
    item.dataset.mode = "";
    refreshSessions();
  });
}

async function openSession(id) {
  if (state.status !== "idle") return;
  closeModuleView(); // 点会话回到对话视图
  try {
    const s2 = await api.loadSession(id);
    state.activeSessionId = id;
    setSessionTitle(s2.title);
    renderHistory(s2.messages || []);
    lockWs(); // 已有会话：工作区与专家随会话锚定，选项行隐藏（与 session_loaded 对齐）
    refreshSessions();
    loadWorkspaces(); // 会话可能锚定其他工作区：主进程已重锚定，同步顶栏显示
  } catch (err) {
    append(createError({ title: "会话加载失败", why: String((err && err.message) || err), next: "重试点击该会话" }));
  }
}

/* ============ 工作区信息（顶栏文件夹按钮：资源管理器打开工作目录） ============ */
async function initWorkspace() {
  try {
    const info = await api.getWorkspaceInfo();
    wsRoot = info.root;
  } catch {}
}

/* ============ 启动 ============ */
let api = window.ordo;

export async function boot(mockApi) {
  if (mockApi) {
    api = mockApi;
    // 原型演示钩子（正式版无）
    window.__sdDemo = {
      send: (t) => send(t),
      openSession,
      reset: () => {
        if (state.status !== "idle") return;
        state.activeSessionId = null;
        thread.querySelectorAll(".turn").forEach((n) => n.remove());
        state.turn = null;
        showEmpty();
        refreshSessions();
      },
    };
  }
  bindMarkdownActions(document.body);
  initTheme(api);
  initUserProfile();
  void initAuthGate();
  // 事件分发异常不静默：留痕到 window.__lastErr 并打到控制台（冒烟/排查用）
  api.onEvent((ev) => {
    try {
      handleEvent(ev);
    } catch (e) {
      window.__lastErr = String((e && e.stack) || e);
      console.error("[ordo-event]", ev && ev.type, window.__lastErr);
      throw e;
    }
  });
  await initWorkspace();

  state.experts = await api.listExperts().catch(() => null);
  if (state.experts) {
    // 契约：listExperts 返回 current 对象（ExpertInfo）；mock 可能只给 currentId
    state.experts.currentId = state.experts.current?.id ?? state.experts.currentId ?? state.experts.items?.[0]?.id;
  }
  paintExpertBtn();

  state.thinkingState = await api.thinkingState().catch(() => null);
  if (state.thinkingState) {
    state.thinkingState.currentId =
      state.thinkingState.current?.id ?? state.thinkingState.currentId ?? state.thinkingState.items?.[0]?.id;
  }
  paintThinkingBtn();

  // L2 确认模式（composer 按钮）：读本地设置，缺省每次确认
  void Promise.resolve(api.getSettings?.() ?? {}).then((st) => {
    if (st && st.confirmMode) confirmMode = st.confirmMode;
    paintConfirmModeBtn();
  });

  await refreshSessions();
  await loadWorkspaces();
  await loadModels();
  // 启动恢复会话（session_loaded）可能与 boot 并发：已有历史内容时不叠画空态
  if (!thread.querySelector(".turn") && !(emptyEl && emptyEl.isConnected)) ensureEmptyState();
  updateSendBtn();
  autoResize();
  await loadSavedTheme();
}

export { handleEvent, setStatus };
