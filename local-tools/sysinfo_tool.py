#!/usr/bin/env python3
"""
系统信息工具 - AiBoxDash 本地工具集
支持: CPU/内存/磁盘/网络/进程/环境变量 等系统信息读取

用法:
  python sysinfo_tool.py --action <overview|cpu|memory|disk|network|process|env> [--top 10] [--path C:\\]

输出: JSON 格式
依赖: 仅标准库（os, platform, shutil, subprocess），无需额外安装
"""
import argparse
import json
import os
import platform
import shutil
import socket
import subprocess
import sys
import time
from pathlib import Path


def get_cpu_info() -> dict:
    """获取 CPU 信息"""
    info = {
        "processor": platform.processor() or "Unknown",
        "cores_physical": os.cpu_count(),
        "architecture": platform.machine(),
    }
    # Windows: 通过 wmic 获取详细 CPU 信息
    if platform.system() == "Windows":
        try:
            out = subprocess.check_output(
                ["wmic", "cpu", "get", "Name,NumberOfCores,NumberOfLogicalProcessors,MaxClockSpeed", "/format:list"],
                text=True, timeout=10, stderr=subprocess.DEVNULL
            )
            for line in out.strip().split("\n"):
                line = line.strip()
                if line.startswith("Name="):
                    info["name"] = line.split("=", 1)[1]
                elif line.startswith("NumberOfCores="):
                    info["cores_physical"] = int(line.split("=", 1)[1])
                elif line.startswith("NumberOfLogicalProcessors="):
                    info["cores_logical"] = int(line.split("=", 1)[1])
                elif line.startswith("MaxClockSpeed="):
                    info["max_clock_mhz"] = int(line.split("=", 1)[1])
        except Exception:
            pass
    else:
        # Linux: /proc/cpuinfo
        try:
            with open("/proc/cpuinfo") as f:
                lines = f.readlines()
            for line in lines:
                if "model name" in line:
                    info["name"] = line.split(":", 1)[1].strip()
                    break
            info["cores_logical"] = len([l for l in lines if l.startswith("processor")])
        except Exception:
            pass
    return info


def get_memory_info() -> dict:
    """获取内存信息"""
    info = {}
    if platform.system() == "Windows":
        try:
            out = subprocess.check_output(
                ["wmic", "OS", "get", "TotalVisibleMemorySize,FreePhysicalMemory", "/format:list"],
                text=True, timeout=10, stderr=subprocess.DEVNULL
            )
            for line in out.strip().split("\n"):
                line = line.strip()
                if line.startswith("TotalVisibleMemorySize="):
                    total_kb = int(line.split("=", 1)[1])
                    info["total_gb"] = round(total_kb / 1024 / 1024, 2)
                elif line.startswith("FreePhysicalMemory="):
                    free_kb = int(line.split("=", 1)[1])
                    info["free_gb"] = round(free_kb / 1024 / 1024, 2)
            if "total_gb" in info and "free_gb" in info:
                info["used_gb"] = round(info["total_gb"] - info["free_gb"], 2)
                info["usage_percent"] = round(info["used_gb"] / info["total_gb"] * 100, 1)
        except Exception:
            pass
    else:
        try:
            with open("/proc/meminfo") as f:
                for line in f:
                    if line.startswith("MemTotal:"):
                        info["total_gb"] = round(int(line.split()[1]) / 1024 / 1024, 2)
                    elif line.startswith("MemAvailable:"):
                        info["free_gb"] = round(int(line.split()[1]) / 1024 / 1024, 2)
            if "total_gb" in info and "free_gb" in info:
                info["used_gb"] = round(info["total_gb"] - info["free_gb"], 2)
                info["usage_percent"] = round(info["used_gb"] / info["total_gb"] * 100, 1)
        except Exception:
            pass
    return info


def get_disk_info(path: str = None) -> dict:
    """获取磁盘信息"""
    target = path or (Path.home().drive if platform.system() == "Windows" else "/")
    usage = shutil.disk_usage(target)
    return {
        "path": str(target),
        "total_gb": round(usage.total / 1024**3, 2),
        "used_gb": round(usage.used / 1024**3, 2),
        "free_gb": round(usage.free / 1024**3, 2),
        "usage_percent": round(usage.used / usage.total * 100, 1)
    }


