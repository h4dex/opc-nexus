"""OPC-Nexus Android tools for Hermes Agent.

Derived from raulvidis/hermes-android at
5f2f8ab6a42b8b88a6588f5cda178af8b89f8311 (MIT). OPC-Nexus replaces the
upstream Python relay with a loopback-only adapter to Mobile Gateway.
"""

from __future__ import annotations

import json
import mimetypes
import os
import tempfile
from pathlib import Path
from typing import Any, Callable
from urllib.parse import urlparse

import requests


_PLUGIN_DIR = Path(__file__).resolve().parent
_CATALOG_CANDIDATES = (
    _PLUGIN_DIR / "tool-catalog.json",
    _PLUGIN_DIR.parent / "tool-catalog.json",
)
CATALOG_PATH = next((path for path in _CATALOG_CANDIDATES if path.is_file()), _CATALOG_CANDIDATES[0])
GATEWAY_ENV = "OPCNEXUS_MOBILE_GATEWAY_URL"
TOKEN_ENV = "OPCNEXUS_MOBILE_TASK_TOKEN"
TIMEOUT_ENV = "OPCNEXUS_MOBILE_TIMEOUT_SECONDS"


def _load_catalog() -> dict[str, Any]:
    if not CATALOG_PATH.is_file():
        searched = ", ".join(str(path) for path in _CATALOG_CANDIDATES)
        raise RuntimeError(f"OPC-Nexus Android tool catalog is missing (searched: {searched})")
    with CATALOG_PATH.open("r", encoding="utf-8") as source:
        catalog = json.load(source)
    tools = catalog.get("tools")
    if not isinstance(tools, list) or len(tools) != 42:
        raise RuntimeError("OPC-Nexus Android tool catalog must contain exactly 42 tools")
    names = [entry.get("name") for entry in tools]
    if len(set(names)) != 42 or any(not isinstance(name, str) for name in names):
        raise RuntimeError("OPC-Nexus Android tool catalog contains invalid or duplicate names")
    return catalog


_CATALOG = _load_catalog()
_SCHEMAS = {
    entry["name"]: {
        "name": entry["name"],
        "description": entry["description"],
        "parameters": entry["parameters"],
    }
    for entry in _CATALOG["tools"]
}


def _gateway_url() -> str:
    raw = os.getenv(GATEWAY_ENV, "").strip().rstrip("/")
    parsed = urlparse(raw)
    if parsed.scheme != "http" or parsed.hostname not in {"127.0.0.1", "::1", "localhost"}:
        raise RuntimeError(f"{GATEWAY_ENV} must be a loopback HTTP URL supplied by OPC-Nexus")
    if parsed.username or parsed.password or parsed.query or parsed.fragment:
        raise RuntimeError(f"{GATEWAY_ENV} contains unsupported URL components")
    return raw


def _task_token() -> str:
    token = os.getenv(TOKEN_ENV, "").strip()
    if not token:
        raise RuntimeError(f"{TOKEN_ENV} is required; launch this profile from OPC-Nexus")
    return token


def _timeout() -> float:
    try:
        timeout = float(os.getenv(TIMEOUT_ENV, "35"))
    except ValueError as error:
        raise RuntimeError(f"{TIMEOUT_ENV} must be numeric") from error
    if timeout < 1 or timeout > 300:
        raise RuntimeError(f"{TIMEOUT_ENV} must be between 1 and 300 seconds")
    return timeout


def _headers() -> dict[str, str]:
    return {
        "Authorization": f"Bearer {_task_token()}",
        "Content-Type": "application/json",
        "Accept": "application/json",
    }


def _json_response(response: requests.Response) -> dict[str, Any]:
    try:
        body = response.json()
    except (ValueError, requests.exceptions.JSONDecodeError):
        body = {"error": response.text or f"HTTP {response.status_code}"}
    if not isinstance(body, dict):
        body = {"result": body}
    if not response.ok:
        message = body.get("error", body)
        raise RuntimeError(f"OPC-Nexus Mobile Gateway rejected the request: {message}")
    return body


def _status() -> dict[str, Any]:
    response = requests.get(
        f"{_gateway_url()}/v1/status",
        headers=_headers(),
        timeout=min(_timeout(), 5),
    )
    return _json_response(response)


def _check_requirements() -> bool:
    try:
        state = _status()
        return bool(state.get("bound") and state.get("online"))
    except Exception:
        return False


def _media_suffix(response: requests.Response, result: dict[str, Any]) -> str:
    artifact = result.get("artifact")
    filename = artifact.get("filename", "") if isinstance(artifact, dict) else ""
    suffix = Path(str(filename)).suffix
    if suffix and len(suffix) <= 10:
        return suffix
    content_type = response.headers.get("content-type", "").split(";", 1)[0].strip()
    return mimetypes.guess_extension(content_type) or ".bin"


def _download_media(path: str, result: dict[str, Any]) -> str:
    if not path.startswith("/v1/artifacts/") or "?" in path or "#" in path:
        raise RuntimeError("Mobile Gateway returned an invalid media path")
    response = requests.get(
        f"{_gateway_url()}{path}",
        headers=_headers(),
        timeout=_timeout(),
    )
    if not response.ok:
        _json_response(response)
    handle = tempfile.NamedTemporaryFile(
        prefix="opcnexus_android_",
        suffix=_media_suffix(response, result),
        delete=False,
    )
    try:
        handle.write(response.content)
        handle.flush()
    finally:
        handle.close()
    return handle.name


def _invoke(tool_name: str, args: Any = None) -> str:
    try:
        payload = args if isinstance(args, dict) else {}
        response = requests.post(
            f"{_gateway_url()}/v1/tools/{tool_name}",
            json={"args": payload},
            headers=_headers(),
            timeout=_timeout(),
        )
        result = _json_response(response)
        media_url = result.get("mediaUrl")
        if isinstance(media_url, str):
            media_path = _download_media(media_url, result)
            return f"{json.dumps(result, ensure_ascii=False)}\nMEDIA:{media_path}"
        return json.dumps(result, ensure_ascii=False)
    except Exception as error:
        return json.dumps({"error": str(error)}, ensure_ascii=False)


def android_setup() -> str:
    """Return OPC-Nexus pairing/binding state without changing local config."""
    try:
        return json.dumps(_status(), ensure_ascii=False)
    except Exception as error:
        return json.dumps({"error": str(error)}, ensure_ascii=False)


def _handler(tool_name: str) -> Callable[..., str]:
    if tool_name == "android_setup":
        return lambda args=None, **_kwargs: android_setup()
    return lambda args=None, **_kwargs: _invoke(tool_name, args)


_HANDLERS = {name: _handler(name) for name in _SCHEMAS}
