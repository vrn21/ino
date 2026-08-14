from __future__ import annotations

import os
import sys
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock

from fastapi.testclient import TestClient
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import modal_bridge as bridge

AUTH = {"Authorization": "Bearer test-bridge-secret"}
LAUNCH = {
    "sessionId": "session-123",
    "repository": {
        "fullName": "acme/repository",
        "defaultBranch": "main",
        "url": "https://github.com/acme/repository",
    },
    "prompt": "Fix the failing test",
    "credentials": {"openaiApiKey": "sk-synthetic-test-key", "githubToken": "github_pat_synthetic"},
}


class FakeProcess:
    def __init__(self, output: str):
        self.stdout = iter([output])


class FakeSandbox:
    def __init__(self, *, tunnel_outputs: list[object] | None = None, log: str = "", agent_status: str = "0\n"):
        self.object_id = "sb_test_123"
        self.tunnel_outputs = list(tunnel_outputs or [{bridge.DESKTOP_PORT: SimpleNamespace(url="https://desktop.modal.run/")}])
        self.log = log
        self.agent_status = agent_status
        self.exec_calls: list[tuple[tuple[object, ...], dict[str, object]]] = []
        self.terminated: list[dict[str, object]] = []
        self.poll_result: int | None = None

    def tunnels(self, timeout: int):
        value = self.tunnel_outputs.pop(0)
        if isinstance(value, Exception):
            raise value
        return value

    def exec(self, *args: object, **kwargs: object) -> FakeProcess:
        self.exec_calls.append((args, kwargs))
        command = str(args[2]) if len(args) > 2 else ""
        return FakeProcess(self.agent_status if bridge.STATUS_PATH in command else self.log)

    def poll(self) -> int | None:
        return self.poll_result

    def terminate(self, **kwargs: object) -> None:
        self.terminated.append(kwargs)


@pytest.fixture(autouse=True)
def configured_token(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("MODAL_BRIDGE_TOKEN", "test-bridge-secret")


@pytest.fixture
def client() -> TestClient:
    return TestClient(bridge.create_api())


def test_bearer_auth_rejects_missing_and_invalid_requests(client: TestClient) -> None:
    assert client.post("/launch", json=LAUNCH).status_code == 401
    assert client.post("/launch", headers={"Authorization": "Bearer wrong"}, json=LAUNCH).status_code == 401


def test_bearer_auth_accepts_valid_request_and_launches(monkeypatch: pytest.MonkeyPatch, client: TestClient) -> None:
    sandbox = FakeSandbox()
    create = Mock(return_value=sandbox)
    monkeypatch.setattr(bridge.modal.Sandbox, "create", create)

    response = client.post("/launch", headers=AUTH, json=LAUNCH)

    assert response.status_code == 200
    assert response.json() == {"id": "sb_test_123", "vncUrl": "https://desktop.modal.run/vnc.html?autoconnect=1&resize=scale"}
    assert create.call_count == 1
    assert sandbox.exec_calls[0][1]["env"] == bridge.launch_environment(bridge.LaunchRequest.model_validate(LAUNCH))


def test_tunnel_retry_returns_first_https_tunnel(monkeypatch: pytest.MonkeyPatch) -> None:
    sandbox = FakeSandbox(tunnel_outputs=[RuntimeError("not ready"), {}, {bridge.DESKTOP_PORT: SimpleNamespace(url="https://ready.modal.run")}])
    sleeps: list[int] = []
    monotonic = iter([0, 0, 1, 2])
    monkeypatch.setattr(bridge.time, "monotonic", lambda: next(monotonic))
    monkeypatch.setattr(bridge.time, "sleep", sleeps.append)

    assert bridge.vnc_url(sandbox) == "https://ready.modal.run/vnc.html?autoconnect=1&resize=scale"
    assert sleeps == [1, 1]


def test_launch_terminates_created_sandbox_when_tunnel_or_agent_fails(monkeypatch: pytest.MonkeyPatch, client: TestClient) -> None:
    sandbox = FakeSandbox(tunnel_outputs=[{}])
    monkeypatch.setattr(bridge.modal.Sandbox, "create", Mock(return_value=sandbox))
    monkeypatch.setattr(bridge, "vnc_url", Mock(side_effect=RuntimeError("desktop unavailable")))

    response = client.post("/launch", headers=AUTH, json=LAUNCH)

    assert response.status_code == 502
    assert response.json() == {"detail": "launch failed"}
    assert sandbox.terminated == [{}]


def test_status_uses_incremental_offset_and_utf8_output_bound(monkeypatch: pytest.MonkeyPatch, client: TestClient) -> None:
    sandbox = FakeSandbox(log="🙂" * (bridge.MAX_LOG_BYTES // 2 + 10), agent_status="7\n")
    sandbox.poll_result = 42
    monkeypatch.setattr(bridge.modal.Sandbox, "from_id", Mock(return_value=sandbox))

    response = client.get("/status/sb_test_123?offset=12", headers=AUTH)

    assert response.status_code == 200
    payload = response.json()
    assert len(payload["log"].encode("utf-8")) <= bridge.MAX_LOG_BYTES
    assert payload["nextLogOffset"] == 12 + len(payload["log"].encode("utf-8"))
    assert payload["agentExitCode"] == 7
    assert payload["sandboxExitCode"] == 42
    log_command = str(sandbox.exec_calls[0][0][2])
    assert f"tail -c +13 {bridge.LOG_PATH}" in log_command
    assert f"head -c {bridge.MAX_LOG_BYTES}" in log_command


def test_terminate_reports_success_and_modal_failure(monkeypatch: pytest.MonkeyPatch, client: TestClient) -> None:
    sandbox = FakeSandbox()
    from_id = Mock(return_value=sandbox)
    monkeypatch.setattr(bridge.modal.Sandbox, "from_id", from_id)

    success = client.post("/terminate/sb_test_123", headers=AUTH)

    assert success.status_code == 200
    assert success.json() == {"terminated": True}
    assert sandbox.terminated == [{"wait": True}]

    from_id.side_effect = RuntimeError("Modal unavailable")
    failure = client.post("/terminate/sb_test_123", headers=AUTH)
    assert failure.status_code == 502
    assert failure.json() == {"detail": "termination failed"}
