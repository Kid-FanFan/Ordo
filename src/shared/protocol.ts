// UI 事件契约：主进程 → 渲染进程（对应 PRD 3.1 流式输出 / 3.7 步骤级可见性 / 3.9 L2 确认 / 3.10 专家切换）
export type UiEvent =
  | { type: "run_start"; prompt?: string }
  | { type: "run_end" }
  | { type: "text_delta"; text: string }
  | { type: "thinking_delta"; text: string }
  | { type: "assistant_done" }
  | { type: "tool_start"; name: string }
  | { type: "tool_end"; name: string }
  | { type: "notice"; text: string }
  /** 计划上报（update_plan 工具直通，方案 §3）：浮标与工作台进度以此为准（D3：计划进度，非工具步骤） */
  | { type: "plan_update"; steps: Array<{ text: string; status: "pending" | "running" | "done" }> }
  | { type: "confirm_request"; id: string; tool: string; args: Record<string, unknown> }
  | { type: "expert_switched"; id: string; name: string }
  | { type: "thinking_switched"; id: string; label: string }
  | { type: "session_loaded"; id: string; title: string; expert: string; messages: unknown[] }
  | { type: "session_saved"; id: string; title: string }
  | { type: "skills_changed"; reason: string }
  /** 会话挂载集合变化（连接器/知识库）：含新建、续接会话时的清空；徽标与选中态以此为准 */
  | { type: "mounts_changed"; connectors: string[]; kbs: string[] }
  /** 运行中消息队列变化（引导/排队）：items 为当前未消费条目（输入框右上方排队区数据源） */
  | { type: "queue_changed"; items: Array<{ entryId: string; kind: "steer" | "followUp"; text: string }> }
  /** 本地型定时任务一次无人值守运行结束（PRD 3.7）：提醒 + 刷新侧栏（运行会话可回看），不打断当前会话 */
  | { type: "automation_run"; id: string; name: string; ok: boolean; summary: string; sessionId?: string }
  /** 浏览器桥状态变化（方案 §5）：面板据此刷新浏览器标签/工具条 */
  | { type: "browser_state_changed" }
  /** 桥请求导航（webview 内嵌后由渲染端 webview 实际加载） */
  | { type: "browser_navigate"; url: string }
  /** 急停：渲染端销毁浏览器标签与 webview */
  | { type: "browser_stop" }
  /** 浏览器控制台有新输出（方案 §5）：控制台子面板增量刷新 */
  | { type: "browser_console_append" }
  /** 交付物登记（非 write_file 链路产物，如浏览器截图存证）：浮层与预览入口即时可用 */
  | { type: "artifact_added"; path: string }
  /** IM 通道状态（钉钉/飞书长连接）：设置页据此刷新；touchedSessionId 存在时表示有 IM 会话更新需刷侧栏 */
  | { type: "im_channels"; channels: ImChannelInfo[]; touchedSessionId?: string }
  | {
      type: "context_compacted";
      tokensBefore: number;
      tokensAfter: number;
      messagesBefore: number;
      messagesAfter: number;
      summary: string;
    };

export interface WorkspaceInfo {
  product: string;
  root: string;
  home: string;
}

export interface ThinkingState {
  current: { id: string; label: string };
  items: Array<{ id: string; label: string }>;
}

/** IM 通道对外状态（设置页渲染；secret 永不下发，只给 hasSecret） */
export interface ImChannelInfo {
  id: "dingtalk" | "feishu";
  label: string;
  enabled: boolean;
  /** ID 与 Secret 均已配置（Secret 含 $ENV: 引用也算） */
  configured: boolean;
  hasSecret: boolean;
  clientId: string;
  /** 已保存 Secret 的本机回显（设置页密码态预填 + 眼睛切换；不上报） */
  secretValue?: string;
  autoApprove: boolean;
  boundUser?: string;
  boundName?: string;
  bindCode: string;
  conn: "off" | "connecting" | "online" | "error";
  detail?: string;
  lastInboundAt?: string;
  sessionId?: string;
}

export interface ExpertInfo {
  id: string;
  name: string;
  description: string;
  /** 业务资源白名单（null = 不收窄；[] = 不挂）。基础工具能力各专家一致，不做约束 */
  skillWhitelist: string[] | null;
  mcpWhitelist: string[] | null;
  kbWhitelist: string[] | null;
}

export interface ExpertsState {
  current: ExpertInfo;
  items: ExpertInfo[];
}
