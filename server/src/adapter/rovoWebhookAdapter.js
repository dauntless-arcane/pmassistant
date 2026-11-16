import fetch from "node-fetch";
import { logger } from "../logger.js";

/**
 * Fires the Automation rule's incoming webhook for a given agent.
 * The automation rule is expected to:
 *   1. Trigger on this incoming webhook
 *   2. Run the Rovo agent, passing through webhookData.body[agent.inputField]
 *   3. Send an outgoing webhook back to this server's /api/callback
 *      with { requestId, result } in the body
 *
 * This function only fires the trigger — it does not wait for a result.
 * The result arrives later via the callback route.
 */
export async function triggerAgent(agent, { requestId, message, callbackUrl }) {
  if (!agent.automationWebhookUrl || agent.automationWebhookUrl.includes("REPLACE_WITH")) {
    throw new Error(
      `Agent "${agent.id}" has no real automationWebhookUrl configured yet in registry.json`
    );
  }

  const body = {
    requestId,
    callbackUrl,
    ...(process.env.CALLBACK_SHARED_SECRET && { callbackSecret: process.env.CALLBACK_SHARED_SECRET }),
    [agent.inputField]: message,
  };

  const headers = { "Content-Type": "application/json" };
  if (agent.secret) {
    headers["X-Automation-Webhook-Token"] = agent.secret;
  }

  logger.info("webhook_request", { requestId, agentId: agent.id });

  const response = await fetch(agent.automationWebhookUrl, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const text = await response.text();
    logger.error("webhook_failed", { requestId, agentId: agent.id, status: response.status, errorType: "http_error" });
    throw new Error(`Failed to trigger automation for "${agent.id}": ${response.status} ${text}`);
  }

  logger.info("webhook_success", { requestId, agentId: agent.id, status: response.status });
}
