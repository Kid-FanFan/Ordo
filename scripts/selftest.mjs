// selftest 编排（M6-B）：两种模式都走「联机 mock 企业服务」链路（登录 → token → 目录/配置/上报）。
//   默认（真实模式）：模型 = config.mock.json 的 model 键经 ORDO_TEST_MODEL_JSON 注入（优先于 mock 端下发）。
//   --mock（剧本模式）：模型 = mock 端 /config/platform 下发的剧本模型（OpenAI 兼容 /v1/chat/completions）。
// config.mock.json 已退役为测试夹具：仅本脚本与 mock-server 读取，客户端运行时不再读它。
// 自测模式下 L2 确认自动同意，跑完 P0 旅程 3 后以退出码报告结果（0=通过）。
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const electronBin = require("electron"); // 返回 electron 可执行文件路径
const useMock = process.argv.includes("--mock");
const MOCK = JSON.parse(fs.readFileSync(path.join(root, "config.mock.json"), "utf-8"));

const mock = spawn(process.execPath, [path.join(root, "tools", "mock-server.mjs")], { stdio: "inherit" });

async function waitMock() {
  for (let i = 0; i < 40; i++) {
    try {
      await fetch("http://127.0.0.1:8787/v1/models");
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 250));
    }
  }
  throw new Error("mock 企业服务 10s 内未就绪");
}

function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: "inherit", ...opts });
    child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} 退出码 ${code}`))));
    child.on("error", reject);
  });
}

// 起点与收尾都清登录态/平台配置缓存（派生数据可再生）：残留会让 mock 下发被 unchanged 短路，
// 也会让开发机交互模式误按联机启动、连向已停止的 mock 端
import os from "node:os";
const cleanDerived = () => {
  for (const f of ["auth.json", "platform-config.json"]) {
    try {
      fs.rmSync(path.join(os.homedir(), ".ordo", f), { force: true });
    } catch {}
  }
};
cleanDerived();

try {
  await waitMock();
  await run(process.execPath, [path.join(root, "node_modules", "typescript", "bin", "tsc"), "-p", path.join(root, "tsconfig.json")], { cwd: root });
  await run(electronBin, ["."], {
    cwd: root,
    env: {
      ...process.env,
      ORDO_SELFTEST: "1",
      // 联机 mock 企业服务（M6-B：登录/目录/配置/上报全链路）
      ORDO_ADMIN_BASE: "http://127.0.0.1:8787",
      ORDO_TEST_EMP_NO: "mock-emp",
      ORDO_TEST_PASSWORD: "mock-pass",
      // 真实模式：夹具真实模型注入（env 优先于 mock 端下发的剧本模型）
      ...(useMock ? {} : { ORDO_TEST_MODEL_JSON: JSON.stringify(MOCK.model) }),
    },
  });
  mock?.kill();
  cleanDerived();
  process.exit(0);
} catch (e) {
  console.error("[selftest] 失败:", e.message);
  mock?.kill();
  cleanDerived();
  process.exit(1);
}
