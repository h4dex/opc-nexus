"""OPC-Nexus host tools exposed only inside a managed project service."""

from __future__ import annotations

import json
import os
import uuid
from urllib.parse import urlparse
from urllib.error import HTTPError
from urllib.request import Request, urlopen

from tools.registry import registry, tool_error


def _host_config() -> tuple[str, str] | None:
    origin = os.getenv("HERMES_NEXUS_HOST_URL", "").strip().rstrip("/")
    token = os.getenv("HERMES_NEXUS_HOST_TOKEN", "").strip()
    if not origin or not token:
        return None
    parsed = urlparse(origin)
    if parsed.scheme != "http" or parsed.hostname not in {"127.0.0.1", "localhost", "::1"}:
        return None
    return origin, token


def _available() -> bool:
    return _host_config() is not None


def _call_host_tool(operation: str, args: dict, *, write: bool = False) -> str:
    """Invoke one real OPC-Nexus capability through Main's host contract.

    Hermes never receives a filesystem/browser credential and never starts a
    second browser or desktop controller.  The authenticated Main process
    owns capability checks, workspace boundaries, audit records and failures.
    """
    config = _host_config()
    if config is None:
        return tool_error("OPC-Nexus 工具桥接不可用：Hermes 项目服务尚未绑定")
    if write and args.get("ownerConfirmed") is not True:
        return tool_error("写入工具需要 ownerConfirmed=true；只有老板明确要求该动作时才允许调用")
    origin, token = config
    payload = json.dumps(args, ensure_ascii=False).encode("utf-8")
    request = Request(
        f"{origin}/{operation}",
        data=payload,
        method="POST",
        headers={
            "content-type": "application/json",
            "x-opc-nexus-host-token": token,
        },
    )
    try:
        with urlopen(request, timeout=180) as response:
            body = json.loads(response.read().decode("utf-8"))
    except HTTPError as exc:
        detail = ""
        try:
            raw = exc.read().decode("utf-8", errors="replace")
            parsed = json.loads(raw) if raw else None
            if isinstance(parsed, dict) and isinstance(parsed.get("error"), str):
                detail = parsed["error"].strip()
            elif raw.strip():
                detail = raw.strip()
        except Exception:
            detail = ""
        suffix = f": {detail[:4000]}" if detail else ""
        return tool_error(f"OPC-Nexus 工具被阻断（HTTP {exc.code}）{suffix}")
    except Exception as exc:
        return tool_error(f"OPC-Nexus 工具调用失败：{exc}")
    if not isinstance(body, dict) or body.get("ok") is not True:
        return tool_error(str(body.get("error", "OPC-Nexus 工具调用失败")))
    return json.dumps({"status": "executed_by_opc_nexus", "operation": operation, "result": body.get("result")}, ensure_ascii=False)


def _nexus_http_request(args: dict, parent_agent=None) -> str:
    method = str(args.get("method") or "GET").strip().upper()
    return _call_host_tool("http-request", args, write=method != "GET")


def _nexus_web_search(args: dict, parent_agent=None) -> str:
    return _call_host_tool("web-search", args)


def _nexus_web_search_aggregate(args: dict, parent_agent=None) -> str:
    return _call_host_tool("web-search-aggregate", args)


def _nexus_research_search(args: dict, parent_agent=None) -> str:
    return _call_host_tool("research-search", args)


def _nexus_browser_navigate(args: dict, parent_agent=None) -> str:
    return _call_host_tool("browser-navigate", args)


def _nexus_browser_snapshot(args: dict, parent_agent=None) -> str:
    return _call_host_tool("browser-snapshot", args)


def _nexus_browser_get_content(args: dict, parent_agent=None) -> str:
    return _call_host_tool("browser-get-content", args)


def _nexus_browser_click(args: dict, parent_agent=None) -> str:
    return _call_host_tool("browser-click", args, write=True)


def _nexus_browser_type(args: dict, parent_agent=None) -> str:
    return _call_host_tool("browser-type", args, write=True)


def _nexus_browser_screenshot(args: dict, parent_agent=None) -> str:
    return _call_host_tool("browser-screenshot", args)


def _nexus_browser_evaluate(args: dict, parent_agent=None) -> str:
    return _call_host_tool("browser-evaluate", args, write=True)


def _nexus_computer_screenshot(args: dict, parent_agent=None) -> str:
    return _call_host_tool("computer-screenshot", args)


