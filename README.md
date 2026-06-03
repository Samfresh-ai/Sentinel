# Sentinel

**Autonomous incident response agent powered by Splunk.**

> *The SRE that never forgets.*

When your services break, Sentinel wakes up from a Splunk alert, investigates with the current logs, and either takes the approved low-risk action or escalates with the evidence it collected.

It investigates the incident using live Splunk log data, cross-references its memory of every incident it has ever resolved, identifies the root cause, executes the remediation, verifies the fix worked, and writes a structured post-mortem back into Splunk. The next time the same pattern appears, it resolves faster because it already knows the answer.

---

## The flow

```
Your app  →  Splunk HEC (logs)
          →  Splunk saved search detects pattern
          →  Splunk fires webhook to Sentinel
          →  ASSESS → REMEMBER → INVESTIGATE → MAP → RETRIEVE → ACT → VERIFY → CLOSE
          →  Post-mortem indexed back into Splunk
          →  Brain updated. Next incident resolved faster.
```

---

## Why it gets smarter

Every resolved incident is written back to Splunk as a structured knowledge artifact. Before acting on a new incident, Sentinel searches this memory for similar past cases and their proven resolutions.

| Run | Brain state | Resolution time | Match confidence |
|---|---|---|---|
| First occurrence | No history | 95s | 13% |
| Second occurrence | Learned | 76s | **95%** |

The second incident reused the memory created by the first run. Confidence moved from 13% to 95%, and the brain grew from zero resolved incidents to one reusable resolution.

---

## Live deployment

Current Render deployment:

- App: `https://sentinel-api-n8ly.onrender.com/`
- API: `https://sentinel-api-n8ly.onrender.com`
- Health: `https://sentinel-api-n8ly.onrender.com/health`
- Runtime readiness: `https://sentinel-api-n8ly.onrender.com/runtime/readiness`
- Agent OpenAPI: `https://sentinel-api-n8ly.onrender.com/agent/openapi.json`
- Submission video: `https://youtu.be/GXZ_88BCrsI`

The current Render service serves the web app and API from the same host. The deployment config keeps `PUBLIC_APP_URL`, `API_PUBLIC_URL`, and `NEXT_PUBLIC_API_URL` separate so the web and API can split cleanly later.

Current verified Splunk target:

- Splunk Enterprise is running on AWS behind a protected gateway.
- Render sends Sentinel logs to that AWS Splunk HEC target.
- Splunk watches those logs with a saved search and fires Sentinel's production webhook.
- Sentinel then acts, verifies with live SPL, closes the incident, and writes the post-mortem back to Splunk.

The verified submitted API path is Render; AWS is the verified Splunk gateway path.
---

## What happens during an incident

Each incident streams through eight phases in real time:

| Phase | What Sentinel does |
|---|---|
| **ASSESS** | Parses the Splunk alert payload — service, symptoms, severity |
| **REMEMBER** | Searches KV Store for similar past incidents and what resolved them |
| **INVESTIGATE** | Runs live SPL queries against your actual log data right now |
| **MAP** | Traverses the service dependency graph, identifies blast radius, upgrades severity if warranted |
| **RETRIEVE** | Selects the best runbook from memory, or generates and saves a new one |
| **ACT** | Executes low-risk remediations automatically; pauses and pages oncall for medium/high risk |
| **VERIFY** | Re-runs the diagnostic SPL query to confirm the fix actually worked before closing |
| **CLOSE** | Writes a structured post-mortem to KV Store and indexes it into Splunk |

If three consecutive remediation attempts fail or the incident matches no known pattern with sufficient confidence, Sentinel escalates to the oncall team via Slack with its full investigation context and stops acting.

---

## Architecture

```
Application logs
      │
      ▼
Splunk HEC  ─────────────────────────────────────────────────────────┐
      │                                                               │
      ▼                                                               │
Splunk Saved Search / Alert Action                                    │
      │                                                               │
      ▼                                                               │
POST /webhooks/splunk-alert?orgId=…&secret=…                         │
      │                                                               │
      ▼                                                               │
Sentinel API                                                          │
      ├── Splunk KV Store  ← incidents, runbooks, services,           │
      │                      audit log, post-mortems (per org)        │
      ├── Live SPL queries ← agent investigates your real logs        │
      ├── Remediation      ← admin endpoints or Cloud Run jobs        │
      └── Slack / oncall   ← escalation when confidence is too low   │
      │                                                               │
      ▼                                                               │
Sentinel web app + Native Splunk dashboard (sentinel_overview)        │
      │                                                               │
      └──── Post-mortems indexed back to Splunk ─────────────────────┘
```

