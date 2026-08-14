"""Authenticated HTTPS bridge between the Cloudflare Worker and Modal Sandboxes."""
from __future__ import annotations

import base64
import hmac
import os
import re
import time
from typing import Annotated

import modal
from modal.stream_type import StreamType
from fastapi import Depends, FastAPI, Header, HTTPException, Query
from pydantic import BaseModel, Field, field_validator

APP_NAME = "ino-modal-bridge"
BRIDGE_SECRET_NAME = "ino-modal-bridge"
DESKTOP_PORT = 6080
LOG_PATH = "/var/log/ino/codex.log"
STATUS_PATH = "/var/log/ino/codex.status"
MAX_LOG_BYTES = 8 * 1024
MAX_OFFSET = 16 * 1024 * 1024
SANDBOX_ID_PATTERN = re.compile(r"^[A-Za-z0-9_-]{1,200}$")

sandbox_image = (
    modal.Image.debian_slim()
    .apt_install(
        "bash", "ca-certificates", "curl", "git", "fluxbox", "novnc", "websockify",
        "x11vnc", "xvfb", "xterm",
    )
    .run_commands(
        "curl -fsSL https://deb.nodesource.com/setup_22.x | bash -",
        "DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends nodejs",
        "npm install -g @openai/codex",
        "mkdir -p /workspace /var/log/ino",
    )
)
bridge_image = modal.Image.debian_slim().pip_install("fastapi[standard]")
app = modal.App(APP_NAME)


class Repository(BaseModel):
    fullName: str = Field(pattern=r"^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$", max_length=200)
    defaultBranch: str = Field(min_length=1, max_length=255)
    url: str = Field(max_length=300)

    @field_validator("url")
    @classmethod
    def canonical_github_url(cls, value: str, info: object) -> str:
        full_name = getattr(info, "data", {}).get("fullName")
        if value != f"https://github.com/{full_name}" or not full_name:
            raise ValueError("invalid repository")
        return value


class Credentials(BaseModel):
    openaiApiKey: str = Field(min_length=1, max_length=500)
    githubToken: str | None = Field(default=None, max_length=500)


class LaunchRequest(BaseModel):
    sessionId: str = Field(min_length=1, max_length=200)
    repository: Repository
    prompt: str = Field(min_length=1, max_length=8_000)
    credentials: Credentials


def bridge_token(authorization: Annotated[str | None, Header()] = None) -> None:
    expected = os.environ.get("MODAL_BRIDGE_TOKEN")
    supplied = authorization.removeprefix("Bearer ") if authorization else ""
    if not expected or not hmac.compare_digest(supplied, expected):
        raise HTTPException(status_code=401, detail="unauthorized")


def sandbox_id(value: str) -> str:
    if not SANDBOX_ID_PATTERN.fullmatch(value):
        raise HTTPException(status_code=404, detail="not found")
    return value


def desktop_command() -> str:
    return " ".join((
        "set -eu;",
        "Xvfb :1 -screen 0 1440x900x24 >/var/log/ino/xvfb.log 2>&1 &",
        "for i in $(seq 1 50); do test -S /tmp/.X11-unix/X1 && break; sleep 0.1; done;",
        "test -S /tmp/.X11-unix/X1;",
        "DISPLAY=:1 fluxbox >/var/log/ino/fluxbox.log 2>&1 &",
        "x11vnc -display :1 -forever -shared -nopw -rfbport 5900 >/var/log/ino/x11vnc.log 2>&1 &",
        "exec websockify --web /usr/share/novnc 6080 localhost:5900",
    ))


def agent_command() -> str:
    # Values enter only via the process environment, never shell interpolation or persisted bridge state.
    return " ".join((
        "set +e; : > \"$INO_CODEX_LOG\"; rm -f \"$INO_STATUS_PATH\";",
        "xterm -display :1 -geometry 180x48+20+20 -title 'Ino Codex' -e bash -lc",
        "'printf \"Ino Codex terminal ready. Cloning repository in 8 seconds...\\n\" | tee -a \"$INO_CODEX_LOG\"; sleep 8; git clone --branch \"$INO_REPO_BRANCH\" --single-branch \"$INO_REPO_URL\" /workspace/repo 2>&1 | tee -a \"$INO_CODEX_LOG\"; clone_exit=${PIPESTATUS[0]}; unset GIT_CONFIG_COUNT GIT_CONFIG_KEY_0 GIT_CONFIG_VALUE_0; if [ \"$clone_exit\" -eq 0 ]; then cd /workspace/repo && set -o pipefail && env -u GIT_CONFIG_COUNT -u GIT_CONFIG_KEY_0 -u GIT_CONFIG_VALUE_0 -u INO_REPO_URL -u INO_REPO_BRANCH codex exec --sandbox danger-full-access \"$INO_PROMPT\" 2>&1 | tee -a \"$INO_CODEX_LOG\"; agent_exit=${PIPESTATUS[0]}; else agent_exit=$clone_exit; fi; printf \"%s\\n\" \"$agent_exit\" > \"$INO_STATUS_PATH\"; printf \"\\nCodex finished (exit %s). This terminal remains open for review.\\n\" \"$agent_exit\" | tee -a \"$INO_CODEX_LOG\"; exec bash'",
        ">>\"$INO_CODEX_LOG\" 2>&1 &",
        "disown || true",
    ))


