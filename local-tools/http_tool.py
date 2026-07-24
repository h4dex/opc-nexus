#!/usr/bin/env python3
"""
网络请求工具 - AiBoxDash 本地工具集
支持: GET/POST/PUT/DELETE、文件下载、表单提交、JSON 请求、响应解析

用法:
  python http_tool.py --url <URL> [--method GET|POST|PUT|DELETE] [--headers '{"k":"v"}'] [--body '...'] [--download <保存路径>] [--timeout 30]

输出: JSON 格式（status_code, headers, body/文件路径）
依赖: 仅标准库（urllib），无需额外安装
"""
import argparse
import json
import os
import ssl
import sys
import time
import urllib.request
import urllib.error
import urllib.parse
from pathlib import Path


def make_request(url: str, method: str = "GET", headers: dict = None,
                 body: str = None, timeout: int = 30, download: str = None,
                 form_data: dict = None, insecure: bool = False) -> dict:
    """发起 HTTP 请求，返回结构化结果"""
    headers = headers or {}
    headers.setdefault("User-Agent", "AiBoxDash-LocalTool/1.0")

    # 表单数据编码
    data = None
    if form_data:
        data = urllib.parse.urlencode(form_data).encode("utf-8")
        headers.setdefault("Content-Type", "application/x-www-form-urlencoded")
    elif body:
        data = body.encode("utf-8")
        headers.setdefault("Content-Type", "application/json")

    # SSL 上下文：默认验证证书，仅当 --insecure 时跳过（内网/自签证书场景）
    ctx = None
    if insecure:
        ctx = ssl.create_default_context()
        ctx.check_hostname = False
        ctx.verify_mode = ssl.CERT_NONE

    req = urllib.request.Request(url, data=data, headers=headers, method=method.upper())

    start = time.time()
    try:
        with urllib.request.urlopen(req, timeout=timeout, context=ctx) as resp:
            elapsed = round(time.time() - start, 3)
            resp_headers = dict(resp.headers)
            status = resp.status

            # 文件下载模式
            if download:
                save_path = Path(download)
                save_path.parent.mkdir(parents=True, exist_ok=True)
                content = resp.read()
                save_path.write_bytes(content)
                return {
                    "ok": True,
                    "status_code": status,
                    "elapsed_seconds": elapsed,
                    "downloaded_to": str(save_path.resolve()),
                    "file_size_bytes": len(content),
                    "content_type": resp_headers.get("Content-Type", "")
                }

            # 普通响应
            raw = resp.read()
            content_type = resp_headers.get("Content-Type", "")
            # 尝试 JSON 解析
            try:
                body_text = raw.decode("utf-8")
                parsed = json.loads(body_text)
                return {
                    "ok": True,
                    "status_code": status,
                    "elapsed_seconds": elapsed,
                    "headers": resp_headers,
                    "content_type": content_type,
                    "body": parsed
                }
            except (json.JSONDecodeError, UnicodeDecodeError):
                body_text = raw.decode("utf-8", errors="replace")
                return {
                    "ok": True,
                    "status_code": status,
                    "elapsed_seconds": elapsed,
                    "headers": resp_headers,
                    "content_type": content_type,
                    "body": body_text[:16000]
                }
    except urllib.error.HTTPError as e:
        elapsed = round(time.time() - start, 3)
        body_text = ""
        try:
            body_text = e.read().decode("utf-8", errors="replace")[:4000]
        except Exception:
            pass
        return {
            "ok": False,
            "status_code": e.code,
            "elapsed_seconds": elapsed,
            "error": f"HTTP {e.code}: {e.reason}",
            "body": body_text
        }
    except urllib.error.URLError as e:
        return {"ok": False, "error": f"连接失败: {e.reason}"}
    except Exception as e:
        return {"ok": False, "error": str(e)}


def main():
    parser = argparse.ArgumentParser(description="网络请求工具")
    parser.add_argument("--url", required=True, help="请求 URL")
    parser.add_argument("--method", default="GET", choices=["GET", "POST", "PUT", "DELETE", "PATCH"], help="HTTP 方法")
    parser.add_argument("--headers", default=None, help="请求头 JSON 字符串")
    parser.add_argument("--body", default=None, help="请求体（字符串）")
    parser.add_argument("--form", default=None, help="表单数据 JSON（key-value）")
    parser.add_argument("--download", default=None, help="下载文件保存路径")
    parser.add_argument("--timeout", type=int, default=30, help="超时秒数（默认 30）")
    parser.add_argument("--insecure", action="store_true", help="跳过 SSL 证书验证（仅限内网/自签证书）")
    args = parser.parse_args()

    headers = json.loads(args.headers) if args.headers else None
    form_data = json.loads(args.form) if args.form else None

    result = make_request(
        url=args.url,
        method=args.method,
        headers=headers,
        body=args.body,
        timeout=args.timeout,
        download=args.download,
        form_data=form_data,
        insecure=args.insecure
    )
    print(json.dumps(result, ensure_ascii=False, indent=2))
    sys.exit(0 if result.get("ok") else 1)


if __name__ == "__main__":
    main()
