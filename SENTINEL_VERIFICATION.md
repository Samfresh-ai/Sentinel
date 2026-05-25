# Sentinel Verification

Sentinel is implemented as a Splunk-native port that runs alongside OperaIQ. This file tracks only the four changed components.

## Current Local State

Local Splunk Enterprise was validated in Docker as `sentinel-splunk` on:

- management API: `https://localhost:8089`
- HEC: `http://localhost:8088`
- app: `sentinel`
- index: `sentinel`

The local `.env` contains Splunk credentials and the HEC token. Values are intentionally not documented here.

Hosted Models re-probe on 2026-05-25 found the current Docker daemon inactive, so Splunk was not reachable at the management port during the second check:

```text
docker version --format 'client={{.Client.Version}} server={{.Server.Version}}'
client=27.3.1 server=
Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?

curl https://localhost:8089/services/server/info?output_mode=json
curl: (7) Failed to connect to localhost port 8089: Connection refused
```

Validated on 2026-05-25:

```text
pnpm splunk:setup-check
pnpm splunk:hosted-models-check
pnpm splunk:seed
pnpm splunk:verify
OPERAIQ_AI_PROVIDER=offline OPERAIQ_LOCAL_VERIFY=true OPERAIQ_REMEDIATION_WAIT_MS=0 pnpm sentinel:test-tools
OPERAIQ_AI_PROVIDER=offline OPERAIQ_LOCAL_VERIFY=true OPERAIQ_REMEDIATION_WAIT_MS=0 pnpm sentinel:smoke-test
OPERAIQ_AI_PROVIDER=offline OPERAIQ_LOCAL_VERIFY=true OPERAIQ_REMEDIATION_WAIT_MS=0 SENTINEL_MODE=true AGENT_NAME=Sentinel NEXT_PUBLIC_API_URL=http://localhost:3001 pnpm sentinel:e2e
OPERAIQ_AI_PROVIDER=offline OPERAIQ_LOCAL_VERIFY=true OPERAIQ_LOCAL_PUBSUB_DIRECT=true OPERAIQ_REMEDIATION_WAIT_MS=0 NEXT_PUBLIC_API_URL=http://localhost:3001 pnpm verify:e2e
```

## Re-run Protocol

After starting Splunk and the API, run:

```bash
pnpm splunk:setup-check
pnpm splunk:seed
pnpm splunk:verify
OPERAIQ_AI_PROVIDER=offline OPERAIQ_LOCAL_VERIFY=true OPERAIQ_REMEDIATION_WAIT_MS=0 pnpm sentinel:test-tools
OPERAIQ_AI_PROVIDER=offline OPERAIQ_LOCAL_VERIFY=true OPERAIQ_REMEDIATION_WAIT_MS=0 pnpm sentinel:smoke-test
OPERAIQ_AI_PROVIDER=offline OPERAIQ_LOCAL_VERIFY=true OPERAIQ_REMEDIATION_WAIT_MS=0 SENTINEL_MODE=true AGENT_NAME=Sentinel NEXT_PUBLIC_API_URL=http://localhost:3001 pnpm sentinel:e2e
```

`sentinel:e2e` expects the API server to be reachable at `NEXT_PUBLIC_API_URL` or `http://localhost:3001`.

`splunk:hosted-models-check` is intentionally separate from `splunk:setup-check`. It checks the AI Toolkit app, the Python for Scientific Computing add-on, the `ai` SPL command, and then attempts a real Hosted Models search. Current output with Docker inactive:

```text
FAILED splunk:hosted-models-check - connect ECONNREFUSED 127.0.0.1:8089
```

If Splunk is running but AI Toolkit is missing, this command should fail later with the exact missing prerequisite instead of treating Hosted Models as generally unavailable.

## Splunk Hosted Models Re-Probe

Official Splunk docs now point to the AI Toolkit `ai` SPL command for LLM calls. The old `genai` / `llmgenerate` names from the migration prompt are not the documented path for current Splunk AI Toolkit.

Verified facts from official sources:

- AI Toolkit is a Splunkbase app, not part of a plain Splunk Enterprise install by default.
- AI Toolkit 5.7.4 requires Splunk Enterprise 9.3.x, 9.4.x, 10.x, 10.1.x, or 10.2.x, plus PSC 4.3.2.
- The `ai` SPL command was introduced in AI Toolkit 5.6.0 and requires `apply_ai_commander_command` to execute.
- Splunk Hosted Models appear as a provider option in AI Toolkit 5.7.0+ and require `list_tokens_scs` capability to see.
- Available Hosted Models listed by Splunk docs are OpenAI GPT-OSS 120B, OpenAI GPT-OSS 20B, and Llama-3.1-FoundationAI-SecurityLLM-base-1.1-8B.

Source references:

- AI Toolkit install requirements: `https://help.splunk.com/en/splunk-cloud-platform/apply-machine-learning/use-ai-toolkit/5.7.4/install-and-upgrade-the-ai-toolkit/install-the-ai-toolkit`
- `ai` command reference: `https://help.splunk.com/en/splunk-cloud-platform/apply-machine-learning/use-ai-toolkit/5.7.4/ai-toolkit-commands-macros-and-visualizations/about-the-ai-command`
- Hosted Models provider/capability note: `https://help.splunk.com/en/splunk-enterprise/apply-machine-learning/use-ai-toolkit/5.7.0/ai-toolkit-commands-macros-and-visualizations/connections-tab-in-the-ai-toolkit`
- Splunkbase AI Toolkit listing: `https://splunkbase.splunk.com/app/2890/`

