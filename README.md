# Ino cloud coding agent MVP

Ino is a minimal cloud coding agent: a static UI served by one Cloudflare Worker
and one Durable Object per coding session. The Worker uses HTTPS to call one
Modal-hosted bridge endpoint, which creates a Modal Sandbox per session, runs
Codex against the selected GitHub repository, exposes an HTTPS noVNC desktop,
and returns bounded incremental logs. There is no queue, database, or additional
service.

1. choose a GitHub repository;
2. reuse browser-persisted BYOS credentials for the one launch request;
3. launch Codex in a fresh Modal sandbox with a noVNC desktop;
4. watch bounded Codex output or take over the browser desktop;
5. stop the session to terminate the Modal sandbox.

## Run Worker locally

```sh
npm install
npm run dev
npm test
npm run typecheck
```

Open `http://localhost:8787` after `npm run dev`. For a local demo only, set
`MODAL_MODE=mock` in `.dev.vars`.

## Deploy the Modal bridge

The bridge is a single Modal ASGI web endpoint plus Modal Sandboxes. It is the
necessary HTTPS boundary because Modal's JavaScript gRPC SDK cannot connect from
Cloudflare workerd.

```sh
python3 -m pip install -r bridge/requirements.txt
modal token set --token-id "$MODAL_TOKEN_ID__INO" --token-secret "$MODAL_TOKEN_SECRET__INO"
modal secret create ino-modal-bridge MODAL_BRIDGE_TOKEN='<generate-a-long-random-value>'
modal deploy bridge/modal_bridge.py
```

`modal deploy` prints the public endpoint (normally ending in `.modal.run`). Set
that exact HTTPS URL and the same bearer secret in Cloudflare, never in
`wrangler.toml`:

```sh
npx wrangler secret put MODAL_ENDPOINT
npx wrangler secret put MODAL_BRIDGE_TOKEN
npx wrangler deploy
```

The Modal token is needed only to deploy/manage Modal resources. Do not set it
in the Worker. The bridge secret is read from Modal Secret `ino-modal-bridge`;
the Worker uses the same value only as `Authorization: Bearer …` for `/launch`,
`/status/:id`, and `/terminate/:id`.

| Worker variable | Required | Description |
| --- | --- | --- |
| `MODAL_ENDPOINT` | remote | HTTPS URL of the deployed Modal bridge |
| `MODAL_BRIDGE_TOKEN` | remote | Shared bearer secret for the bridge |
| `MODAL_MODE` | no | Set to `mock` only for an explicit local/demo mock; remote is otherwise the default |

## Runtime behavior

The Worker makes fetch-only HTTPS calls, so it is workerd-compatible. The bridge
builds a Sandbox image with Git, Codex CLI, Xvfb, fluxbox, xterm, x11vnc, noVNC,
and websockify. It waits for the X socket before starting the desktop, exposes
encrypted port `6080`, and returns
`/vnc.html?autoconnect=1&resize=scale`.

The bridge clones the canonical `https://github.com/:owner/:repo.git` URL with
the ephemeral GitHub token held only in Git's in-process HTTP-header config. It
then opens Codex in an xterm desktop window with
`codex exec --sandbox danger-full-access`, teeing output to a log. Status reads
at most 8 KiB of new UTF-8 log bytes and completion state. Stop reattaches by
Sandbox ID and calls `terminate(wait=True)`.

## API

| Method | Route | Purpose |
| --- | --- | --- |
| GET | `/api/auth/identity` | GitHub or demo identity (not used by the sparse MVP home) |
| GET | `/api/repositories` | GitHub repositories using the browser's saved PAT |
| POST | `/api/sessions` | Create: `{ repo, prompt }` |
| GET | `/api/sessions/:id` | Poll state and bounded new Codex output |
| POST | `/api/sessions/:id/start` | Start: `{ credentials: { openaiApiKey, githubToken? } }` (GitHub token can also be sent once in `x-github-token`) |
| POST | `/api/sessions/:id/stop` | Terminate the Modal sandbox |

## Credential safety

The home page contains only the prompt and repository chooser. `/settings` stores
the GitHub PAT and OpenAI BYOS key in this browser's `localStorage` so they can
be reused between browser sessions. Saved values are never rendered; Settings
shows a masked saved/not-saved status and supports replacement or deletion.
Anyone with access to the same browser profile can use the saved values.

The client sends the GitHub PAT only to repository listing and the one session
start request (for the initial private-repository clone). It never sends the PAT
with session creation, polling, stop, or unrelated requests. The OpenAI key is
sent only in the session start body. Neither credential is stored in Durable
Object state, returned in API responses, included in shell arguments, or written
to Worker logs. The bridge stores neither request nor credential state.
Recognizable OpenAI/GitHub credentials and authorization headers are redacted
from persisted agent output while normal logs are retained. Provider errors are
reduced to fixed safe messages.
