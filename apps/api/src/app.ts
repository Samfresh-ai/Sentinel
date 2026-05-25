import crypto from "node:crypto";
import cors from "cors";
import express, { type NextFunction, type Request, type Response } from "express";
import helmet from "helmet";
import { ObjectId } from "mongodb";
import {
  closeMongoClient,
  createCollectionsAndIndexes,
  incidentsCollection,
  insertIncidentWithEmbedding,
  postmortemsCollection,
  runbooksCollection,
  servicesCollection,
  patternsCollection
} from "@operaiq/brain";
import {
  agentToolDefinitions,
  executeRemediation,
  getRunbook,
  getServiceDependencyGraph,
  runIncidentAgent,
  searchSimilarIncidents,
  writePostmortem
} from "@operaiq/agent";
import {
  createLogger,
  normalizeAlertPayload,
  paginationQuerySchema,
  type AgentEvent,
  loadRootEnv,
  type NormalizedAlert
} from "@operaiq/shared";
import {
  addAgentEventHandler,
  decodePubSubJsonMessage,
  publishAgentEvent,
  publishAlertEvent,
  startAgentEventsSubscription
} from "./pubsub.js";
import { verifyPubSubPushAuth } from "./pubsub-auth.js";
import { serializeIncident, serializePattern, serializePostmortem, serializeRunbook, serializeService } from "./serialize.js";
import { verifySlackSignature } from "./slack.js";

loadRootEnv();

const logger = createLogger("operaiq-api");
const rawBodies = new WeakMap<Request, Buffer>();

function rawBodySaver(req: Request, _res: Response, buf: Buffer): void {
  rawBodies.set(req, Buffer.from(buf));
}

function asyncHandler(handler: (req: Request, res: Response) => Promise<void>) {
  return (req: Request, res: Response, next: NextFunction): void => {
    handler(req, res).catch(next);
  };
}

function verifyWebhookSecret(req: Request): void {
  const expected = process.env.WEBHOOK_SECRET;
  if (!expected) {
    throw new Error("WEBHOOK_SECRET is not configured");
  }
  const actual = req.header("x-operaiq-secret") ?? "";
  const expectedBuffer = Buffer.from(expected);
  const actualBuffer = Buffer.from(actual);
  if (expectedBuffer.length !== actualBuffer.length || !crypto.timingSafeEqual(expectedBuffer, actualBuffer)) {
    const error = new Error("Invalid webhook secret");
    error.name = "Unauthorized";
    throw error;
  }
}

function verifyToolSecret(req: Request): void {
  const expected = process.env.AGENT_TOOL_SECRET ?? process.env.WEBHOOK_SECRET;
  if (!expected) {
    throw new Error("AGENT_TOOL_SECRET or WEBHOOK_SECRET is required for agent tool execution");
  }
  const bearer = req.header("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
  const explicit = req.header("x-operaiq-tool-secret") ?? "";
  const actual = bearer.length > 0 ? bearer : explicit;
  const expectedBuffer = Buffer.from(expected);
  const actualBuffer = Buffer.from(actual);
  if (expectedBuffer.length !== actualBuffer.length || !crypto.timingSafeEqual(expectedBuffer, actualBuffer)) {
    const error = new Error("Invalid agent tool secret");
    error.name = "Unauthorized";
    throw error;
  }
}

async function createIncidentFromAlert(alert: NormalizedAlert): Promise<string> {
  const incidentId = await insertIncidentWithEmbedding({
    title: alert.title,
    severity: alert.severity,
    status: "open",
    symptoms: alert.symptoms,
    affectedServices: alert.affectedServices,
    rootCause: null,
    resolution: null,
    remediationSteps: [],
    detectedAt: new Date(alert.detectedAt),
    resolvedAt: null,
    durationMinutes: null,
    postMortemId: null
  });
  return incidentId.toHexString();
}

type ToolHandler = (input: unknown) => Promise<unknown>;

const toolHandlers: Record<string, ToolHandler> = {
  search_similar_incidents: searchSimilarIncidents,
  get_service_dependency_graph: getServiceDependencyGraph,
  get_runbook: getRunbook,
  execute_remediation: executeRemediation,
  write_postmortem: writePostmortem
};

function toolOpenApiDocument(): Record<string, unknown> {
  const paths: Record<string, unknown> = {};
  for (const tool of agentToolDefinitions) {
    paths[`/agent/tools/${tool.name}`] = {
      post: {
        operationId: tool.name,
        summary: tool.description,
        security: [{ bearerAuth: [] }],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: tool.inputSchema
            }
          }
        },
        responses: {
          "200": {
            description: "Tool execution result",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["result"],
                  properties: {
                    result: {
                      description: "Tool-specific structured response"
                    }
                  }
                }
              }
            }
          },
          "401": { description: "Invalid agent tool secret" },
          "500": { description: "Tool execution failed" }
        }
      }
    };
  }
  return {
    openapi: "3.1.0",
    info: {
      title: "OperaIQ Agent Tools",
      version: "0.1.0"
    },
    servers: [
      {
        url: process.env.AGENT_TOOL_EXECUTION_BASE_URL ?? process.env.PUBLIC_APP_URL ?? "http://localhost:3001"
      }
    ],
    components: {
      securitySchemes: {
        bearerAuth: {
          type: "http",
          scheme: "bearer"
        }
      }
    },
    paths
  };
}

