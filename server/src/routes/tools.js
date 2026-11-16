import { Router } from "express";
import toolsRegistry from "../toolsRegistry.json" with { type: "json" };

const router = Router();

// Exposes the tools registry to the UI's tools catalogue box.
router.get("/tools", (req, res) => {
  const tools = toolsRegistry.map((t) => ({
    id: t.id,
    name: t.name,
    description: t.description,
    url: t.url,
  }));
  res.json({ tools });
});

export default router;
