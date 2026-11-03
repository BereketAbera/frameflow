ALTER TABLE videos ADD COLUMN title TEXT;
ALTER TABLE videos ADD COLUMN description TEXT NOT NULL DEFAULT '';
ALTER TABLE videos ADD COLUMN tags TEXT NOT NULL DEFAULT '';
ALTER TABLE videos ADD COLUMN visibility TEXT NOT NULL DEFAULT 'private' CHECK (visibility IN ('public','unlisted','private'));
ALTER TABLE videos ADD COLUMN view_count INTEGER NOT NULL DEFAULT 0;
UPDATE videos SET title = original_filename, visibility = CASE WHEN status = 'completed' THEN 'public' ELSE 'private' END WHERE title IS NULL;

CREATE TABLE profiles (user_id TEXT PRIMARY KEY, display_name TEXT NOT NULL, bio TEXT NOT NULL DEFAULT '', avatar_url TEXT, created_at TEXT NOT NULL);
INSERT OR IGNORE INTO profiles(user_id,display_name,bio,created_at) VALUES ('local-development','Frameflow Studio','AI video creator and experimental filmmaker',datetime('now'));
CREATE TABLE video_likes (video_id TEXT NOT NULL REFERENCES videos(id) ON DELETE CASCADE,user_id TEXT NOT NULL,created_at TEXT NOT NULL,PRIMARY KEY(video_id,user_id));
CREATE TABLE comments (id TEXT PRIMARY KEY,video_id TEXT NOT NULL REFERENCES videos(id) ON DELETE CASCADE,user_id TEXT NOT NULL,parent_id TEXT REFERENCES comments(id) ON DELETE CASCADE,body TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
CREATE TABLE saved_videos (video_id TEXT NOT NULL REFERENCES videos(id) ON DELETE CASCADE,user_id TEXT NOT NULL,created_at TEXT NOT NULL,PRIMARY KEY(video_id,user_id));
CREATE TABLE playlists (id TEXT PRIMARY KEY,user_id TEXT NOT NULL,title TEXT NOT NULL,is_public INTEGER NOT NULL DEFAULT 0,created_at TEXT NOT NULL);
CREATE TABLE playlist_items (playlist_id TEXT NOT NULL REFERENCES playlists(id) ON DELETE CASCADE,video_id TEXT NOT NULL REFERENCES videos(id) ON DELETE CASCADE,position INTEGER NOT NULL,PRIMARY KEY(playlist_id,video_id));
CREATE TABLE notifications (id TEXT PRIMARY KEY,user_id TEXT NOT NULL,type TEXT NOT NULL,message TEXT NOT NULL,href TEXT,read_at TEXT,created_at TEXT NOT NULL);
CREATE TABLE featured_videos (id TEXT PRIMARY KEY,title TEXT NOT NULL,description TEXT NOT NULL,creator TEXT NOT NULL,source_url TEXT NOT NULL,embed_url TEXT,thumbnail_url TEXT,tags TEXT NOT NULL,tool TEXT,created_at TEXT NOT NULL);
CREATE INDEX comments_video_created_idx ON comments(video_id,created_at DESC);
CREATE INDEX notifications_user_created_idx ON notifications(user_id,created_at DESC);