def _nexus_computer_click(args: dict, parent_agent=None) -> str:
    return _call_host_tool("computer-click", args, write=True)


def _nexus_computer_type(args: dict, parent_agent=None) -> str:
    return _call_host_tool("computer-type", args, write=True)


def _nexus_computer_key(args: dict, parent_agent=None) -> str:
    return _call_host_tool("computer-key", args, write=True)


def _nexus_audio_synthesize(args: dict, parent_agent=None) -> str:
    return _call_host_tool("audio-synthesize", args, write=True)


def _nexus_video_probe(args: dict, parent_agent=None) -> str:
    return _call_host_tool("video-probe", args)


def _nexus_video_trim(args: dict, parent_agent=None) -> str:
    return _call_host_tool("video-trim", args, write=True)


def _nexus_video_concat(args: dict, parent_agent=None) -> str:
    return _call_host_tool("video-concat", args, write=True)


def _nexus_video_extract_audio(args: dict, parent_agent=None) -> str:
    return _call_host_tool("video-extract-audio", args, write=True)


def _nexus_video_thumbnail(args: dict, parent_agent=None) -> str:
    return _call_host_tool("video-thumbnail", args, write=True)


def _nexus_image_generate(args: dict, parent_agent=None) -> str:
    """Generate or edit an image through the project-scoped OPC-Nexus Provider."""
    return _call_host_tool("image-generate", args, write=True)


def _register_nexus_tool(name: str, description: str, properties: dict, required: list[str], handler, *, write: bool = False):
    schema = {
        "name": name,
        "description": description,
        "parameters": {
            "type": "object",
            "additionalProperties": False,
            "properties": properties,
            "required": required,
        },
    }
    registry.register(name=name, toolset="planning", schema=schema,
                      handler=lambda args, **kw: handler(args, kw.get("parent_agent")),
                      check_fn=_available, emoji="N")


_register_nexus_tool(
    "nexus_web_search", "通过 OPC-Nexus 主进程执行真实联网搜索并返回来源 URL。", {"query": {"type": "string"}}, ["query"], _nexus_web_search)
_register_nexus_tool(
    "nexus_web_search_aggregate",
    "并行查询 Bing 与 DuckDuckGo，去重并返回带搜索引擎标记的真实结果；不可达引擎会明确标记 unavailable。",
    {"query": {"type": "string"}, "maxResults": {"type": "integer", "minimum": 1, "maximum": 12}},
    ["query"], _nexus_web_search_aggregate)
_register_nexus_tool(
    "nexus_research_search",
    "先聚合多个搜索引擎，再抓取有限数量的正文，返回 S1/S2 来源编号、URL、HTTP 状态、抓取时间和引用文本；禁止把 failed/skipped 来源当作事实依据。",
    {"query": {"type": "string"}, "maxResults": {"type": "integer", "minimum": 1, "maximum": 12},
     "maxSources": {"type": "integer", "minimum": 1, "maximum": 8},
     "domains": {"type": "array", "items": {"type": "string"}}},
    ["query"], _nexus_research_search)
_register_nexus_tool(
    "nexus_http_request", "通过 OPC-Nexus 主进程发起真实 HTTP/HTTPS 请求。GET 只读；POST/PUT/DELETE 必须 ownerConfirmed=true。",
    {"url": {"type": "string"}, "method": {"type": "string", "enum": ["GET", "POST", "PUT", "DELETE"]},
     "headers": {"type": "object"}, "body": {"type": "string"}, "ownerConfirmed": {"type": "boolean"}}, ["url"], _nexus_http_request)
