CREATE TABLE IF NOT EXISTS videos (
  id TEXT PRIMARY KEY,
  original_filename TEXT NOT NULL,
  source_path TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('uploading', 'uploaded', 'queued', 'processing', 'completed', 'failed')),
  hatchet_run_id TEXT,
  master_playlist_path TEXT,
  error_code TEXT,
  error_message TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  processing_started_at TEXT,
  processing_completed_at TEXT
);

CREATE INDEX IF NOT EXISTS videos_created_at_idx ON videos(created_at DESC);
CREATE INDEX IF NOT EXISTS videos_status_updated_at_idx ON videos(status, updated_at);
