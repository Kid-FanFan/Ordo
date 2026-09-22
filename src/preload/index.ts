// preload：类型化 IPC 桥（contextIsolation 开启，渲染进程只能经 window.ordo 访问）
// 契约基线（锁定）+ 契约扩展（前端以 ?. 降级调用）：文件预览 / 工作区 / 会话管理 / 技能市场 / 模型 / 停止
import { contextBridge, ipcRenderer, webUtils } from "electron";

contextBridge.exposeInMainWorld("ordo", {
  // ---- 基线契约（锁定） ----
  /** 拖拽/选择文件的原始绝对路径（输入引用 v6：附件零副本，仅引用） */
  pathForFile: (file: File) => {
    try {
      return webUtils.getPathForFile(file);
    } catch {
      return "";
    }
  },
  // ---- 基线契约（锁定） ----
  prompt: (text: string, attachments?: Array<{ name: string; size?: number; dataBase64: string }>) =>
    ipcRenderer.invoke("ordo:prompt", text, attachments),
  respondConfirm: (id: string, approved: boolean) => ipcRenderer.invoke("ordo:confirm", id, approved),
  getWorkspaceInfo: () => ipcRenderer.invoke("ordo:workspaceInfo"),
  listExperts: () => ipcRenderer.invoke("ordo:listExperts"),
  switchExpert: (id: string) => ipcRenderer.invoke("ordo:switchExpert", id),
  thinkingState: () => ipcRenderer.invoke("ordo:thinkingState"),
  switchThinking: (id: string) => ipcRenderer.invoke("ordo:switchThinking", id),
  listSessions: () => ipcRenderer.invoke("ordo:listSessions"),
  newSession: () => ipcRenderer.invoke("ordo:newSession"),
  loadSession: (id: string) => ipcRenderer.invoke("ordo:loadSession", id),
  // 插件包（M5）：目录/安装/卸载
  pluginPacks: () => ipcRenderer.invoke("ordo:pluginPacks"),
  pluginPackInstall: (name: string) => ipcRenderer.invoke("ordo:pluginPackInstall", name),
  pluginPackUninstall: (name: string) => ipcRenderer.invoke("ordo:pluginPackUninstall", name),

  // 模式与登录（M6-B）：unconfigured=欢迎页 / locked=联机待登录 / online / standalone
  getAuthState: () => ipcRenderer.invoke("ordo:getAuthState"),
  authLogin: (baseUrl: string, empNo: string, password: string) => ipcRenderer.invoke("ordo:authLogin", baseUrl, empNo, password),
  authStandalone: () => ipcRenderer.invoke("ordo:authStandalone"),
  authLogout: () => ipcRenderer.invoke("ordo:authLogout"),
  relaunch: () => ipcRenderer.invoke("ordo:relaunch"),
  // 单机模型配置（M6-B）：仅一个 API，保存后重启生效
  getLocalModel: () => ipcRenderer.invoke("ordo:getLocalModel"),
  setLocalModel: (input: unknown) => ipcRenderer.invoke("ordo:setLocalModel", input),
  testLocalModel: (input: unknown) => ipcRenderer.invoke("ordo:testLocalModel", input),
  listLocalModels: (input: unknown) => ipcRenderer.invoke("ordo:listLocalModels", input),
  // 本机设置与面板（M6-C）：通用组持久化 / 个人信息 / 手动检查更新
  getSettings: () => ipcRenderer.invoke("ordo:getSettings"),
  setSettings: (patch: unknown) => ipcRenderer.invoke("ordo:setSettings", patch),
  getProfile: () => ipcRenderer.invoke("ordo:getProfile"),
  checkUpdate: () => ipcRenderer.invoke("ordo:checkUpdate"),

  onEvent: (callback: (ev: unknown) => void) => {
    const listener = (_e: Electron.IpcRendererEvent, ev: unknown) => callback(ev);
    ipcRenderer.on("ordo:event", listener);
    return () => ipcRenderer.removeListener("ordo:event", listener);
  },

  // ---- 契约扩展（已实装） ----
  // 运行控制
  cancel: () => ipcRenderer.invoke("ordo:cancel"),
  steer: (text: string) => ipcRenderer.invoke("ordo:steer", text),
  queueFollowUp: (text: string) => ipcRenderer.invoke("ordo:queueFollowUp", text),
  cancelQueued: (entryId: string) => ipcRenderer.invoke("ordo:cancelQueued", entryId),
  switchQueued: (entryId: string, target: "steer" | "followUp") => ipcRenderer.invoke("ordo:switchQueued", entryId, target),
  // 回答操作（复制在渲染层本地完成；重新生成/质量反馈走主进程）
  regenerate: () => ipcRenderer.invoke("ordo:regenerate"),
  feedback: (value: "up" | "down") => ipcRenderer.invoke("ordo:feedback", value),
  // 多模态：当前模型是否声明图像输入
  visionSupported: () => ipcRenderer.invoke("ordo:visionSupported"),
  // 工作台文件预览 / 输入 @ 引用
  readFilePreview: (relPath: string) => ipcRenderer.invoke("ordo:readFilePreview", relPath),
  // 文件定位（资源管理器/Finder）与系统默认程序打开（跨平台 shell API）
  revealFile: (relPath: string) => ipcRenderer.invoke("ordo:revealFile", relPath),
  openPath: (relPath: string) => ipcRenderer.invoke("ordo:openPath", relPath),
  // 历史交付卡存在性批量检查（v6：已消失文件不渲染）
  filesExist: (paths: string[]) => ipcRenderer.invoke("ordo:filesExist", paths),
  // 用户侧编辑保存（md/txt/csv 文本 + xlsx 值回写；显式动作，审计 user_edit）
  saveFileEdit: (relPath: string, payload: { text: string } | { base64: string }) =>
    ipcRenderer.invoke("ordo:saveFileEdit", relPath, payload),
  getWorkspaceFiles: () => ipcRenderer.invoke("ordo:getWorkspaceFiles"),
  // 多工作区（PRD 3.8）
  listWorkspaces: () => ipcRenderer.invoke("ordo:listWorkspaces"),
  switchWorkspace: (id: string) => ipcRenderer.invoke("ordo:switchWorkspace", id),
  pickWorkspace: () => ipcRenderer.invoke("ordo:pickWorkspace"),
  pickDir: (title: string) => ipcRenderer.invoke("ordo:pickDir", title),
  openWorkspaceDir: (root?: string) => ipcRenderer.invoke("ordo:openWorkspaceDir", root),
  // 会话管理（置顶/重命名/删除→回收站）
  pinSession: (id: string, pinned: boolean) => ipcRenderer.invoke("ordo:pinSession", id, pinned),
  renameSession: (id: string, title: string) => ipcRenderer.invoke("ordo:renameSession", id, title),
  deleteSession: (id: string) => ipcRenderer.invoke("ordo:deleteSession", id),
  // 技能市场（启停即时生效：停用 = 不注入提示词）
  listSkills: () => ipcRenderer.invoke("ordo:listSkills"),
  setResourceEnabled: (module: string, id: string, enabled: boolean) =>
    ipcRenderer.invoke("ordo:setResourceEnabled", module, id, enabled),
  // 技能生命周期（沉淀走对话内 save_skill 工具；此处为查看/编辑/删除/导入 + 企业市场/审核/同步）
  readSkill: (name: string) => ipcRenderer.invoke("ordo:readSkill", name),
  updateSkill: (name: string, input: { description?: string; content?: string }) =>
    ipcRenderer.invoke("ordo:updateSkill", name, input),
  deleteSkill: (name: string) => ipcRenderer.invoke("ordo:deleteSkill", name),
  importSkill: (srcPath: string) => ipcRenderer.invoke("ordo:importSkill", srcPath),
  pickSkillFolder: () => ipcRenderer.invoke("ordo:pickSkillFolder"),
  openSkillDir: (name: string) => ipcRenderer.invoke("ordo:openSkillDir", name),
  // 企业技能市场（PRD 4.2/4.3：目录/安装/卸载/提交审核/同步）
  skillMarket: () => ipcRenderer.invoke("ordo:skillMarket"),
  skillInstalled: () => ipcRenderer.invoke("ordo:skillInstalled"),
  installSkill: (name: string) => ipcRenderer.invoke("ordo:installSkill", name),
  uninstallSkill: (name: string) => ipcRenderer.invoke("ordo:uninstallSkill", name),
  submitSkill: (name: string) => ipcRenderer.invoke("ordo:submitSkill", name),
  skillSubmissions: () => ipcRenderer.invoke("ordo:skillSubmissions"),
  syncSkills: () => ipcRenderer.invoke("ordo:syncSkills"),
  // 模型切换（PRD 3.4 管理端配置内切换）
  listModels: () => ipcRenderer.invoke("ordo:listModels"),
  switchModel: (id: string) => ipcRenderer.invoke("ordo:switchModel", id),
  // 资源清单（一期无接入，返回空列表而非造假数据）
  listKnowledgeBases: () => ipcRenderer.invoke("ordo:listKnowledgeBases"),
  setActiveKnowledgeBases: (ids: string[]) => ipcRenderer.invoke("ordo:setActiveKnowledgeBases", ids),
  createKb: (name: string) => ipcRenderer.invoke("ordo:createKb", name),
  deleteKb: (id: string) => ipcRenderer.invoke("ordo:deleteKb", id),
  listKbDocs: (id: string) => ipcRenderer.invoke("ordo:listKbDocs", id),
  addKbDocs: (id: string, paths: string[]) => ipcRenderer.invoke("ordo:addKbDocs", id, paths),
  removeKbDoc: (id: string, doc: string) => ipcRenderer.invoke("ordo:removeKbDoc", id, doc),
  pickKbFiles: () => ipcRenderer.invoke("ordo:pickKbFiles"),
  listConnectors: () => ipcRenderer.invoke("ordo:listConnectors"),
  setActiveConnectors: (names: string[]) => ipcRenderer.invoke("ordo:setActiveConnectors", names),
  // 个人连接器（客户端自添加远端 MCP；体验清单 #3）
  addPersonalConnector: (input: { displayName: string; endpoint: string; headersJson?: string }) =>
    ipcRenderer.invoke("ordo:addPersonalConnector", input),
  removePersonalConnector: (id: string) => ipcRenderer.invoke("ordo:removePersonalConnector", id),
  // IM 通道（一期：钉钉/飞书长连接直连；手机对话桥接到本机 Agent）
  imList: () => ipcRenderer.invoke("ordo:imList"),
  imSave: (id: string, patch: { enabled?: boolean; clientId?: string; secret?: string; autoApprove?: boolean; boundUser?: string }) =>
    ipcRenderer.invoke("ordo:imSave", id, patch),
  imUnbind: (id: string) => ipcRenderer.invoke("ordo:imUnbind", id),
  imNewBindCode: (id: string) => ipcRenderer.invoke("ordo:imNewBindCode", id),
  // 自动化（PRD 3.7 本地型：仅用户自建、仅本机运行；管理端编排的任务不进客户端）
  listAutomations: () => ipcRenderer.invoke("ordo:listAutomations"),
  automationCatalog: () => ipcRenderer.invoke("ordo:automationCatalog"),
  createAutomation: (input: unknown) => ipcRenderer.invoke("ordo:createAutomation", input),
  updateAutomation: (id: string, patch: unknown) => ipcRenderer.invoke("ordo:updateAutomation", id, patch),
  deleteAutomation: (id: string) => ipcRenderer.invoke("ordo:deleteAutomation", id),
  runAutomation: (id: string) => ipcRenderer.invoke("ordo:runAutomation", id),
  automationRuns: (id: string) => ipcRenderer.invoke("ordo:automationRuns", id),
  // 常用任务模板（/ 命令：输入 / 选中后插入正文可再编辑；内置种子 + 用户自建）
  listTemplates: () => ipcRenderer.invoke("ordo:listTemplates"),
  createTemplate: (input: unknown) => ipcRenderer.invoke("ordo:createTemplate", input),
  updateTemplate: (id: string, patch: unknown) => ipcRenderer.invoke("ordo:updateTemplate", id, patch),
  deleteTemplate: (id: string) => ipcRenderer.invoke("ordo:deleteTemplate", id),
  // 回收站（统计 / 手动清空；超过保留期的条目启动时自动清理）
  recycleStats: () => ipcRenderer.invoke("ordo:recycleStats"),
  clearRecycle: () => ipcRenderer.invoke("ordo:clearRecycle"),
  // 浏览器桥 A（方案 §5）：面板侧状态/控制台尾部/急停/＋菜单开页/webview 附着
  browserState: () => ipcRenderer.invoke("ordo:browserState"),
  browserConsoleTail: (n: number) => ipcRenderer.invoke("ordo:browserConsoleTail", n),
  browserStop: () => ipcRenderer.invoke("ordo:browserStop"),
  browserOpenUser: (url: string) => ipcRenderer.invoke("ordo:browserOpenUser", url),
  browserAttach: (webContentsId: number) => ipcRenderer.invoke("ordo:browserAttach", webContentsId),
  // 用户侧终端（方案 §6）：打开（cwd 跟随工作区）/写入/尺寸/关闭/状态
  termOpen: () => ipcRenderer.invoke("ordo:termOpen"),
  termWrite: (data: string) => ipcRenderer.invoke("ordo:termWrite", data),
  termResize: (cols: number, rows: number) => ipcRenderer.invoke("ordo:termResize", cols, rows),
  termClose: () => ipcRenderer.invoke("ordo:termClose"),
  termState: () => ipcRenderer.invoke("ordo:termState"),
  // 主题系统（外观切换 + 自定义主题导入/删除 + 标题栏颜色动态更新）
  listThemes: () => ipcRenderer.invoke("ordo:listThemes"),
  importTheme: () => ipcRenderer.invoke("ordo:importTheme"),
  deleteTheme: (id: string) => ipcRenderer.invoke("ordo:deleteTheme", id),
  getThemePreference: () => ipcRenderer.invoke("ordo:getThemePreference"),
  setThemePreference: (id: string) => ipcRenderer.invoke("ordo:setThemePreference", id),
  setTitleBarOverlay: (color: string, symbolColor: string) => ipcRenderer.invoke("ordo:setTitleBarOverlay", color, symbolColor),
  // 记忆系统配置
  getMemoryConfig: () => ipcRenderer.invoke("ordo:getMemoryConfig"),
  setMemoryConfig: (config: unknown) => ipcRenderer.invoke("ordo:setMemoryConfig", config),
  testMemorySummaryModel: (config: unknown) => ipcRenderer.invoke("ordo:testMemorySummaryModel", config),
  testMemoryEmbeddingModel: (config: unknown) => ipcRenderer.invoke("ordo:testMemoryEmbeddingModel", config),
});
