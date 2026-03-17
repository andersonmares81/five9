import express from "express";
import { authMiddleware } from "../auth.js";
import { createFive9Client } from "../five9/client.js";

const router = express.Router();
const five9 = createFive9Client();

router.get("/:agentId/:recordingId", authMiddleware, async (req, res) => {
  const { agentId, recordingId } = req.params;
  try {
    const response = await five9.stream(`/agents/${agentId}/recordings/${recordingId}`, {
      context: "str"
    });

    const contentType = response.headers?.["content-type"] || "application/octet-stream";
    res.setHeader("Content-Type", contentType);
    if (response.headers?.["content-length"]) {
      res.setHeader("Content-Length", response.headers["content-length"]);
    }
    return response.data.pipe(res);
  } catch (error) {
    console.error("recording_stream_failed", error.message);
    return res.status(502).json({ error: "recording_stream_failed" });
  }
});

export default router;
