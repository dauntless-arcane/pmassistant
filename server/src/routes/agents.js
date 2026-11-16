import { Router } from "express";
import registry from "../registry.json" with { type: "json" };

const router = Router();

// Exposes the registry to the UI's agent picker — id/name/description only,
// never automationWebhookUrl/secret.
router.get("/agents", (req, res) => {
  const agents = registry.map((a) => ({
    id: a.id,
    name: a.name,
    description: a.description,
    fallback: Boolean(a.fallback),
  }));
  res.json({ agents });
});

export default router;
