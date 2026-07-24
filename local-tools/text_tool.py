#!/usr/bin/env python3
"""
文本/数据处理工具 - AiBoxDash 本地工具集
支持: 编码转换、JSON 格式化/查询、正则提取、文本统计、模板渲染、数据清洗

用法:
  python text_tool.py --action <encode|decode|json_fmt|json_query|regex|stats|template|clean|diff|replace> [选项]

输出: JSON 格式
依赖: 仅标准库，无需额外安装
"""
import argparse
import base64
import hashlib
import json
import re
import sys
import urllib.parse
from collections import Counter
from pathlib import Path


def encode_text(text: str, encoding: str = "base64") -> dict:
    """文本编码"""
    data = text.encode("utf-8")
    if encoding == "base64":
        result = base64.b64encode(data).decode("ascii")
    elif encoding == "url":
        result = urllib.parse.quote(text)
    elif encoding == "hex":
        result = data.hex()
    elif encoding == "md5":
        result = hashlib.md5(data).hexdigest()
    elif encoding == "sha256":
        result = hashlib.sha256(data).hexdigest()
    else:
        return {"ok": False, "error": f"不支持的编码: {encoding}"}
    return {"ok": True, "input_length": len(text), "encoding": encoding, "result": result}


def decode_text(text: str, encoding: str = "base64") -> dict:
    """文本解码"""
    try:
        if encoding == "base64":
            result = base64.b64decode(text).decode("utf-8")
        elif encoding == "url":
            result = urllib.parse.unquote(text)
        elif encoding == "hex":
            result = bytes.fromhex(text).decode("utf-8")
        else:
            return {"ok": False, "error": f"不支持的解码: {encoding}"}
        return {"ok": True, "result": result}
    except Exception as e:
        return {"ok": False, "error": f"解码失败: {e}"}


def json_format(text: str, compact: bool = False) -> dict:
    """JSON 格式化/压缩"""
    try:
        data = json.loads(text)
        if compact:
            result = json.dumps(data, ensure_ascii=False, separators=(",", ":"))
        else:
            result = json.dumps(data, ensure_ascii=False, indent=2)
        return {"ok": True, "result": result, "type": type(data).__name__}
    except json.JSONDecodeError as e:
        return {"ok": False, "error": f"JSON 解析失败: {e}"}


def json_query(text: str, path: str) -> dict:
    """JSON 路径查询（简易版，支持 a.b.c 和 a[0].b 格式）"""
    try:
        data = json.loads(text)
    except json.JSONDecodeError as e:
        return {"ok": False, "error": f"JSON 解析失败: {e}"}

    # 解析路径
    keys = re.split(r"\.", path)
    current = data
    for key in keys:
        if not key:
            continue
        # 处理数组索引: key[0]
        m = re.match(r"^(.+?)\[(\d+)\]$", key)
        if m:
            key_name, idx = m.group(1), int(m.group(2))
            if isinstance(current, dict) and key_name in current:
                current = current[key_name]
            if isinstance(current, list) and idx < len(current):
                current = current[idx]
            else:
                return {"ok": False, "error": f"路径不存在: {path}（在 {key} 处）"}
        elif isinstance(current, dict) and key in current:
            current = current[key]
        else:
            return {"ok": False, "error": f"路径不存在: {path}（在 {key} 处）"}

    result_str = json.dumps(current, ensure_ascii=False, indent=2) if isinstance(current, (dict, list)) else str(current)
    return {"ok": True, "path": path, "result": result_str, "type": type(current).__name__}


def regex_extract(text: str, pattern: str, group: int = 0) -> dict:
    """正则表达式提取"""
    try:
        matches = re.finditer(pattern, text)
        results = []
        for m in matches:
            if group > 0 and group <= len(m.groups()):
                results.append(m.group(group))
            else:
                results.append(m.group(0))
            if len(results) >= 200:
                break
        return {"ok": True, "pattern": pattern, "match_count": len(results), "matches": results}
    except re.error as e:
        return {"ok": False, "error": f"正则表达式错误: {e}"}


def text_stats(text: str) -> dict:
    """文本统计分析"""
    lines = text.split("\n")
    words = text.split()
    # 中文字符统计
    chinese_chars = len(re.findall(r"[\u4e00-\u9fff]", text))
    # 字符频率 Top 10（排除空白）
    char_freq = Counter(c for c in text if not c.isspace()).most_common(10)

    return {
        "ok": True,
        "chars": len(text),
        "chars_no_space": len(text.replace(" ", "").replace("\n", "").replace("\t", "")),
        "lines": len(lines),
        "words": len(words),
        "chinese_chars": chinese_chars,
        "paragraphs": len([p for p in text.split("\n\n") if p.strip()]),
        "top_chars": [{"char": c, "count": n} for c, n in char_freq],
        "avg_line_length": round(sum(len(l) for l in lines) / max(len(lines), 1), 1)
    }