_register_nexus_tool("nexus_browser_navigate", "通过 OPC-Nexus 真实浏览器导航到 http/https 页面。", {"url": {"type": "string"}, "cdp_url": {"type": "string"}}, ["url"], _nexus_browser_navigate)
_register_nexus_tool("nexus_browser_snapshot", "读取当前真实浏览器页面文本。", {}, [], _nexus_browser_snapshot)
_register_nexus_tool("nexus_browser_get_content", "读取当前真实浏览器页面正文文本。", {}, [], _nexus_browser_get_content)
_register_nexus_tool("nexus_browser_click", "在真实浏览器中点击 CSS 元素；必须 ownerConfirmed=true。", {"selector": {"type": "string"}, "ownerConfirmed": {"type": "boolean"}}, ["selector", "ownerConfirmed"], _nexus_browser_click, write=True)
_register_nexus_tool("nexus_browser_type", "在真实浏览器输入文本；必须 ownerConfirmed=true。", {"selector": {"type": "string"}, "text": {"type": "string"}, "ownerConfirmed": {"type": "boolean"}}, ["selector", "text", "ownerConfirmed"], _nexus_browser_type, write=True)
_register_nexus_tool("nexus_browser_screenshot", "保存真实浏览器页面截图到项目工作目录。", {"selector": {"type": "string"}}, [], _nexus_browser_screenshot)
_register_nexus_tool("nexus_browser_evaluate", "在真实浏览器页面执行 JavaScript；必须 ownerConfirmed=true。", {"script": {"type": "string"}, "ownerConfirmed": {"type": "boolean"}}, ["script", "ownerConfirmed"], _nexus_browser_evaluate, write=True)
_register_nexus_tool("nexus_computer_screenshot", "截取真实主机桌面截图；项目必须使用主机沙箱。", {}, [], _nexus_computer_screenshot)
_register_nexus_tool("nexus_computer_click", "控制真实主机鼠标；项目必须使用主机沙箱且 ownerConfirmed=true。", {"x": {"type": "number"}, "y": {"type": "number"}, "button": {"type": "string", "enum": ["left", "right"]}, "ownerConfirmed": {"type": "boolean"}}, ["x", "y", "ownerConfirmed"], _nexus_computer_click, write=True)
_register_nexus_tool("nexus_computer_type", "向真实主机当前焦点输入文本；必须 ownerConfirmed=true。", {"text": {"type": "string"}, "ownerConfirmed": {"type": "boolean"}}, ["text", "ownerConfirmed"], _nexus_computer_type, write=True)
_register_nexus_tool("nexus_computer_key", "向真实主机发送按键组合；必须 ownerConfirmed=true。", {"keys": {"type": "string"}, "ownerConfirmed": {"type": "boolean"}}, ["keys", "ownerConfirmed"], _nexus_computer_key, write=True)
_register_nexus_tool("nexus_audio_synthesize", "使用真实 Edge TTS 或已配置的 Hermes TTS provider 合成音频并保存到项目目录；依赖未安装时明确失败。", {"text": {"type": "string"}, "voice": {"type": "string", "description": "Edge TTS voice；使用 Hermes provider 时以其项目配置为准"}, "outputPath": {"type": "string"}, "ownerConfirmed": {"type": "boolean"}}, ["text", "ownerConfirmed"], _nexus_audio_synthesize, write=True)
_register_nexus_tool("nexus_video_probe", "使用真实 FFmpeg 探测视频流和时长。", {"inputPath": {"type": "string"}}, ["inputPath"], _nexus_video_probe)
_register_nexus_tool("nexus_video_trim", "使用真实 FFmpeg 剪切视频；必须 ownerConfirmed=true。", {"inputPath": {"type": "string"}, "outputPath": {"type": "string"}, "startSec": {"type": "number"}, "durationSec": {"type": "number"}, "ownerConfirmed": {"type": "boolean"}}, ["inputPath", "outputPath", "ownerConfirmed"], _nexus_video_trim, write=True)
_register_nexus_tool("nexus_video_concat", "使用真实 FFmpeg 拼接视频；必须 ownerConfirmed=true。", {"inputPaths": {"type": "array", "items": {"type": "string"}}, "outputPath": {"type": "string"}, "ownerConfirmed": {"type": "boolean"}}, ["inputPaths", "outputPath", "ownerConfirmed"], _nexus_video_concat, write=True)
_register_nexus_tool("nexus_video_extract_audio", "使用真实 FFmpeg 从视频抽取音频；必须 ownerConfirmed=true。", {"inputPath": {"type": "string"}, "outputPath": {"type": "string"}, "ownerConfirmed": {"type": "boolean"}}, ["inputPath", "outputPath", "ownerConfirmed"], _nexus_video_extract_audio, write=True)
_register_nexus_tool("nexus_video_thumbnail", "使用真实 FFmpeg 生成视频缩略图；必须 ownerConfirmed=true。", {"inputPath": {"type": "string"}, "outputPath": {"type": "string"}, "timeSec": {"type": "number"}, "ownerConfirmed": {"type": "boolean"}}, ["inputPath", "outputPath", "ownerConfirmed"], _nexus_video_thumbnail, write=True)
_register_nexus_tool(
    "nexus_image_generate",
    "通过当前项目配置的真实图片 Provider 进行文生图或图生图；结果写入项目目录并返回 SHA-256 产物信息。必须 ownerConfirmed=true。",
    {
        "prompt": {"type": "string"},
        "model": {"type": "string"},
        "size": {"type": "string", "enum": ["1024x1024", "1536x1024", "1024x1536", "auto"]},
        "quality": {"type": "string", "enum": ["auto", "low", "medium", "high"]},
        "count": {"type": "integer", "minimum": 1, "maximum": 4},
        "imagePath": {"type": "string"},
        "imagePaths": {"type": "array", "items": {"type": "string"}, "maxItems": 16},
        "outputPath": {"type": "string"},
        "ownerConfirmed": {"type": "boolean"},
    },
    ["prompt", "ownerConfirmed"],
    _nexus_image_generate,
    write=True,
)


