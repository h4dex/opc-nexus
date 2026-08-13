import importlib.util
import json
import sys
from pathlib import Path

import responses


GATEWAY = "http://127.0.0.1:18766"


def test_catalog_registers_exactly_42_tools(plugin):
    catalog = json.loads(plugin.CATALOG_PATH.read_text(encoding="utf-8"))
    names = [entry["name"] for entry in catalog["tools"]]
    assert len(names) == 42
    assert len(set(names)) == 42
    assert set(plugin._SCHEMAS) == set(names)
    assert set(plugin._HANDLERS) == set(names)


def test_catalog_is_the_schema_source(plugin):
    catalog = json.loads(plugin.CATALOG_PATH.read_text(encoding="utf-8"))
    for entry in catalog["tools"]:
        assert plugin._SCHEMAS[entry["name"]] == {
            "name": entry["name"],
            "description": entry["description"],
            "parameters": entry["parameters"],
        }


def test_missing_task_token_fails_closed(plugin, monkeypatch):
    monkeypatch.delenv("OPCNEXUS_MOBILE_TASK_TOKEN")
    result = json.loads(plugin._HANDLERS["android_ping"]({}))
    assert "OPCNEXUS_MOBILE_TASK_TOKEN is required" in result["error"]


def test_non_loopback_gateway_is_rejected(plugin, monkeypatch):
    monkeypatch.setenv("OPCNEXUS_MOBILE_GATEWAY_URL", "http://192.168.1.20:18766")
    result = json.loads(plugin._HANDLERS["android_ping"]({}))
    assert "loopback HTTP URL" in result["error"]


@responses.activate
def test_tool_forwards_args_and_token(plugin):
    responses.add(
        responses.POST,
        f"{GATEWAY}/v1/tools/android_tap",
        json={"success": True},
    )
    result = json.loads(plugin._HANDLERS["android_tap"]({"node_id": "node-7"}))
    assert result == {"success": True}
    request = responses.calls[0].request
    assert request.headers["Authorization"] == "Bearer task-token"
    assert json.loads(request.body) == {"args": {"node_id": "node-7"}}


@responses.activate
def test_android_setup_only_reads_gateway_status(plugin, tmp_path, monkeypatch):
    monkeypatch.setenv("HOME", str(tmp_path))
    responses.add(
        responses.GET,
        f"{GATEWAY}/v1/status",
        json={"bound": True, "online": True, "deviceId": "phone-1"},
    )
    result = json.loads(plugin._HANDLERS["android_setup"]({}))
    assert result["deviceId"] == "phone-1"
    assert responses.calls[0].request.method == "GET"
    assert list(tmp_path.rglob(".env")) == []
    source = Path(plugin.__file__).read_text(encoding="utf-8")
    assert "android_relay" not in source
    assert "save_env_value" not in source


@responses.activate
def test_check_requirements_tracks_binding_and_connection(plugin):
    responses.add(responses.GET, f"{GATEWAY}/v1/status", json={"bound": True, "online": True})
    assert plugin._check_requirements() is True
    responses.reset()
    responses.add(responses.GET, f"{GATEWAY}/v1/status", json={"bound": True, "online": False})
    assert plugin._check_requirements() is False


@responses.activate
def test_gateway_error_body_is_preserved(plugin):
    responses.add(
        responses.POST,
        f"{GATEWAY}/v1/tools/android_type",
        json={"error": "permission_denied:accessibility"},
        status=403,
    )
    result = json.loads(plugin._HANDLERS["android_type"]({"text": "secret"}))
    assert "permission_denied:accessibility" in result["error"]


@responses.activate
def test_media_result_downloads_task_scoped_artifact(plugin):
    responses.add(
        responses.POST,
        f"{GATEWAY}/v1/tools/android_screenshot",
        json={
            "success": True,
            "artifact": {"id": "artifact-1", "filename": "screen.png"},
            "mediaUrl": "/v1/artifacts/artifact-1",
        },
    )
    responses.add(
        responses.GET,
        f"{GATEWAY}/v1/artifacts/artifact-1",
        body=b"\x89PNG\r\n\x1a\nimage",
        content_type="image/png",
    )
    result = plugin._HANDLERS["android_screenshot"]({})
    payload, media = result.split("\nMEDIA:", 1)
    assert json.loads(payload)["artifact"]["id"] == "artifact-1"
    path = Path(media)
    try:
        assert path.suffix == ".png"
        assert path.read_bytes().startswith(b"\x89PNG")
        assert responses.calls[1].request.headers["Authorization"] == "Bearer task-token"
    finally:
        path.unlink(missing_ok=True)


def test_plugin_register_function_registers_all_tools(plugin):
    package_spec = importlib.util.spec_from_file_location(
        "opcnexus_android",
        Path(plugin.__file__).with_name("__init__.py"),
        submodule_search_locations=[str(Path(plugin.__file__).parent)],
    )
    package = importlib.util.module_from_spec(package_spec)
    sys.modules[package_spec.name] = package
    package_spec.loader.exec_module(package)

    class Context:
        def __init__(self):
            self.tools = []

        def register_tool(self, **kwargs):
            self.tools.append(kwargs)

    context = Context()
    package.register(context)
    assert len(context.tools) == 42
    assert {item["name"] for item in context.tools} == set(plugin._SCHEMAS)
    assert all(item["toolset"] == "android" for item in context.tools)