Local attempt results on 2026-05-25:

```text
AI Toolkit download:
https://splunkbase.splunk.com/app/2890/release/5.7.4/download
http_code=401 content_type=text/html; charset=utf-8

PSC Linux 64-bit download:
https://splunkbase.splunk.com/app/2882/release/4.3.2/download
http_code=401 content_type=text/html; charset=utf-8
```

OpenClaw browser reached the Splunk AI Toolkit page and confirmed it shows `Log in to Download`, latest version `5.7.4`, release date `May 20, 2026`, and platform compatibility for Splunk Enterprise `9.3`, `9.4`, and `10.x`.

Current blocker, stated precisely: Hosted Models are not blocked by confirmed Developer License limits yet. They are blocked because the local Splunk runtime is currently down and the required Splunkbase packages, AI Toolkit 5.7.4 and PSC 4.3.2, require an authenticated Splunkbase download before they can be installed and tested. After those are installed, the next real blocker to verify is whether the local account/license exposes `list_tokens_scs` and a Splunk Hosted Models provider in the AI Toolkit Connections tab.

## Shipped vs Imagined

| Component | Shipped | Imagined / blocked |
| --- | --- | --- |
| Splunk KV Store brain | `@operaiq/splunk-brain` implements typed REST client, KV collection create/query/insert/update/delete, and Sentinel incident writes. `pnpm splunk:setup-check`, `pnpm splunk:seed`, and `pnpm splunk:verify` pass against local Splunk. | Production Splunk Cloud/Enterprise deployment still needs a real hosted target and certificate policy. |
| SPL-based similarity search | `findSimilarIncidents()` searches `index=sentinel sourcetype=sentinel:postmortem` and computes keyword-overlap similarity; fallback ranks resolved KV incidents by keyword overlap. | This is lower quality than MongoDB Atlas Vector Search and should be stated in submissions. |
| Live log query tool | `query_splunk_logs` runs targeted SPL and streams an `INVESTIGATE` step between REMEMBER and MAP in `runSentinelAgent()`. `sentinel:test-tools` returned 5 indexed post-mortem rows and `sentinel:smoke-test` found 4 recent notification-service events. | Splunk Hosted Models are not proven yet. The real blocker is missing authenticated Splunkbase installation of AI Toolkit 5.7.4 + PSC 4.3.2, plus a follow-up capability check for `list_tokens_scs`. |
| Splunk Alert Action trigger | `POST /webhooks/splunk-alert` validates Splunk alert payloads, creates a Sentinel incident in KV Store, and invokes the Sentinel agent directly in the background. `sentinel:e2e` passed through the webhook and resolved incident `1480e3011b278a91ed1245bb`. | Browser-created saved-search alert click-through is not separately proven; the webhook payload path is proven by script. |

## Required Answers

1. Live SPL query:
   - Query: `search index=sentinel sourcetype=sentinel:postmortem | head 5`
   - Result count: `5`
   - Raw JSON sample:

```json
{
  "query": "search index=sentinel sourcetype=sentinel:postmortem | head 5",
  "resultCount": 5,
  "first": {
    "_time": "2026-05-25T07:55:58.809+00:00",
    "index": "sentinel",
    "sourcetype": "sentinel:postmortem",
    "event": {
      "type": "postmortem",
      "incidentId": "1480e3011b278a91ed1245bb",
      "title": "Splunk alert: sentinel_e2e_notification_s3_access_denied",
      "severity": "P3",
      "generatedBy": "sentinel"
    }
  }
}
```

2. Dual write:
   - Search after `sentinel:e2e`: `search index=sentinel sourcetype=sentinel:postmortem | stats count`
   - Result count: `8`
   - One returned indexed field: `incidentId=1480e3011b278a91ed1245bb`

3. OperaIQ + Sentinel side by side:
   - OperaIQ local e2e passed from the same repo: `PASSED verify:e2e - End-to-end flow: PASSED`
   - Sentinel local e2e passed from the same repo: `PASSED sentinel:e2e - incident=1480e3011b278a91ed1245bb, postmortemId=3d3009a4e09c984dd343c8cb, indexedPostmortems=8`
   - Shared dependency to watch: `execute_remediation` is shared and switches data source through `SENTINEL_MODE` / `AGENT_NAME=Sentinel`; Cloud Run dispatch remains shared.

4. One thing Sentinel does better:
   - Sentinel can run a live SPL investigation against recent operational events before choosing a runbook, so the agent is checking current incident evidence instead of only historical memory.

## Known Gaps

- Official `@splunk/splunk-mcp` was not available on npm, so Sentinel uses a custom REST adapter in `packages/splunk-mcp`.
- Splunk Hosted Models are not proven yet. The blocker is not confirmed to be Developer License by itself. Current blockers are: Docker/Splunk is inactive, Splunkbase requires login to download AI Toolkit 5.7.4 and PSC 4.3.2, and `list_tokens_scs` capability/provider visibility still needs verification after those apps are installed.
- SPL keyword-overlap similarity is less precise than MongoDB Atlas Vector Search.
- The Docker Splunk image defaulted HEC to HTTPS. Local setup was changed to `enableSSL=0` so it matches Sentinel's documented `http://localhost:8088` HEC path.
- Pub/Sub is not used as the Sentinel trigger. It remains part of OperaIQ and existing SSE infrastructure; Sentinel uses the Splunk Alert Action webhook for trigger.
