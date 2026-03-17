import { randomUUID } from "crypto";

const jobs = new Map();

function nowIso() {
  return new Date().toISOString();
}

function pruneJobs() {
  const maxJobs = Number(process.env.JOBS_MAX || 200);
  if (jobs.size <= maxJobs) return;
  const entries = Array.from(jobs.values()).sort((a, b) => (a.createdAt || "").localeCompare(b.createdAt || ""));
  const removeCount = Math.max(0, entries.length - maxJobs);
  for (let i = 0; i < removeCount; i += 1) {
    jobs.delete(entries[i].id);
  }
}

export function createJob({ type, payload = null, run }) {
  pruneJobs();
  const id = randomUUID();
  const job = {
    id,
    type,
    status: "running",
    payload,
    progress: {},
    result: null,
    error: null,
    createdAt: nowIso(),
    updatedAt: nowIso(),
    finishedAt: null
  };

  jobs.set(id, job);

  const report = (progressPatch) => {
    if (!jobs.has(id)) return;
    job.progress = { ...(job.progress || {}), ...(progressPatch || {}) };
    job.updatedAt = nowIso();
  };

  (async () => {
    try {
      const result = await run({ report });
      job.result = result ?? null;
      job.status = "succeeded";
      job.updatedAt = nowIso();
      job.finishedAt = nowIso();
    } catch (error) {
      job.status = "failed";
      job.error = String(error?.message || "job_failed");
      job.updatedAt = nowIso();
      job.finishedAt = nowIso();
    }
  })();

  return job;
}

export function getJob(jobId) {
  if (!jobId) return null;
  return jobs.get(String(jobId)) || null;
}

