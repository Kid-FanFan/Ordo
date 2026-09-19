// 客户端强更通道（R3-4）：管理端登记新版本 → 启动/WS 推送触发检查 → 下载（sha256 复核）→ 强制锁定或提示安装。
// e2e 用 ORDO_UPDATE_NOUI=1 停在"已下载"标记（不弹窗不安装）；自测无管理端地址不进入本链路。
import { app, dialog } from "electron";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { adminFetchJson, authHeaders } from "./admin-link";

function compareVersion(a: string, b: string): number {
  const pa = String(a).split(".").map(Number);
  const pb = String(b).split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d) return d;
  }
  return 0;
}

export type UpdateCheckStatus =
  | "no-source" // 管理端未登记版本
  | "uptodate" // 已是最新
  | "locked" // 低于最低版：已弹锁定框（仅允许升级）
  | "prompted" // 有新版：已弹提示框（用户可选稍后）
  | "downloaded" // 已下载校验（NOUI：e2e）
  | "download-failed"
  | "bad-sha"
  | "failed"; // 检查请求失败

export async function checkClientUpdate(base: string, win: Electron.BrowserWindow | null): Promise<UpdateCheckStatus> {
  let r: { latest: string; minVersion: string; sha256: string; notes: string };
  try {
    r = await adminFetchJson<{ latest: string; minVersion: string; sha256: string; notes: string }>(base, "/api/v1/client/version");
  } catch {
    return "failed";
  }
  if (!r?.latest || !r?.sha256) return "no-source";
  const current = app.getVersion();
  if (compareVersion(r.latest, current) <= 0) return "uptodate";
  const force = !!r.minVersion && compareVersion(current, r.minVersion) < 0;
  console.log(`[ADMIN-UPDATE] latest=${r.latest} current=${current}${force ? " 强制（低于最低可用版本）" : " 提示更新"}`);

  const res = await fetch(`${base}/api/v1/artifacts/${r.sha256}`, { headers: authHeaders() });
  if (!res.ok) {
    console.log(`[ADMIN-UPDATE] 安装包下载失败（HTTP ${res.status}）`);
    return "download-failed";
  }
  const bytes = Buffer.from(await res.arrayBuffer());
  const sha = createHash("sha256").update(bytes).digest("hex");
  if (sha !== r.sha256) {
    console.log("[ADMIN-UPDATE] 安装包校验不符（拒装，防篡改）");
    return "bad-sha";
  }
  const dest = path.join(os.tmpdir(), `ordo-setup-${r.latest}${process.platform === "win32" ? ".exe" : ""}`);
  await fsp.writeFile(dest, bytes);
  console.log(`[ADMIN-UPDATE] downloaded ${r.latest} sha-ok → ${dest}`);

  if (process.env.ORDO_UPDATE_NOUI === "1") {
    console.log("[ADMIN-UPDATE] NOUI 模式：停在已下载（e2e），不弹窗不安装");
    return "downloaded";
  }

  const choice = await dialog.showMessageBox(win ?? undefined as never, {
    type: force ? "warning" : "info",
    title: force ? "必须升级才能继续使用" : "发现新版本",
    message: `Ordo ${r.latest} 已发布${force ? "：当前版本已低于最低可用要求，需立即升级" : ""}`,
    detail: [r.notes, `安装包已就绪（已校验），点击「立即升级」将运行安装程序并退出本程序。`].filter(Boolean).join("\n"),
    buttons: force ? ["立即升级"] : ["稍后提醒", "立即升级"],
    defaultId: force ? 0 : 1,
    noLink: true,
  });
  const accept = force ? true : choice.response === 1;
  if (!accept) return force ? "locked" : "prompted";
  spawn(dest, [], { detached: true, stdio: "ignore" }).unref();
  app.quit();
  return force ? "locked" : "prompted";
}