def _create_employee(args: dict, parent_agent=None) -> str:
    """Create a real OPC-Nexus employee through the authenticated Main host.

    Hermes may propose the employee profile, but Main owns validation, engine
    readiness, organization scope, persistence, and audit. The tool never
    creates an implicit employee: it is called only when the owner explicitly
    asks Hermes to staff the project.
    """
    config = _host_config()
    if config is None:
        return tool_error("OPC-Nexus employee provisioning is unavailable in this Hermes service.")
    origin, token = config
    body = {
        "ownerConfirmed": args.get("ownerConfirmed", False),
        "name": args.get("name"),
        "role": args.get("role"),
        "systemPrompt": args.get("systemPrompt", ""),
        "soulMd": args.get("soulMd", ""),
        "agentsMd": args.get("agentsMd", ""),
        "userMd": args.get("userMd", ""),
        "permissionMode": args.get("permissionMode", "autonomous"),
        "memoryMode": args.get("memoryMode", "short_term"),
        "concurrencyLimit": args.get("concurrencyLimit", 1),
        "capabilities": args.get("capabilities", {}),
        "addToProjectPool": args.get("addToProjectPool", False),
    }
    if args.get("engineId"):
        body["engineId"] = args.get("engineId")
    payload = json.dumps(body, ensure_ascii=False).encode("utf-8")
    request = Request(
        f"{origin}/create-employee",
        data=payload,
        method="POST",
        headers={
            "content-type": "application/json",
            "x-opc-nexus-host-token": token,
        },
    )
    try:
        with urlopen(request, timeout=30) as response:
            body = json.loads(response.read().decode("utf-8"))
    except HTTPError as exc:
        detail = ""
        try:
            raw = exc.read().decode("utf-8", errors="replace")
            parsed = json.loads(raw) if raw else None
            if isinstance(parsed, dict) and isinstance(parsed.get("error"), str):
                detail = parsed["error"].strip()
            elif raw.strip():
                detail = raw.strip()
        except Exception:
            detail = ""
        suffix = f": {detail[:4000]}" if detail else ""
        return tool_error(f"OPC-Nexus rejected employee provisioning (HTTP {exc.code}){suffix}")
    except Exception as exc:
        return tool_error(f"OPC-Nexus rejected employee provisioning: {exc}")
    if not isinstance(body, dict) or body.get("ok") is not True:
        return tool_error(str(body.get("error", "OPC-Nexus rejected employee provisioning")))
    return json.dumps(
        {
            "status": "created_by_opc_nexus",
            "employee": body.get("result"),
            "note": "The employee is real and persisted. Use the returned exact id for later delegation; do not claim task execution until nexus_delegate_task returns a receipt.",
        },
        ensure_ascii=False,
    )


