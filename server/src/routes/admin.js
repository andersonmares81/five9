import express from "express";
import { authMiddleware } from "../auth.js";
import { refreshAggregates, syncCalls, syncRecordings } from "../five9/sync.js";
import { syncWfoInteractionRecordings } from "../wfo/sync.js";
import { clearWfoSession, getWfoSession } from "../wfo/session.js";

const router = express.Router();

function isUnauthorized(error) {
  return error?.response?.status === 401;
}

router.post("/five9/sync", authMiddleware, async (req, res) => {
  try {
    const { from, to, agentId, campaignId } = req.body || {};
    const result = await syncCalls({ from, to, agentId, campaignId });
    const recordings = await syncRecordings();
    await refreshAggregates({ from, to });
    return res.json({ calls: result, recordings });
  } catch (error) {
    console.error("admin_five9_sync_failed", error.message);
    return res.status(500).json({ error: "admin_five9_sync_failed" });
  }
});

router.post("/wfo/sync", authMiddleware, async (req, res) => {
  try {
    const pageNumber = Number(req.body?.pageNumber || 1);
    const session = getWfoSession();
    if (!session) return res.status(400).json({ error: "wfo_session_not_configured" });

    const result = await syncWfoInteractionRecordings({
      pageNumber,
      clientOptions: {
        baseUrl: session.baseUrl,
        method: session.method,
        headers: session.headers,
        payload: session.payload,
        pageSize: session.pageSize
      }
    });
    return res.json(result);
  } catch (error) {
    console.error("admin_wfo_sync_failed", error.message);
    if (isUnauthorized(error)) {
      clearWfoSession();
      return res.status(401).json({ error: "wfo_session_expired" });
    }
    return res.status(500).json({ error: "admin_wfo_sync_failed" });
  }
});

export default router;
