import express from "express";
import { authMiddleware } from "../auth.js";
import { createJob, getJob } from "../jobs.js";
import { pushBackupDayChanges, pushBackupRange } from "../backup/push.js";
import { query } from "../db.js";

const router = express.Router();

function toRangeBoundary(value, endOfDay = false) {
  if (!value) return null;
  const stringValue = String(value).trim();
  if (!stringValue) return null;

  if (/^\d{4}-\d{2}-\d{2}$/.test(stringValue)) {
    const tzOffset = process.env.BACKUP_TZ_OFFSET || "-05:00";
    const time = endOfDay ? "23:59:59.999" : "00:00:00.000";
    const date = new Date(`${stringValue}T${time}${tzOffset}`);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }

  const date = new Date(stringValue);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

async function discoverAllCallsWindow() {
  const result = await query(
    `
    SELECT
      MIN(start_time) AS min_start_time,
      MAX(start_time) AS max_start_time,
      COUNT(*)::int AS total
    FROM calls
    `
  );
  const row = result.rows?.[0] || null;
  if (!row?.min_start_time || !row?.max_start_time) {
    return null;
  }
  return {
    from: new Date(row.min_start_time).toISOString(),
    to: new Date(row.max_start_time).toISOString(),
    total: Number(row.total || 0)
  };
}

router.post("/push-range", authMiddleware, async (req, res) => {
  try {
    const endpoint = process.env.BACKUP_ENDPOINT || "";
    if (!endpoint) {
      return res.status(400).json({ error: "backup_endpoint_not_configured" });
    }

    const { from, to, pageSize, useAll = false } = req.body || {};
    let rangeFrom = toRangeBoundary(from, false);
    let rangeTo = toRangeBoundary(to, true);

    if (useAll || (!rangeFrom && !rangeTo)) {
      const discovered = await discoverAllCallsWindow();
      if (!discovered) {
        return res.status(400).json({ error: "no_calls_available" });
      }
      rangeFrom = discovered.from;
      rangeTo = discovered.to;
    }

    if (!rangeFrom || !rangeTo) {
      return res.status(400).json({ error: "invalid_date_range" });
    }

    const job = createJob({
      type: "backup_push_range",
      payload: {
        from: rangeFrom,
        to: rangeTo
      },
      run: async ({ report }) => {
        const pushed = await pushBackupRange({
          from: rangeFrom,
          to: rangeTo,
          endpoint,
          pageSize: Number(pageSize || process.env.BACKUP_PAGE_SIZE || 500),
          report
        });

        return {
          pushed,
          from: rangeFrom,
          to: rangeTo,
          endpointHost: (() => {
            try {
              return new URL(endpoint).host;
            } catch {
              return null;
            }
          })()
        };
      }
    });

    return res.json({
      jobId: job.id,
      job
    });
  } catch (error) {
    console.error("backup_push_range_failed", error.message);
    return res.status(500).json({ error: "backup_push_range_failed" });
  }
});

router.post("/push-day", authMiddleware, async (req, res) => {
  try {
    const endpoint = process.env.BACKUP_ENDPOINT || "";
    if (!endpoint) {
      return res.status(400).json({ error: "backup_endpoint_not_configured" });
    }

    const { date, pageSize } = req.body || {};
    const dateValue = String(date || "").trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateValue)) {
      return res.status(400).json({ error: "invalid_date" });
    }

    const job = createJob({
      type: "backup_push_day",
      payload: { date: dateValue },
      run: async ({ report }) => {
        const result = await pushBackupDayChanges({
          date: dateValue,
          endpoint,
          pageSize: Number(pageSize || process.env.BACKUP_PAGE_SIZE || 500),
          report
        });
        return {
          ...result,
          endpointHost: (() => {
            try {
              return new URL(endpoint).host;
            } catch {
              return null;
            }
          })()
        };
      }
    });

    return res.json({ jobId: job.id, job });
  } catch (error) {
    console.error("backup_push_day_failed", error.message);
    return res.status(500).json({ error: "backup_push_day_failed" });
  }
});

router.get("/jobs/:jobId", authMiddleware, (req, res) => {
  const job = getJob(req.params.jobId);
  if (!job || (job.type !== "backup_push_range" && job.type !== "backup_push_day")) {
    return res.status(404).json({ error: "job_not_found" });
  }
  return res.json(job);
});

export default router;
