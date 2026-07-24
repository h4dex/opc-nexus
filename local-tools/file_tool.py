#!/usr/bin/env python3
"""
文件批处理工具 - AiBoxDash 本地工具集
支持: 批量重命名、文件查找、目录树、文件统计、压缩/解压、文件哈希

用法:
  python file_tool.py --action <rename|find|tree|stats|zip|unzip|hash|dedup> --path <路径> [选项]

输出: JSON 格式
依赖: 仅标准库，无需额外安装
"""
import argparse
import hashlib
import json
import os
import re
import shutil
import sys
import zipfile
from pathlib import Path


def batch_rename(path: str, pattern: str, replacement: str, dry_run: bool = True) -> dict:
    """批量重命名（正则替换）"""
    dir_path = Path(path)
    if not dir_path.is_dir():
        return {"ok": False, "error": f"目录不存在: {path}"}

    renamed = []
    for f in sorted(dir_path.iterdir()):
        if not f.is_file():
            continue
        new_name = re.sub(pattern, replacement, f.name)
        if new_name != f.name:
            new_path = f.parent / new_name
            renamed.append({"from": f.name, "to": new_name})
            if not dry_run:
                if new_path.exists():
                    continue  # 跳过冲突
                f.rename(new_path)

    return {
        "ok": True,
        "dry_run": dry_run,
        "renamed_count": len(renamed),
        "changes": renamed[:50]  # 最多显示 50 条
    }


def find_files(path: str, pattern: str = "*", recursive: bool = True,
               min_size: int = None, max_size: int = None) -> dict:
    """文件查找"""
    root = Path(path)
    if not root.exists():
        return {"ok": False, "error": f"路径不存在: {path}"}

    files = []
    glob_fn = root.rglob if recursive else root.glob
    for f in glob_fn(pattern):
        if not f.is_file():
            continue
        size = f.stat().st_size
        if min_size and size < min_size:
            continue
        if max_size and size > max_size:
            continue
        files.append({
            "path": str(f.resolve()),
            "name": f.name,
            "size_bytes": size,
            "modified": f.stat().st_mtime
        })
        if len(files) >= 500:  # 限制结果数量
            break

    return {"ok": True, "count": len(files), "files": files}


def dir_tree(path: str, max_depth: int = 3, show_files: bool = True) -> dict:
    """目录树结构"""
    root = Path(path)
    if not root.is_dir():
        return {"ok": False, "error": f"目录不存在: {path}"}

    tree_lines = []
    file_count = 0
    dir_count = 0

    def walk(dir_path: Path, prefix: str, depth: int):
        nonlocal file_count, dir_count
        if depth > max_depth:
            return
        entries = sorted(dir_path.iterdir(), key=lambda x: (x.is_file(), x.name.lower()))
        # 过滤隐藏文件和 node_modules 等
        entries = [e for e in entries if not e.name.startswith(".") and e.name not in
                   ("node_modules", "__pycache__", ".git", "venv", ".venv")]
        for i, entry in enumerate(entries):
            is_last = i == len(entries) - 1
            connector = "└── " if is_last else "├── "
            if entry.is_dir():
                dir_count += 1
                tree_lines.append(f"{prefix}{connector}{entry.name}/")
                extension = "    " if is_last else "│   "
                walk(entry, prefix + extension, depth + 1)
            elif show_files:
                file_count += 1
                size = entry.stat().st_size
                size_str = f" ({size} B)" if size < 1024 else f" ({size // 1024} KB)"
                tree_lines.append(f"{prefix}{connector}{entry.name}{size_str}")

    tree_lines.append(f"{root.name}/")
    walk(root, "", 1)

    return {
        "ok": True,
        "root": str(root.resolve()),
        "dirs": dir_count,
        "files": file_count,
        "tree": "\n".join(tree_lines[:300])  # 限制输出行数
    }


def file_stats(path: str) -> dict:
    """文件/目录统计"""
    root = Path(path)
    if not root.exists():
        return {"ok": False, "error": f"路径不存在: {path}"}

    if root.is_file():
        stat = root.stat()
        return {
            "ok": True, "path": str(root.resolve()), "type": "file",
            "size_bytes": stat.st_size, "modified": stat.st_mtime,
            "extension": root.suffix, "name": root.name
        }

    # 目录统计
    total_size = 0
    file_count = 0
    dir_count = 0
    ext_stats = {}

    for f in root.rglob("*"):
        if f.is_file():
            file_count += 1
            size = f.stat().st_size
            total_size += size
            ext = f.suffix.lower() or "(无扩展名)"
            if ext not in ext_stats:
                ext_stats[ext] = {"count": 0, "size": 0}
            ext_stats[ext]["count"] += 1
            ext_stats[ext]["size"] += size
        elif f.is_dir():
            dir_count += 1

    # 按大小排序取 Top 10
    top_ext = sorted(ext_stats.items(), key=lambda x: x[1]["size"], reverse=True)[:10]

    return {
        "ok": True,
        "path": str(root.resolve()),
        "type": "directory",
        "total_size_bytes": total_size,
        "total_size_mb": round(total_size / 1024 / 1024, 2),
        "file_count": file_count,
        "dir_count": dir_count,
        "by_extension": {ext: info for ext, info in top_ext}
    }


