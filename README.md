# Ino cloud coding agent MVP

A deliberately small Bun + TypeScript full-stack cloud coding agent. A static,
dependency-free web UI is served by one Cloudflare Worker, and one Durable Object
represents one coding session. The result supports the smallest launch-and-observe MVP flow without
queues, a database, websockets, or a separate frontend service:

1. connect GitHub and choose a repository;
2. provide an ephemeral BYOS OpenAI key;
3. launch Codex in a Modal sandbox;
4. poll durable lifecycle events and open the CUA/VNC computer.

The remote Modal bridge is an intentionally small deployment boundary, not a
second product service. This repository defines its launch contract. Follow-up
messages are recorded as durable operator notes in this MVP; they are not sent
to the running Codex process. Stop marks the session stopped in coordination
state but does not terminate a remote sandbox until the bridge adds a terminate
operation. These controls are labeled accordingly in the UI.

## Run

```sh
bun install
bun run dev
bun test
bun run typecheck
```

Deploy with `bun run deploy`. `wrangler.toml` provisions the `SESSIONS` Durable
Object binding.

Open `http://localhost:8787` after `bun run dev`. The default configuration is a
safe demo: GitHub falls back to a sample repository and Modal returns a mock
session. Set the variables below to connect real services.

## API

All responses are JSON. Authentication and repository routes use the optional
per-browser GitHub token sent in `x-github-token`. Without a token they return
demo identity/repository data; invalid supplied tokens fail clearly instead of
falling back to demo data.

| Method | Route | Purpose |
| --- | --- | --- |
| GET | `/api/auth/identity` | GitHub or demo identity |
| GET | `/api/repositories` | GitHub or demo repositories |
| POST | `/api/sessions` | Create: `{ repo, prompt }` |
| GET | `/api/sessions/:id` | Poll state/events |
| POST | `/api/sessions/:id/start` | Start: `{ credentials: { openaiApiKey } }` |
| POST | `/api/sessions/:id/message` | Append a message: `{ message }` |
| POST | `/api/sessions/:id/stop` | Mark a session stopped |

A repository is `{ id, fullName, defaultBranch, private, url }`. Sessions
include status, repo, initial prompt, timestamped logs/events, Modal job ID,
and optional VNC URL.

## Configuration

| Variable | Required | Description |
| --- | --- | --- |
| `MODAL_MODE` | no | `mock` (default) or `remote` |
| `MODAL_ENDPOINT` | remote only | URL for the Modal launch bridge (`POST /launch`) |
| `MODAL_TOKEN` | remote only | Bearer token for that bridge |
| `MODAL_IMAGE` | no | Codex image, defaults to `ghcr.io/openai/codex:latest` |

Set secrets with `wrangler secret put <NAME>`, not in `wrangler.toml`.

## BYOS safety

`credentials.openaiApiKey` is accepted only on `start`, validated, and passed
directly into the Modal launch request as `OPENAI_API_KEY`. It is never included
in Durable Object session state, events, responses, or logs. Do not add it to
client analytics, error reports, or persisted data.

`MODAL_MODE=mock` is local/demo-safe and returns a non-routable mock VNC URL.
Remote mode constructs a bridge request that runs `codex exec <prompt>`; the
bridge is responsible for securely cloning the repository, starting the
container, and exposing VNC.
