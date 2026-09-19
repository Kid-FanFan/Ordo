// 管理端链路（M1→M6）：admin.baseUrl 非空时启用——三注册表 Provider 换 HTTP、平台配置定时拉取热更。
// M6 起客户端档端点一律 Bearer JWT（login 获取，三角色皆可），X-Emp-No 匿名头退役。
// 任一请求失败静默降级（PRD 4.6）：目录沿用本地缓存/空目录，配置沿用内存快照，不打断用户。
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { safeStorage } from "electron";

/** 管理端下发的平台配置快照（五键，与 config.mock.json 对应键同构；宽松类型 = 逐键可选应用） */
export interface PlatformConfigRemote {
  model?: any;
  compaction?: any;
  basePrompt?: string;
  shell?: any;
  browser?: { urlWhitelist?: string[] };
}

/** 解析管理端地址：env ORDO_ADMIN_BASE 优先（自测/探针用），否则 config 的 admin.baseUrl；空 = 单机 mock 模式 */
export function adminBaseUrl(cfg: { admin?: { baseUrl?: string } }): string {
  const raw = String(process.env.ORDO_ADMIN_BASE ?? cfg?.admin?.baseUrl ?? "")
    .trim();
  return raw ? raw.replace(/\/+$/, "") : "";
}

/** 本机兜底标识（无登录态时的日志/本地目录命名用；服务端授权与审计一律以 token 工号为准） */
export function empNo(): string {
  return (os.userInfo().username || "unknown").toLowerCase();
}

// ---------- 登录态与模式（M6-B）：auth.json 持久化 {mode, baseUrl, token, user} ----------
// mode = "online"（接入管理端，须登录）| "standalone"（单机，无 token）| 无文件 = 未配置（欢迎页）。
// token 经 Electron safeStorage 加密落盘（tokenEnc base64）；加密不可用（如无系统钥匙串）回退明文并标记。
// e2e/CI 用 env 凭据自动登录（ORDO_TEST_EMP_NO/ORDO_TEST_PASSWORD），UI 登录写同一存储。

export type AuthMode = "online" | "standalone";

export interface AdminAuthSnapshot {
  mode: AuthMode;
  baseUrl?: string;
  token: string;
  user: { empNo: string; name: string; role: string; dept: string | null };
}

interface AuthFile {
  mode?: string;
  baseUrl?: string;
  /** safeStorage 加密后的 base64 */
  tokenEnc?: string;
  /** 明文回退（enc 不可用时） */
  token?: string;
  enc?: "safe" | "plain";
  user?: AdminAuthSnapshot["user"];
}

let authSnapshot: AdminAuthSnapshot | null = null;
let authMode: AuthMode | null = null;
let authBaseUrlSaved = "";
let authFile = "";

function encodeToken(token: string): { tokenEnc?: string; token?: string; enc: "safe" | "plain" } {
  try {
    if (safeStorage.isEncryptionAvailable()) {
      return { tokenEnc: safeStorage.encryptString(token).toString("base64"), enc: "safe" };
    }
  } catch {
    /* 落明文回退 */
  }
  return { token, enc: "plain" };
}

function decodeToken(f: AuthFile): string {
  if (f.enc === "plain" || (!f.tokenEnc && f.token)) return f.token ?? "";
  try {
    return f.tokenEnc ? safeStorage.decryptString(Buffer.from(f.tokenEnc, "base64")) : "";
  } catch {
    return "";
  }
}

/** 启动装载登录态与模式（auth.json；无文件/损坏 = 未配置回欢迎页） */
export function initAdminAuth(file: string): void {
  authFile = file;
  authSnapshot = null;
  authMode = null;
  authBaseUrlSaved = "";
  try {
    const f = JSON.parse(fs.readFileSync(file, "utf-8")) as AuthFile;
    authBaseUrlSaved = String(f.baseUrl ?? "").replace(/\/+$/, "");
    if (f.mode === "standalone") {
      authMode = "standalone";
      return;
    }
    if (f.mode === "online") {
      const token = decodeToken(f);
      if (token) {
        authMode = "online";
        authSnapshot = { mode: "online", baseUrl: authBaseUrlSaved, token, user: f.user ?? { empNo: "", name: "", role: "user", dept: null } };
        return;
      }
      // online 但 token 缺失/解密失败：保留模式与地址（锁定重登），不带旧 token
      authMode = "online";
    }
  } catch {
    /* 未配置 */
  }
}

