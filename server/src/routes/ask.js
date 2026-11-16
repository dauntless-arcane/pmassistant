import { Router } from "express";
import { v4 as uuidv4 } from "uuid";
import { routeRequest } from "../router.js";
import { triggerAgent } from "../adapter/rovoWebhookAdapter.js";
import { createRequest, markError } from "../store.js";
import { logger } from "../logger.js";
import { buildContextualMessage } from "../context.js";
import registry from "../registry.json" with { type: "json" };

const router = Router();

// How many prior turns of the current conversation to carry forward as context.
const MAX_HISTORY_TURNS = 6;

router.post("/ask", async (req, res) => {
  const { message, history, agentId: requestedAgentId } = req.body || {};
  if (!message || typeof message !== "string") {
    logger.warn("ask_invalid_body", { errorType: "invalid_body" });
    return res.status(400).json({ error: "Body must include a non-empty 'message' string." });
  }

  const safeHistory = Array.isArray(history)
    ? history
        .filter((h) => h && typeof h.message === "string" && typeof h.result === "string")
        .slice(-MAX_HISTORY_TURNS)
    : [];

  logger.info("ask_received", { messageLength: message.length, historyTurns: safeHistory.length, requestedAgentId: requestedAgentId || null });

  let agent = null;
  let usedFallback = false;

  if (requestedAgentId) {
    // User picked an agent directly in the UI — skip the router entirely.
    agent = registry.find((a) => a.id === requestedAgentId);
    if (!agent) {
      logger.warn("ask_unknown_agent_id", { requestedAgentId });
      return res.status(400).json({ error: `Unknown agentId: ${requestedAgentId}` });
    }
    logger.info("agent_manually_selected", { agentId: agent.id, agentName: agent.name });
  } else {
    let agentId;
    try {
      const routed = await routeRequest(message, registry, safeHistory);
      agentId = routed.agentId;
    } catch (err) {
      logger.error("routing_failed", { errorType: err.name });
      return res.status(500).json({ error: `Routing failed: ${err.message}` });
    }

    agent = agentId ? registry.find((a) => a.id === agentId) : null;
    usedFallback = !agent;
    if (usedFallback) {
      agent = registry.find((a) => a.fallback);
    }
  }

  if (!agent) {
    logger.info("routing_no_match");
    return res.status(200).json({
      requestId: null,
      agentId: null,
      agentName: null,
      status: "no_match",
      message: "No automation matched this request.",
    });
  }

  const requestId = uuidv4();
  createRequest(requestId, { agentId: agent.id, agentName: agent.name, message });
  logger.info(usedFallback ? "fallback_agent_used" : "request_created", {
    requestId,
    agentId: agent.id,
    agentName: agent.name,
  });

  const publicBase = (process.env.PUBLIC_CALLBACK_BASE_URL || `http://localhost:${process.env.PORT || 4000}`).replace(/\/+$/, "");
  const callbackUrl = `${publicBase}/api/callback`;

  const contextualMessage = buildContextualMessage(safeHistory, message);

  try {
    await triggerAgent(agent, { requestId, message: contextualMessage, callbackUrl });
    logger.info("agent_triggered", { requestId, agentId: agent.id });
  } catch (err) {
    logger.error("agent_trigger_failed", { requestId, agentId: agent.id, errorType: err.name });
    markError(requestId, err.message);
    return res.status(502).json({ error: err.message, requestId });
  }

  return res.status(202).json({
    requestId,
    agentId: agent.id,
    agentName: agent.name,
    status: "pending",
  });
});

export default router;
