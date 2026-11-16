import "dotenv/config";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import express from "express";
import cors from "cors";
import helmet from "helmet";

import askRoute from "./routes/ask.js";
import agentsRoute from "./routes/agents.js";
import toolsRoute from "./routes/tools.js";
import callbackRoute from "./routes/callback.js";
import routeCallbackRoute from "./routes/routeCallback.js";
import statusRoute from "./routes/status.js";
import logsRoute from "./routes/logs.js";
import { logger, LOG_FILE_PATH } from "./logger.js";
import { ipGuard, loadAtlassianRanges } from "./ipGuard.js";
import { sweepExpired, PENDING_TTL_MS } from "./store.js";
import { sweepPendingRoutes } from "./router.js";

const app = express();
app.disable("x-powered-by");

// CSP allows inline scripts/styles only because the built-in /api/logs/view
// page is self-contained inline HTML; the React UI itself loads from 'self'.
// upgrade-insecure-requests is off so the UI still loads over plain http
// (localhost / docker without TLS).
app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        "default-src": ["'self'"],
        "script-src": ["'self'", "'unsafe-inline'"],
        "style-src": ["'self'", "'unsafe-inline'", "https:"],
        "font-src": ["'self'", "https:", "data:"],
        "img-src": ["'self'", "data:", "https:"],
        "connect-src": ["'self'"],
        "upgrade-insecure-requests": null,
      },
    },
  })
);

// CORS: same-origin only unless CORS_ORIGIN lists allowed origins (comma-separated).
// The Vite dev proxy makes the browser see same-origin requests, so it needs no CORS.
const corsOrigins = (process.env.CORS_ORIGIN || "")
  .split(",")
  .map((o) => o.trim())
  .filter(Boolean);
if (corsOrigins.length) app.use(cors({ origin: corsOrigins }));

const BODY_LIMIT = process.env.BODY_LIMIT || "1mb";

// Tunnel traffic (X-Forwarded-For present) may only reach the callback
// endpoints, and only from Atlassian IPs. Must run before any route.
await loadAtlassianRanges();
app.use(ipGuard);

app.use((req, res, next) => {
  const start = Date.now();
  res.on("finish", () => {
    logger.info("http_request", {
      method: req.method,
      path: req.originalUrl,
      status: res.statusCode,
      durationMs: Date.now() - start,
    });
  });
  next();
});

// callbackRoute uses its own text parser to handle unescaped newlines in agent responses
app.use("/api", callbackRoute);
app.use(express.json({ limit: BODY_LIMIT }));
app.use("/api", askRoute);
app.use("/api", agentsRoute);
app.use("/api", toolsRoute);
app.use("/api", routeCallbackRoute);
app.use("/api", statusRoute);
app.use("/api", logsRoute);

// Liveness probe: no auth, no external dependencies, no sensitive info.
app.get("/api/health", (req, res) => res.json({ status: "ok" }));
app.get("/health", (req, res) => res.json({ ok: true }));

// In the container image the built client is served from here; in local dev
// the folder usually doesn't exist and Vite serves the UI instead.
const CLIENT_DIST = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "client", "dist");
if (fs.existsSync(CLIENT_DIST)) {
  app.use(express.static(CLIENT_DIST));
  app.get(/^\/(?!api\/|health).*/, (req, res) => res.sendFile(path.join(CLIENT_DIST, "index.html")));
}

// Generic error handler: never leak stack traces or internals to the client.
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  const status = err.status >= 400 && err.status < 500 ? err.status : 500;
  logger.error("unhandled_error", { errorType: err.name, status });
  if (res.headersSent) return res.end();
  const messages = { 400: "Bad request", 413: "Payload too large" };
  res.status(status).json({ error: status === 500 ? "Internal server error" : messages[status] || "Request error" });
});

const PORT = process.env.PORT || 4000;
const server = app.listen(PORT, () => {
  logger.info("server_started", { port: PORT, logFile: LOG_FILE_PATH });
  console.log(`PM Assistant POC server listening on http://localhost:${PORT}`);
  console.log(`Callback endpoint (needs a public tunnel for real automations): /api/callback`);
  console.log(`Logs viewer: http://localhost:${PORT}/api/logs/view`);
});

// Periodically expire pending requests/routing decisions that never got a callback.
const SWEEP_INTERVAL_MS = Math.min(60000, PENDING_TTL_MS);
setInterval(() => {
  const { expired, removed } = sweepExpired();
  const routes = sweepPendingRoutes(PENDING_TTL_MS);
  if (expired || removed || routes) logger.info("pending_sweep", { expired, removed, expiredRoutes: routes });
}, SWEEP_INTERVAL_MS).unref();

// Node's default keepAliveTimeout (5s) is shorter than gaps that show up
// naturally in this app (think time between chat messages, polling pauses).
// The Vite dev proxy reuses a pooled keep-alive connection, and if it sends
// the next request right as this timeout closes an idle socket, the client
// gets ECONNRESET with a truncated body instead of a fresh connection.
// headersTimeout must stay above keepAliveTimeout or Node's HTTP parser
// misbehaves, so both are raised together.
server.keepAliveTimeout = 120000;
server.headersTimeout = 125000;

const SHUTDOWN_TIMEOUT_MS = 10000;
let shuttingDown = false;

function shutdown(signal) {
  if (shuttingDown) {
    // Second Ctrl+C (or duplicate signal): bail out immediately.
    logger.warn("shutdown_forced_exit", { signal });
    process.exit(1);
  }
  shuttingDown = true;

  logger.info("shutdown_initiated", { signal });
  console.log(`\n${signal} received, shutting down gracefully (press Ctrl+C again to force)...`);

  // Stop accepting new connections; wait for in-flight requests (e.g. a
  // pending router webhook round-trip in router.js) to finish naturally.
  server.close((err) => {
    if (err) {
      logger.error("shutdown_error", { error: err.message });
      process.exit(1);
    }
    logger.info("shutdown_complete", { signal });
    process.exit(0);
  });

  setTimeout(() => {
    logger.warn("shutdown_timed_out", { signal, timeoutMs: SHUTDOWN_TIMEOUT_MS });
    console.error(`Still had open connections after ${SHUTDOWN_TIMEOUT_MS}ms, forcing exit.`);
    process.exit(1);
  }, SHUTDOWN_TIMEOUT_MS).unref();
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
