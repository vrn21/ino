# Architecture

```
client --HTTP polling--> Worker router --> CodingSession Durable Object
                                  \--> GitHub API (optional token)
CodingSession --HTTPS fetch + bearer--> Modal ASGI bridge --> Modal Sandbox
                                                          \--> HTTPS noVNC tunnel
```

The Worker serves the static UI and routes typed JSON APIs. A unique Durable
Object ID is allocated at session creation and is the stable session ID. Its
persisted coordination record contains lifecycle state, selected repository,
initial prompt, capped events, timestamps, Sandbox ID, desktop tunnel URL, and
a byte offset for incremental agent logs.

Cloudflare workerd cannot use the Modal JavaScript SDK's gRPC transport because
of grpc-js ALPN behavior. The Worker therefore performs fetch-only HTTPS calls
to one authenticated Modal ASGI endpoint. The bridge is deployed from
`bridge/modal_bridge.py`, has no database or queue, and owns all Modal Python
SDK interaction.

The bridge starts one Sandbox with an image containing Git, Codex CLI, Xvfb,
fluxbox, xterm, x11vnc, noVNC, and websockify. The desktop command waits for the
X socket, exposes encrypted port 6080, and returns the HTTPS noVNC client URL
with `autoconnect=1` and scaled resizing. A separate process clones the
canonical repository URL and starts `codex exec --sandbox danger-full-access`
inside xterm while teeing output into the bounded status log.

The persisted Sandbox ID enables status and termination reattachment. Polling
returns a maximum 8 KiB incremental log chunk, its UTF-8 byte offset, agent
completion, and Sandbox completion. The Durable Object will not move its cursor
backward or append a zero-progress retry response. Stop invokes the bridge's
`terminate`, which invokes the Modal Sandbox termination API.

The browser persists the GitHub PAT and OpenAI key in its own `localStorage` so
Settings can reuse them across browser sessions; neither value is rendered after
save. The GitHub PAT crosses the Worker only for repository listing and the
single launch request that authenticates the initial clone. The OpenAI key
crosses the Worker only in that launch request. Neither is persisted in Durable
Object state, response JSON, shell command arguments, or Worker error output.
Agent output redacts recognized credentials and authorization headers but
preserves normal logs, bounded in UTF-8 bytes. Follow-up messages are unsupported
rather than being stored as notes or falsely represented as forwarded to Codex.

`MODAL_MODE=mock` is the sole explicit demo path. All other settings require
`MODAL_ENDPOINT` and `MODAL_BRIDGE_TOKEN`; Modal machine tokens stay only in the
deployment environment for the bridge.