NEXUS_CREATE_EMPLOYEE_SCHEMA = {
    "name": "nexus_create_employee",
    "description": (
        "Create one real OPC-Nexus digital employee from the owner's staffing request. "
        "Use only when the owner explicitly asks to create or staff an employee. "
        "Main validates the engine, permissions, memory policy, organization scope and audit. "
        "Do not invent an employee id; use the id returned by this tool."
    ),
    "parameters": {
        "type": "object",
        "additionalProperties": False,
        "properties": {
            "ownerConfirmed": {"type": "boolean", "description": "Must be true only when the owner explicitly requested this employee"},
            "name": {"type": "string", "description": "Display name, 2-30 characters"},
            "role": {"type": "string", "description": "Concrete responsibility, 2-500 characters"},
            "systemPrompt": {"type": "string"},
            "soulMd": {"type": "string"},
            "agentsMd": {"type": "string"},
            "userMd": {"type": "string"},
            "engineId": {"type": "string", "description": "Exact configured engine id; omit to use the healthy default"},
            "permissionMode": {"type": "string", "enum": ["readonly", "standard", "trusted", "autonomous"]},
            "memoryMode": {"type": "string", "enum": ["long_term", "short_term", "none"]},
            "concurrencyLimit": {"type": "integer", "minimum": 1, "maximum": 8},
            "capabilities": {
                "type": "object",
                "additionalProperties": False,
                "properties": {
                    "network": {"type": "boolean"},
                    "shell": {"type": "boolean"},
                    "install": {"type": "boolean"},
                    "browser": {"type": "boolean"},
                    "computer": {"type": "boolean"},
                },
            },
            "addToProjectPool": {"type": "boolean", "description": "Only set true when the owner explicitly wants a restricted project employee pool"},
        },
        "required": ["ownerConfirmed", "name", "role"],
    },
}


registry.register(
    name="nexus_create_employee",
    toolset="planning",
    schema=NEXUS_CREATE_EMPLOYEE_SCHEMA,
    handler=lambda args, **kw: _create_employee(args, kw.get("parent_agent")),
    check_fn=_available,
    emoji="N",
)


def _session_id(parent_agent) -> str:
    try:
        from gateway.session_context import get_session_env

        value = get_session_env("HERMES_UI_SESSION_ID", "") or get_session_env("HERMES_SESSION_ID", "")
        if value:
            return str(value)
    except Exception:
        pass
    return str(getattr(parent_agent, "session_id", "") or "")


def _submit_plan(args: dict, parent_agent=None) -> str:
    config = _host_config()
    if config is None:
        return tool_error("OPC-Nexus plan governance is unavailable in this Hermes service.")
    session_id = _session_id(parent_agent)
    if not session_id:
        return tool_error("The Hermes session has no OPC-Nexus project binding.")
    origin, token = config
    payload = json.dumps(
        {
            "hermesSessionId": session_id,
            "model": os.getenv("HERMES_INFERENCE_MODEL", "unknown"),
            "draft": args,
        },
        ensure_ascii=False,
    ).encode("utf-8")
    request = Request(
        f"{origin}/submit-plan",
        data=payload,
        method="POST",
        headers={
            "content-type": "application/json",
            "x-opc-nexus-host-token": token,
        },
    )
    try:
        with urlopen(request, timeout=30) as response:
            body = json.loads(response.read().decode("utf-8"))
    except HTTPError as exc:
        # urllib otherwise exposes only "422 Unprocessable Entity", which
        # leaves Hermes unable to repair an invalid plan. The host contract
        # returns a bounded JSON error with the exact governance rule, so keep
        # that diagnostic in the tool result while retaining the real status.
        detail = ""
        try:
            raw = exc.read().decode("utf-8", errors="replace")
            parsed = json.loads(raw) if raw else None
            if isinstance(parsed, dict) and isinstance(parsed.get("error"), str):
                detail = parsed["error"].strip()
            elif raw.strip():
                detail = raw.strip()
        except Exception:
            detail = ""
        suffix = f": {detail[:4000]}" if detail else ""
        return tool_error(f"OPC-Nexus rejected the plan submission (HTTP {exc.code}){suffix}")
    except Exception as exc:
        return tool_error(f"OPC-Nexus rejected the plan submission: {exc}")
    if not isinstance(body, dict) or body.get("ok") is not True:
        return tool_error(str(body.get("error", "OPC-Nexus rejected the plan submission")))
    return json.dumps(
        {
            "status": "projected_for_owner_approval",
            "governance": body.get("result"),
            "note": "OPC-Nexus owns approval and execution. Do not claim that this plan is approved or complete.",
        },
        ensure_ascii=False,
    )


