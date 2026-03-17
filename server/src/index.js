import express from "express";
import dotenv from "dotenv";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import cron from "node-cron";
import authRoutes from "./routes/auth.js";
import reportsRoutes from "./routes/reports.js";
import realtimeRoutes from "./routes/realtime.js";
import adminRoutes from "./routes/admin.js";
import recordingsRoutes from "./routes/recordings.js";
import wfoRoutes from "./routes/wfo.js";
import systemRoutes from "./routes/system.js";
import analysisRoutes from "./routes/analysis.js";
import backupRoutes from "./routes/backup.js";
import { refreshAggregates, syncCalls, syncRecordings } from "./five9/sync.js";
import { syncWfoInteractionRecordings } from "./wfo/sync.js";
import { pushBackupRange } from "./backup/push.js";
import { ensureMediaStorageSchema } from "./media/storage.js";
import { startAutomationScheduler } from "./automation.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.join(__dirname, "..", ".env") });

const app = express();
app.use(express.json({ limit: process.env.JSON_BODY_LIMIT || "10mb" }));

app.get("/api/health", (_req, res) => res.json({ ok: true }));
app.use("/api/auth", authRoutes);
app.use("/api/reports", reportsRoutes);
app.use("/api/realtime", realtimeRoutes);
app.use("/api/admin", adminRoutes);
app.use("/api/recordings", recordingsRoutes);
app.use("/api/wfo", wfoRoutes);
app.use("/api/system", systemRoutes);
app.use("/api/analysis", analysisRoutes);
app.use("/api/backup", backupRoutes);

const webDistPath = path.join(__dirname, "..", "..", "web", "dist");
if (process.env.SERVE_WEB_DIST === "true" && fs.existsSync(webDistPath)) {
  app.use(express.static(webDistPath));
  app.get(/^\/(?!api\/).*/, (_req, res) => {
    res.sendFile(path.join(webDistPath, "index.html"));
  });
}

const port = process.env.PORT ? Number(process.env.PORT) : 3001;

async function start() {
  await ensureMediaStorageSchema();
  await startAutomationScheduler();

  app.listen(port, () => {
    if (process.env.ENABLE_SCHEDULER === "true") {
      const cronExpr = process.env.SYNC_CRON || "*/15 * * * *";
      cron.schedule(cronExpr, async () => {
        try {
          const { from, to } = defaultSyncWindow();
          await syncCalls({ from, to });
          await syncRecordings();
          if (process.env.WFO_ENABLED === "true") {
            await syncWfoInteractionRecordings({ pageNumber: 1 });
          }
          await refreshAggregates({ from, to });
        } catch (error) {
          console.error("sync_failed", error.message);
        }
      });
    }

    if (process.env.BACKUP_ENABLED === "true") {
      const backupCron = process.env.BACKUP_CRON || "0 19 * * *";
      const backupTimezone = process.env.BACKUP_TIMEZONE || "America/Bogota";
      cron.schedule(
        backupCron,
        async () => {
          try {
            const { from, to } = dailyBackupWindow();
            await pushBackupRange({
              from,
              to,
              endpoint: process.env.BACKUP_ENDPOINT,
              pageSize: Number(process.env.BACKUP_PAGE_SIZE || 500)
            });
          } catch (error) {
            console.error("backup_failed", error.message);
          }
        },
        { timezone: backupTimezone }
      );
    }
    console.log(`server_listening:${port}`);
  });
}

start().catch((error) => {
  console.error("server_start_failed", error.message);
  process.exit(1);
});

function defaultSyncWindow() {
  const now = new Date();
  const from = new Date(now.getTime() - 1000 * 60 * 60 * 24).toISOString();
  const to = now.toISOString();
  return { from, to };
}

function dailyBackupWindow() {
  const now = new Date();
  const tzOffset = process.env.BACKUP_TZ_OFFSET || "-05:00";
  const today = now.toISOString().slice(0, 10);
  const from = new Date(`${today}T00:00:00${tzOffset}`).toISOString();
  const to = new Date(`${today}T23:59:59.999${tzOffset}`).toISOString();
  return { from, to };
}
