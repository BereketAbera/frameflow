ALTER TABLE videos ADD COLUMN source_object_key TEXT;
ALTER TABLE videos ADD COLUMN output_prefix TEXT;
ALTER TABLE videos ADD COLUMN master_playlist_object_key TEXT;
ALTER TABLE videos ADD COLUMN upload_status TEXT NOT NULL DEFAULT 'uploaded';
ALTER TABLE videos ADD COLUMN upload_expires_at TEXT;
ALTER TABLE videos ADD COLUMN source_etag TEXT;
ALTER TABLE videos ADD COLUMN source_size_bytes INTEGER;
ALTER TABLE videos ADD COLUMN declared_size_bytes INTEGER;

UPDATE videos SET upload_status = 'uploaded' WHERE source_object_key IS NULL;
CREATE INDEX IF NOT EXISTS videos_upload_expiry_idx ON videos(upload_status, upload_expires_at);