def nexus_clarify_callback(session_id: str):
    """Create a non-blocking, durable OPC-Nexus clarify callback for API sessions."""
    stable_session_id = str(session_id or "").strip()

    def _clarify(question, choices, multi_select=False):
        config = _host_config()
        if config is None:
            raise RuntimeError("OPC-Nexus clarification governance is unavailable")
        if not stable_session_id:
            raise RuntimeError("The Hermes session has no OPC-Nexus project binding")
        clarify_id = f"clarify_{uuid.uuid4().hex}"
        origin, token = config
        payload = json.dumps(
            {
                "clarifyId": clarify_id,
                "hermesSessionId": stable_session_id,
                "question": str(question or "").strip(),
                "choices": list(choices or []),
                "multiSelect": bool(multi_select),
            },
            ensure_ascii=False,
        ).encode("utf-8")
        request = Request(
            f"{origin}/clarify",
            data=payload,
            method="POST",
            headers={
                "content-type": "application/json",
                "x-opc-nexus-host-token": token,
            },
        )
        try:
            with urlopen(request, timeout=30) as response:
                body = json.loads(response.read().decode("utf-8"))
        except Exception as exc:
            raise RuntimeError(f"OPC-Nexus rejected the clarification: {exc}") from exc
        if not isinstance(body, dict) or body.get("ok") is not True:
            raise RuntimeError(str(body.get("error", "OPC-Nexus rejected the clarification")))
        return f"OPC_NEXUS_CLARIFY_PENDING:{clarify_id}"

    return _clarify


NEXUS_SUBMIT_PLAN_SCHEMA = {
    "name": "nexus_submit_plan",
    "description": (
        "Submit a complex project execution plan to OPC-Nexus host governance. "
        "Use only after material ambiguity has been resolved with clarify. "
        "This creates an approval draft; it never approves or executes work."
    ),
    "parameters": {
        "type": "object",
        "additionalProperties": False,
        "properties": {
            "objective": {"type": "string"},
            "assumptions": {"type": "array", "items": {"type": "string"}},
            "scope": {
                "type": "object",
                "additionalProperties": False,
                "properties": {
                    "included": {"type": "array", "items": {"type": "string"}},
                    "excluded": {"type": "array", "items": {"type": "string"}},
                },
                "required": ["included", "excluded"],
            },
            "team": {
                "type": "array",
                "items": {
                    "type": "object",
                    "additionalProperties": False,
                    "properties": {
                        "workerAgentId": {"type": "string", "description": "Exact ID from NEXUS-CONTEXT.md"},
                        "responsibility": {"type": "string"},
                        "capabilities": {"type": "array", "items": {"type": "string"}},
                    },
                    "required": ["workerAgentId", "responsibility", "capabilities"],
                },
            },
            "dag": {
                "type": "array",
                "items": {
                    "type": "object",
                    "additionalProperties": False,
                    "properties": {
                        "id": {"type": "string"},
                        "title": {"type": "string"},
                        "workerAgentId": {"type": "string", "description": "Exact ID from NEXUS-CONTEXT.md"},
                        "dependsOn": {"type": "array", "items": {"type": "string"}},
                        "acceptanceCriteria": {"type": "array", "items": {"type": "string"}},
                        "expectedArtifacts": {
                            "type": "array",
                            "items": {"type": "string"},
                            "description": (
                                "Plan-level relative artifact paths owned only by this node. "
                                "Every plan artifact must be assigned to exactly one DAG node."
                            ),
                        },
                    },
                    "required": [
                        "id", "title", "workerAgentId", "dependsOn",
                        "acceptanceCriteria", "expectedArtifacts"
                    ],
                },
            },
            "risks": {
                "type": "array",
                "items": {
                    "type": "object",
                    "additionalProperties": False,
                    "properties": {
                        "id": {"type": "string"},
                        "description": {"type": "string"},
                        "mitigation": {"type": "string"},
                        "approvalRequired": {"type": "boolean"},
                    },
                    "required": ["id", "description", "mitigation", "approvalRequired"],
                },
            },
            "budget": {
                "type": "object",
                "additionalProperties": False,
                "properties": {
                    "maxCost": {"type": "integer", "minimum": 0},
                    "maxTokens": {"type": "integer", "minimum": 0},
                    "maxConcurrent": {"type": "integer", "minimum": 1, "maximum": 32},
                },
                "required": ["maxCost", "maxTokens", "maxConcurrent"],
            },
            "acceptanceCriteria": {"type": "array", "items": {"type": "string"}},
            "expectedArtifacts": {
                "type": "array",
                "items": {
                    "type": "object",
                    "additionalProperties": False,
                    "properties": {
                        "relativePath": {"type": "string"},
                        "mediaType": {"type": "string"},
                        "previewable": {"type": "boolean"},
                        "runCommand": {"type": "string"},
                    },
                    "required": ["relativePath", "mediaType", "previewable"],
                },
            },
            "memoryRefs": {"type": "array", "items": {"type": "string"}},
        },
        "required": [
            "objective", "assumptions", "scope", "team", "dag", "risks", "budget",
            "acceptanceCriteria", "expectedArtifacts", "memoryRefs",
        ],
    },
}