def template_render(template: str, variables: str) -> dict:
    """简易模板渲染（{{key}} 占位符替换）"""
    try:
        vars_dict = json.loads(variables)
    except json.JSONDecodeError as e:
        return {"ok": False, "error": f"变量 JSON 解析失败: {e}"}

    result = template
    missing = []
    for key, value in vars_dict.items():
        placeholder = "{{" + key + "}}"
        if placeholder in result:
            result = result.replace(placeholder, str(value))

    # 检查未替换的占位符
    remaining = re.findall(r"\{\{(\w+)\}\}", result)
    if remaining:
        missing = list(set(remaining))

    return {"ok": True, "result": result, "missing_variables": missing}


def text_clean(text: str, operations: str = "trim,collapse_spaces") -> dict:
    """文本清洗"""
    ops = [op.strip() for op in operations.split(",")]
    result = text

    for op in ops:
        if op == "trim":
            result = "\n".join(line.rstrip() for line in result.split("\n")).strip()
        elif op == "collapse_spaces":
            result = re.sub(r" {2,}", " ", result)
        elif op == "remove_blank_lines":
            result = re.sub(r"\n{3,}", "\n\n", result)
        elif op == "remove_bom":
            result = result.lstrip("\ufeff")
        elif op == "normalize_newlines":
            result = result.replace("\r\n", "\n").replace("\r", "\n")
        elif op == "remove_control":
            result = re.sub(r"[\x00-\x08\x0b\x0c\x0e-\x1f]", "", result)
        elif op == "lowercase":
            result = result.lower()
        elif op == "uppercase":
            result = result.upper()

    return {"ok": True, "operations": ops, "result": result, "original_length": len(text), "result_length": len(result)}


def text_replace(text: str, find: str, replace: str, use_regex: bool = False) -> dict:
    """文本替换"""
    if use_regex:
        try:
            count = len(re.findall(find, text))
            result = re.sub(find, replace, text)
        except re.error as e:
            return {"ok": False, "error": f"正则错误: {e}"}
    else:
        count = text.count(find)
        result = text.replace(find, replace)

    return {"ok": True, "replacements": count, "result": result}


def main():
    parser = argparse.ArgumentParser(description="文本/数据处理工具")
    parser.add_argument("--action", required=True,
                        choices=["encode", "decode", "json_fmt", "json_query", "regex",
                                 "stats", "template", "clean", "replace"],
                        help="操作类型")
    parser.add_argument("--text", default=None, help="输入文本（或通过 --file 读取）")
    parser.add_argument("--file", default=None, help="从文件读取输入")
    parser.add_argument("--encoding", default="base64", help="编码类型: base64/url/hex/md5/sha256")
    parser.add_argument("--path", default=None, help="JSON 查询路径")
    parser.add_argument("--pattern", default=None, help="正则表达式")
    parser.add_argument("--group", type=int, default=0, help="正则分组")
    parser.add_argument("--variables", default="{}", help="模板变量 JSON")
    parser.add_argument("--operations", default="trim,collapse_spaces", help="清洗操作（逗号分隔）")
    parser.add_argument("--find", default=None, help="查找字符串")
    parser.add_argument("--replace", default="", help="替换字符串")
    parser.add_argument("--use-regex", action="store_true", help="替换时使用正则")
    parser.add_argument("--compact", action="store_true", help="JSON 压缩输出")
    args = parser.parse_args()

    # 获取输入文本
    text = args.text or ""
    if args.file:
        try:
            text = Path(args.file).read_text(encoding="utf-8")
        except Exception as e:
            print(json.dumps({"ok": False, "error": f"读取文件失败: {e}"}, ensure_ascii=False))
            sys.exit(1)

    if args.action == "encode":
        result = encode_text(text, args.encoding)
    elif args.action == "decode":
        result = decode_text(text, args.encoding)
    elif args.action == "json_fmt":
        result = json_format(text, args.compact)
    elif args.action == "json_query":
        if not args.path:
            result = {"ok": False, "error": "需要 --path 参数"}
        else:
            result = json_query(text, args.path)
    elif args.action == "regex":
        if not args.pattern:
            result = {"ok": False, "error": "需要 --pattern 参数"}
        else:
            result = regex_extract(text, args.pattern, args.group)
    elif args.action == "stats":
        result = text_stats(text)
    elif args.action == "template":
        result = template_render(text, args.variables)
    elif args.action == "clean":
        result = text_clean(text, args.operations)
    elif args.action == "replace":
        if args.find is None:
            result = {"ok": False, "error": "需要 --find 参数"}
        else:
            result = text_replace(text, args.find, args.replace, args.use_regex)
    else:
        result = {"ok": False, "error": f"未知操作: {args.action}"}

    print(json.dumps(result, ensure_ascii=False, indent=2))
    sys.exit(0 if result.get("ok") else 1)


if __name__ == "__main__":
    main()
