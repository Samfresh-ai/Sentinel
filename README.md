# Sentinel

**Autonomous incident response agent powered by Splunk.**

> *The SRE that never forgets.*

When your services break, Sentinel wakes up. No pager. No trigger command. No human in the loop.

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
| First occurrence | No history | 21.6s | 13% |
| Second occurrence | Learned | 7.1s | **95%** |

The second incident resolved 3× faster. The brain compounds — the more Sentinel handles, the faster and more accurate it becomes.

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
| Hosted models | Splunk AI Toolkit 5.7.4 — capability-probed at startup; Gemini fallback on Enterprise |
| Backend | Node.js 20, TypeScript (strict), Express.js |
| Frontend | Next.js 14 App Router, Tailwind CSS, Server-Sent Events (live reasoning stream) |
| Auth | JWT, per-org webhook secrets |
| Deployment | Docker Compose (local), Render / Google Cloud Run (production) |

---

## Quick test

Requirements: Docker, Node.js 20+, pnpm, a local Splunk Enterprise instance.
See `SPLUNK_SETUP.md` for Splunk setup (15 minutes).

```bash
git clone https://github.com/Samfresh-ai/Sentinel.git
cd Sentinel
cp .env.example .env       # fill in SPLUNK_* values
docker compose up -d
pnpm install
pnpm splunk:setup-check    # confirms Splunk is reachable
pnpm splunk:seed           # seeds KV Store with incident history
pnpm sentinel:demo         # fires a live incident end to end
```

Open `http://localhost:3000`. A P1 incident will appear, stream through all eight reasoning phases, and resolve. The post-mortem lands in Splunk at `index=sentinel sourcetype=sentinel:postmortem`.

**Learning loop proof:**
```bash
pnpm sentinel:demo:learning-loop
# Incident 1 (novel):      resolved in 21.6s, best match: 13%
# Incident 2 (recognised): resolved in 7.1s,  best match: 95%
```

**Escalation path proof:**
```bash
pnpm sentinel:demo:escalate
# Fires an unknown incident type, watches Sentinel exhaust attempts and escalate
```

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

All of the following passed on 2026-05-27:

```bash
pnpm typecheck                   # zero type errors
pnpm build                       # clean build
pnpm splunk:setup-check          # Splunk REST, KV Store, HEC all reachable
pnpm sentinel:e2e                # full incident lifecycle end to end
pnpm sentinel:test-feedback-loop # remediation verify-and-retry path
pnpm sentinel:demo:escalate      # unknown incident escalates correctly
pnpm sentinel:demo:learning-loop # novel 21.6s → recognised 7.1s
pnpm sentinel:test-dlq           # crashed agent recovered via dead letter queue
```

Proof outputs, audit counts, and the shipped vs imagined table: `SENTINEL_VERIFICATION.md`

---

## Honest state

| Component | State |
|---|---|
| Local Splunk Enterprise — full autonomous flow | ✅ Verified |
| Splunk KV Store brain (incidents, runbooks, post-mortems) | ✅ Verified |
| Live SPL log investigation during incidents | ✅ Verified |
| Splunk Alert Action autonomous trigger | ✅ Verified |
| Native Splunk dashboard (6 panels) | ✅ Verified |
| Multi-tenant org isolation (403 cross-org access) | ✅ Verified |
| Audit log (498 entries across test runs) | ✅ Verified |
| Dead letter queue + agent crash recovery | ✅ Verified |
| Splunk AI Toolkit 5.7.4 + PSC 4.3.2 installed | ✅ Installed |
| Splunk Hosted Models | ⚡ Capability-gated — probes at startup, Gemini fallback on Enterprise; activates automatically on Splunk Cloud Platform |
| Splunk Cloud deployment | 🔄 Implemented and tested — pending active Cloud credentials |
| SPL keyword similarity vs vector embeddings | ⚠️ Known gap — lower precision than vector search, documented in `SENTINEL_VERIFICATION.md` |
| Cloud Run remediation (live infrastructure actions) | 🔄 Implemented — requires GCP billing enabled |
