import { Router } from "express";
import { resolveRouteCallback } from "../router.js";
import { logger } from "../logger.js";

const router = Router();

// The router automation's outgoing webhook action should POST here with:
// { "requestId": "...", "result": "<agentId or 'none'>" }
router.post("/route-callback", (req, res) => {
  const { requestId, result } = req.body || {};

  if (!requestId) {
    logger.warn("route_callback_missing_request_id");
    return res.status(400).json({ error: "Body must include 'requestId'." });
  }

  const resolved = resolveRouteCallback(requestId, result ?? "");
  if (!resolved) {
    logger.warn("route_callback_unknown_request_id", { requestId });
    return res.status(404).json({ error: `Unknown routing requestId: ${requestId}` });
  }

  logger.info("route_callback_processed", { requestId, result });
  return res.status(200).json({ ok: true });
});

export default router;