def launch_environment(request: LaunchRequest) -> dict[str, str]:
    environment = {
        "OPENAI_API_KEY": request.credentials.openaiApiKey,
        "INO_PROMPT": request.prompt,
        "INO_REPO_URL": request.repository.url,
        "INO_REPO_BRANCH": request.repository.defaultBranch,
        "INO_CODEX_LOG": LOG_PATH,
        "INO_STATUS_PATH": STATUS_PATH,
    }
    if request.credentials.githubToken:
        token = base64.b64encode(f"x-access-token:{request.credentials.githubToken}".encode()).decode()
        environment.update({
            "GIT_CONFIG_COUNT": "1",
            "GIT_CONFIG_KEY_0": "http.https://github.com/.extraheader",
            "GIT_CONFIG_VALUE_0": f"AUTHORIZATION: basic {token}",
        })
    return environment


def vnc_url(sandbox: modal.Sandbox) -> str:
    # Sandbox readiness only means the container is running. The background
    # desktop command still needs time to bind port 6080 and create its tunnel.
    deadline = time.monotonic() + 60
    while time.monotonic() < deadline:
        try:
            tunnel = sandbox.tunnels(timeout=5).get(DESKTOP_PORT)
        except Exception:
            # Modal raises while the encrypted port is still being registered.
            tunnel = None
        if tunnel and tunnel.url.startswith("https://"):
            return f"{tunnel.url.rstrip('/')}/vnc.html?autoconnect=1&resize=scale"
        time.sleep(1)
    raise RuntimeError("desktop unavailable")


def read_text(process: object) -> str:
    return "".join(getattr(process, "stdout"))


def create_api() -> FastAPI:
    service = FastAPI()

    @service.post("/launch", dependencies=[Depends(bridge_token)])
    def launch(request: LaunchRequest) -> dict[str, str]:
        sandbox: modal.Sandbox | None = None
        try:
            sandbox = modal.Sandbox.create(
                "bash", "-lc", desktop_command(), app=app, image=sandbox_image,
                encrypted_ports=[DESKTOP_PORT], timeout=20 * 60, idle_timeout=10 * 60, workdir="/workspace",
            )
            url = vnc_url(sandbox)
            sandbox.exec("bash", "-lc", agent_command(), stdout=StreamType.DEVNULL,
                         stderr=StreamType.DEVNULL, workdir="/workspace", env=launch_environment(request))
            return {"id": sandbox.object_id, "vncUrl": url}
        except Exception:
            if sandbox is not None:
                try:
                    sandbox.terminate()
                except Exception:
                    pass
            raise HTTPException(status_code=502, detail="launch failed") from None

    @service.get("/status/{raw_sandbox_id}", dependencies=[Depends(bridge_token)])
    def status(raw_sandbox_id: str, offset: int = Query(default=0, ge=0, le=MAX_OFFSET)) -> dict[str, int | str | None]:
        sandbox = modal.Sandbox.from_id(sandbox_id(raw_sandbox_id))
        try:
            log_process = sandbox.exec("bash", "-lc", f"test -f {LOG_PATH} && tail -c +{offset + 1} {LOG_PATH} | head -c {MAX_LOG_BYTES} || true", timeout=3)
            status_process = sandbox.exec("bash", "-lc", f"test -f {STATUS_PATH} && cat {STATUS_PATH} || true", timeout=3)
            log = read_text(log_process)
            while len(log.encode("utf-8")) > MAX_LOG_BYTES:
                log = log[:-1]
            raw_exit = read_text(status_process).strip()
            agent_exit = int(raw_exit) if re.fullmatch(r"-?\d+", raw_exit) else None
            return {
                "log": log,
                "nextLogOffset": offset + len(log.encode("utf-8")),
                "agentExitCode": agent_exit,
                "sandboxExitCode": sandbox.poll(),
            }
        except Exception:
            raise HTTPException(status_code=502, detail="status unavailable") from None

    @service.post("/terminate/{raw_sandbox_id}", dependencies=[Depends(bridge_token)])
    def terminate(raw_sandbox_id: str) -> dict[str, bool]:
        try:
            modal.Sandbox.from_id(sandbox_id(raw_sandbox_id)).terminate(wait=True)
            return {"terminated": True}
        except Exception:
            raise HTTPException(status_code=502, detail="termination failed") from None

    return service


@app.function(image=bridge_image, secrets=[modal.Secret.from_name(BRIDGE_SECRET_NAME, required_keys=["MODAL_BRIDGE_TOKEN"])])
@modal.asgi_app()
def api() -> FastAPI:
    return create_api()
