-- The thumbnail shown on a video's card and the short clip that plays on hover. Both stay NULL for videos processed
-- before the workflow made them, and for a video whose thumbnail or preview could not be made.
ALTER TABLE videos ADD COLUMN thumbnail_object_key TEXT;
ALTER TABLE videos ADD COLUMN preview_object_key TEXT;
