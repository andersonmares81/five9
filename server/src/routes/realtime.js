import express from "express";
import { authMiddleware } from "../auth.js";
import { getRealtimeAgents } from "../five9/sync.js";

const router = express.Router();

router.get("/agents", authMiddleware, async (_req, res) => {
  try {
    const data = await getRealtimeAgents();
    return res.json(data);
  } catch (error) {
    console.error("realtime_agents_failed", error.message);
    return res.status(500).json({ error: "realtime_agents_failed" });
  }
});

export default router;
