import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import cron from "node-cron";
import { query } from "./db.js";
import { buildRangePayloadFromSession, getWfoSession } from "./wfo/session.js";
import { syncWfoInteractionRecordingsRange } from "./wfo/sync.js";
import { dayRangeIso, prefetchMediaJob } from "./routes/wfo.js";
import { pushBackupDayChanges } from "./backup/push.js";
import { ensureSchema as ensureAnalysisSchema, transcribeRangeJob } from "./routes/analysis.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const storageDir = path.join(__dirname, "..", "storage");
const stateFilePath = path.join(storageDir, "automation-state.json");

let automationState = null;
let schedulerHandle = null;
let currentRunPromise = null;

function nowIso() {
  return new Date().toISOString();
}

function getAutomationConfig() {
  return {
    enabled: String(process.env.ENABLE_AUTOMATION || "true").toLowerCase() !== "false",
    cron: process.env.AUTOMATION_CRON || "0 * * * *",
    timezone: process.env.AUTOMATION_TIMEZONE || process.env.BACKUP_TIMEZONE || "America/Bogota",
    backfillDaysPerRun: Math.max(1, Number(process.env.AUTOMATION_BACKFILL_DAYS_PER_RUN || 2)),
    syncMaxPages: Math.max(1, Number(process.env.AUTOMATION_SYNC_MAX_PAGES || 20)),
    syncStartPage: Math.max(1, Number(process.env.AUTOMATION_SYNC_START_PAGE || 1)),
    syncOrder: String(process.env.AUTOMATION_SYNC_ORDER || "asc").toLowerCase() === "desc" ? "desc" : "asc",
    prefetchMaxCalls: Number(process.env.AUTOMATION_PREFETCH_MAX_CALLS || 0) || null,
    transcribeMaxCalls: Number(process.env.AUTOMATION_TRANSCRIBE_MAX_CALLS || 0) || null,
    uploadBackup: String(process.env.AUTOMATION_UPLOAD_BACKUP || "true").toLowerCase() !== "false",
    runOnStartup: String(process.env.AUTOMATION_RUN_ON_STARTUP || "true").toLowerCase() !== "false"
  };
}

function createDefaultState() {
  const config = getAutomationConfig();
  return {
    enabled: config.enabled,
    cron: config.cron,
    timezone: config.timezone,
    running: false,
    currentTask: null,
    lastRun: null,
    recentRuns: [],
    days: {},
    monthStats: [],
    backfill: {
      currentMonth: formatMonthKey(new Date(), config.timezone),
      pendingDates: [],
      processedDates: []
    },
    updatedAt: nowIso()
  };
}

function loadStateFromDisk() {
  if (automationState) return automationState;
  try {
    if (!fs.existsSync(stateFilePath)) {
      automationState = createDefaultState();
      return automationState;
    }
    const raw = fs.readFileSync(stateFilePath, "utf8");
    const parsed = JSON.parse(raw);
    automationState = {
      ...createDefaultState(),
      ...(parsed || {}),
      currentTask: parsed?.currentTask || null,
      lastRun: parsed?.lastRun || null,
      recentRuns: Array.isArray(parsed?.recentRuns) ? parsed.recentRuns.slice(0, 12) : [],
      days: parsed?.days && typeof parsed.days === "object" ? parsed.days : {},
      monthStats: Array.isArray(parsed?.monthStats) ? parsed.monthStats : []
    };
    return automationState;
  } catch (error) {
    console.error("automation_state_load_failed", error?.message || error);
    automationState = createDefaultState();
    return automationState;
  }
}

function persistState() {
  const state = loadStateFromDisk();
  try {
    fs.mkdirSync(storageDir, { recursive: true });
    fs.writeFileSync(stateFilePath, JSON.stringify(state, null, 2), "utf8");
  } catch (error) {
    console.error("automation_state_persist_failed", error?.message || error);
  }
}

function updateState(mutator) {
  const state = loadStateFromDisk();
  mutator(state);
  state.enabled = getAutomationConfig().enabled;
  state.cron = getAutomationConfig().cron;
  state.timezone = getAutomationConfig().timezone;
  state.updatedAt = nowIso();
  persistState();
  return state;
}

