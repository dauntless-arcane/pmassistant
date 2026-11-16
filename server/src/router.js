import fetch from "node-fetch";
import { v4 as uuidv4 } from "uuid";
import { logger } from "./logger.js";
import { formatHistoryForPrompt } from "./context.js";

// Requests waiting on a routing decision from the Rovo router automation.
// requestId -> { resolve, reject, timer }
const pendingRoutes = new Map();

const ROUTER_TIMEOUT_MS = Number(process.env.ROVO_ROUTER_TIMEOUT_MS) || 30000;

function buildRouterPrompt(message, registry, history) {
  const menu = registry
    .map(
      (a) =>
        `- id: ${a.id}\n  name: ${a.name}\n  description: ${a.description}\n  example requests: ${a.triggerExamples.join(
          " | "
        )}`
    )
    .join("\n");

  const transcript = formatHistoryForPrompt(history);
  const context = transcript
    ? `\nRecent conversation for context (most recent last):\n${transcript}\n`
    : "";

  return `You are a routing component. Given a user's request and a list of available automations, respond with ONLY the id of the single best-matching automation, or the literal string "none" if nothing fits well.

Available automations:
${menu}
${context}
User request: "${message}"

Respond with ONLY the id (or "none"). No explanation, no punctuation, no markdown.`;
}

/**
 * Safety-net sweep: rejects and removes routing decisions older than ttlMs
 * (normally the per-request timer already did this). Returns how many.
 */
export function sweepPendingRoutes(ttlMs, now = Date.now()) {
  let n = 0;
  for (const [id, entry] of pendingRoutes) {
    if (now - entry.createdAt > ttlMs) {
      clearTimeout(entry.timer);
      pendingRoutes.delete(id);
      entry.reject(new Error("Routing decision expired."));
      n++;
    }
  }
  return n;
}

/**
 * Called by the /api/route-callback route once the router automation
 * sends back its decision. Resolves the matching pending routeRequest() call.
 */
export function resolveRouteCallback(requestId, result) {
  const entry = pendingRoutes.get(requestId);
  if (!entry) return false;
  clearTimeout(entry.timer);
  pendingRoutes.delete(requestId);
  entry.resolve(result);
  return true;
}

/**
 * Fires the constant Rovo router automation's incoming webhook with a prompt
 * listing every registry entry, then waits for that automation to call back
 * to /api/route-callback with its decision — same fire+callback mechanics as
 * the per-agent triggers, hidden behind a request/response-shaped function.
 *
 * @param {string} message - the user's free-text request
 * @param {Array} registry - list of agent entries (see registry.json)
 * @param {Array} history - prior { message, result } turns in this conversation
 * @returns {Promise<{agentId: string|null}>}
 */
export async function routeRequest(message, registry, history = []) {
  const webhookUrl = process.env.ROVO_ROUTER_WEBHOOK_URL;
  if (!webhookUrl || webhookUrl.includes("REPLACE_WITH")) {
    throw new Error(
      "ROVO_ROUTER_WEBHOOK_URL is not set. Add the routing automation's incoming webhook URL to server/.env."
    );
  }

  // Fallback agents (see registry.json's "fallback" flag) are never offered
  // to the router as a choice — they're only used by ask.js when nothing matches.
  const routable = registry.filter((a) => !a.fallback);

  const inputField = process.env.ROVO_ROUTER_INPUT_FIELD || "prompt";
  const publicBase = (process.env.PUBLIC_CALLBACK_BASE_URL || `http://localhost:${process.env.PORT || 4000}`).replace(/\/+$/, "");
  const callbackUrl = `${publicBase}/api/route-callback`;
  const routingRequestId = uuidv4();

  const prompt = buildRouterPrompt(message, routable, history);
  logger.info("router_rovo_call", { routingRequestId });

  const decisionPromise = new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingRoutes.delete(routingRequestId);
      reject(new Error("Timed out waiting for a routing decision from the Rovo router."));
    }, ROUTER_TIMEOUT_MS);
    pendingRoutes.set(routingRequestId, { resolve, reject, timer, createdAt: Date.now() });
  });

  const headers = { "Content-Type": "application/json" };
  if (process.env.ROVO_ROUTER_WEBHOOK_SECRET) {
    headers["X-Automation-Webhook-Token"] = process.env.ROVO_ROUTER_WEBHOOK_SECRET;
  }

  const response = await fetch(webhookUrl, {
    method: "POST",
    headers,
    body: JSON.stringify({ requestId: routingRequestId, callbackUrl, ...(process.env.CALLBACK_SHARED_SECRET && { callbackSecret: process.env.CALLBACK_SHARED_SECRET }), [inputField]: prompt }),
  });

  if (!response.ok) {
    resolveRouteCallback(routingRequestId, null);
    const text = await response.text();
    logger.error("router_rovo_call_failed", { routingRequestId, status: response.status, errorType: "http_error" });
    throw new Error(`Router webhook call failed: ${response.status} ${text}`);
  }

  const rawResult = await decisionPromise;
  const rawId = String(rawResult || "").trim().toLowerCase();

  const match = routable.find((a) => a.id.toLowerCase() === rawId);
  logger.info("router_decision", { routingRequestId, matchedAgentId: match ? match.id : null });
  return { agentId: match ? match.id : null };
}
