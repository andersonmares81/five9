import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import { query } from "../src/db.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.join(__dirname, "..", ".env") });

const directionSql = `
  CASE
    WHEN metadata->>'CALL_DIRECTION' ILIKE 'O' THEN 'Outbound'
    WHEN metadata->>'CALL_DIRECTION' ILIKE 'I' THEN 'Inbound'
    WHEN NULLIF(metadata->>'CALL_DIRECTION', '') IS NULL THEN NULL
    ELSE metadata->>'CALL_DIRECTION'
  END
`;

async function run() {
  const result = await query(
    `
    UPDATE calls
    SET
      agent_first_name = COALESCE(NULLIF(agent_first_name, ''), NULLIF(metadata->>'AGENT_FNAME', '')),
      agent_last_name = COALESCE(NULLIF(agent_last_name, ''), NULLIF(metadata->>'AGENT_LNAME', '')),
      result_code = COALESCE(NULLIF(result_code, ''), NULLIF(metadata->>'RESULT_CODE', ''), NULLIF(metadata->>'EVENT_CODE', '')),
      screen_capture_type = COALESCE(NULLIF(screen_capture_type, ''), NULLIF(metadata->>'SCAP_TYPE', '')),
      event_dir = COALESCE(${directionSql}, event_dir),
      duration_sec = CASE
        WHEN duration_sec IS NOT NULL THEN duration_sec
        WHEN (metadata->>'CALL_DURATION') ~ '^[0-9]+$' THEN (metadata->>'CALL_DURATION')::int
        ELSE duration_sec
      END,
      updated_at = now()
    WHERE metadata IS NOT NULL
    `
  );

  console.log(`wfo_backfill_updated=${result.rowCount}`);
}

run().catch((error) => {
  console.error("wfo_backfill_failed", error.message);
  process.exit(1);
});
