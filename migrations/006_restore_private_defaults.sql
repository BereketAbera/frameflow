UPDATE videos
SET visibility = 'private'
WHERE visibility = 'public'
  AND description = ''
  AND tags = ''
  AND title = original_filename;
