import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const storageDir = path.join(__dirname, "..", "..", "storage");
const statePath = path.join(storageDir, "backup-state.json");

function nowIso() {
  return new Date().toISOString();
}

function defaultState() {
  return {
    version: 1,
    days: {},
    updatedAt: nowIso()
  };
}

function safeReadJson(filePath) {
  try {
    if (!fs.existsSync(filePath)) return null;
    const raw = fs.readFileSync(filePath, "utf8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function atomicWriteJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(value, null, 2), "utf8");
  fs.renameSync(tmpPath, filePath);
}

export function loadBackupState() {
  const parsed = safeReadJson(statePath);
  if (!parsed || typeof parsed !== "object") return defaultState();
  return {
    ...defaultState(),
    ...parsed,
    days: parsed.days && typeof parsed.days === "object" ? parsed.days : {}
  };
}

export function getDayBackupCursor(date) {
  const state = loadBackupState();
  const cursor = state.days?.[date] || null;
  const changedAt = cursor?.changedAt ? String(cursor.changedAt) : null;
  const callId = cursor?.callId ? String(cursor.callId) : null;
  return {
    changedAt,
    callId
  };
}

export function setDayBackupCursor(date, cursor) {
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(String(date))) return;
  const state = loadBackupState();
  state.days = state.days && typeof state.days === "object" ? state.days : {};
  state.days[date] = {
    changedAt: cursor?.changedAt ? String(cursor.changedAt) : null,
    callId: cursor?.callId ? String(cursor.callId) : null
  };
  state.updatedAt = nowIso();
  atomicWriteJson(statePath, state);
}

