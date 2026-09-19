<p align="center">简体中文 · <a href="README_EN.md">English</a></p>

<div align="center">
  <img src="build/brand/ordo-logo-2048.png" width="96" alt="Ordo logo"/>
  <h1>Ordo</h1>
  <p>企业级 AI Agent 桌面工作台 · Windows<br/>
  让员工用自然语言完成文档、数据、浏览器、终端里的真实工作——可控、可审计、可私有化。</p>
</div>

---

## 它是什么

Ordo 是一个跑在员工电脑上的 Agent 工作台：内置文件 / Office（docx·pptx·xlsx）/ 终端 / 浏览器 / OCR 等真实工具，模型规划并执行多步任务，产物直接落进你的工作区。名字取自拉丁语 *ordo*（秩序）——「可控可管的全能执行者」。

**双模式：**

- **单机模式**：无需服务器，全功能本地可用，自配一个 OpenAI 兼容 API（DeepSeek / 通义 / 本地 vLLM 均可）
- **联机模式**：连接企业管理端——工号登录，技能 / 知识库 / 连接器 / 专家按部门授权统一下发，操作全程审计，内置强更通道（管理端为企业内网组件，不随本仓库分发；本仓库内置一套 mock 管理端数据用于开发与自测）

## 核心能力

- **真实工具执行**：工作区文件读写、Office 文档创建与编辑、PowerShell 终端、浏览器控制（导航/截图/控制台）、图像 OCR（离线包内置）
- **操作分级（L1/L2/L3）**：只读直接执行、写入类弹窗确认、敏感操作禁入——所有工具调用分级管控，路径围栏限制在授权工作区内
- **技能系统**：对助手说「把刚才的流程做成技能」，会话里验证过的流程沉淀为可复用技能包（SKILL.md），个人区 / 企业市场分级管理
- **专家（角色）**：人设提示词 + 资源白名单，同一基座切换业务角色
- **知识库**：个人库本地检索；企业库由管理端托管
- **自动化**：本地定时任务，无人值守运行 + 完成通知，产物回会话可回看
- **IM 通道**：钉钉 / 飞书官方长连接直连，手机上直接下任务、收结果，任务执行中可排队 / 插话引导
- **会话体验**：流式回答、工具调用归组、思考强度调节、上下文自动压缩、答案多版本浏览、崩溃后恢复未完成任务
- **主题系统**：4 套内置主题 + 自定义主题（可换图标与背景）

## 界面

| 工作台 | 会话运行 | 预览面板 |
|---|---|---|
| ![工作台](assets/ui/workbench.png) | ![会话](assets/ui/session.png) | ![预览](assets/ui/preview.png) |

## 快速开始

**安装包（推荐）**：到 [Releases](https://gitee.com/kidzyf/ordo/releases) 下载 `Ordo-0.1.0-setup.exe`（Windows 10/11 x64）。

**源码运行**：

```bash
git clone https://gitee.com/kidzyf/ordo.git
cd ordo
npm install          # 自动安装 Electron（默认 npmmirror 镜像，可自行更换）
npm start            # 启动桌面端；设置 → 模型 里填一个 OpenAI 兼容 API 即可对话
```

**开发与自测**：

```bash
npm run mock           # 本地 mock 模型服务（:8787，剧本式应答，无需任何真实 key）
npm run selftest:mock  # 267 项全量自测（UI 断言 + Agent 全链路），开箱即跑
npm run dist           # 构建 NSIS 安装包 → release/Ordo-<版本>-setup.exe
```

> 仓库内的 `config.mock.json` 已脱敏（`model.apiKey` 为占位符）：mock 自测不需要任何真实密钥；真实模式自测请在其中填入你自己的 key。

## 数据与安全

- 全部本机数据落 `~/.ordo/`（会话 / 工作区 / 技能 / 知识库 / 审计 / 日志），卸载即走
- 工具调用三级管控 + 路径围栏 + 全量审计日志
- 单机模式数据不出本机（仅模型 API 按你的配置出站）

## 技术栈

Electron + TypeScript ｜ Agent 运行时基于 [pi](https://github.com/earendil-works/pi)（MIT）SDK（JSONL 会话存储 / AgentHarness 编排 / steer·followUp 消息队列）｜ 渲染层纯 JS 无框架 ｜ 管理端 mock 数据内置

## 目录结构

```
src/main/          Electron 主进程：Agent 装配、IPC、IM 通道、OCR、自动化
src/preload/       类型化 IPC 桥（contextIsolation）
src/renderer/      聊天 + 工作台 UI（纯 JS 无构建）+ 主题引擎
tools/             mock 模型服务、图标管线、探针脚本
scripts/           全量自测驱动（mock / 真实双模式）
build/brand/       品牌源图 + 多尺寸图标生成（npm run icon）
```

## License

[MIT](LICENSE)。附加商标注记：**Ordo 名称与猫头鹰 Logo 不随 MIT 授权转移**，不得用于衍生产品的品牌宣传。