The UI is not a fake demo surface. Every incident, reasoning step, audit entry, and post-mortem it shows was created by the Splunk-driven flow.

---

## Tech stack

| Layer | Technology |
|---|---|
| Observability platform | Splunk Enterprise / Splunk Cloud |
| Agent memory | Splunk KV Store + Splunk HEC (indexed post-mortems) |
| Live log investigation | SPL via custom Splunk MCP REST adapter |
| Hosted models | Capability-probed at startup; fallback generation is used on local Enterprise when hosted inference is unavailable |
| Backend | Node.js 20, TypeScript (strict), Express.js |
| Frontend | Next.js 14 App Router, Tailwind CSS, Server-Sent Events (live reasoning stream) |
| Auth | JWT, per-org webhook secrets |
| Deployment | Docker Compose (local), Render / Google Cloud Run (production) |

---

## Quick test

Requirements: Docker, Node.js 20+, pnpm, a local Splunk Enterprise instance.
See `SPLUNK_SETUP.md` for the Splunk Enterprise setup.

```bash
git clone https://github.com/Samfresh-ai/Sentinel.git
cd Sentinel
cp .env.example .env       # fill in SPLUNK_* values
docker compose up -d
pnpm install
pnpm splunk:setup-check    # confirms Splunk is reachable
pnpm splunk:seed           # seeds KV Store with incident history
pnpm splunk:verify         # confirms KV Store and HEC proof data
pnpm sentinel:quick-test   # app logs -> saved search -> webhook -> ACT/VERIFY/CLOSE
```

Open the Sentinel web URL after the script starts. A real Splunk saved search fires the webhook, Sentinel creates an incident, runs through the agent phases, verifies with SPL, closes the incident, and writes the post-mortem to Splunk.

**Learning loop proof:**

The earlier full verification run fired the same Redis/payment incident twice. The first run was novel: it resolved in 95s with a 13% best memory match. The second run was recognised from Sentinel's stored post-mortem: it resolved in 76s with a 95% best match. That proves the brain is not just storing history; later incidents retrieve and use it.
```bash
pnpm sentinel:quick-test
# Incident 1 (novel):      resolved in 21.6s, best match: 13%
# Incident 2 (recognised): resolved in 7.1s,  best match: 95%
```

**Escalation path proof:**

The escalation proof fired an unknown incident type and verified that Sentinel stopped autonomous remediation, marked the incident as escalated, and prepared on-call context instead of pretending it had fixed something. Recorded proof: incident `919ede8b78670d534bb83c2e` escalated correctly.


---

## Connecting a real Splunk instance

If you have Splunk Enterprise or Splunk Cloud already running:

**Step 1 — Sign up and get your webhook URL**

Visit your deployed Sentinel URL, create an org, and copy the generated webhook URL:
```
https://your-sentinel.com/webhooks/splunk-alert?orgId=…&secret=…
```

**Step 2 — Add it to any Splunk saved search**

In Splunk: open any saved search → Edit → Add Alert Action → Webhook → paste the URL.

**Step 3 — Ship your app logs to Splunk HEC**

Point your application's log output at your Splunk HEC endpoint (`index=prod`).
Sentinel watches `index=prod` for error patterns by default.

That is the entire integration. Sentinel acts on every alert that fires from that point forward.

---

## Splunk Enterprise (local, with tunnel)

```env
SPLUNK_HOST=splunk.yourdomain.com
SPLUNK_MGMT_URL=https://splunk.yourdomain.com
SPLUNK_HEC_URL=https://splunk.yourdomain.com
SPLUNK_GATEWAY_TOKEN=<tunnel-auth-token>
SPLUNK_USERNAME=admin
SPLUNK_PASSWORD=<secret>
SPLUNK_HEC_TOKEN=<hec-token>
```

## Splunk Cloud

```env
SPLUNK_CLOUD_STACK_HOST=<stack>.splunkcloud.com
SPLUNK_USERNAME=<secret>
SPLUNK_PASSWORD=<secret>
SPLUNK_HEC_TOKEN=<secret>
# Leave SPLUNK_MGMT_URL and SPLUNK_HEC_URL empty — derived from SPLUNK_CLOUD_STACK_HOST
```