export function createApp(): express.Express {
  const app = express();
  app.use(helmet());
  app.use(cors());
  app.use((req, res, next) => {
    const startedAt = Date.now();
    res.on("finish", () => {
      logger.info(
        {
          method: req.method,
          path: req.path,
          statusCode: res.statusCode,
          durationMs: Date.now() - startedAt
        },
        "HTTP request completed"
      );
    });
    next();
  });
  app.use(express.json({ limit: "1mb", verify: rawBodySaver }));
  app.use(express.urlencoded({ extended: false, verify: rawBodySaver }));

  app.get(
    "/health",
    asyncHandler(async (_req, res) => {
      const brainSize = await (await incidentsCollection()).countDocuments();
      res.json({ status: "ok", brainSize });
    })
  );

  app.post(
    "/webhooks/alert",
    asyncHandler(async (req, res) => {
      verifyWebhookSecret(req);
      const alert = normalizeAlertPayload(req.body);
      const incidentId = await createIncidentFromAlert(alert);
      const messageId = await publishAlertEvent({ incidentId, alert });
      res.status(202).json({ incidentId, status: "open", pubsubMessageId: messageId });
    })
  );

  app.post(
    "/pubsub/alerts",
    asyncHandler(async (req, res) => {
      await verifyPubSubPushAuth(req);
      const decoded = decodePubSubJsonMessage(req.body);
      const parsed = zodPubSubAgentPayload(decoded);
      const result = await runIncidentAgent(parsed, async (event) => {
        await publishAgentEvent(event);
      });
      res.status(result.status === "failed" ? 500 : 204).send();
    })
  );

  app.post(
    "/webhooks/slack/interactions",
    asyncHandler(async (req, res) => {
      const rawBody = rawBodies.get(req) ?? Buffer.from("");
      if (!verifySlackSignature(req, rawBody)) {
        res.status(401).json({ error: "Invalid Slack signature or missing SLACK_SIGNING_SECRET" });
        return;
      }
      const payloadField = typeof req.body.payload === "string" ? req.body.payload : "";
      const payload = JSON.parse(payloadField) as { actions?: Array<{ action_id?: string; value?: string }> };
      const action = payload.actions?.find((item) => item.action_id === "operaiq_approve_remediation");
      if (!action?.value) {
        res.status(400).json({ error: "No OperaIQ approval action found" });
        return;
      }
      const approved = JSON.parse(action.value) as {
        action: "scale_service" | "restart_pod" | "purge_cache" | "rotate_connection_pool" | "notify_team";
        targetService: string;
        parameters: Record<string, string | number>;
      };
      const result = await executeRemediation({
        action: approved.action,
        targetService: approved.targetService,
        parameters: {
          ...approved.parameters,
          riskLevel: "low",
          approvedByHuman: "true"
        }
      });
      res.json({ ok: true, result });
    })
  );

  app.get(
    "/agent/tools",
    asyncHandler(async (_req, res) => {
      res.json({ tools: agentToolDefinitions });
    })
  );

  app.get(
    "/agent/openapi.json",
    asyncHandler(async (_req, res) => {
      res.json(toolOpenApiDocument());
    })
  );

  app.post(
    "/agent/tools/:toolName",
    asyncHandler(async (req, res) => {
      verifyToolSecret(req);
      const toolName = typeof req.params.toolName === "string" ? req.params.toolName : "";
      const handler = toolHandlers[toolName];
      if (!handler) {
        res.status(404).json({ error: `Unknown agent tool ${toolName}` });
        return;
      }
      const result = await handler(req.body);
      res.json({ result });
    })
  );

  app.get(
    "/incidents",
    asyncHandler(async (req, res) => {
      const pagination = paginationQuerySchema.parse(req.query);
      const collection = await incidentsCollection();
      const [items, total] = await Promise.all([
        collection
          .find({})
          .sort({ detectedAt: -1 })
          .skip((pagination.page - 1) * pagination.pageSize)
          .limit(pagination.pageSize)
          .toArray(),
        collection.countDocuments()
      ]);
      res.json({ items: items.map(serializeIncident), total, page: pagination.page, pageSize: pagination.pageSize });
    })
  );

  app.get(
    "/incidents/:id",
    asyncHandler(async (req, res) => {
      const id = typeof req.params.id === "string" ? req.params.id : "";
      if (!ObjectId.isValid(id)) {
        res.status(400).json({ error: "Invalid incident ID" });
        return;
      }
      const incident = await (await incidentsCollection()).findOne({ _id: new ObjectId(id) });
      if (!incident) {
        res.status(404).json({ error: "Incident not found" });
        return;
      }
      const postmortem = incident.postMortemId
        ? await (await postmortemsCollection()).findOne({ _id: incident.postMortemId })
        : null;
      res.json({
        incident: serializeIncident(incident),
        postmortem: postmortem ? serializePostmortem(postmortem) : null,
        alertPayload: {
          title: incident.title,
          severity: incident.severity,
          affectedServices: incident.affectedServices,
          symptoms: incident.symptoms,
          detectedAt: incident.detectedAt.toISOString()
        }
      });
    })
  );

  app.get(
    "/incidents/:id/stream",
    asyncHandler(async (req, res) => {
      const incidentId = typeof req.params.id === "string" ? req.params.id : "";
      if (!ObjectId.isValid(incidentId)) {
        res.status(400).end();
        return;
      }
      await startAgentEventsSubscription();
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive"
      });
      const remove = addAgentEventHandler((event: AgentEvent) => {
        if (event.incidentId === incidentId) {
          res.write(`event: step\n`);
          res.write(`data: ${JSON.stringify(event)}\n\n`);
        }
      });
      req.on("close", () => {
        remove();
        res.end();
      });
    })
  );

  app.get(
    "/services",
    asyncHandler(async (_req, res) => {
      const services = await (await servicesCollection()).find({}).sort({ name: 1 }).toArray();
      res.json({ items: services.map(serializeService) });
    })
  );

  app.get(
    "/brain/stats",
    asyncHandler(async (_req, res) => {
      const incidents = await incidentsCollection();
      const runbooks = await runbooksCollection();
      const patterns = await patternsCollection();
      const postmortems = await postmortemsCollection();
      const since = new Date();
      since.setHours(0, 0, 0, 0);
      const [incidentCount, runbookCount, patternCount, recentPostmortems, incidentTypes] = await Promise.all([
        incidents.countDocuments(),
        runbooks.countDocuments(),
        patterns.countDocuments(),
        postmortems.find({}).sort({ createdAt: -1 }).limit(5).toArray(),
        runbooks.find({}).sort({ updatedAt: -1 }).limit(5).toArray()
      ]);
      const [open, inProgress, resolvedToday] = await Promise.all([
        incidents.countDocuments({ status: "open" }),
        incidents.countDocuments({ status: "in_progress" }),
        incidents.countDocuments({ status: "resolved", resolvedAt: { $gte: since } })
      ]);
      res.json({
        incidentCount,
        runbookCount,
        patternCount,
        statusCounts: { open, inProgress, resolvedToday },
        topIncidentTypes: incidentTypes.map((runbook, index) => ({
          name: runbook.incidentType,
          count: Math.max(1, 5 - index)
        })),
        recentPostmortems: recentPostmortems.map(serializePostmortem)
      });
    })
  );

  app.post(
    "/simulate",
    asyncHandler(async (req, res) => {
      const alert = normalizeAlertPayload({ source: "operaiq", ...req.body });
      const incidentId = await createIncidentFromAlert(alert);
      const messageId = await publishAlertEvent({ incidentId, alert });
      res.status(202).json({ incidentId, pubsubMessageId: messageId });
    })
  );

  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const status = error instanceof Error && error.name === "Unauthorized" ? 401 : 500;
    const message = error instanceof Error ? error.message : "Unknown error";
    logger.error({ error }, "API request failed");
    res.status(status).json({ error: message });
  });

  return app;
}

function zodPubSubAgentPayload(value: unknown): { incidentId: string; alert: NormalizedAlert } {
  const schema = runIncidentAgentInputSchemaForApi();
  return schema.parse(value);
}

function runIncidentAgentInputSchemaForApi() {
  return {
    parse(value: unknown): { incidentId: string; alert: NormalizedAlert } {
      if (typeof value !== "object" || value === null || !("incidentId" in value) || !("alert" in value)) {
        throw new Error("Invalid agent Pub/Sub payload");
      }
      const raw = value as { incidentId?: unknown; alert?: unknown };
      if (typeof raw.incidentId !== "string") {
        throw new Error("Invalid incident ID in Pub/Sub payload");
      }
      const alert = normalizeAlertPayload(raw.alert);
      return { incidentId: raw.incidentId, alert };
    }
  };
}

process.on("SIGTERM", () => {
  closeMongoClient().catch((error: unknown) => {
    logger.error({ error }, "Failed to close MongoDB client on SIGTERM");
  });
});
