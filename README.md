# PM Assistant POC — routing to Rovo agents via Automation

This is a runnable scaffold for the pattern from the design doc, narrowed to
just Rovo-built agents:

```
                    ┌─────────────────────────┐
React UI  →  Node server  →  Router automation (constant webhook) → Rovo router agent
                    └──────────────┬──────────┘
                    picks an agentId, calls back
                                   ↓
              Node server  →  that agent's automation webhook  →  Rovo agent
                                   ↑___________ result comes back here __________|
```

Because Rovo agents have no public API, the Node server never calls Rovo
directly for anything. Both the routing decision and the actual work happen
the same way: the server fires a Jira/Confluence **Automation rule's
incoming webhook**, and the automation rule runs a Rovo agent and sends the
result back to the server's callback endpoint. This whole exchange is async
— the UI polls for the result rather than getting it synchronously.

- **Routing** is a single, constant Automation rule whose Rovo agent picks the best-matching
  `agentId` from `registry.json` and calls back to `/api/route-callback` —
  so the request text never leaves the org.
- **Running the matched agent** is unchanged: the server looks up that
  agent's own `automationWebhookUrl` in `registry.json` and fires it, and
  that automation calls back to `/api/callback` with the final result.

## 1. Run the server

```bash
cd server
cp .env.example .env
# edit .env: add the real ROVO_ROUTER_WEBHOOK_URL for your routing automation
npm install
npm run dev
```

