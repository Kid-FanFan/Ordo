# Python Sidecar（桩）

承担 PRD 中三件 Python 生态的重活，对 Electron 主进程表现为一组本地工具（后续按 MCP 标准封装，见 PRD 4.4）：

1. **RapidOCR**：本地图片/扫描件文字提取（PRD 3.2 双通道路由的"要文字"通道）
2. **Embedding**：个人知识库向量化（`~/.ordo/rag/`）
3. **技能脚本沙箱**：SKILL 代码执行的白名单 Python 运行时（PRD 3.5）

一期骨架仅保留接口桩（`sidecar.py`，所有端点返回 501），不引入任何 Python 依赖。
