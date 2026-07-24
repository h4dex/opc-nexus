#!/usr/bin/env python3
"""
本地 Web Server 工具 - AiBoxDash 本地工具集
支持: 静态文件服务、Mock API 服务、文件上传接收、反向代理、目录浏览

用法:
  python webserver_tool.py --action <static|mock|upload|proxy> --port 8080 [选项]

模式说明:
  static  - 静态文件服务（目录浏览 + 文件下载）
  mock    - Mock API 服务（根据 JSON 配置返回预设响应）
  upload  - 文件上传接收服务
  proxy   - 简易反向代理（转发请求到后端）

输出: 启动后输出 JSON 格式服务信息，Ctrl+C 停止
依赖: 仅标准库，无需额外安装
"""
import argparse
import json
import os
import sys
import threading
import time
import urllib.request
import urllib.error
from http.server import HTTPServer, BaseHTTPRequestHandler, SimpleHTTPRequestHandler
from pathlib import Path
from urllib.parse import urlparse, parse_qs
import cgi
import io


class StaticHandler(SimpleHTTPRequestHandler):
    """静态文件服务（增强版：JSON 目录列表 + CORS）"""

    def __init__(self, *args, directory=None, **kwargs):
        self.serve_directory = directory or "."
        super().__init__(*args, directory=self.serve_directory, **kwargs)

    def end_headers(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        super().end_headers()

    def do_OPTIONS(self):
        self.send_response(204)
        self.end_headers()

    def log_message(self, format, *args):
        # 输出为 JSON 格式日志
        entry = {"time": time.strftime("%H:%M:%S"), "request": format % args}
        print(json.dumps(entry, ensure_ascii=False), flush=True)


class MockAPIHandler(BaseHTTPRequestHandler):
    """Mock API 服务：根据路由配置返回预设 JSON 响应"""

    routes = {}  # 类变量，由外部注入

    def do_GET(self):
        self._handle()

    def do_POST(self):
        self._handle()

    def do_PUT(self):
        self._handle()

    def do_DELETE(self):
        self._handle()

    def _handle(self):
        parsed = urlparse(self.path)
        path = parsed.path.rstrip("/") or "/"
        method = self.command

        # 查找匹配路由
        route_key = f"{method} {path}"
        route = self.routes.get(route_key) or self.routes.get(f"* {path}") or self.routes.get(path)

        if route:
            status = route.get("status", 200)
            body = route.get("body", {"message": "ok"})
            delay = route.get("delay", 0)
            if delay > 0:
                time.sleep(delay)
        else:
            # 默认返回请求信息（echo 模式）
            status = 200
            content_length = int(self.headers.get("Content-Length", 0))
            req_body = self.rfile.read(content_length).decode("utf-8") if content_length > 0 else None
            try:
                req_json = json.loads(req_body) if req_body else None
            except json.JSONDecodeError:
                req_json = req_body

            body = {
                "_echo": True,
                "method": method,
                "path": path,
                "query": parse_qs(parsed.query),
                "headers": dict(self.headers),
                "body": req_json
            }

        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(json.dumps(body, ensure_ascii=False, indent=2).encode("utf-8"))

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "*")
        self.end_headers()

    def log_message(self, format, *args):
        entry = {"time": time.strftime("%H:%M:%S"), "request": format % args}
        print(json.dumps(entry, ensure_ascii=False), flush=True)


class UploadHandler(BaseHTTPRequestHandler):
    """文件上传接收服务"""

    upload_dir = "./uploads"

    def do_GET(self):
        """返回上传页面"""
        html = """<!DOCTYPE html><html><head><meta charset="utf-8"><title>文件上传</title>
<style>body{font-family:system-ui;max-width:600px;margin:3em auto;padding:1em}
.drop{border:2px dashed #ccc;padding:3em;text-align:center;border-radius:8px;margin:1em 0}
input[type=file]{margin:1em 0}button{padding:.5em 2em;font-size:1.1em}</style></head>
<body><h2>📁 AiBoxDash 文件上传</h2>
<div class="drop"><p>选择文件上传到服务器</p>
<form method="POST" enctype="multipart/form-data">
<input type="file" name="files" multiple><br>
<button type="submit">上传</button></form></div>
<p>上传目录: """ + self.upload_dir + """</p></body></html>"""
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.end_headers()
        self.wfile.write(html.encode("utf-8"))

    def do_POST(self):
        """处理文件上传"""
        content_type = self.headers.get("Content-Type", "")
        if "multipart/form-data" not in content_type:
            self.send_response(400)
            self.end_headers()
            self.wfile.write(b'{"error": "需要 multipart/form-data"}')
            return

        upload_path = Path(self.upload_dir)
        upload_path.mkdir(parents=True, exist_ok=True)

        try:
            form = cgi.FieldStorage(
                fp=self.rfile,
                headers=self.headers,
                environ={"REQUEST_METHOD": "POST", "CONTENT_TYPE": content_type}
            )
            saved = []
            items = form["files"] if "files" in form else []
            if not isinstance(items, list):
                items = [items]

            for item in items:
                if item.filename:
                    filename = Path(item.filename).name  # 安全：只取文件名
                    save_path = upload_path / filename
                    save_path.write_bytes(item.file.read())
                    saved.append({"name": filename, "size": save_path.stat().st_size, "path": str(save_path.resolve())})

            self.send_response(200)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.end_headers()
            result = {"ok": True, "uploaded": saved, "count": len(saved)}
            self.wfile.write(json.dumps(result, ensure_ascii=False).encode("utf-8"))
        except Exception as e:
            self.send_response(500)
            self.end_headers()
            self.wfile.write(json.dumps({"ok": False, "error": str(e)}).encode("utf-8"))

    def log_message(self, format, *args):
        entry = {"time": time.strftime("%H:%M:%S"), "request": format % args}
        print(json.dumps(entry, ensure_ascii=False), flush=True)