Server runs at `http://localhost:$PORT` (`.env`'s `PORT`, default `4000`).

## 2. Run the client

```bash
cd client
cp .env.example .env
# edit .env if you want the dev server or API proxy on non-default ports
npm install
npm run dev
```

Open `http://localhost:$CLIENT_PORT` (`.env`'s `CLIENT_PORT`, default `5173`).
Requests you type get proxied to the server at `SERVER_PORT` (default `4000`,
must match the server's own `PORT`).

## 3. Expose the server publicly (needed for the callbacks) — local testing only; not a deployment path

Atlassian Cloud can't reach `localhost`, so both automation rules' outgoing
webhook actions need a public URL for your server. While testing, a tunnel
works. This is for local testing only and is not a deployment path:

```bash
ngrok http 4000
```

Copy the `https://...ngrok-free.app` URL into `server/.env` as
`PUBLIC_CALLBACK_BASE_URL`, then restart the server.

## 4. Build the router Automation rule (one, constant)

In Jira or Confluence → **Project settings → Automation** (or global
automation), create one rule:

1. **Trigger:** *Incoming webhook*. Save the rule once to get the generated
   webhook URL — paste that into `server/.env` as `ROVO_ROUTER_WEBHOOK_URL`.
2. **Action:** *Ask Rovo Agent*, with its prompt input set to the incoming
   webhook's payload field, e.g. `{{webhookData.body.prompt}}`. The prompt
   already lists every `registry.json` entry (id/name/description/trigger
   examples) and asks for a single best-matching `id`, or `"none"`.
3. **Action:** *Send web request* (outgoing webhook).
   - URL: `{{webhook.body.callbackUrl}}` (the server sends its own callback URL with every request, so nobody edits the rule when the tunnel URL changes)
   - Method: POST
   - Body (JSON):
```json
     {
       "requestId": "{{webhookData.body.requestId}}",
       "result": "{{ <smart value for the Rovo agent's response> }}"
     }
```
     `result` should be just the bare agent id (or `"none"`).

## 5. Build an Automation rule per agent

Same as before — one rule per entry in `registry.json`:

1. **Trigger:** *Incoming webhook*. Paste the generated URL into
   `server/src/registry.json` as `automationWebhookUrl` for that agent.
2. **Action:** *Ask Rovo Agent* for that specific agent, prompt set to
   `{{webhookData.body.prompt}}`.
3. **Action:** *Send web request* to `<PUBLIC_CALLBACK_BASE_URL>/api/callback`
   with `{ "requestId": "{{webhookData.body.requestId}}", "result": "..." }`.

## 6. Fill in `server/src/registry.json`

Replace every `PLACEHOLDER_*` and `REPLACE_WITH_*` value:
- `name` / `description` / `triggerExamples` — real info about each agent,
  written so the router agent can tell when to pick it.
- `automationWebhookUrl` — the incoming webhook URL from step 5.

## 7. Try it

Type a request in the UI. You should see it move through
`received → routed → running → done`, with the agent name shown once routed,
and the automation's result once the callback arrives.

## Known limitations of this POC

- Single Node process, in-memory store — restart loses in-flight requests
  and pending routing decisions.
- Routing is now two Rovo automation round-trips deep (route decision, then
  the agent run) — no caching or retry logic.
- No auth on `/api/callback` or `/api/route-callback` — fine for a local
  demo, not for anything beyond that. Add a shared secret before this goes
  anywhere near real data.
- Only proves the Rovo-agent slice of the original design doc's V1 scope —
  Python/other automation types would need their own adapters following the
  same shape (registry entry + a `trigger*` function).

## Run with Docker (easiest way to share)

One image contains both the API and the built UI, so there is a single port
and no Node/npm setup needed — only Docker.

**Run from source**

```bash
cp server/.env.example server/.env   # fill in webhook URLs (see steps 3-4)
docker compose up --build            # UI + API at http://localhost:4000
```

- Change the host port with `PORT=8080 docker compose up` (the container
  always listens on 4000 internally).
- `server/.env` is read at start-up and is **not** baked into the image, so
  secrets are never shared with it.
- Logs persist in the `pm-logs` volume; view them at
  `http://localhost:4000/api/logs/view`.
- `server/src/registry.json` is baked into the image: edit it and rebuild
  (`docker compose up --build`) to change agents.
- Stop with `Ctrl+C` or `docker compose down`.

**Share the image with someone else**

```bash
docker compose build
docker save pm-assistant-poc:latest | gzip > pm-assistant.tgz   # send this file
```

The recipient needs the file plus their own `.env`:

```bash
docker load < pm-assistant.tgz
docker run --rm -p 4000:4000 --env-file .env pm-assistant-poc:latest
```

(Or push the image to a registry and share `docker pull <name>`.)

**Still required in a container (local testing only):** Atlassian Cloud can't reach `localhost`, so
`PUBLIC_CALLBACK_BASE_URL` must be a public tunnel URL (step 3) pointing at
the published port, e.g. `ngrok http 4000`.

**Troubleshooting**

| Symptom | Fix |
|---|---|
| `cannot connect to the Docker daemon` | Start Docker Desktop |
| Port already in use | `PORT=<free port> docker compose up` |
| Requests stay `pending` | Callback URL not public/reachable — check `PUBLIC_CALLBACK_BASE_URL` |
| Registry edits not showing | Rebuild the image |

## Exposing the callback (VS Code port forwarding / dev tunnel)

Forward port 4000 in VS Code (Ports tab, visibility Public) and set
`PUBLIC_CALLBACK_BASE_URL` to the forwarded URL. The server then enforces:

- Requests arriving through the tunnel may only reach `/api/callback`,
  `/api/route-callback` and `/api/health`, and only from Atlassian egress IPs
  (fetched from https://ip-ranges.atlassian.com/ at startup).
- If `CALLBACK_SHARED_SECRET` is set, callbacks must also send it as the
  `X-Callback-Secret` header. Add that header to the Automation webhook action
  with the value `{{webhook.body.callbackSecret}}` (only sent when the secret is set).
  Atlassian's ranges cover all Atlassian Cloud tenants, so use the secret.
- Everything else (UI, `/api/ask`, logs) works only on `http://localhost:4000`.

## Owner / Support

- Business owner: [business owner]
- Technical contact: [technical contact]
- Support plan: [support plan]

## Data flow

1. The browser sends the user's request text (and up to 6 prior turns of the
   conversation) to this server's `POST /api/ask`.
2. The server sends the request text to the router automation's incoming
   webhook (`ROVO_ROUTER_WEBHOOK_URL`), unless the user picked an agent
   directly. The Rovo router agent returns an agent id to `/api/route-callback`.
3. The server sends the request text plus conversation context to the chosen
   agent's automation webhook (`automationWebhookUrl` in `registry.json`).
   The automation calls back to `/api/callback` with the result.
4. The UI polls `GET /api/status/:requestId` for the result.

Nothing is sent to any third-party LLM service; request text goes only to the
Atlassian automation webhooks configured above.

**Stored:** request text, agent id/name and agent results are kept in server
memory only (no database). They are removed on restart, and pending requests
that never receive a callback are marked expired after `PENDING_TTL_MINUTES`
(default 30). Finished entries are dropped after the same period.

**Logged** (`server/logs/app.log`, viewable at `/api/logs/view`): requestId,
timestamps, status transitions, agent id/name, message/result lengths and
error types. Request text and agent results are not logged.

## Security notes

Known gaps (this is a POC):

- No authentication on `/api/callback` and `/api/route-callback`.
- No SSO or user authentication on the UI or API.
- The log viewer (`/api/logs`, `/api/logs/view`) is unauthenticated.
- Webhook URLs (and per-agent secrets) are stored in `server/src/registry.json`,
  which is committed to the repository and baked into the Docker image.
- State is in memory in a single process.

Implemented: `helmet` headers, JSON/text body size limit (`BODY_LIMIT`), CORS
restricted to `CORS_ORIGIN` (same-origin by default), no stack traces returned
to clients, `X-Powered-By` disabled, container runs as non-root.

Configuration added: `PENDING_TTL_MINUTES`, `CORS_ORIGIN`, `BODY_LIMIT`
(see `server/.env.example`). Health check: `GET /api/health`.