/** 当前模式：null = 未配置（首启/退出登录后 → 欢迎页） */
export function authModeOf(): AuthMode | null {
  return authMode;
}

/** 联机模式登记的管理端地址（锁定重登时表单回填） */
export function savedBaseUrl(): string {
  return authBaseUrlSaved;
}

/** 渲染层状态：unconfigured=欢迎页 / locked=联机但未登录 / online / standalone */
export function authState(): { mode: "unconfigured" | "locked" | "online" | "standalone"; baseUrl?: string; user?: AdminAuthSnapshot["user"] } {
  if (authMode === "standalone") return { mode: "standalone" };
  if (authMode === "online") {
    return authSnapshot
      ? { mode: "online", baseUrl: authBaseUrlSaved, user: authSnapshot.user }
      : { mode: "locked", baseUrl: authBaseUrlSaved };
  }
  return { mode: "unconfigured" };
}

export function adminToken(): string {
  return authSnapshot?.token ?? "";
}

export function adminUser(): AdminAuthSnapshot["user"] | null {
  return authSnapshot?.user ?? null;
}

export function authHeaders(): Record<string, string> {
  return authSnapshot?.token ? { authorization: `Bearer ${authSnapshot.token}` } : {};
}

/** 退出登录：清 auth.json（模式+token），回欢迎页重选；企业下发资源（managed/配置缓存）与个人数据一律保留（用户定案） */
export function clearAdminAuth(): Promise<void> {
  authSnapshot = null;
  authMode = null;
  authBaseUrlSaved = "";
  return authFile ? fsp.rm(authFile, { force: true }).catch(() => {}) : Promise.resolve();
}

/** 切换单机模式：写 {mode:"standalone"}（无 token 无地址） */
export async function setStandaloneMode(): Promise<void> {
  authSnapshot = null;
  authMode = "standalone";
  authBaseUrlSaved = "";
  if (!authFile) return;
  await fsp.mkdir(path.dirname(authFile), { recursive: true }).catch(() => {});
  await fsp.writeFile(authFile, JSON.stringify({ mode: "standalone" }, null, 2), "utf-8").catch(() => {});
}

