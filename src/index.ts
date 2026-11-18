#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import cors from "cors";
import express, { type NextFunction, type Request, type Response } from "express";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { CdpSessionManager } from "./browser/cdp-manager.js";
import { loadConfig } from "./config.js";
import { GoogleFlowController } from "./flow/controller.js";
import { FlowJobQueue } from "./queue/job-queue.js";
import { buildFlowMcpServer } from "./server/mcp-factory.js";
import { MediaUrlSigner, verifyBearerToken } from "./utils/media-signer.js";

interface ManagedHttpSession {
  transport: StreamableHTTPServerTransport;
  lastSeenMs: number;
}

async function main() {
  const args = new Set(process.argv.slice(2));
  const config = loadConfig();

  const cdp = new CdpSessionManager(config);
  const queue = new FlowJobQueue(
    config.stateDirAbs,
    config.FLOW_MAX_CREDITS_PER_CALL,
    config.FLOW_DAILY_CREDIT_CAP,
  );
  const signer = new MediaUrlSigner(
    config.FLOW_MEDIA_SIGNING_SECRET,
    config.PUBLIC_BASE_URL,
    config.FLOW_MEDIA_URL_TTL_SECONDS,
  );
  const flow = new GoogleFlowController(config, cdp, queue, signer);

  if (args.has("--doctor")) {
    const report = await cdp.runDoctor(args.has("--close-hung"));
    console.error(JSON.stringify(report, null, 2));
    process.exit(report.cdpReachable ? 0 : 1);
  }

  if (args.has("--stdio")) {
    const stdioServer = buildFlowMcpServer({ cdp, flow, queue });
    const transport = new StdioServerTransport();
    await stdioServer.connect(transport);
    console.error("[google-flow-mcp] Running on stdio transport");
    return;
  }

  if (!config.FLOW_MCP_AUTH_TOKEN) {
    console.error(
      "[WARN] FLOW_MCP_AUTH_TOKEN kosong! Segera set token rahasia sebelum mengekspos endpoint /mcp ke jaringan publik.",
    );
  }

  const app = express();
  app.disable("x-powered-by");
  app.use(
    cors({
      origin: false,
      exposedHeaders: ["Mcp-Session-Id"],
      allowedHeaders: ["Content-Type", "Authorization", "Mcp-Session-Id", "Last-Event-ID"],
    }),
  );
  app.use(express.json({ limit: "4mb" }));

  const hostGuard = (req: Request, res: Response, next: NextFunction) => {
    const hostHeader = (req.headers.host ?? "").toLowerCase();
    const hostWithoutPort = hostHeader.split(":")[0];
    const allowed =
      config.allowedHostsList.includes("*") ||
      config.allowedHostsList.includes(hostHeader) ||
      config.allowedHostsList.includes(hostWithoutPort);

    if (!allowed) {
      res.status(403).json({
        jsonrpc: "2.0",
        error: { code: -32001, message: `Forbidden Host header: ${hostHeader}` },
        id: null,
      });
      return;
    }
    next();
  };

  const bearerAuthGuard = (req: Request, res: Response, next: NextFunction) => {
    if (!verifyBearerToken(req.headers.authorization, config.FLOW_MCP_AUTH_TOKEN)) {
      res.setHeader("WWW-Authenticate", 'Bearer realm="google-flow-mcp"');
      res.status(401).json({
        jsonrpc: "2.0",
        error: { code: -32001, message: "Unauthorized: Invalid or missing Bearer token." },
        id: null,
      });
      return;
    }
    next();
  };

  app.get("/healthz", hostGuard, async (_req: Request, res: Response) => {
    const doctor = await cdp.runDoctor(false);
    res.status(200).json({
      status: "ok",
      transport: config.FLOW_STATELESS_HTTP ? "streamable-http-stateless" : "streamable-http-stateful",
      cdpReachable: doctor.cdpReachable,
      queue: queue.getQueueMetrics(),
    });
  });

  app.get("/media/:filename", hostGuard, (req: Request, res: Response) => {
    const safeName = path.basename(req.params.filename ?? "");
    const exp = typeof req.query.exp === "string" ? req.query.exp : undefined;
    const sig = typeof req.query.sig === "string" ? req.query.sig : undefined;

    if (!signer.verify(safeName, exp, sig)) {
      res.status(403).json({ error: "Invalid or expired media signature." });
      return;
    }

    const fullPath = path.join(config.outputDirAbs, safeName);
    if (!fs.existsSync(fullPath)) {
      res.status(404).json({ error: "Media file not found." });
      return;
    }

    res.sendFile(fullPath);
  });

  const sessions = new Map<string, ManagedHttpSession>();

  const gcTimer = setInterval(() => {
    const cutoff = Date.now() - config.FLOW_SESSION_TTL_MS;
    for (const [sid, entry] of sessions.entries()) {
      if (entry.lastSeenMs < cutoff) {
        entry.transport.close().catch(() => undefined);
        sessions.delete(sid);
      }
    }
  }, 60_000);
  gcTimer.unref();

  app.post("/mcp", hostGuard, bearerAuthGuard, async (req: Request, res: Response) => {
    try {
      if (config.FLOW_STATELESS_HTTP) {
        const statelessTransport = new StreamableHTTPServerTransport({
          sessionIdGenerator: undefined,
          enableJsonResponse: true,
        });
        const server = buildFlowMcpServer({ cdp, flow, queue });
        res.on("close", () => {
          statelessTransport.close().catch(() => undefined);
        });
        await server.connect(statelessTransport);
        await statelessTransport.handleRequest(req, res, req.body);
        return;
      }

      const sessionId = req.headers["mcp-session-id"] as string | undefined;
      if (sessionId && sessions.has(sessionId)) {
        const managed = sessions.get(sessionId)!;
        managed.lastSeenMs = Date.now();
        await managed.transport.handleRequest(req, res, req.body);
        return;
      }

      if (!sessionId && isInitializeRequest(req.body)) {
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (id) => {
            sessions.set(id, { transport, lastSeenMs: Date.now() });
          },
        });

        transport.onclose = () => {
          if (transport.sessionId) {
            sessions.delete(transport.sessionId);
          }
        };

        const server = buildFlowMcpServer({ cdp, flow, queue });
        await server.connect(transport);
        await transport.handleRequest(req, res, req.body);
        return;
      }

      res.status(400).json({
        jsonrpc: "2.0",
        error: {
          code: -32000,
          message: "Bad Request: Missing valid Mcp-Session-Id header or initialize payload.",
        },
        id: null,
      });
    } catch (err) {
      console.error("[google-flow-mcp] POST /mcp error:", err);
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: "2.0",
          error: { code: -32603, message: "Internal MCP server error." },
          id: null,
        });
      }
    }
  });

  const handleExistingSession = async (req: Request, res: Response) => {
    if (config.FLOW_STATELESS_HTTP) {
      res.status(405).json({
        jsonrpc: "2.0",
        error: { code: -32000, message: "Method not allowed in stateless HTTP mode." },
        id: null,
      });
      return;
    }

    const sessionId = req.headers["mcp-session-id"] as string | undefined;
    if (!sessionId || !sessions.has(sessionId)) {
      res.status(400).json({
        jsonrpc: "2.0",
        error: { code: -32000, message: "Invalid or expired Mcp-Session-Id." },
        id: null,
      });
      return;
    }

    const managed = sessions.get(sessionId)!;
    managed.lastSeenMs = Date.now();
    await managed.transport.handleRequest(req, res);
  };

  app.get("/mcp", hostGuard, bearerAuthGuard, handleExistingSession);
  app.delete("/mcp", hostGuard, bearerAuthGuard, handleExistingSession);

  const httpServer = app.listen(config.PORT, config.HOST, () => {
    console.error(
      `[google-flow-mcp] Streamable HTTP listening at http://${config.HOST}:${config.PORT}/mcp (CDP: ${config.FLOW_CDP_URL})`,
    );
  });

  const shutdown = async () => {
    console.error("[google-flow-mcp] Shutting down gracefully...");
    clearInterval(gcTimer);
    for (const entry of sessions.values()) {
      await entry.transport.close().catch(() => undefined);
    }
    sessions.clear();
    await cdp.gracefulDetach();
    httpServer.close(() => process.exit(0));
  };

  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
}

main().catch((err) => {
  console.error("[google-flow-mcp] Fatal startup error:", err);
  process.exit(1);
});
