import crypto from "node:crypto";
import bcrypt from "bcryptjs";
import { Router, type NextFunction, type Request, type Response } from "express";
import jwt from "jsonwebtoken";
import { countDocuments, createCollection, createKvKey, getDocument, insertDocument, queryDocuments, updateDocument } from "@sentinel/splunk-brain";

export interface AuthenticatedOrg {
  orgId: string;
  userId: string;
  orgName: string;
}

export interface AuthenticatedRequest extends Request {
  auth?: AuthenticatedOrg;
}

const JWT_EXPIRES_IN_SECONDS = 7 * 24 * 60 * 60;
const BCRYPT_COST = 12;
const authRateLimitWindows = new Map<string, { count: number; windowStart: number }>();

function jwtSecret(): string {
  const secret = process.env.JWT_SECRET;
  if (!secret || secret.trim().length === 0) {
    throw new Error("JWT_SECRET is required");
  }
  return secret;
}

function unauthorizedError(): Error {
  const error = new Error("Unauthorized");
  error.name = "Unauthorized";
  return error;
}

function apiBaseUrl(req: Request): string {
  const configured = process.env.API_PUBLIC_URL ?? process.env.AGENT_TOOL_EXECUTION_BASE_URL ?? process.env.NEXT_PUBLIC_API_URL;
  if (configured && configured.trim().length > 0) return configured.replace(/\/+$/, "");
  return `${req.protocol}://${req.get("host")}`;
}

function webhookUrl(req: Request, orgId: string, secret: string): string {
  return `${apiBaseUrl(req)}/webhooks/alert?orgId=${encodeURIComponent(orgId)}&secret=${encodeURIComponent(secret)}`;
}

function signToken(payload: AuthenticatedOrg): string {
  return jwt.sign(payload, jwtSecret(), { expiresIn: JWT_EXPIRES_IN_SECONDS });
}

function bearerToken(req: Request): string | null {
  const header = req.header("authorization") ?? "";
  const match = /^Bearer\s+(.+)$/i.exec(header);
  return match?.[1] ?? null;
}

export function verifyAuth(req: Request): AuthenticatedOrg {
  const token = bearerToken(req);
  if (!token) {
    throw unauthorizedError();
  }
  try {
    const decoded = jwt.verify(token, jwtSecret()) as Partial<AuthenticatedOrg>;
    if (!decoded.orgId || !decoded.userId || !decoded.orgName) throw new Error("Invalid JWT payload");
    return { orgId: decoded.orgId, userId: decoded.userId, orgName: decoded.orgName };
  } catch {
    throw unauthorizedError();
  }
}

export function requireAuth(req: AuthenticatedRequest, _res: Response, next: NextFunction): void {
  try {
    req.auth = verifyAuth(req);
    next();
  } catch (error) {
    next(error);
  }
}

function clientIp(req: Request): string {
  const forwarded = req.header("x-forwarded-for");
  if (forwarded && forwarded.trim().length > 0) return forwarded.split(",")[0]!.trim();
  return req.ip || req.socket.remoteAddress || "unknown";
}

function authIpRateLimit(req: Request, res: Response, next: NextFunction): void {
  const key = clientIp(req);
  const now = Date.now();
  const current = authRateLimitWindows.get(key);
  const inWindow = current && now - current.windowStart < 60_000;
  const nextCount = inWindow ? current.count + 1 : 1;
  authRateLimitWindows.set(key, { count: nextCount, windowStart: inWindow ? current.windowStart : now });
  if (nextCount > 20) {
    res.setHeader("Retry-After", "60");
    res.status(429).json({ error: "Rate limit exceeded" });
    return;
  }
  next();
}

