# Sentinel Verification

Sentinel is implemented as a Splunk-native port that runs alongside OperaIQ. This file tracks only the four changed components.

## Current Local State

`pnpm typecheck` passes across the monorepo after adding the Sentinel packages and scripts.

`pnpm splunk:setup-check` currently fails before making a network call because `.env` does not yet contain:

- `SPLUNK_USERNAME`
- `SPLUNK_PASSWORD`
- `SPLUNK_HEC_TOKEN`

Local Splunk Enterprise is also not proven running on `https://localhost:8089` / `http://localhost:8088` in this workspace. Live Sentinel e2e is blocked until Splunk is installed/licensed and those values are added to `.env`.

## Required Live Proof

After Splunk setup, run:

```bash
pnpm splunk:setup-check
pnpm splunk:seed
pnpm splunk:verify
OPERAIQ_AI_PROVIDER=offline OPERAIQ_LOCAL_VERIFY=true OPERAIQ_REMEDIATION_WAIT_MS=0 pnpm sentinel:test-tools
OPERAIQ_AI_PROVIDER=offline OPERAIQ_LOCAL_VERIFY=true OPERAIQ_REMEDIATION_WAIT_MS=0 pnpm sentinel:smoke-test
OPERAIQ_AI_PROVIDER=offline OPERAIQ_LOCAL_VERIFY=true OPERAIQ_REMEDIATION_WAIT_MS=0 pnpm sentinel:e2e
```

`sentinel:e2e` expects the API server to be reachable at `NEXT_PUBLIC_API_URL` or `http://localhost:3001`.

## Shipped vs Imagined

| Component | Shipped | Imagined / blocked |
| --- | --- | --- |
| Splunk KV Store brain | `@operaiq/splunk-brain` implements typed REST client, KV collection create/query/insert/update/delete, and Sentinel incident writes. | Live KV Store proof waits on Splunk Enterprise credentials/license. |
| SPL-based similarity search | `findSimilarIncidents()` searches `index=sentinel sourcetype=sentinel:postmortem` and computes keyword-overlap similarity; fallback ranks resolved KV incidents by keyword overlap. | This is lower quality than MongoDB Atlas Vector Search and should be stated in submissions. |
| Live log query tool | `query_splunk_logs` runs targeted SPL and streams an `INVESTIGATE` step between REMEMBER and MAP in `runSentinelAgent()`. | Live result count waits on seeded Splunk events. |
| Splunk Alert Action trigger | `POST /webhooks/splunk-alert` validates Splunk alert payloads, creates a Sentinel incident in KV Store, and invokes the Sentinel agent directly in the background. | Real saved-search alert proof waits on local Splunk setup. |

## Required Answers After Live Setup

1. Live SPL query:
   - Query to run: `search index=sentinel sourcetype=sentinel:postmortem | head 5`
   - Result count: not available until Splunk is running and seeded.
   - Raw JSON: not available until Splunk is running and seeded.

2. Dual write:
   - Search to run after `sentinel:e2e`: `index=sentinel sourcetype=sentinel:postmortem`
   - Result count and one returned field: not available until Splunk is running and seeded.

3. OperaIQ + Sentinel side by side:
   - OperaIQ `pnpm verify:e2e` previously passed in local zero-billing mode.
   - Sentinel `pnpm sentinel:e2e` is blocked on local Splunk credentials/instance.
   - Shared dependency to watch: `execute_remediation` is shared and switches data source through `SENTINEL_MODE` / `AGENT_NAME=Sentinel`; Cloud Run dispatch remains shared.

4. One thing Sentinel does better:
   - Sentinel can run a live SPL investigation against recent operational events before choosing a runbook, so the agent is checking current incident evidence instead of only historical memory.

## Known Gaps

- Official `@splunk/splunk-mcp` was not available on npm, so Sentinel uses a custom REST adapter in `packages/splunk-mcp`.
- Splunk Hosted Models are not proven available on the local Developer License. The generation path remains Gemini/offline fallback until proven otherwise.
- SPL keyword-overlap similarity is less precise than MongoDB Atlas Vector Search.
- Splunk KV Store collection creation and HEC writes are implemented but not live-proven until Splunk is installed/licensed locally.
- Pub/Sub is not used as the Sentinel trigger. It remains part of OperaIQ and existing SSE infrastructure; Sentinel uses the Splunk Alert Action webhook for trigger.