def get_network_info() -> dict:
    """获取网络信息"""
    info = {"hostname": socket.gethostname()}
    try:
        info["ip_addresses"] = socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET)
        info["ip_addresses"] = list(set(addr[4][0] for addr in info["ip_addresses"]))
    except Exception:
        info["ip_addresses"] = []
    # 获取默认网关和 DNS（Windows）
    if platform.system() == "Windows":
        try:
            out = subprocess.check_output(
                ["ipconfig"], text=True, timeout=10, stderr=subprocess.DEVNULL
            )
            gateways = []
            dns_servers = []
            for line in out.split("\n"):
                line = line.strip()
                if "默认网关" in line or "Default Gateway" in line:
                    gw = line.split(":")[-1].strip()
                    if gw and gw != "0.0.0.0":
                        gateways.append(gw)
                elif "DNS" in line:
                    dns = line.split(":")[-1].strip()
                    if dns:
                        dns_servers.append(dns)
            info["gateways"] = gateways
            info["dns_servers"] = dns_servers
        except Exception:
            pass
    return info


def get_process_list(top: int = 10) -> list:
    """获取占用资源最多的进程"""
    processes = []
    if platform.system() == "Windows":
        try:
            out = subprocess.check_output(
                ["tasklist", "/FO", "CSV", "/NH"],
                text=True, timeout=15, stderr=subprocess.DEVNULL
            )
            for line in out.strip().split("\n")[:top + 5]:
                parts = line.strip('"').split('","')
                if len(parts) >= 5:
                    name = parts[0]
                    pid = parts[1]
                    mem = parts[4].replace(" K", "").replace(",", "")
                    try:
                        processes.append({"name": name, "pid": int(pid), "memory_kb": int(mem)})
                    except ValueError:
                        continue
        except Exception:
            pass
    else:
        try:
            out = subprocess.check_output(
                ["ps", "aux", "--sort=-%mem"],
                text=True, timeout=10, stderr=subprocess.DEVNULL
            )
            lines = out.strip().split("\n")[1:top + 1]
            for line in lines:
                parts = line.split(None, 10)
                if len(parts) >= 11:
                    processes.append({
                        "user": parts[0], "pid": int(parts[1]),
                        "cpu_percent": float(parts[2]), "mem_percent": float(parts[3]),
                        "command": parts[10][:100]
                    })
        except Exception:
            pass
    return processes[:top]


def get_overview() -> dict:
    """系统概览"""
    return {
        "system": platform.system(),
        "release": platform.release(),
        "version": platform.version(),
        "machine": platform.machine(),
        "python_version": platform.python_version(),
        "hostname": socket.gethostname(),
        "username": os.getlogin() if hasattr(os, "getlogin") else os.environ.get("USERNAME", "unknown"),
        "cpu": get_cpu_info(),
        "memory": get_memory_info(),
        "disk": get_disk_info(),
        "uptime_info": f"Python {platform.python_version()} on {platform.system()} {platform.release()}"
    }


def main():
    parser = argparse.ArgumentParser(description="系统信息工具")
    parser.add_argument("--action", required=True,
                        choices=["overview", "cpu", "memory", "disk", "network", "process", "env"],
                        help="查询类型")
    parser.add_argument("--top", type=int, default=10, help="进程列表数量（默认 10）")
    parser.add_argument("--path", default=None, help="磁盘查询路径")
    parser.add_argument("--keys", default=None, help="环境变量过滤（逗号分隔的前缀）")
    args = parser.parse_args()

    if args.action == "overview":
        result = get_overview()
    elif args.action == "cpu":
        result = get_cpu_info()
    elif args.action == "memory":
        result = get_memory_info()
    elif args.action == "disk":
        result = get_disk_info(args.path)
    elif args.action == "network":
        result = get_network_info()
    elif args.action == "process":
        result = {"processes": get_process_list(args.top)}
    elif args.action == "env":
        env = dict(os.environ)
        if args.keys:
            prefixes = [k.strip() for k in args.keys.split(",")]
            env = {k: v for k, v in env.items() if any(k.startswith(p) for p in prefixes)}
        # 过滤敏感变量
        sensitive = {"PASSWORD", "SECRET", "TOKEN", "API_KEY", "CREDENTIAL"}
        env = {k: ("***" if any(s in k.upper() for s in sensitive) else v) for k, v in env.items()}
        result = {"env": env, "count": len(env)}
    else:
        result = {"error": f"未知操作: {args.action}"}

    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