/** 工号密码登录：换 token 并落 auth.json（UI 登录与 env 自动登录共用） */
export async function adminLogin(base: string, empInput: string, password: string): Promise<AdminAuthSnapshot> {
  const res = await fetch(`${base}/api/v1/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ empNo: empInput, password }),
  });
  const data = (await res.json().catch(() => ({}))) as { token?: string; user?: AdminAuthSnapshot["user"]; error?: string };
  if (!res.ok || !data.token) throw new Error(data?.error || `登录失败（HTTP ${res.status}）`);
  authSnapshot = { mode: "online", baseUrl: base, token: data.token, user: data.user ?? { empNo: empInput, name: empInput, role: "user", dept: null } };
  authMode = "online";
  authBaseUrlSaved = base;
  if (authFile) {
    await fsp.mkdir(path.dirname(authFile), { recursive: true }).catch(() => {});
    await fsp.writeFile(authFile, JSON.stringify({ mode: "online", baseUrl: base, ...encodeToken(data.token), user: authSnapshot.user }, null, 2), "utf-8").catch(() => {});
  }
  return authSnapshot;
}

/** 存量 token 校验（/auth/me）：明确无效（401/403）即清本地；网络不可达不判死（4.6 降级沿用） */
export async function adminVerifyToken(base: string): Promise<boolean> {
  if (!authSnapshot) return false;
  try {
    const res = await fetch(`${base}/api/v1/auth/me`, { headers: authHeaders() });
    if (res.status === 401 || res.status === 403) {
      await clearAdminAuth();
      return false;
    }
    if (res.ok) authSnapshot.user = (await res.json()) as AdminAuthSnapshot["user"];
    return true;
  } catch {
    return true;
  }
}

/** e2e/CI 桥：env 凭据自动登录（M6-B UI 登录前的过渡通道） */
export async function envAutoLogin(base: string): Promise<boolean> {
  const emp = process.env.ORDO_TEST_EMP_NO;
  const pw = process.env.ORDO_TEST_PASSWORD;
  if (!emp || !pw) return adminToken() !== "";
  try {
    await adminLogin(base, emp, pw);
    console.log(`[ADMIN] env 自动登录成功: ${emp}`);
    return true;
  } catch (e) {
    console.log(`[ADMIN] env 自动登录失败: ${String((e as Error).message ?? e)}`);
    return false;
  }
}

// 运行中 token 过期（401）：通知渲染层锁定回登录页（每进程只发一次；网络故障/未登录请求不触发）
let authExpiredHandler: (() => void) | null = null;
let authExpiredFired = false;
export function setAuthExpiredHandler(fn: () => void): void {
  authExpiredHandler = fn;
}

export async function adminFetchJson<T>(base: string, urlPath: string, init?: RequestInit & { timeoutMs?: number }): Promise<T> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), init?.timeoutMs ?? 10_000);
  try {
    const hadToken = !!authSnapshot?.token;
    const res = await fetch(`${base}${urlPath}`, {
      ...init,
      headers: { ...(init?.body ? { "content-type": "application/json" } : {}), ...authHeaders(), ...(init?.headers ?? {}) },
      signal: ctrl.signal,
    });
    const data = (await res.json().catch(() => ({}))) as { error?: string };
    if (res.status === 401 && hadToken && !authExpiredFired) {
      authExpiredFired = true;
      authSnapshot = null; // 内存态置空（锁定）；auth.json 保留 mode 供重登回填地址
      authExpiredHandler?.();
    }
    if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
    return data as T;
  } finally {
    clearTimeout(timer);
  }
}

/** 平台配置同步：启动先应用本地缓存（离线可用）→ since 版本号拉取 → 应用 + 落缓存；每 30 分钟轮询，失败静默。 */
export class AdminConfigSync {
  private timer: NodeJS.Timeout | null = null;
  private version = 0;

  constructor(
    private opts: { base: string; cacheFile: string; apply: (config: PlatformConfigRemote) => void; onSync?: (msg: string) => void }
  ) {}

  async start(): Promise<void> {
    try {
      const cached = JSON.parse(await fsp.readFile(this.opts.cacheFile, "utf-8")) as {
        version: number;
        config?: PlatformConfigRemote;
      };
      if (cached?.config) {
        this.version = cached.version;
        this.opts.apply(cached.config);
        this.opts.onSync?.(`恢复本地缓存配置 v${cached.version}`);
      }
    } catch {
      /* 无缓存：沿用本地 config 快照 */
    }
    await this.pollOnce();
    this.timer = setInterval(() => void this.pollOnce(), 30 * 60 * 1000);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /** 管理端推送触发的立即拉取（R2：WS config_changed → 秒级热更） */
  poke(): Promise<void> {
    return this.pollOnce();
  }

  async pollOnce(): Promise<void> {
    try {
      const r = await adminFetchJson<{ version: number; unchanged?: boolean; config?: PlatformConfigRemote }>(
        this.opts.base,
        `/api/v1/config/platform?since=${this.version}`
      );
      if (r.unchanged || !r.config) return;
      this.version = r.version;
      this.opts.apply(r.config);
      await fsp.mkdir(path.dirname(this.opts.cacheFile), { recursive: true });
      await fsp.writeFile(this.opts.cacheFile, JSON.stringify({ version: r.version, config: r.config }, null, 2), "utf-8");
      this.opts.onSync?.(`已热更平台配置 v${r.version}`);
    } catch {
      /* 管理端不可达：沿用内存配置（4.6 降级，不打断用户） */
    }
  }
}