class ProxyHandler(BaseHTTPRequestHandler):
    """简易反向代理"""

    target_base = "http://127.0.0.1:3000"

    def do_GET(self):
        self._proxy()

    def do_POST(self):
        self._proxy()

    def do_PUT(self):
        self._proxy()

    def do_DELETE(self):
        self._proxy()

    def _proxy(self):
        target_url = self.target_base.rstrip("/") + self.path
        content_length = int(self.headers.get("Content-Length", 0))
        body = self.rfile.read(content_length) if content_length > 0 else None

        # 转发请求头（排除 Host）
        headers = {k: v for k, v in self.headers.items() if k.lower() not in ("host", "connection")}

        try:
            req = urllib.request.Request(target_url, data=body, headers=headers, method=self.command)
            with urllib.request.urlopen(req, timeout=30) as resp:
                resp_body = resp.read()
                self.send_response(resp.status)
                for key, val in resp.headers.items():
                    if key.lower() not in ("transfer-encoding", "connection"):
                        self.send_header(key, val)
                self.end_headers()
                self.wfile.write(resp_body)
        except urllib.error.HTTPError as e:
            self.send_response(e.code)
            self.end_headers()
            self.wfile.write(e.read())
        except Exception as e:
            self.send_response(502)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps({"error": f"代理失败: {e}"}).encode("utf-8"))

    def log_message(self, format, *args):
        entry = {"time": time.strftime("%H:%M:%S"), "proxy": f"{self.command} {self.path}", "request": format % args}
        print(json.dumps(entry, ensure_ascii=False), flush=True)


def start_server(action: str, port: int, host: str, directory: str = None,
                 routes_file: str = None, target: str = None, duration: int = 0) -> dict:
    """启动服务"""

    if action == "static":
        serve_dir = directory or "."
        if not Path(serve_dir).is_dir():
            return {"ok": False, "error": f"目录不存在: {serve_dir}"}
        handler = lambda *args, **kwargs: StaticHandler(*args, directory=serve_dir, **kwargs)
        desc = f"静态文件服务 → {Path(serve_dir).resolve()}"

    elif action == "mock":
        routes = {}
        if routes_file and Path(routes_file).is_file():
            routes = json.loads(Path(routes_file).read_text(encoding="utf-8"))
        MockAPIHandler.routes = routes
        handler = MockAPIHandler
        desc = f"Mock API 服务（{len(routes)} 条路由规则，未匹配路由为 echo 模式）"

    elif action == "upload":
        UploadHandler.upload_dir = directory or "./uploads"
        handler = UploadHandler
        desc = f"文件上传服务 → {Path(UploadHandler.upload_dir).resolve()}"

    elif action == "proxy":
        if not target:
            return {"ok": False, "error": "代理模式需要 --target 参数（后端地址）"}
        ProxyHandler.target_base = target
        handler = ProxyHandler
        desc = f"反向代理 → {target}"
    else:
        return {"ok": False, "error": f"未知模式: {action}"}

    try:
        server = HTTPServer((host, port), handler)
    except OSError as e:
        return {"ok": False, "error": f"端口 {port} 被占用: {e}"}

    info = {
        "ok": True,
        "mode": action,
        "url": f"http://{host}:{port}",
        "port": port,
        "description": desc,
        "pid": os.getpid()
    }
    print(json.dumps(info, ensure_ascii=False, indent=2), flush=True)

    # 定时自动停止（用于工作流场景）
    if duration > 0:
        def auto_stop():
            time.sleep(duration)
            print(json.dumps({"event": "auto_stop", "message": f"服务已运行 {duration}s，自动停止"}), flush=True)
            server.shutdown()
        threading.Thread(target=auto_stop, daemon=True).start()

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
        print(json.dumps({"event": "stopped"}, ensure_ascii=False), flush=True)

    return info


def main():
    parser = argparse.ArgumentParser(description="本地 Web Server 工具")
    parser.add_argument("--action", required=True,
                        choices=["static", "mock", "upload", "proxy"],
                        help="服务模式: static(静态文件)/mock(Mock API)/upload(文件上传)/proxy(反向代理)")
    parser.add_argument("--port", type=int, default=8080, help="监听端口（默认 8080）")
    parser.add_argument("--host", default="127.0.0.1", help="监听地址（默认 127.0.0.1，局域网用 0.0.0.0）")
    parser.add_argument("--dir", default=None, help="服务目录（static/upload 模式）")
    parser.add_argument("--routes", default=None, help="Mock 路由配置 JSON 文件路径")
    parser.add_argument("--target", default=None, help="代理目标地址（proxy 模式，如 http://127.0.0.1:3000）")
    parser.add_argument("--duration", type=int, default=0, help="自动停止秒数（0=手动停止，工作流场景使用）")
    args = parser.parse_args()

    start_server(
        action=args.action,
        port=args.port,
        host=args.host,
        directory=args.dir,
        routes_file=args.routes,
        target=args.target,
        duration=args.duration
    )


if __name__ == "__main__":
    main()
