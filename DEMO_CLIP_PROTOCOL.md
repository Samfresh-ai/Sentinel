# Sentinel Demo Clip Protocol

Verified source run:

```text
pnpm sentinel:demo
✓ Demo logs sent to Splunk
 index=prod | total events: 120
 ECONNRESET count: 44
 Autonomous: saved search fires if pnpm sentinel:demo:setup has run
 Manual fast-path: pnpm sentinel:demo
✓ Demo Sentinel KV Store seeded
 incidents: 3 Redis/payment historical matches
 runbook: demo-redis-connection-pool
→ Incident created: 7bec7b7290fb5547536b401a [open]
→ Agent started [in_progress]
→ Tool called: search_similar_incidents
→ Tool called: query_splunk_logs
→ Tool called: get_service_dependency_graph
→ Tool called: execute_remediation
→ Tool called: write_postmortem
→ Incident resolved: 7bec7b7290fb5547536b401a [resolved] in 3s
→ Postmortem written: 83e6d9e593bd1bdde8aea9a1
```

Splunk proof query:

```spl
index=prod sourcetype=app service=payment | stats count by error_type
```

Expected result:

```text
ECONNRESET 44
UPSTREAM_TIMEOUT 6
```

## Clip 0 - Autonomous Watcher

Timebox: `0:00-0:18`

Show terminal running:

```bash
pnpm sentinel:demo:logs
```

The command completes and exits. Leave the screen idle with no trigger command running. After 30-60 seconds, switch to the browser feed and show the new `sentinel_auto_detect_payment_errors` incident appearing without human action.

Caption: `No command. No trigger. Sentinel watches and acts.`

## Clip 1 - The Alert

Timebox: `0:00-0:12`

Show terminal running:

```bash
pnpm sentinel:demo:trigger
```

Frame the POST firing and:

```text
→ Incident created: <id> [open]
```

Caption: `Alert fires: payment-service ECONNRESET spike detected`

## Clip 2 - Sentinel Wakes

Timebox: `0:12-0:25`

Show browser at `http://localhost:3000`, incident feed. The new P1 `sentinel_demo_payment_redis_spike` row should appear with status `in_progress`.

Caption: `Sentinel begins autonomous investigation`

## Clip 3 - Live Investigation

Timebox: `0:25-1:20`

Show browser at:

```text
http://localhost:3000/incidents/<id>
```

Keep the Agent Reasoning Panel visible through `[CLOSE]`.

Required visible lines:

```text
[REMEMBER] Searched Splunk incident memory and found 3 similar matches. Best match: Redis connection pool exhaustion - payment-service (64% match).
[INVESTIGATE] index=prod sourcetype=app service=payment | stats count by error_type -> ECONNRESET: 44 events in last 15 minutes.
[MAP] payment-service maps to postgres-main, redis-cache; redis-cache is the likely root for this alert.
[ACT] Executing rotate_connection_pool on redis-cache with low risk.
[ACT] rotate_connection_pool on redis-cache completed in 1s with success=true.
[CLOSE] Wrote Sentinel post-mortem <postmortemId> to Splunk KV Store and HEC.
```

Caption: `Live SPL investigation. 3 similar past incidents found. Remediation executing.`

## Clip 4 - Resolved

Timebox: `1:20-1:35`

Show the incident feed row after resolution. Status must be `resolved`; resolution time for the verified source run was `4s`.

Caption: `Resolved autonomously. No human intervention.`

## Clip 5 - The Brain Grows

Timebox: `1:35-2:00`

Show Splunk Web at `http://localhost:8000` and run:

```spl
index=sentinel sourcetype=sentinel:postmortem | head 1
```

Expand `incidentId`. For the verified source run, show:

```text
incidentId=7bec7b7290fb5547536b401a
```

Caption: `Post-mortem written to Splunk. Sentinel now knows this pattern.`

## Clip 6 - Brain Counter

Timebox: `2:00-2:15`

Show `http://localhost:3000/brain`. The brain counter should be higher than before the run, and the recent post-mortems list should include the latest Sentinel post-mortem.

Caption: `The brain grows with every resolved incident.`
