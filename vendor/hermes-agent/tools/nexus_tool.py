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
