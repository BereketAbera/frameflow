ALTER TABLE videos ADD COLUMN user_id TEXT;
UPDATE videos SET user_id = 'local-development' WHERE user_id IS NULL;
CREATE INDEX IF NOT EXISTS idx_videos_user_created ON videos(user_id, created_at DESC);