registry.register(
    name="nexus_submit_plan",
    toolset="planning",
    schema=NEXUS_SUBMIT_PLAN_SCHEMA,
    handler=lambda args, **kw: _submit_plan(args, kw.get("parent_agent")),
    check_fn=_available,
    emoji="N",
)


def _delegate_task(args: dict, parent_agent=None) -> str:
    config = _host_config()
    if config is None:
        return tool_error("OPC-Nexus employee dispatch is unavailable in this Hermes service.")
    session_id = _session_id(parent_agent)
    if not session_id:
        return tool_error("The Hermes session has no OPC-Nexus project binding.")
    origin, token = config
    payload = json.dumps(
        {
            "requestId": f"task_{uuid.uuid4().hex}",
            "hermesSessionId": session_id,
            "workerAgentId": args.get("workerAgentId"),
            "title": args.get("title"),
            "description": args.get("description"),
            "intent": args.get("intent"),
            "relatedTaskIds": args.get("relatedTaskIds", []),
            "expectedArtifacts": args.get("expectedArtifacts", []),
        },
        ensure_ascii=False,
    ).encode("utf-8")
    request = Request(
        f"{origin}/delegate",
        data=payload,
        method="POST",
        headers={
            "content-type": "application/json",
            "x-opc-nexus-host-token": token,
        },
    )
    try:
        with urlopen(request, timeout=30) as response:
            body = json.loads(response.read().decode("utf-8"))
    except HTTPError as exc:
        # Preserve the host's bounded policy reason.  A bare ``HTTP 422`` is
        # not actionable when the request was rejected by governance (for
        # example, a validation task whose related task is still FAILED).
        detail = ""
        try:
            raw = exc.read().decode("utf-8", errors="replace")
            parsed = json.loads(raw) if raw else None
            if isinstance(parsed, dict) and isinstance(parsed.get("error"), str):
                detail = parsed["error"].strip()
            elif raw.strip():
                detail = raw.strip()
        except Exception:
            detail = ""
        suffix = f": {detail[:4000]}" if detail else ""
        return tool_error(f"OPC-Nexus rejected employee dispatch (HTTP {exc.code}){suffix}")
    except Exception as exc:
        return tool_error(f"OPC-Nexus rejected employee dispatch: {exc}")
    if not isinstance(body, dict) or body.get("ok") is not True:
        return tool_error(str(body.get("error", "OPC-Nexus rejected employee dispatch")))
    return json.dumps(
        {
            "status": "accepted_by_opc_nexus",
            "receipt": body.get("result"),
            "note": "Report only the real task status in this receipt. Do not claim completion yet.",
        },
        ensure_ascii=False,
    )


NEXUS_DELEGATE_TASK_SCHEMA = {
    "name": "nexus_delegate_task",
    "description": (
        "Assign one real task to an OPC-Nexus digital employee. Use the exact employee id "
        "from NEXUS-CONTEXT.md, especially when the owner explicitly @mentions an employee. "
        "Classify the request as execution, status_inquiry, or validation. A status inquiry "
        "must not request artifacts. For independent acceptance use validation and identify "
        "the existing related project tasks."
    ),
    "parameters": {
        "type": "object",
        "additionalProperties": False,
        "properties": {
            "workerAgentId": {"type": "string"},
            "title": {"type": "string"},
            "description": {"type": "string"},
            "intent": {
                "type": "string",
                "enum": ["execution", "status_inquiry", "validation"],
                "description": (
                    "execution creates work; status_inquiry asks for a factual report without "
                    "new files; validation independently checks existing work and returns a verdict"
                ),
            },
            "relatedTaskIds": {
                "type": "array",
                "items": {"type": "string"},
                "description": "Existing project task ids being inspected or validated.",
            },
            "expectedArtifacts": {"type": "array", "items": {"type": "string"}},
        },
        "required": [
            "workerAgentId", "title", "description", "intent", "relatedTaskIds", "expectedArtifacts"
        ],
    },
}


registry.register(
    name="nexus_delegate_task",
    toolset="planning",
    schema=NEXUS_DELEGATE_TASK_SCHEMA,
    handler=lambda args, **kw: _delegate_task(args, kw.get("parent_agent")),
    check_fn=_available,
    emoji="N",
)


