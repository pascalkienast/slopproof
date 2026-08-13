CREATE OR REPLACE FUNCTION slopproof_guard_recording_part()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  previous_last integer;
BEGIN
  IF NEW.part_number > 1 THEN
    SELECT last_chunk_index INTO previous_last
    FROM recording_parts
    WHERE upload_session_id = NEW.upload_session_id
      AND part_number = NEW.part_number - 1;
    IF previous_last IS NULL OR
       NEW.first_chunk_index NOT IN (previous_last, previous_last + 1) THEN
      RAISE EXCEPTION 'recording part range is not contiguous' USING ERRCODE = '23514';
    END IF;
  ELSIF NEW.first_chunk_index <> 0 THEN
    RAISE EXCEPTION 'first recording part must start at chunk zero' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