function formatDateKey(date, timeZone) {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  });
  const parts = formatter.formatToParts(date);
  const year = parts.find((item) => item.type === "year")?.value || "0000";
  const month = parts.find((item) => item.type === "month")?.value || "00";
  const day = parts.find((item) => item.type === "day")?.value || "00";
  return `${year}-${month}-${day}`;
}

function formatMonthKey(date, timeZone) {
  return formatDateKey(date, timeZone).slice(0, 7);
}

function buildMonthDates(monthKey) {
  const [year, month] = String(monthKey || "").split("-").map(Number);
  if (!year || !month) return [];
  const dates = [];
  const cursor = new Date(Date.UTC(year, month - 1, 1));
  while (cursor.getUTCMonth() === month - 1) {
    dates.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return dates;
}

function compactRecentRuns(list) {
  return list.slice(0, 12);
}

function summarizeDayStatus(dayState) {
  if (!dayState) return "pending";
  if (dayState.backup?.status === "failed" || dayState.transcribe?.status === "failed" || dayState.prefetch?.status === "failed" || dayState.sync?.status === "failed") {
    return "attention";
  }
  if (dayState.backup?.status === "succeeded" && dayState.transcribe?.status === "succeeded" && dayState.prefetch?.status === "succeeded" && dayState.sync?.status === "succeeded") {
    return "complete";
  }
  if (dayState.transcribe?.status === "succeeded" && dayState.sync?.status === "succeeded") {
    return "partial";
  }
  return "pending";
}

function upsertDayState(date, patch) {
  updateState((state) => {
    const current = state.days?.[date] || {};
    state.days[date] = {
      ...current,
      ...patch,
      sync: { ...(current.sync || {}), ...(patch.sync || {}) },
      prefetch: { ...(current.prefetch || {}), ...(patch.prefetch || {}) },
      transcribe: { ...(current.transcribe || {}), ...(patch.transcribe || {}) },
      backup: { ...(current.backup || {}), ...(patch.backup || {}) },
      lastUpdatedAt: nowIso()
    };
  });
}

function setCurrentTask(task) {
  updateState((state) => {
    state.currentTask = task
      ? {
          ...task,
          updatedAt: nowIso()
        }
      : null;
    state.running = Boolean(task);
  });
}

function updateCurrentTask(mutator) {
  updateState((state) => {
    if (!state.currentTask) return;
    mutator(state.currentTask);
    state.currentTask.updatedAt = nowIso();
    state.running = true;
  });
}

async function fetchMonthStats(requestedMonthKey = null) {
  await ensureAnalysisSchema();
  const config = getAutomationConfig();
  const today = formatDateKey(new Date(), config.timezone);
  const monthKey = requestedMonthKey || today.slice(0, 7);
  const monthStart = `${monthKey}-01`;
  
  // If requesting current month, include only dates up to today
  // If requesting past/future month, include all dates in that month
  const monthEnd = monthKey === today.slice(0, 7) ? today : buildMonthDates(monthKey).pop() || today;
  
  const tzOffset = process.env.BACKUP_TZ_OFFSET || "-05:00";
  const rangeFrom = new Date(`${monthStart}T00:00:00.000${tzOffset}`).toISOString();
  const rangeTo = new Date(`${monthEnd}T23:59:59.999${tzOffset}`).toISOString();
  const result = await query(
    `
    SELECT
      ((c.start_time AT TIME ZONE $1)::date)::text AS day,
      COUNT(*)::int AS total_calls,
      COUNT(*) FILTER (
        WHERE c.local_audio_path IS NOT NULL OR c.local_audio_purged_at IS NOT NULL
      )::int AS audio_processed,
      COUNT(*) FILTER (
        WHERE c.local_audio_path IS NOT NULL AND c.local_audio_purged_at IS NULL
      )::int AS audio_local,
      COUNT(*) FILTER (
        WHERE c.local_screen_path IS NOT NULL
      )::int AS screen_local,
      COUNT(CASE WHEN ca.call_id IS NOT NULL THEN 1 END)::int AS transcript_count
    FROM calls c
    LEFT JOIN call_analysis ca ON ca.call_id = c.call_id
    WHERE c.start_time >= $2 AND c.start_time <= $3
    GROUP BY 1
    ORDER BY 1 ASC
    `,
    [config.timezone, rangeFrom, rangeTo]
  );

  const statsMap = new Map((result.rows || []).map((row) => [row.day, row]));
  const days = buildMonthDates(monthKey)
    .filter((date) => date <= today)
    .map((date) => {
      const counts = statsMap.get(date) || {};
      const dayState = loadStateFromDisk().days?.[date] || null;
      return {
        date,
        totalCalls: Number(counts.total_calls || 0),
        audioProcessed: Number(counts.audio_processed || 0),
        audioLocal: Number(counts.audio_local || 0),
        screenLocal: Number(counts.screen_local || 0),
        transcriptCount: Number(counts.transcript_count || 0),
        syncStatus: dayState?.sync?.status || "pending",
        prefetchStatus: dayState?.prefetch?.status || "pending",
        transcribeStatus: dayState?.transcribe?.status || "pending",
        backupStatus: dayState?.backup?.status || "pending",
        lastError:
          dayState?.backup?.error ||
          dayState?.transcribe?.error ||
          dayState?.prefetch?.error ||
          dayState?.sync?.error ||
          null,
        status: summarizeDayStatus(dayState)
      };
    });

  updateState((state) => {
    state.monthStats = days;
    state.backfill.currentMonth = monthKey;
  });
  return days;
}

function getIncompleteBackfillDates(monthStats, today) {
  return monthStats
    .filter((day) => day.date < today)
    .filter((day) => !(day.syncStatus === "succeeded" && day.prefetchStatus === "succeeded" && day.transcribeStatus === "succeeded" && (day.backupStatus === "succeeded" || day.backupStatus === "skipped")))
    .map((day) => day.date);
}

function createRunEntry({ reason, status = "running", error = null }) {
  const config = getAutomationConfig();
  return {
    reason,
    status,
    error,
    startedAt: nowIso(),
    finishedAt: null,
    timezone: config.timezone,
    cron: config.cron
  };
}

async function runSyncStep({ date, mode, session }) {
  const config = getAutomationConfig();
  const range = dayRangeIso({ date });
  setCurrentTask({
    type: "automation",
    mode,
    date,
    phase: "sync",
    from: range?.from || null,
    to: range?.to || null,
    sync: { status: "running" },
    prefetchProgress: null,
    transcribeProgress: null
  });
  if (!range || !session) {
    const error = "wfo_session_not_configured";
    upsertDayState(date, {
      sync: { status: "failed", error, updatedAt: nowIso(), mode }
    });
    updateCurrentTask((task) => {
      task.phase = "sync";
      task.sync = { status: "failed", error };
    });
    return { status: "failed", error };
  }

  try {
    const payload = buildRangePayloadFromSession({ from: range.from, to: range.to, order: config.syncOrder });
    const result = await syncWfoInteractionRecordingsRange({
      from: range.from,
      to: range.to,
      order: config.syncOrder,
      maxPages: config.syncMaxPages,
      startPage: config.syncStartPage,
      clientOptions: {
        baseUrl: session.baseUrl,
        method: session.method,
        headers: session.headers,
        payload,
        pageSize: session.pageSize
      }
    });
    upsertDayState(date, {
      sync: { status: "succeeded", result, updatedAt: nowIso(), mode }
    });
    updateCurrentTask((task) => {
      task.sync = { status: "succeeded", result };
    });
    return { status: "succeeded", result };
  } catch (error) {
    const message = String(error?.message || "wfo_sync_range_failed");
    upsertDayState(date, {
      sync: { status: "failed", error: message, updatedAt: nowIso(), mode }
    });
    updateCurrentTask((task) => {
      task.sync = { status: "failed", error: message };
    });
    return { status: "failed", error: message };
  }
}

async function runPrefetchStep({ date, mode, session }) {
  updateCurrentTask((task) => {
    task.phase = "prefetch";
    task.prefetchProgress = { date, total: 0, done: 0 };
  });
  if (!session) {
    const error = "wfo_session_not_configured";
    upsertDayState(date, {
      prefetch: { status: "failed", error, updatedAt: nowIso(), mode }
    });
    updateCurrentTask((task) => {
      task.phase = "prefetch";
      task.prefetchProgress = { date, failed: 0, errorCounts: { [error]: 1 }, lastError: { error } };
    });
    return { status: "failed", error };
  }

  updateCurrentTask((task) => {
    task.phase = "prefetch";
    task.prefetchProgress = { date, total: 0, done: 0 };
  });

  try {
    const result = await prefetchMediaJob({
      date,
      maxCalls: getAutomationConfig().prefetchMaxCalls,
      offset: 0,
      catalog: "ONLINE_DB",
      session,
      report: (progress) => {
        updateCurrentTask((task) => {
          task.phase = "prefetch";
          task.prefetchProgress = progress;
        });
      }
    });
    upsertDayState(date, {
      prefetch: { status: "succeeded", result, updatedAt: nowIso(), mode }
    });
    return { status: "succeeded", result };
  } catch (error) {
    const message = String(error?.message || "prefetch_failed");
    upsertDayState(date, {
      prefetch: { status: "failed", error: message, updatedAt: nowIso(), mode }
    });
    updateCurrentTask((task) => {
      task.phase = "prefetch";
      task.prefetchProgress = {
        ...(task.prefetchProgress || {}),
        lastError: { error: message }
      };
    });
    return { status: "failed", error: message };
  }
}

async function runTranscribeStep({ date, mode }) {
  if (!loadStateFromDisk().currentTask) {
    setCurrentTask({
      type: "automation",
      mode,
      date,
      phase: "transcribe",
      sync: null,
      prefetchProgress: null,
      transcribeProgress: { date, total: 0, done: 0 }
    });
  } else {
    updateCurrentTask((task) => {
      task.phase = "transcribe";
      task.transcribeProgress = { date, total: 0, done: 0 };
    });
  }

  try {
    const result = await transcribeRangeJob({
      date,
      maxCalls: getAutomationConfig().transcribeMaxCalls,
      offset: 0,
      force: false,
      report: (progress) => {
        updateCurrentTask((task) => {
          task.phase = "transcribe";
          task.transcribeProgress = progress;
        });
      }
    });
    upsertDayState(date, {
      transcribe: { status: "succeeded", result, updatedAt: nowIso(), mode }
    });
    return { status: "succeeded", result };
  } catch (error) {
    const message = String(error?.message || "transcribe_failed");
    upsertDayState(date, {
      transcribe: { status: "failed", error: message, updatedAt: nowIso(), mode }
    });
    updateCurrentTask((task) => {
      task.phase = "transcribe";
      task.transcribeProgress = {
        ...(task.transcribeProgress || {}),
        lastError: { error: message }
      };
    });
    return { status: "failed", error: message };
  }
}

async function runBackupStep({ date, mode }) {
  if (!getAutomationConfig().uploadBackup || !process.env.BACKUP_ENDPOINT) {
    upsertDayState(date, {
      backup: { status: "skipped", error: null, updatedAt: nowIso(), mode }
    });
    updateCurrentTask((task) => {
      task.phase = "backup";
      task.backup = { status: "skipped" };
    });
    return { status: "skipped" };
  }

  updateCurrentTask((task) => {
    task.phase = "backup";
    task.backup = { status: "running" };
  });

  function backupErrorCode(error) {
    const message = String(error?.message || "");
    if (message.includes("ECONNREFUSED")) return "backup_endpoint_unreachable";
    if (message.toLowerCase().includes("timeout")) return "backup_endpoint_timeout";
    if (message.includes("Backup endpoint error:")) return "backup_endpoint_http_error";
    return "backup_push_failed";
  }

  try {
    const result = await pushBackupDayChanges({
      date,
      endpoint: process.env.BACKUP_ENDPOINT,
      pageSize: Number(process.env.BACKUP_PAGE_SIZE || 500)
    });

    upsertDayState(date, {
      backup: { status: "succeeded", result: { ok: true, ...result }, updatedAt: nowIso(), mode }
    });
    updateCurrentTask((task) => {
      task.backup = { status: "succeeded", result: { ok: true, ...result } };
    });
    return { status: "succeeded", result };
  } catch (error) {
    const code = backupErrorCode(error);
    const message = String(error?.message || "backup_push_failed");
    upsertDayState(date, {
      backup: { status: "failed", error: code || message, result: { ok: false, error: code, message }, updatedAt: nowIso(), mode }
    });
    updateCurrentTask((task) => {
      task.backup = { status: "failed", error: code || message };
    });
    return { status: "failed", error: code || message };
  }
}

async function processDay({ date, mode }) {
  const session = getWfoSession();
  await runSyncStep({ date, mode, session });
  await runPrefetchStep({ date, mode, session: getWfoSession() });
  await runTranscribeStep({ date, mode });
  await runBackupStep({ date, mode });
}

async function runAutomationCycle({ reason = "manual" } = {}) {
  if (currentRunPromise) {
    return currentRunPromise;
  }

  currentRunPromise = (async () => {
    const config = getAutomationConfig();
    const run = createRunEntry({ reason });
    updateState((state) => {
      state.running = true;
      state.lastRun = run;
      state.recentRuns = compactRecentRuns([run, ...(state.recentRuns || [])]);
    });

    try {
      const today = formatDateKey(new Date(), config.timezone);
      const monthStats = await fetchMonthStats();
      const pendingDates = getIncompleteBackfillDates(monthStats, today);
      updateState((state) => {
        state.backfill.pendingDates = pendingDates;
        state.backfill.processedDates = [];
      });

      await processDay({ date: today, mode: "hourly" });

      const backfillTargets = pendingDates.slice(0, config.backfillDaysPerRun);
      for (const date of backfillTargets) {
        await processDay({ date, mode: "backfill" });
        updateState((state) => {
          state.backfill.processedDates = [date, ...(state.backfill.processedDates || [])].slice(0, 8);
        });
      }

      const nextStats = await fetchMonthStats();
      const remainingPending = getIncompleteBackfillDates(nextStats, today);
      updateState((state) => {
        state.running = false;
        state.currentTask = null;
        state.backfill.pendingDates = remainingPending;
        state.lastRun = {
          ...run,
          status: "succeeded",
          finishedAt: nowIso()
        };
        state.recentRuns = compactRecentRuns([
          state.lastRun,
          ...(state.recentRuns || []).filter((entry) => entry.startedAt !== run.startedAt)
        ]);
      });
      return loadStateFromDisk().lastRun;
    } catch (error) {
      const message = String(error?.message || "automation_failed");
      updateState((state) => {
        state.running = false;
        state.currentTask = null;
        state.lastRun = {
          ...run,
          status: "failed",
          error: message,
          finishedAt: nowIso()
        };
        state.recentRuns = compactRecentRuns([
          state.lastRun,
          ...(state.recentRuns || []).filter((entry) => entry.startedAt !== run.startedAt)
        ]);
      });
      throw error;
    } finally {
      currentRunPromise = null;
    }
  })();

  return currentRunPromise;
}

export async function getAutomationStatus() {
  const monthStats = await fetchMonthStats();
  const config = getAutomationConfig();
  const today = formatDateKey(new Date(), config.timezone);
  const pendingDates = getIncompleteBackfillDates(monthStats, today);
  updateState((nextState) => {
    nextState.backfill.pendingDates = pendingDates;
  });
  const state = loadStateFromDisk();
  return {
    ...state,
    enabled: config.enabled,
    cron: config.cron,
    timezone: config.timezone,
    running: Boolean(currentRunPromise) || Boolean(state.currentTask),
    monthStats,
    backfill: {
      ...(state.backfill || {}),
      currentMonth: formatMonthKey(new Date(), config.timezone),
      pendingDates
    }
  };
}

export async function runAutomationNow() {
  return runAutomationCycle({ reason: "manual" });
}

export async function getMonthStats(monthKey) {
  if (!monthKey || typeof monthKey !== "string" || !monthKey.match(/^\d{4}-\d{2}$/)) {
    return [];
  }
  return fetchMonthStats(monthKey);
}

export async function startAutomationScheduler() {
  const config = getAutomationConfig();
  loadStateFromDisk();
  await fetchMonthStats().catch(() => null);
  if (!config.enabled || schedulerHandle) return;

  schedulerHandle = cron.schedule(
    config.cron,
    async () => {
      try {
        await runAutomationCycle({ reason: "schedule" });
      } catch (error) {
        console.error("automation_cycle_failed", error?.message || error);
      }
    },
    { timezone: config.timezone }
  );

  if (config.runOnStartup) {
    setTimeout(() => {
      runAutomationCycle({ reason: "startup" }).catch((error) => {
        console.error("automation_startup_failed", error?.message || error);
      });
    }, 3000);
  }
}