def _task_status(args: dict, parent_agent=None) -> str:
    config = _host_config()
    if config is None:
        return tool_error("OPC-Nexus employee status is unavailable in this Hermes service.")
    session_id = _session_id(parent_agent)
    if not session_id:
        return tool_error("The Hermes session has no OPC-Nexus project binding.")
    origin, token = config
    payload = json.dumps(
        {
            "requestId": f"status_{uuid.uuid4().hex}",
            "hermesSessionId": session_id,
            "taskId": args.get("taskId"),
            "waitSeconds": args.get("waitSeconds", 0),
        },
        ensure_ascii=False,
    ).encode("utf-8")
    request = Request(
        f"{origin}/task-status",
        data=payload,
        method="POST",
        headers={
            "content-type": "application/json",
            "x-opc-nexus-host-token": token,
        },
    )
    try:
        with urlopen(request, timeout=30) as response:
            body = json.loads(response.read().decode("utf-8"))
    except Exception as exc:
        return tool_error(f"OPC-Nexus rejected employee status: {exc}")
    if not isinstance(body, dict) or body.get("ok") is not True:
        return tool_error(str(body.get("error", "OPC-Nexus rejected employee status")))
    return json.dumps(
        {
            "status": "authoritative_opc_nexus_task_status",
            "receipt": body.get("result"),
            "note": (
                "Only a terminal COMPLETED status with a real result is successful. "
                "For validation, report completion only when validationVerdict is PASS. "
                "Report FAIL, BLOCKED, FAILED, CANCELLED, and INTERRUPTED honestly."
            ),
        },
        ensure_ascii=False,
    )


NEXUS_TASK_STATUS_SCHEMA = {
    "name": "nexus_task_status",
    "description": (
        "Read the authoritative OPC-Nexus state and result of a task previously created by "
        "nexus_delegate_task. Use waitSeconds for a bounded long poll. Do not claim the "
        "employee completed or validated work before this tool returns a terminal state."
    ),
    "parameters": {
        "type": "object",
        "additionalProperties": False,
        "properties": {
            "taskId": {"type": "string"},
            "waitSeconds": {"type": "integer", "minimum": 0, "maximum": 25},
        },
        "required": ["taskId", "waitSeconds"],
    },
}


registry.register(
    name="nexus_task_status",
    toolset="planning",
    schema=NEXUS_TASK_STATUS_SCHEMA,
    handler=lambda args, **kw: _task_status(args, kw.get("parent_agent")),
    check_fn=_available,
    emoji="N",
)


def _mcp_call(args: dict, parent_agent=None) -> str:
    config = _host_config()
    if config is None:
        return tool_error("OPC-Nexus MCP bridge is unavailable in this Hermes service.")
    origin, token = config
    payload = json.dumps(
        {
            "serverId": args.get("serverId"),
            "toolName": args.get("toolName"),
            "args": args.get("args", {}),
        },
        ensure_ascii=False,
    ).encode("utf-8")
    request = Request(
        f"{origin}/mcp-call",
        data=payload,
        method="POST",
        headers={
            "content-type": "application/json",
            "x-opc-nexus-host-token": token,
        },
    )
    try:
        with urlopen(request, timeout=60) as response:
            body = json.loads(response.read().decode("utf-8"))
    except Exception as exc:
        return tool_error(f"OPC-Nexus MCP call failed: {exc}")
    if not isinstance(body, dict) or body.get("ok") is not True:
        return tool_error(str(body.get("error", "OPC-Nexus MCP call failed")))
    return json.dumps(body.get("result"), ensure_ascii=False)


NEXUS_MCP_CALL_SCHEMA = {
    "name": "nexus_mcp_call",
    "description": (
        "Call one MCP tool selected in the OPC-Nexus project plugin center. "
        "Use only server and tool names listed as ready in the host context."
    ),
    "parameters": {
        "type": "object",
        "additionalProperties": False,
        "properties": {
            "serverId": {"type": "string"},
            "toolName": {"type": "string"},
            "args": {"type": "object"},
        },
        "required": ["serverId", "toolName", "args"],
    },
}


registry.register(
    name="nexus_mcp_call",
    toolset="planning",
    schema=NEXUS_MCP_CALL_SCHEMA,
    handler=lambda args, **kw: _mcp_call(args, kw.get("parent_agent")),
    check_fn=_available,
    emoji="N",
)
