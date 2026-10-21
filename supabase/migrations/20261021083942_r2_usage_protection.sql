-- Service-only R2 controls. Reading progress remains in its existing database.
BEGIN;

CREATE TABLE public.readlay_r2_limits (
  id integer PRIMARY KEY CHECK (id = 1),
  account_id text CHECK (account_id ~ '^[a-f0-9]{32}$'),
  bucket text NOT NULL DEFAULT 'readlay-audio',
  enabled boolean NOT NULL DEFAULT true,
  uploads_enabled boolean NOT NULL DEFAULT true,
  class_a_enabled boolean NOT NULL DEFAULT true,
  class_b_enabled boolean NOT NULL DEFAULT true,
  storage_limit_bytes bigint NOT NULL DEFAULT 9000000000 CHECK (storage_limit_bytes > 0 AND storage_limit_bytes <= 9000000000),
  class_a_limit bigint NOT NULL DEFAULT 800000 CHECK (class_a_limit > 0 AND class_a_limit < 1000000),
  class_b_limit bigint NOT NULL DEFAULT 8000000 CHECK (class_b_limit > 0 AND class_b_limit < 10000000),
  warning_percent integer NOT NULL DEFAULT 80 CHECK (warning_percent BETWEEN 1 AND 99),
  max_snapshot_age_seconds integer NOT NULL DEFAULT 93600 CHECK (max_snapshot_age_seconds BETWEEN 300 AND 93600),
  read_requests_per_minute integer NOT NULL DEFAULT 60 CHECK (read_requests_per_minute BETWEEN 1 AND 600),
  version integer NOT NULL DEFAULT 1,
  refresh_token uuid,
  refresh_started_at timestamptz,
  refresh_until timestamptz,
  last_refresh_error text,
  updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO public.readlay_r2_limits (id) VALUES (1);

CREATE TABLE public.readlay_r2_months (
  period date PRIMARY KEY,
  reported_class_a bigint NOT NULL DEFAULT 0 CHECK (reported_class_a >= 0),
  reported_class_b bigint NOT NULL DEFAULT 0 CHECK (reported_class_b >= 0),
  monthly_class_a bigint NOT NULL DEFAULT 0 CHECK (monthly_class_a >= 0),
  monthly_class_b bigint NOT NULL DEFAULT 0 CHECK (monthly_class_b >= 0),
  reserved_class_a bigint NOT NULL DEFAULT 0 CHECK (reserved_class_a >= 0),
  reserved_class_b bigint NOT NULL DEFAULT 0 CHECK (reserved_class_b >= 0),
  reported_storage_bytes bigint NOT NULL DEFAULT 0 CHECK (reported_storage_bytes >= 0),
  protected_storage_bytes bigint NOT NULL DEFAULT 0 CHECK (protected_storage_bytes >= 0),
  object_count bigint NOT NULL DEFAULT 0 CHECK (object_count >= 0),
  pending_multipart_uploads bigint NOT NULL DEFAULT 0 CHECK (pending_multipart_uploads >= 0),
  observed_at timestamptz,
  storage_at timestamptz,
  inventory_at timestamptz
);

-- An uncertain PUT keeps its space reservation until a complete inventory sees it.
-- Rows and R2 objects are never deleted by this system.
CREATE TABLE public.readlay_r2_objects (
  object_key text PRIMARY KEY,
  byte_length bigint NOT NULL CHECK (byte_length > 0),
  reserved_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  observed_at timestamptz
);
CREATE INDEX readlay_r2_pending_objects ON public.readlay_r2_objects (reserved_at) WHERE observed_at IS NULL;

CREATE TABLE public.readlay_r2_read_rates (
  subject text PRIMARY KEY,
  minute timestamptz NOT NULL,
  requests integer NOT NULL CHECK (requests > 0)
);

ALTER TABLE public.readlay_r2_limits ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.readlay_r2_months ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.readlay_r2_objects ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.readlay_r2_read_rates ENABLE ROW LEVEL SECURITY;
GRANT USAGE ON SCHEMA public TO service_role;
REVOKE ALL ON public.readlay_r2_limits, public.readlay_r2_months, public.readlay_r2_objects, public.readlay_r2_read_rates FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON public.readlay_r2_limits, public.readlay_r2_months, public.readlay_r2_objects, public.readlay_r2_read_rates TO service_role;

CREATE FUNCTION public.readlay_r2_bind(p_account_id text, p_bucket text) RETURNS void
LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
DECLARE c public.readlay_r2_limits;
BEGIN
  SELECT * INTO c FROM public.readlay_r2_limits WHERE id = 1 FOR UPDATE;
  IF p_account_id !~ '^[a-f0-9]{32}$' OR p_bucket !~ '^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$' THEN RAISE EXCEPTION 'Invalid R2 binding'; END IF;
  IF c.account_id IS NULL THEN
    UPDATE public.readlay_r2_limits SET account_id = p_account_id, bucket = p_bucket WHERE id = 1;
  ELSIF c.account_id <> p_account_id OR c.bucket <> p_bucket THEN RAISE EXCEPTION 'R2 binding mismatch'; END IF;
END $$;

CREATE FUNCTION public.readlay_r2_status(p_account_id text, p_bucket text) RETURNS jsonb
LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
DECLARE c public.readlay_r2_limits; m public.readlay_r2_months; pending bigint; fresh boolean; reserved_a bigint; reserved_b bigint;
BEGIN
  SELECT * INTO c FROM public.readlay_r2_limits WHERE id = 1;
  IF c.account_id IS DISTINCT FROM p_account_id OR c.bucket <> p_bucket THEN RAISE EXCEPTION 'R2 binding mismatch'; END IF;
  SELECT * INTO m FROM public.readlay_r2_months WHERE period = date_trunc('month', now() AT TIME ZONE 'UTC')::date;
  SELECT coalesce(sum(byte_length), 0) INTO pending FROM public.readlay_r2_objects WHERE observed_at IS NULL;
  SELECT coalesce(sum(reserved_class_a), 0), coalesce(sum(reserved_class_b), 0) INTO reserved_a, reserved_b FROM public.readlay_r2_months
    WHERE period >= date_trunc('month', (now() AT TIME ZONE 'UTC') - interval '31 days')::date;
  fresh := m.observed_at IS NOT NULL AND m.observed_at >= clock_timestamp() - make_interval(secs => c.max_snapshot_age_seconds)
    AND (c.last_refresh_error IS NULL OR c.last_refresh_error = 'inventory_unavailable');
  RETURN jsonb_build_object(
    'limits', jsonb_build_object('enabled', c.enabled, 'uploadsEnabled', c.uploads_enabled, 'classAEnabled', c.class_a_enabled, 'classBEnabled', c.class_b_enabled,
      'storageLimitBytes', c.storage_limit_bytes, 'classALimit', c.class_a_limit, 'classBLimit', c.class_b_limit,
      'warningPercent', c.warning_percent, 'maxSnapshotAgeSeconds', c.max_snapshot_age_seconds, 'readRequestsPerMinute', c.read_requests_per_minute, 'version', c.version),
    'usage', jsonb_build_object('period', date_trunc('month', now() AT TIME ZONE 'UTC')::date,
      'reportedStorageBytes', coalesce(m.reported_storage_bytes, 0), 'pendingStorageBytes', pending,
      'effectiveStorageBytes', coalesce(m.protected_storage_bytes, 0) + pending,
      'reportedClassA', coalesce(m.reported_class_a, 0), 'reportedClassB', coalesce(m.reported_class_b, 0),
      'monthlyClassA', coalesce(m.monthly_class_a, 0), 'monthlyClassB', coalesce(m.monthly_class_b, 0),
      'reservedClassA', reserved_a, 'reservedClassB', reserved_b,
      'effectiveClassA', coalesce(m.reported_class_a, 0) + reserved_a,
      'effectiveClassB', coalesce(m.reported_class_b, 0) + reserved_b,
      'objectCount', coalesce(m.object_count, 0), 'pendingMultipartUploads', coalesce(m.pending_multipart_uploads, 0),
      'observedAt', m.observed_at, 'storageAt', m.storage_at, 'inventoryAt', m.inventory_at),
    'health', jsonb_build_object('fresh', coalesce(fresh, false), 'lastRefreshError', c.last_refresh_error,
      'inventoryFresh', m.inventory_at IS NOT NULL AND m.inventory_at >= clock_timestamp() - make_interval(secs => c.max_snapshot_age_seconds))
  );
END $$;

CREATE FUNCTION public.readlay_r2_reserve(p_account_id text, p_bucket text, p_operation text, p_subject text, p_object_key text DEFAULT NULL, p_bytes bigint DEFAULT 0) RETURNS jsonb
LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
DECLARE c public.readlay_r2_limits; m public.readlay_r2_months; s jsonb; a boolean; pending bigint; existing public.readlay_r2_objects; extra bigint := 0; rate public.readlay_r2_read_rates;
BEGIN
  -- All reservations, snapshots and configuration updates share this lock.
  SELECT * INTO c FROM public.readlay_r2_limits WHERE id = 1 FOR UPDATE;
  IF c.account_id IS DISTINCT FROM p_account_id OR c.bucket <> p_bucket THEN RETURN jsonb_build_object('allowed', false, 'reason', 'configuration'); END IF;
  IF p_operation NOT IN ('GetObject', 'HeadObject', 'HeadBucket', 'ListObjectsV2', 'PutObject') OR p_subject IS NULL OR length(p_subject) NOT BETWEEN 1 AND 160 OR p_bytes IS NULL OR p_bytes < 0 THEN
    RETURN jsonb_build_object('allowed', false, 'reason', 'invalid_operation');
  END IF;
  a := p_operation IN ('ListObjectsV2', 'PutObject');
  s := public.readlay_r2_status(p_account_id, p_bucket);
  IF NOT c.enabled THEN RETURN jsonb_build_object('allowed', false, 'reason', 'paused'); END IF;
  IF NOT (s #>> '{health,fresh}')::boolean THEN RETURN jsonb_build_object('allowed', false, 'reason', 'usage_unavailable'); END IF;
  SELECT * INTO m FROM public.readlay_r2_months WHERE period = date_trunc('month', now() AT TIME ZONE 'UTC')::date;
  IF a AND (NOT c.class_a_enabled OR (s #>> '{usage,effectiveClassA}')::bigint >= c.class_a_limit) THEN RETURN jsonb_build_object('allowed', false, 'reason', 'class_a_limit'); END IF;
  IF NOT a AND (NOT c.class_b_enabled OR (s #>> '{usage,effectiveClassB}')::bigint >= c.class_b_limit) THEN RETURN jsonb_build_object('allowed', false, 'reason', 'class_b_limit'); END IF;
  IF p_operation = 'PutObject' THEN
    IF NOT c.uploads_enabled THEN RETURN jsonb_build_object('allowed', false, 'reason', 'uploads_paused'); END IF;
    IF NOT (s #>> '{health,inventoryFresh}')::boolean OR m.storage_at IS NULL OR m.storage_at < clock_timestamp() - make_interval(secs => c.max_snapshot_age_seconds) THEN RETURN jsonb_build_object('allowed', false, 'reason', 'inventory_unavailable'); END IF;
    IF m.pending_multipart_uploads > 0 THEN RETURN jsonb_build_object('allowed', false, 'reason', 'multipart_pending'); END IF;
    IF NOT c.class_b_enabled OR (s #>> '{usage,effectiveClassB}')::bigint >= c.class_b_limit THEN RETURN jsonb_build_object('allowed', false, 'reason', 'verification_limit'); END IF;
    IF p_object_key IS NULL OR length(p_object_key) > 1024 OR p_object_key !~ '^[a-zA-Z0-9][a-zA-Z0-9_./-]+$' OR p_object_key ~ '(^|/)\.{1,2}(/|$)|//' OR p_bytes <= 0 OR p_bytes > 5368709120 THEN RETURN jsonb_build_object('allowed', false, 'reason', 'invalid_object'); END IF;
    SELECT * INTO existing FROM public.readlay_r2_objects WHERE object_key = p_object_key;
    IF FOUND AND existing.byte_length <> p_bytes THEN RETURN jsonb_build_object('allowed', false, 'reason', 'immutable_object'); END IF;
    IF existing.object_key IS NULL THEN extra := p_bytes; END IF;
    IF (s #>> '{usage,effectiveStorageBytes}')::bigint + extra >= c.storage_limit_bytes THEN RETURN jsonb_build_object('allowed', false, 'reason', 'storage_limit'); END IF;
    INSERT INTO public.readlay_r2_objects (object_key, byte_length) VALUES (p_object_key, p_bytes) ON CONFLICT (object_key) DO NOTHING;
  ELSIF p_bytes <> 0 OR p_object_key IS NOT NULL THEN RETURN jsonb_build_object('allowed', false, 'reason', 'invalid_object'); END IF;
  IF p_operation IN ('GetObject', 'HeadObject') AND p_subject <> 'operator' THEN
    SELECT * INTO rate FROM public.readlay_r2_read_rates WHERE subject = p_subject;
    IF rate.minute = date_trunc('minute', clock_timestamp()) AND rate.requests >= c.read_requests_per_minute THEN RETURN jsonb_build_object('allowed', false, 'reason', 'read_rate'); END IF;
    INSERT INTO public.readlay_r2_read_rates (subject, minute, requests) VALUES (p_subject, date_trunc('minute', clock_timestamp()), 1)
    ON CONFLICT (subject) DO UPDATE SET minute = EXCLUDED.minute, requests = CASE WHEN readlay_r2_read_rates.minute = EXCLUDED.minute THEN readlay_r2_read_rates.requests + 1 ELSE 1 END;
  END IF;
  UPDATE public.readlay_r2_months SET reserved_class_a = reserved_class_a + CASE WHEN a THEN 1 ELSE 0 END,
    reserved_class_b = reserved_class_b + CASE WHEN a THEN 0 ELSE 1 END WHERE period = m.period;
  RETURN jsonb_build_object('allowed', true);
END $$;

CREATE FUNCTION public.readlay_r2_update_limits(p_account_id text, p_bucket text, p_limits jsonb) RETURNS boolean
LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
DECLARE c public.readlay_r2_limits;
BEGIN
  SELECT * INTO c FROM public.readlay_r2_limits WHERE id = 1 FOR UPDATE;
  IF c.account_id IS DISTINCT FROM p_account_id OR c.bucket <> p_bucket THEN RAISE EXCEPTION 'R2 binding mismatch'; END IF;
  IF c.version <> (p_limits->>'version')::integer THEN RETURN false; END IF;
  UPDATE public.readlay_r2_limits SET enabled = (p_limits->>'enabled')::boolean, uploads_enabled = (p_limits->>'uploadsEnabled')::boolean,
    class_a_enabled = (p_limits->>'classAEnabled')::boolean, class_b_enabled = (p_limits->>'classBEnabled')::boolean,
    storage_limit_bytes = (p_limits->>'storageLimitBytes')::bigint, class_a_limit = (p_limits->>'classALimit')::bigint, class_b_limit = (p_limits->>'classBLimit')::bigint,
    warning_percent = (p_limits->>'warningPercent')::integer, max_snapshot_age_seconds = (p_limits->>'maxSnapshotAgeSeconds')::integer,
    read_requests_per_minute = (p_limits->>'readRequestsPerMinute')::integer, version = version + 1, updated_at = clock_timestamp() WHERE id = 1;
  RETURN true;
END $$;

CREATE FUNCTION public.readlay_r2_begin_refresh(p_account_id text, p_bucket text, p_token uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
DECLARE c public.readlay_r2_limits; started timestamptz;
BEGIN
  SELECT * INTO c FROM public.readlay_r2_limits WHERE id = 1 FOR UPDATE;
  IF c.account_id IS DISTINCT FROM p_account_id OR c.bucket <> p_bucket OR p_token IS NULL THEN RAISE EXCEPTION 'R2 binding mismatch'; END IF;
  IF c.refresh_until > clock_timestamp() OR c.refresh_started_at > clock_timestamp() - interval '5 minutes' THEN RETURN NULL; END IF;
  UPDATE public.readlay_r2_limits SET refresh_token = p_token, refresh_started_at = clock_timestamp(), refresh_until = clock_timestamp() + interval '5 minutes' WHERE id = 1 RETURNING refresh_started_at INTO started;
  RETURN jsonb_build_object('startedAt', started);
END $$;

CREATE FUNCTION public.readlay_r2_observe(p_account_id text, p_bucket text, p_token uuid, p_snapshot jsonb) RETURNS void
LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
DECLARE c public.readlay_r2_limits; period_start date := date_trunc('month', now() AT TIME ZONE 'UTC')::date;
BEGIN
  SELECT * INTO c FROM public.readlay_r2_limits WHERE id = 1 FOR UPDATE;
  IF c.account_id IS DISTINCT FROM p_account_id OR c.bucket <> p_bucket OR p_token IS NULL OR c.refresh_token IS DISTINCT FROM p_token OR c.refresh_until IS NULL OR c.refresh_until < clock_timestamp() THEN RAISE EXCEPTION 'R2 refresh lease mismatch'; END IF;
  IF p_snapshot IS NULL OR p_snapshot->>'period' IS NULL OR p_snapshot->>'storageAt' IS NULL OR (p_snapshot->>'period')::date <> period_start OR (p_snapshot->>'storageAt')::timestamptz > clock_timestamp()
    OR (p_snapshot->>'storageAt')::timestamptz < clock_timestamp() - make_interval(secs => c.max_snapshot_age_seconds)
    OR (p_snapshot->>'classA')::bigint < 0 OR (p_snapshot->>'classB')::bigint < 0 OR (p_snapshot->>'storageBytes')::bigint < 0 THEN RAISE EXCEPTION 'Invalid R2 snapshot'; END IF;
  INSERT INTO public.readlay_r2_months (period, reported_class_a, reported_class_b, monthly_class_a, monthly_class_b, reported_storage_bytes, protected_storage_bytes, object_count, pending_multipart_uploads, observed_at, storage_at)
    VALUES (period_start, (p_snapshot->>'classA')::bigint, (p_snapshot->>'classB')::bigint, (p_snapshot->>'monthlyClassA')::bigint, (p_snapshot->>'monthlyClassB')::bigint, (p_snapshot->>'storageBytes')::bigint, (p_snapshot->>'storageBytes')::bigint,
      (p_snapshot->>'objectCount')::bigint, (p_snapshot->>'pendingMultipartUploads')::bigint, clock_timestamp(), (p_snapshot->>'storageAt')::timestamptz)
  ON CONFLICT (period) DO UPDATE SET reported_class_a = greatest(readlay_r2_months.reported_class_a, EXCLUDED.reported_class_a),
    reported_class_b = greatest(readlay_r2_months.reported_class_b, EXCLUDED.reported_class_b), reported_storage_bytes = EXCLUDED.reported_storage_bytes,
    monthly_class_a = greatest(readlay_r2_months.monthly_class_a, EXCLUDED.monthly_class_a), monthly_class_b = greatest(readlay_r2_months.monthly_class_b, EXCLUDED.monthly_class_b),
    protected_storage_bytes = greatest(EXCLUDED.reported_storage_bytes, readlay_r2_months.protected_storage_bytes),
    object_count = EXCLUDED.object_count, pending_multipart_uploads = EXCLUDED.pending_multipart_uploads, observed_at = EXCLUDED.observed_at, storage_at = EXCLUDED.storage_at;
  UPDATE public.readlay_r2_limits SET last_refresh_error = NULL WHERE id = 1;
END $$;

CREATE FUNCTION public.readlay_r2_finish_inventory(p_account_id text, p_bucket text, p_token uuid, p_objects jsonb, p_inventory_started_at timestamptz, p_other_storage_bytes bigint) RETURNS void
LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
DECLARE c public.readlay_r2_limits; total bigint; count_objects bigint;
BEGIN
  SELECT * INTO c FROM public.readlay_r2_limits WHERE id = 1 FOR UPDATE;
  IF c.account_id IS DISTINCT FROM p_account_id OR c.bucket <> p_bucket OR p_token IS NULL OR c.refresh_token IS DISTINCT FROM p_token OR c.refresh_until IS NULL OR c.refresh_until < clock_timestamp() THEN RAISE EXCEPTION 'R2 refresh lease mismatch'; END IF;
  IF p_objects IS NULL OR jsonb_typeof(p_objects) <> 'array' OR jsonb_array_length(p_objects) > 100000 OR p_inventory_started_at IS NULL OR p_inventory_started_at < c.refresh_started_at OR p_inventory_started_at > clock_timestamp() OR p_other_storage_bytes IS NULL OR p_other_storage_bytes < 0 THEN RAISE EXCEPTION 'Invalid R2 inventory'; END IF;
  IF EXISTS (SELECT 1 FROM jsonb_to_recordset(p_objects) AS item(key text, size bigint) WHERE key IS NULL OR size IS NULL OR size < 0)
    OR (SELECT count(*) FROM jsonb_to_recordset(p_objects) AS item(key text, size bigint)) <> (SELECT count(DISTINCT key) FROM jsonb_to_recordset(p_objects) AS item(key text, size bigint)) THEN RAISE EXCEPTION 'Invalid R2 inventory objects'; END IF;
  SELECT coalesce(sum(size), 0), count(*) INTO total, count_objects FROM jsonb_to_recordset(p_objects) AS item(key text, size bigint);
  UPDATE public.readlay_r2_objects AS object SET observed_at = CASE WHEN EXISTS (
    SELECT 1 FROM jsonb_to_recordset(p_objects) AS item(key text, size bigint) WHERE item.key = object.object_key AND item.size = object.byte_length
  ) THEN clock_timestamp() ELSE NULL END WHERE object.reserved_at <= p_inventory_started_at;
  UPDATE public.readlay_r2_months SET protected_storage_bytes = greatest(reported_storage_bytes, total + p_other_storage_bytes), inventory_at = clock_timestamp()
    WHERE period = date_trunc('month', now() AT TIME ZONE 'UTC')::date AND observed_at >= c.refresh_started_at;
  IF NOT FOUND THEN RAISE EXCEPTION 'R2 observation missing'; END IF;
  UPDATE public.readlay_r2_limits SET refresh_token = NULL, refresh_until = NULL, last_refresh_error = NULL WHERE id = 1;
END $$;

CREATE FUNCTION public.readlay_r2_fail_refresh(p_account_id text, p_bucket text, p_token uuid, p_reason text) RETURNS void
LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
BEGIN
  IF p_reason = 'inventory_unavailable' THEN
    UPDATE public.readlay_r2_months SET inventory_at = NULL WHERE period = date_trunc('month', now() AT TIME ZONE 'UTC')::date
      AND EXISTS (SELECT 1 FROM public.readlay_r2_limits WHERE id = 1 AND account_id = p_account_id AND bucket = p_bucket AND refresh_token = p_token);
  END IF;
  UPDATE public.readlay_r2_limits SET last_refresh_error = CASE WHEN p_reason IN ('analytics_configuration', 'analytics_unavailable', 'inventory_unavailable') THEN p_reason ELSE 'analytics_unavailable' END,
    refresh_token = NULL, refresh_until = NULL WHERE id = 1 AND account_id = p_account_id AND bucket = p_bucket AND refresh_token = p_token;
END $$;

REVOKE ALL ON FUNCTION public.readlay_r2_bind(text,text), public.readlay_r2_status(text,text), public.readlay_r2_reserve(text,text,text,text,text,bigint),
  public.readlay_r2_update_limits(text,text,jsonb), public.readlay_r2_begin_refresh(text,text,uuid), public.readlay_r2_observe(text,text,uuid,jsonb),
  public.readlay_r2_finish_inventory(text,text,uuid,jsonb,timestamptz,bigint), public.readlay_r2_fail_refresh(text,text,uuid,text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.readlay_r2_bind(text,text), public.readlay_r2_status(text,text), public.readlay_r2_reserve(text,text,text,text,text,bigint),
  public.readlay_r2_update_limits(text,text,jsonb), public.readlay_r2_begin_refresh(text,text,uuid), public.readlay_r2_observe(text,text,uuid,jsonb),
  public.readlay_r2_finish_inventory(text,text,uuid,jsonb,timestamptz,bigint), public.readlay_r2_fail_refresh(text,text,uuid,text) TO service_role;

NOTIFY pgrst, 'reload schema';
COMMIT;
