// 客户端本地设置（M6-C）：~/.ordo/config/settings.json —— 通用组三项真实持久化。
// 企业管控项不在此处（平台配置由管理端下发，PRD 5.1）：本文件只存用户本机偏好。
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";

export interface AppSettings {
  /** 开机自启（app.setLoginItemSettings） */
  autoStart: boolean;
  /** 桌面通知（任务完成 / L2 待确认 / 自动化触发） */
  desktopNotify: boolean;
  /** 启动时恢复上次会话 */
  restoreLastSession: boolean;
  /** 默认工作区目录覆盖（存储节修改；重启生效，不迁移旧文件；缺省 = ~/.ordo/workspace） */
  workspaceDir?: string;
  /** 个人知识库（rag）目录覆盖（同上；缺省 = ~/.ordo/rag） */
  ragDir?: string;
}

export const DEFAULT_APP_SETTINGS: AppSettings = {
  autoStart: false,
  desktopNotify: true,
  restoreLastSession: true,
};

export class AppSettingsStore {
  private data: AppSettings = { ...DEFAULT_APP_SETTINGS };

  constructor(private file: string) {
    try {
      const raw = JSON.parse(fs.readFileSync(file, "utf-8")) as Partial<AppSettings>;
      this.data = {
        autoStart: raw.autoStart === true,
        desktopNotify: raw.desktopNotify !== false, // 缺省开
        restoreLastSession: raw.restoreLastSession !== false,
        ...(typeof raw.workspaceDir === "string" && raw.workspaceDir.trim() ? { workspaceDir: raw.workspaceDir.trim() } : {}),
        ...(typeof raw.ragDir === "string" && raw.ragDir.trim() ? { ragDir: raw.ragDir.trim() } : {}),
      };
    } catch {
      /* 无文件：默认值 */
    }
  }

  get(): AppSettings {
    return { ...this.data };
  }

  async apply(patch: Partial<AppSettings>): Promise<AppSettings> {
    this.data = {
      autoStart: patch.autoStart ?? this.data.autoStart,
      desktopNotify: patch.desktopNotify ?? this.data.desktopNotify,
      restoreLastSession: patch.restoreLastSession ?? this.data.restoreLastSession,
      workspaceDir: patch.workspaceDir !== undefined ? patch.workspaceDir : this.data.workspaceDir,
      ragDir: patch.ragDir !== undefined ? patch.ragDir : this.data.ragDir,
    };
    if (this.data.workspaceDir === "") delete this.data.workspaceDir; // 空串 = 回默认位置
    if (this.data.ragDir === "") delete this.data.ragDir;
    await fsp.mkdir(path.dirname(this.file), { recursive: true }).catch(() => {});
    await fsp.writeFile(this.file, JSON.stringify(this.data, null, 2), "utf-8");
    return this.get();
  }
}
