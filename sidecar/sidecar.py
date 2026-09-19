"""Ordo Python sidecar（接口桩）。

规划中的本地服务（骨架期全部返回 501 Not Implemented）：
  POST /ocr        —— RapidOCR 文字提取（输入：图片路径/字节；输出：文本 + 置信度）
  POST /embed      —— 文本向量化（输入：文本批次；输出：向量批次，落盘 ~/.ordo/rag/）
  POST /exec       —— 技能脚本沙箱执行（输入：脚本 + 参数；白名单运行时，资源限制）

对主进程的暴露方式：本地 HTTP，后续迁移为标准 MCP server。
运行：python sidecar.py --port 8790
"""
import argparse
from http.server import BaseHTTPRequestHandler, HTTPServer


class StubHandler(BaseHTTPRequestHandler):
    def do_POST(self):
        length = int(self.headers.get("Content-Length", 0))
        self.rfile.read(length)
        self.send_response(501)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.end_headers()
        self.wfile.write(f'{{"error": "not implemented (stub)", "endpoint": "{self.path}"}}'.encode("utf-8"))

    def log_message(self, fmt, *args):
        print(f"[sidecar-stub] {self.address_string()} {fmt % args}")


def main():
    parser = argparse.ArgumentParser(description="Ordo sidecar (stub)")
    parser.add_argument("--port", type=int, default=8790)
    args = parser.parse_args()
    HTTPServer(("127.0.0.1", args.port), StubHandler).serve_forever()


if __name__ == "__main__":
    main()
