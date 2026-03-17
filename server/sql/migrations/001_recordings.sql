ALTER TABLE calls
  ADD COLUMN IF NOT EXISTS call_session_id TEXT,
  ADD COLUMN IF NOT EXISTS extension TEXT,
  ADD COLUMN IF NOT EXISTS ani TEXT,
  ADD COLUMN IF NOT EXISTS dnis TEXT,
  ADD COLUMN IF NOT EXISTS event_code TEXT,
  ADD COLUMN IF NOT EXISTS event_dir TEXT,
  ADD COLUMN IF NOT EXISTS recording_id TEXT,
  ADD COLUMN IF NOT EXISTS recording_url TEXT;

CREATE INDEX IF NOT EXISTS calls_call_session_id_idx ON calls (call_session_id);
CREATE INDEX IF NOT EXISTS calls_recording_id_idx ON calls (recording_id);

CREATE TABLE IF NOT EXISTS call_recordings (
  id SERIAL PRIMARY KEY,
  recording_id TEXT NOT NULL UNIQUE,
  agent_id TEXT,
  call_session_id TEXT,
  campaign_id TEXT,
  created TIMESTAMPTZ,
  length_ms INTEGER,
  name TEXT,
  number TEXT,
  metadata JSONB,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS call_recordings_call_session_id_idx ON call_recordings (call_session_id);
CREATE INDEX IF NOT EXISTS call_recordings_agent_id_idx ON call_recordings (agent_id);
