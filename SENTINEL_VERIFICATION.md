# Sentinel Verification

Sentinel is implemented as a Splunk-native port that runs alongside OperaIQ. This file tracks only the four changed components.

## Current Local State

Local Splunk Enterprise is running in Docker as `sentinel-splunk` on:

- management API: `https://localhost:8089`
- HEC: `http://localhost:8088`
- app: `sentinel`
- index: `sentinel`

The local `.env` contains Splunk credentials and the HEC token. Values are intentionally not documented here.

Validated on 2026-05-25:

```text
pnpm splunk:setup-check
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

## Shipped vs Imagined

| Component | Shipped | Imagined / blocked |
| --- | --- | --- |
| Splunk KV Store brain | `@operaiq/splunk-brain` implements typed REST client, KV collection create/query/insert/update/delete, and Sentinel incident writes. `pnpm splunk:setup-check`, `pnpm splunk:seed`, and `pnpm splunk:verify` pass against local Splunk. | Production Splunk Cloud/Enterprise deployment still needs a real hosted target and certificate policy. |
| SPL-based similarity search | `findSimilarIncidents()` searches `index=sentinel sourcetype=sentinel:postmortem` and computes keyword-overlap similarity; fallback ranks resolved KV incidents by keyword overlap. | This is lower quality than MongoDB Atlas Vector Search and should be stated in submissions. |
| Live log query tool | `query_splunk_logs` runs targeted SPL and streams an `INVESTIGATE` step between REMEMBER and MAP in `runSentinelAgent()`. `sentinel:test-tools` returned 5 indexed post-mortem rows and `sentinel:smoke-test` found 4 recent notification-service events. | Splunk Hosted Models are not proven on this local license, so reasoning still uses offline/Gemini fallback. |
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
- Splunk Hosted Models are not proven available on the local Developer License. The generation path remains Gemini/offline fallback until proven otherwise.
- SPL keyword-overlap similarity is less precise than MongoDB Atlas Vector Search.
- The Docker Splunk image defaulted HEC to HTTPS. Local setup was changed to `enableSSL=0` so it matches Sentinel's documented `http://localhost:8088` HEC path.
- Pub/Sub is not used as the Sentinel trigger. It remains part of OperaIQ and existing SSE infrastructure; Sentinel uses the Splunk Alert Action webhook for trigger.
