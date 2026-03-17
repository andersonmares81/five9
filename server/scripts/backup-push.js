import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import { pushBackupRange } from "../src/backup/push.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.join(__dirname, "..", ".env") });

const [fromArg, toArg] = process.argv.slice(2);
const tzOffset = process.env.BACKUP_TZ_OFFSET || "-05:00";
const pageSize = Number(process.env.BACKUP_PAGE_SIZE || 500);
const endpoint = process.env.BACKUP_ENDPOINT;

function addDays(dateStr, days) {
  const [year, month, day] = dateStr.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day + days));
  return date.toISOString().slice(0, 10);
}

function toRange(dateStr) {
  const from = new Date(`${dateStr}T00:00:00${tzOffset}`).toISOString();
  const to = new Date(`${dateStr}T23:59:59.999${tzOffset}`).toISOString();
  return { from, to };
}

async function run() {
  const today = new Date();
  const todayStr = today.toISOString().slice(0, 10);
  const startDate = fromArg || process.env.BACKUP_FROM_DATE || todayStr;
  const endDate = toArg || process.env.BACKUP_TO_DATE || startDate;

  let dateCursor = startDate;
  let total = 0;

  while (dateCursor <= endDate) {
    const { from, to } = toRange(dateCursor);
    const pushed = await pushBackupRange({ from, to, endpoint, pageSize });
    total += pushed;
    console.log(`backup_day=${dateCursor} pushed=${pushed}`);
    if (dateCursor === endDate) break;
    dateCursor = addDays(dateCursor, 1);
  }

  console.log(`backup_total=${total}`);
}

run().catch((error) => {
  console.error("backup_failed", error.message);
  process.exit(1);
});