Full variable reference: `.env.example`
Full Splunk setup guide: `SPLUNK_SETUP.md`

---

## Native Splunk dashboard

Sentinel ships a Simple XML dashboard that installs directly into the Splunk app and runs inside Splunk's own UI — not in the external web app.

Panels: active incidents, resolution timeline, brain growth, severity distribution, recent agent decisions, service health.

```bash
# Install into running Splunk container
docker cp apps/splunk-app/sentinel/default sentinel-splunk:/opt/splunk/etc/apps/sentinel/
docker exec -u root sentinel-splunk \
  chown -R splunk:splunk /opt/splunk/etc/apps/sentinel/default
docker exec -u splunk sentinel-splunk \
  /opt/splunk/bin/splunk restart --accept-license --answer-yes --no-prompt
```

Open: `http://localhost:8000/app/sentinel/sentinel_overview`

---

## Multi-tenancy

Each organisation gets an isolated brain. Every incident, runbook, post-mortem, and audit entry is stamped with `orgId` at write time and filtered by JWT on every read. A request from org A for org B's incident returns `403`. Two teams using the same Sentinel deployment never see each other's data.

---

## Production deployment

Sentinel blocks startup if unsafe settings are present in production — offline generation, local-only verification, localhost URLs, or missing Splunk credentials cause a hard exit with a clear error message. Check `/runtime/readiness` to confirm production status before going live.

Current public links:

- `PUBLIC_APP_URL`: `https://sentinel-api-n8ly.onrender.com/`
- `API_PUBLIC_URL`: `https://sentinel-api-n8ly.onrender.com`
- `NEXT_PUBLIC_API_URL`: `https://sentinel-api-n8ly.onrender.com`
- `AGENT_TOOL_EXECUTION_BASE_URL`: `https://sentinel-api-n8ly.onrender.com`

Required production environment variables:
```env
NODE_ENV=production
SENTINEL_RUNTIME_ENV=production
SENTINEL_MODE=true
AGENT_NAME=Sentinel
JWT_SECRET=<secret>
WEBHOOK_SECRET=<secret>
PUBLIC_APP_URL=https://<sentinel-web-url>
API_PUBLIC_URL=https://<sentinel-api-url>
NEXT_PUBLIC_API_URL=https://<sentinel-api-url>
AGENT_TOOL_EXECUTION_BASE_URL=https://<sentinel-api-url>
```

Render deployment guide: `deploy/render/README.md`
Google Cloud Run deployment: `cloudbuild.sentinel.yaml`

---

## Verification

Latest full proof passed on 2026-05-31 against the public Render deployment and AWS-hosted Splunk Enterprise target:

```bash
pnpm typecheck                   # zero type errors
pnpm build                       # clean build
pnpm splunk:setup-check          # Splunk REST, KV Store, HEC all reachable
pnpm splunk:seed && pnpm splunk:verify
pnpm preflight
pnpm sentinel:quick-test         # full Splunk alert lifecycle end to end
```
---

## Honest state

| Component | State |
|---|---|
| Public Render deployment | ✅ Verified live on current commit |
| AWS-hosted Splunk Enterprise proof target | ✅ Verified |
| Render -> AWS Splunk -> webhook -> Sentinel autonomous flow | ✅ Verified |
| Local Splunk Enterprise — full autonomous flow | ✅ Verified |
| Splunk KV Store brain (incidents, runbooks, post-mortems) | ✅ Verified |
| Live SPL log investigation during incidents | ✅ Verified |
| Splunk Alert Action autonomous trigger | ✅ Verified |
| Native Splunk dashboard (6 panels) | ✅ Verified |
| Multi-tenant org isolation (403 cross-org access) | ✅ Verified |
| Audit log | ✅ Verified |
| Learning loop (memory improves match confidence on repeat incident) | ✅ Verified |
| Escalation path for unknown/unsafe incidents | ✅ Verified |
| Splunk Hosted Models | ⚡ Capability-gated; fallback generation is used on local Enterprise |
| Splunk Cloud deployment | 🔄 Supported in code and docs; pending active Cloud credentials and reachable HEC |
| Cloud Run remediation (live infrastructure actions) | 🔄 Implemented; requires GCP billing and target services |
