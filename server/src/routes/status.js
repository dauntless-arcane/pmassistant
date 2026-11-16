import { Router } from "express";
import { getRequest } from "../store.js";
import { logger } from "../logger.js";

const router = Router();

router.get("/status/:requestId", (req, res) => {
  const entry = getRequest(req.params.requestId);
  if (!entry) {
    logger.warn("status_not_found", { requestId: req.params.requestId });
    return res.status(404).json({ error: "Unknown requestId" });
  }
  try {
    logger.info("status_queried", { requestId: entry.requestId, status: entry.status });
    return res.status(200).json(entry);
  } catch (e) {
    logger.error("status_serialize_failed", { requestId: entry.requestId, errorType: e.name });
    return res.status(200).json({ ...entry, result: "[result contained non-serializable characters]" });
  }
});

export default router;
