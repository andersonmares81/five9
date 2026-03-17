import express from "express";
import { authMiddleware } from "../auth.js";
import { getAutomationStatus, runAutomationNow, getMonthStats } from "../automation.js";

const router = express.Router();

function safeBackupEndpointHost(endpoint) {
  if (!endpoint) return null;
  try {
    const url = new URL(endpoint);
    return url.host || null;
  } catch {
    return null;
  }
}

router.get("/info", authMiddleware, (_req, res) => {
  const backupEndpoint = process.env.BACKUP_ENDPOINT || "";
  const backupEndpointHost = safeBackupEndpointHost(backupEndpoint);

  return res.json({
    service: {
      port: process.env.PORT ? Number(process.env.PORT) : 3001,
      nodeEnv: process.env.NODE_ENV || "production",
      serveWebDist: process.env.SERVE_WEB_DIST === "true",
      uptimeSec: Math.round(process.uptime())
    },
    auth: {
      mode: process.env.AUTH_MODE || "jwt"
    },
    reports: {
      timezone: process.env.REPORTS_TIMEZONE || process.env.BACKUP_TIMEZONE || "America/Bogota"
    },
    backup: {
      enabled: process.env.BACKUP_ENABLED === "true",
      endpointConfigured: Boolean(backupEndpoint),
      endpointHost: backupEndpointHost
    },
    media: {
      storageDir: process.env.MEDIA_STORAGE_DIR || "server/storage/media",
      deleteAudioAfterTranscribe: String(process.env.DELETE_AUDIO_AFTER_TRANSCRIBE || "true").toLowerCase() !== "false"
    },
    scheduler: {
      enabled: process.env.ENABLE_SCHEDULER === "true"
    },
    automation: {
      enabled: String(process.env.ENABLE_AUTOMATION || "true").toLowerCase() !== "false",
      cron: process.env.AUTOMATION_CRON || "0 * * * *",
      timezone: process.env.AUTOMATION_TIMEZONE || process.env.BACKUP_TIMEZONE || "America/Bogota"
    }
  });
});

router.get("/automation", authMiddleware, async (_req, res) => {
  try {
    const status = await getAutomationStatus();
    return res.json(status);
  } catch (error) {
    console.error("automation_status_failed", error.message);
    return res.status(500).json({ error: "automation_status_failed" });
  }
});

router.get("/automation/month/:monthKey", authMiddleware, async (req, res) => {
  try {
    const { monthKey } = req.params;
    const stats = await getMonthStats(monthKey);
    return res.json({ monthStats: stats });
  } catch (error) {
    console.error("month_stats_failed", error.message);
    return res.status(500).json({ error: "month_stats_failed" });
  }
});

router.post("/automation/run-now", authMiddleware, async (_req, res) => {
  try {
    const run = await runAutomationNow();
    return res.json({ ok: true, run });
  } catch (error) {
    console.error("automation_run_failed", error.message);
    return res.status(500).json({ error: "automation_run_failed", detail: String(error?.message || "automation_run_failed") });
  }
});

export default router;
