#!/usr/bin/env python3
"""Exercise the local operation-policy layer without changing SiYuan data."""

from __future__ import annotations

import importlib.util
import json
import os
import subprocess
import sys
from pathlib import Path


BRIDGE = Path(__file__).resolve().parent.parent
PROXY = BRIDGE / "bin" / "siyuan-mcp-stdio.py"
LAUNCHER = Path.home() / "plugins" / "siyuan-notes" / "scripts" / "siyuan_launcher_mcp.py"
POLICY = BRIDGE / "config" / "siyuan-policy.json"


def load_proxy_module():
    spec = importlib.util.spec_from_file_location("siyuan_bridge_policy", PROXY)
    if spec is None or spec.loader is None:
        raise RuntimeError("could not load bridge module")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def assert_policy_matrix(module):
    cases = {
        "readonly": {
            "allow": [("search", "fulltext"), ("document", "get"), ("block", "get_kramdown")],
            "deny": [("document", "create"), ("block", "update"), ("file", "read"), ("sql", "query")],
        },
        "authoring": {
            "allow": [("document", "create"), ("block", "append"), ("block", "update"), ("attr", "set"), ("dailynote", "append")],
            "deny": [("document", "delete"), ("document", "rename"), ("block", "delete"), ("file", "write"), ("sql", "query"), ("http_request", "get")],
        },
        "full": {
            "allow": [("document", "delete"), ("file", "write"), ("sql", "query"), ("http_request", "post"), ("sync", "perform")],
            "deny": [],
        },
    }
    for profile, expected in cases.items():
        os.environ["SIYUAN_MCP_PROFILE"] = profile
        for tool, action in expected["allow"]:
            if not module.action_allowed(tool, action):
                raise AssertionError(f"{profile} unexpectedly denied {tool}.{action}")
        for tool, action in expected["deny"]:
            if module.action_allowed(tool, action):
                raise AssertionError(f"{profile} unexpectedly allowed {tool}.{action}")
    os.environ.pop("SIYUAN_MCP_PROFILE", None)


def launcher_round_trip():
    if not LAUNCHER.is_file():
        raise AssertionError(f"missing policy control server: {LAUNCHER}")
    try:
        original = json.loads(POLICY.read_text(encoding="utf-8")).get("profile", "full")
    except (OSError, ValueError, AttributeError):
        original = "full"
    proc = subprocess.Popen(
        ["/usr/bin/python3", str(LAUNCHER)],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )
    try:
        requests = [
            {"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {"protocolVersion": "2024-11-05", "capabilities": {}, "clientInfo": {"name": "policy-test", "version": "1"}}},
            {"jsonrpc": "2.0", "id": 2, "method": "tools/list", "params": {}},
            {"jsonrpc": "2.0", "id": 3, "method": "resources/list", "params": {}},
            {"jsonrpc": "2.0", "id": 4, "method": "resources/templates/list", "params": {}},
            {"jsonrpc": "2.0", "id": 5, "method": "resources/read", "params": {"uri": "ui://siyuan/controls-v1.html"}},
            {"jsonrpc": "2.0", "id": 6, "method": "tools/call", "params": {"name": "show_siyuan_controls", "arguments": {}}},
            {"jsonrpc": "2.0", "id": 7, "method": "tools/call", "params": {"name": "set_siyuan_policy", "arguments": {"profile": "readonly"}}},
            {"jsonrpc": "2.0", "id": 8, "method": "tools/call", "params": {"name": "get_siyuan_policy", "arguments": {}}},
            {"jsonrpc": "2.0", "id": 9, "method": "tools/call", "params": {"name": "set_siyuan_policy", "arguments": {"profile": original}}},
        ]
        assert proc.stdin is not None and proc.stdout is not None
        for request in requests:
            proc.stdin.write(json.dumps(request, ensure_ascii=False) + "\n")
            proc.stdin.flush()
            line = proc.stdout.readline()
            if not line:
                raise AssertionError("policy control server returned no response")
            response = json.loads(line)
            if "error" in response:
                raise AssertionError("policy control server returned an error")
            result = response.get("result") or {}
            if request["method"] == "initialize":
                extensions = result.get("capabilities", {}).get("extensions", {})
                ui_capability = extensions.get("io.modelcontextprotocol/ui", {})
                if "text/html;profile=mcp-app" not in ui_capability.get("mimeTypes", []):
                    raise AssertionError("initialize omitted MCP Apps capability")
            elif request["method"] == "tools/list":
                names = {tool.get("name") for tool in result.get("tools", [])}
                if "show_siyuan_controls" not in names:
                    raise AssertionError("tools/list omitted show_siyuan_controls")
                show_tool = next(tool for tool in result.get("tools", []) if tool.get("name") == "show_siyuan_controls")
                if show_tool.get("annotations", {}).get("readOnlyHint") is not True:
                    raise AssertionError("show_siyuan_controls is not annotated readonly")
            elif request["method"] == "resources/list":
                resources = result.get("resources", [])
                if not any(resource.get("uri") == "ui://siyuan/controls-v1.html" for resource in resources):
                    raise AssertionError("resources/list omitted the controls resource")
            elif request["method"] == "resources/templates/list":
                if result.get("resourceTemplates") != []:
                    raise AssertionError("resources/templates/list returned an unexpected template")
            elif request["method"] == "resources/read":
                contents = result.get("contents", [])
                if not contents or contents[0].get("mimeType") != "text/html;profile=mcp-app":
                    raise AssertionError("resources/read did not return an MCP Apps HTML resource")
                csp = contents[0].get("_meta", {}).get("ui", {}).get("csp", {})
                if csp.get("connectDomains") != [] or csp.get("resourceDomains") != []:
                    raise AssertionError("controls UI did not declare an empty CSP allowlist")
                html = contents[0].get("text", "")
                for marker in (
                    "2026-01-26",
                    "2025-06-18",
                    "ui/initialize",
                    "appCapabilities",
                    "ui/update-model-context",
                    "ui/request-display-mode",
                    "initialSnapshot",
                    "tools/call",
                    "calc(100vw - 20px)",
                ):
                    if marker not in html:
                        raise AssertionError(f"controls UI is missing {marker}")
            elif request["method"] == "tools/call" and request["params"]["name"] == "show_siyuan_controls":
                structured = result.get("structuredContent") or {}
                if structured.get("profile") not in {"readonly", "authoring", "full"}:
                    raise AssertionError("show_siyuan_controls returned no policy snapshot")
                if (result.get("_meta") or {}).get("ui", {}).get("resourceUri") != "ui://siyuan/controls-v1.html":
                    raise AssertionError("show_siyuan_controls omitted its UI resource metadata")
        observed = json.loads(POLICY.read_text(encoding="utf-8")).get("profile")
        if observed != original:
            raise AssertionError("policy control server did not restore the original profile")
    finally:
        try:
            proc.kill()
        except OSError:
            pass
        proc.wait(timeout=5)


def main():
    module = load_proxy_module()
    assert_policy_matrix(module)
    launcher_round_trip()
    mode = json.loads(POLICY.read_text(encoding="utf-8")).get("profile", "unknown")
    print(f"policy profiles: PASS (readonly/authoring/full; current={mode})")
    print("policy control MCP: PASS (round-trip without touching notes)")


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:  # noqa: BLE001 - concise test failure
        print(f"policy tests: FAIL ({exc})")
        sys.exit(1)
