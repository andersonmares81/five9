CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS calls (
  id SERIAL PRIMARY KEY,
  call_id TEXT NOT NULL UNIQUE,
  agent_id TEXT,
  agent_name TEXT,
  agent_first_name TEXT,
  agent_last_name TEXT,
  campaign_id TEXT,
  campaign_name TEXT,
  call_session_id TEXT,
  extension TEXT,
  ani TEXT,
  dnis TEXT,
  result_code TEXT,
  screen_capture_type TEXT,
  event_code TEXT,
  event_dir TEXT,
  recording_id TEXT,
  recording_url TEXT,
  start_time TIMESTAMPTZ,
  end_time TIMESTAMPTZ,
  duration_sec INTEGER,
  direction TEXT,
  status TEXT,
  metadata JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS calls_start_time_idx ON calls (start_time DESC);
CREATE INDEX IF NOT EXISTS calls_agent_id_idx ON calls (agent_id);
CREATE INDEX IF NOT EXISTS calls_campaign_id_idx ON calls (campaign_id);
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

CREATE TABLE IF NOT EXISTS call_aggregates (
  day DATE PRIMARY KEY,
  total_calls INTEGER NOT NULL DEFAULT 0,
  avg_duration_sec INTEGER NOT NULL DEFAULT 0,
  answered_calls INTEGER NOT NULL DEFAULT 0,
  missed_calls INTEGER NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS call_analysis (
  id SERIAL PRIMARY KEY,
  call_id TEXT NOT NULL UNIQUE REFERENCES calls(call_id) ON DELETE CASCADE,
  source TEXT,
  media_url_sanitized TEXT,
  transcript_text TEXT,
  transcript_json JSONB,
  sentiment_label TEXT,
  sentiment_score REAL,
  sentiment_json JSONB,
  language TEXT,
  provider TEXT,
  model TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS call_analysis_updated_at_idx ON call_analysis (updated_at DESC);
