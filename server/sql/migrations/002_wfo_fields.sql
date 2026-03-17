ALTER TABLE calls
  ADD COLUMN IF NOT EXISTS agent_first_name TEXT,
  ADD COLUMN IF NOT EXISTS agent_last_name TEXT,
  ADD COLUMN IF NOT EXISTS result_code TEXT,
  ADD COLUMN IF NOT EXISTS screen_capture_type TEXT;