async function ensureAuthCollections(): Promise<void> {
  await createCollection("orgs", {});
  await createCollection("users", {});
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export async function verifyWebhookOrg(orgId: string, secret: string): Promise<{ orgId: string; orgName: string }> {
  await ensureAuthCollections();
  const org = await getDocument<Record<string, unknown>>("orgs", orgId);
  const hash = typeof org?.webhookSecretHash === "string" ? org.webhookSecretHash : "";
  if (!org || !hash || !(await bcrypt.compare(secret, hash))) {
    throw unauthorizedError();
  }
  return { orgId, orgName: typeof org.orgName === "string" ? org.orgName : orgId };
}

async function getSessionRecords(auth: AuthenticatedOrg): Promise<{ org: Record<string, unknown>; user: Record<string, unknown> }> {
  await ensureAuthCollections();
  const [org, user] = await Promise.all([
    getDocument<Record<string, unknown>>("orgs", auth.orgId),
    getDocument<Record<string, unknown>>("users", auth.userId)
  ]);
  if (!org || !user || user.orgId !== auth.orgId) {
    throw unauthorizedError();
  }
  return { org, user };
}

export function authRouter(): Router {
  const router = Router();

  router.post("/signup", authIpRateLimit, async (req, res, next) => {
    try {
      await ensureAuthCollections();
      const body = req.body as { orgName?: unknown; adminEmail?: unknown; adminPassword?: unknown };
      if (typeof body.orgName !== "string" || typeof body.adminEmail !== "string" || typeof body.adminPassword !== "string") {
        res.status(400).json({ error: "orgName, adminEmail, and adminPassword are required" });
        return;
      }
      const orgName = body.orgName.trim();
      const adminEmail = normalizeEmail(body.adminEmail);
      if (!orgName || !adminEmail || body.adminPassword.length < 8) {
        res.status(400).json({ error: "Valid orgName, adminEmail, and 8+ character password are required" });
        return;
      }
      const existingUsers = await queryDocuments<Record<string, unknown>>("users", { email: adminEmail }, 1);
      if (existingUsers.length > 0) {
        res.status(409).json({ error: "Account already exists" });
        return;
      }
      const now = new Date().toISOString();
      const orgId = createKvKey();
      const userId = createKvKey();
      const webhookSecret = crypto.randomBytes(32).toString("hex");
      await insertDocument("orgs", {
        _key: orgId,
        orgName,
        adminEmail,
        webhookSecretHash: await bcrypt.hash(webhookSecret, BCRYPT_COST),
        createdAt: now,
        updatedAt: now
      });
      await insertDocument("users", {
        _key: userId,
        orgId,
        orgName,
        email: adminEmail,
        passwordHash: await bcrypt.hash(body.adminPassword, BCRYPT_COST),
        role: "admin",
        createdAt: now,
        updatedAt: now
      });
      res.status(201).json({ token: signToken({ orgId, userId, orgName }), orgId, webhookUrl: webhookUrl(req, orgId, webhookSecret) });
    } catch (error) {
      next(error);
    }
  });

  router.post("/login", authIpRateLimit, async (req, res, next) => {
    try {
      await ensureAuthCollections();
      const body = req.body as { email?: unknown; password?: unknown };
      if (typeof body.email !== "string" || typeof body.password !== "string") {
        res.status(400).json({ error: "email and password are required" });
        return;
      }
      const email = normalizeEmail(body.email);
      const user = (await queryDocuments<Record<string, unknown>>("users", { email }, 1))[0];
      const passwordHash = typeof user?.passwordHash === "string" ? user.passwordHash : "";
      if (!user || !passwordHash || !(await bcrypt.compare(body.password, passwordHash))) {
        res.status(401).json({ error: "Unauthorized" });
        return;
      }
      const orgId = typeof user.orgId === "string" ? user.orgId : "";
      const org = await getDocument<Record<string, unknown>>("orgs", orgId);
      if (!org) {
        throw unauthorizedError();
      }
      const orgName = typeof org?.orgName === "string" ? org.orgName : typeof user.orgName === "string" ? user.orgName : orgId;
      res.json({ token: signToken({ orgId, userId: String(user._key), orgName }), orgId, orgName });
    } catch (error) {
      next(error);
    }
  });

  router.get("/me", requireAuth, async (req: AuthenticatedRequest, res, next) => {
    try {
      const auth = req.auth!;
      const { org } = await getSessionRecords(auth);
      const brainSize = await countDocuments("incidents", {}, { orgId: auth.orgId }).catch(() => 0);
      res.json({
        orgId: auth.orgId,
        orgName: typeof org.orgName === "string" ? org.orgName : auth.orgName,
        adminEmail: typeof org?.adminEmail === "string" ? org.adminEmail : "",
        brainSize,
        webhookUrl: `${apiBaseUrl(req)}/webhooks/alert?orgId=${encodeURIComponent(auth.orgId)}&secret=<shown-once-at-signup>`
      });
    } catch (error) {
      next(error);
    }
  });

  router.post("/webhook-secret/rotate", requireAuth, async (req: AuthenticatedRequest, res, next) => {
    try {
      const auth = req.auth!;
      await getSessionRecords(auth);
      const webhookSecret = crypto.randomBytes(32).toString("hex");
      const rotatedAt = new Date().toISOString();
      await updateDocument("orgs", auth.orgId, {
        webhookSecretHash: await bcrypt.hash(webhookSecret, BCRYPT_COST),
        webhookSecretRotatedAt: rotatedAt,
        updatedAt: rotatedAt
      });
      res.json({
        orgId: auth.orgId,
        webhookUrl: webhookUrl(req, auth.orgId, webhookSecret),
        rotatedAt
      });
    } catch (error) {
      next(error);
    }
  });

  return router;
}