def zip_dir(path: str, output: str = None) -> dict:
    """压缩目录为 ZIP"""
    root = Path(path)
    if not root.is_dir():
        return {"ok": False, "error": f"目录不存在: {path}"}

    out = Path(output) if output else root.with_suffix(".zip")
    file_count = 0

    with zipfile.ZipFile(str(out), "w", zipfile.ZIP_DEFLATED) as zf:
        for f in root.rglob("*"):
            if f.is_file():
                # 跳过 node_modules 等
                rel = f.relative_to(root)
                if any(part in ("node_modules", ".git", "__pycache__", "venv") for part in rel.parts):
                    continue
                zf.write(f, rel)
                file_count += 1

    return {"ok": True, "output": str(out.resolve()), "files": file_count, "size_bytes": out.stat().st_size}


def unzip_file(path: str, output: str = None) -> dict:
    """解压 ZIP 文件"""
    src = Path(path)
    if not src.is_file():
        return {"ok": False, "error": f"文件不存在: {path}"}

    out_dir = Path(output) if output else src.with_suffix("")
    out_dir.mkdir(parents=True, exist_ok=True)

    with zipfile.ZipFile(str(src), "r") as zf:
        names = zf.namelist()
        zf.extractall(str(out_dir))

    return {"ok": True, "output": str(out_dir.resolve()), "files": len(names)}


def file_hash(path: str, algorithm: str = "sha256") -> dict:
    """计算文件哈希"""
    fpath = Path(path)
    if not fpath.is_file():
        return {"ok": False, "error": f"文件不存在: {path}"}

    h = hashlib.new(algorithm)
    with open(fpath, "rb") as f:
        while chunk := f.read(8192):
            h.update(chunk)

    return {"ok": True, "file": str(fpath.resolve()), "algorithm": algorithm, "hash": h.hexdigest()}


def find_duplicates(path: str) -> dict:
    """查找重复文件（基于大小 + MD5）"""
    root = Path(path)
    if not root.is_dir():
        return {"ok": False, "error": f"目录不存在: {path}"}

    # 先按大小分组
    size_map = {}
    for f in root.rglob("*"):
        if f.is_file():
            size = f.stat().st_size
            if size > 0:
                size_map.setdefault(size, []).append(f)

    # 对同大小文件计算 MD5
    duplicates = []
    for size, files in size_map.items():
        if len(files) < 2:
            continue
        hash_map = {}
        for f in files:
            h = hashlib.md5()
            with open(f, "rb") as fp:
                while chunk := fp.read(8192):
                    h.update(chunk)
            digest = h.hexdigest()
            hash_map.setdefault(digest, []).append(str(f.resolve()))

        for digest, paths in hash_map.items():
            if len(paths) >= 2:
                duplicates.append({"hash": digest, "size_bytes": size, "files": paths})

    return {"ok": True, "duplicate_groups": len(duplicates), "duplicates": duplicates[:20]}


def main():
    parser = argparse.ArgumentParser(description="文件批处理工具")
    parser.add_argument("--action", required=True,
                        choices=["rename", "find", "tree", "stats", "zip", "unzip", "hash", "dedup"],
                        help="操作类型")
    parser.add_argument("--path", required=True, help="目标路径")
    parser.add_argument("--output", default=None, help="输出路径")
    parser.add_argument("--pattern", default="*", help="匹配模式（find: glob, rename: 正则）")
    parser.add_argument("--replacement", default="", help="重命名替换字符串")
    parser.add_argument("--recursive", action="store_true", default=True, help="递归搜索")
    parser.add_argument("--dry-run", action="store_true", default=True, help="重命名预览模式（默认开启）")
    parser.add_argument("--execute", action="store_true", help="实际执行重命名（关闭 dry-run）")
    parser.add_argument("--depth", type=int, default=3, help="目录树深度")
    parser.add_argument("--algorithm", default="sha256", choices=["md5", "sha1", "sha256"], help="哈希算法")
    args = parser.parse_args()

    dry_run = not args.execute

    actions = {
        "rename": lambda: batch_rename(args.path, args.pattern, args.replacement, dry_run),
        "find": lambda: find_files(args.path, args.pattern, args.recursive),
        "tree": lambda: dir_tree(args.path, args.depth),
        "stats": lambda: file_stats(args.path),
        "zip": lambda: zip_dir(args.path, args.output),
        "unzip": lambda: unzip_file(args.path, args.output),
        "hash": lambda: file_hash(args.path, args.algorithm),
        "dedup": lambda: find_duplicates(args.path),
    }

    result = actions[args.action]()
    print(json.dumps(result, ensure_ascii=False, indent=2))
    sys.exit(0 if result.get("ok") else 1)


if __name__ == "__main__":
    main()
