# OperaIQ

OperaIQ is an autonomous incident-response app that stores operational memory in Qdrant, detects hard failure patterns, acts on low-risk fixes, verifies the result, and writes the postmortem back into memory.

Qdrant is the vector brain. It stores logs, incidents, runbooks, service context, audit events, pattern matches, and postmortems so later incidents can retrieve prior proof instead of starting cold.

Important honesty note: Qdrant is not a native webhook runner. The Qdrant-backed watcher lives in the OperaIQ API process, reads unchecked log patterns from Qdrant, and fires the webhook back into OperaIQ.

## Live URLs

- Web: https://operaiq.onrender.com
- API: https://operaiq-api.3.208.71.125.sslip.io
- Qdrant: private on the AWS host, API-key protected, used by the API over the Docker network

## Local Quick Run

```bash
cp .env.example .env
pnpm install
docker compose -f docker-compose.qdrant.yml up -d
pnpm qdrant:setup-check
pnpm qdrant:seed
pnpm qdrant:verify
pnpm operaiq:test-tools
pnpm operaiq:quick-test
pnpm build
```

Local URLs:

- Web: http://localhost:3000/test-app
- API: http://localhost:3001
- Qdrant: http://localhost:6333

## Required Env

Use the repo's existing names:

```text
QDRANT_URL=<aws-private-qdrant-url>
QDRANT_API_KEY=<secret>
QDRANT_COLLECTION=operaiq_memory
OPERAIQ_ORG_ID=demo-org
OPERAIQ_AUTO_ACT_LOW_RISK=true
OPERAIQ_CONFIDENCE_THRESHOLD=0.82
NEXT_PUBLIC_API_URL=<deployed-api-url>
API_PUBLIC_URL=<deployed-api-url>
PUBLIC_APP_URL=<render-web-url>
WEB_PUBLIC_URL=<render-web-url>
AGENT_TOOL_EXECUTION_BASE_URL=<deployed-api-url>
SENTINEL_REMEDIATION_BACKEND=admin-endpoint
SENTINEL_GENERATION_PROVIDER=nvidia
EMBEDDING_PROVIDER=nvidia
NVIDIA_API_KEY=<secret>
JWT_SECRET=<secret>
WEBHOOK_SECRET=<secret>
AGENT_TOOL_SECRET=<secret>
```

## Judge Flow

1. Open the web app.
2. Create a fresh org and project.
3. Send hard failure logs from `/test-app`.
4. Watch the chain complete: app logs stored in Qdrant, API watcher detects the pattern, webhook fires, OperaIQ creates an incident, acts, verifies, and stores the postmortem in Qdrant.

## Deployed Verification

Use the browser flow at:

```text
https://operaiq.onrender.com/test-app
```

The final stage JSON must show:

```json
{
  "appLogsStored": true,
  "qdrantPatternMatched": true,
  "webhookFired": true,
  "operaiqActed": true,
  "operaiqVerified": true,
  "qdrantPostmortemStored": true
}
```

Proof artifacts are written under `artifacts/runtime/` and are not committed.
