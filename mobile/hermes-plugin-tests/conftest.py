import importlib.util
import sys
from pathlib import Path

import pytest


PLUGIN_DIR = Path(__file__).parents[1] / "hermes-plugin"


@pytest.fixture
def plugin(monkeypatch):
    monkeypatch.setenv("OPCNEXUS_MOBILE_GATEWAY_URL", "http://127.0.0.1:18766")
    monkeypatch.setenv("OPCNEXUS_MOBILE_TASK_TOKEN", "task-token")
    monkeypatch.setenv("OPCNEXUS_MOBILE_TIMEOUT_SECONDS", "5")
    spec = importlib.util.spec_from_file_location("opcnexus_android_tool", PLUGIN_DIR / "android_tool.py")
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module
