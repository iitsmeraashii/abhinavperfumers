// Isolated local PostgreSQL integration test. Never connects to Supabase.
// Requires initdb, pg_ctl and psql on PATH. No downloads or production credentials.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'event-overview-pg-'));
const data = path.join(directory, 'data');
let started = false;
function run(binary, args, input) {
  const result = spawnSync(binary, args, { input, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`${binary}: ${result.error?.message || result.stderr || result.stdout}`);
  return result.stdout;
}
try {
  run('initdb', ['-D', data, '-A', 'trust', '-U', 'postgres', '--no-locale']);
  run('pg_ctl', ['-D', data, '-l', path.join(directory, 'server.log'), '-o', `-F -c listen_addresses='' -k ${directory} -p 55439`, '-w', 'start']);
  started = true;
  const setup = `
CREATE ROLE authenticated;
CREATE ROLE anon;
CREATE SCHEMA auth;
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT NULLIF(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
GRANT USAGE ON SCHEMA auth TO authenticated, anon;
CREATE TABLE public.sales_representatives (auth_user_id uuid, role text, rep_code text, name text, is_active boolean, login_enabled boolean);
CREATE TABLE public.events (id uuid PRIMARY KEY, event_code text, whatsapp_template_id text, whatsapp_template_name text);
CREATE TABLE public.lead_entries (event_code text, lead_status text, system_status text, whatsapp_status text, lead_temperature text, country text, state text, sales_rep_code text, created_at timestamp);
ALTER TABLE public.lead_entries ENABLE ROW LEVEL SECURITY;
CREATE POLICY lead_read ON public.lead_entries FOR SELECT TO authenticated USING (EXISTS (SELECT 1 FROM public.sales_representatives sr WHERE sr.auth_user_id=auth.uid() AND (sr.role='admin' OR sr.rep_code=lead_entries.sales_rep_code)));
GRANT SELECT ON public.sales_representatives, public.events, public.lead_entries TO authenticated;
INSERT INTO sales_representatives VALUES
('00000000-0000-0000-0000-000000000001','admin','ADMIN','Admin',true,true),
('00000000-0000-0000-0000-000000000002','sales_rep','R1','Rep One',true,true),
('00000000-0000-0000-0000-000000000003','sales_rep','R2','Rep Two',true,true),
('00000000-0000-0000-0000-000000000004','admin','OFF','Disabled',false,true);
INSERT INTO events VALUES
('10000000-0000-0000-0000-000000000001','A','template-id','template-name'),
('10000000-0000-0000-0000-000000000002','B',NULL,NULL),
('10000000-0000-0000-0000-000000000003','EMPTY','partial-id',NULL);
INSERT INTO lead_entries VALUES
('A','CONTACTED','CREATED','READ','Hot','India','Goa','R1','2026-10-16'),
('A','QUALIFIED','CREATED','DELIVERED','Warm',' India ',' Goa ','R1','2026-10-16'),
('A','CONVERTED','CREATED','FAILED','Cold',NULL,NULL,'R1','2026-10-16'),
('A','LOST','CREATED',NULL,NULL,'','','R2','2026-10-15'),
('A','NEW','CREATED','SENT','','UAE','OUTSIDE INDIA','R2','2026-10-15'),
('A','REQUIRES_REVIEW','INVALID_LEAD','READ','Hot','India','Goa',NULL,'2026-10-15');
INSERT INTO lead_entries SELECT 'B','NEW','CREATED','SENT','Hot','Country '||i,'State '||i,'R1',timestamp '2026-01-01'+i*interval '1 day' FROM generate_series(1,110) i;
`;
  const tests = `
BEGIN;
SET LOCAL ROLE authenticated;
SET LOCAL request.jwt.claim.sub = '00000000-0000-0000-0000-000000000001';
DO $$ DECLARE r jsonb; m jsonb; BEGIN
r:=public.get_event_overview('10000000-0000-0000-0000-000000000001'); m:=r->'metrics';
IF m->>'total'<>'6' OR m->>'contacted'<>'1' OR m->>'samples'<>'1' OR m->>'converted'<>'1' OR m->>'lost'<>'1' OR m->>'engaged'<>'4' OR m->>'sampled'<>'3' OR m->>'connected'<>'3' OR m->>'unassigned'<>'2' OR m->>'review'<>'1' OR m->>'invalid'<>'1' THEN RAISE EXCEPTION 'Event metrics mismatch: %',m; END IF;
IF r->>'templateConfigured'<>'true' OR jsonb_array_length(r->'countries')<>4 OR jsonb_array_length(r->'reps')<>3 OR jsonb_array_length(r->'days')<>2 THEN RAISE EXCEPTION 'Grouped response mismatch'; END IF;
IF NOT EXISTS(SELECT 1 FROM jsonb_array_elements(r->'countries') g WHERE g->>'value'=' India ' AND g->>'count'='1') THEN RAISE EXCEPTION 'Raw geography changed'; END IF;
IF NOT EXISTS(SELECT 1 FROM jsonb_array_elements(r->'countries') g WHERE g->>'value' IS NULL AND g->>'count'='2') THEN RAISE EXCEPTION 'Unassigned grouping mismatch'; END IF;
r:=public.get_event_overview('10000000-0000-0000-0000-000000000002');
IF r->'metrics'->>'total'<>'110' OR jsonb_array_length(r->'countries')<>100 OR r->>'countriesMore'<>'true' OR jsonb_array_length(r->'days')<>90 OR r->>'daysMore'<>'true' OR r->>'templateConfigured'<>'false' THEN RAISE EXCEPTION 'Bounded response mismatch'; END IF;
r:=public.get_event_overview('10000000-0000-0000-0000-000000000003');
IF r->'metrics'->>'total'<>'0' OR r->>'templateConfigured'<>'false' OR jsonb_array_length(r->'countries')<>0 THEN RAISE EXCEPTION 'Empty/partial-template mismatch'; END IF;
BEGIN
  PERFORM public.get_event_overview('10000000-0000-0000-0000-000000000099');
  RAISE EXCEPTION 'Missing event was accepted';
EXCEPTION WHEN SQLSTATE 'P0002' THEN NULL; END;
END $$;
RESET ROLE;
-- Test explicit admin eligibility as authenticated browser roles.
DO $$ DECLARE u text; denied boolean; BEGIN
FOREACH u IN ARRAY ARRAY['00000000-0000-0000-0000-000000000002','00000000-0000-0000-0000-000000000004','00000000-0000-0000-0000-000000000099',''] LOOP
  PERFORM set_config('request.jwt.claim.sub',u,true);
  SET LOCAL ROLE authenticated;
  denied:=false;
  BEGIN PERFORM public.get_event_overview('10000000-0000-0000-0000-000000000001'); EXCEPTION WHEN insufficient_privilege THEN denied:=true; END;
  RESET ROLE;
  IF NOT denied THEN RAISE EXCEPTION 'Ineligible caller accepted'; END IF;
END LOOP;
END $$;
-- Confirm the function honors RLS even for an eligible admin.
DROP POLICY lead_read ON public.lead_entries;
CREATE POLICY lead_read ON public.lead_entries FOR SELECT TO authenticated USING (false);
SET LOCAL request.jwt.claim.sub = '00000000-0000-0000-0000-000000000001';
SET LOCAL ROLE authenticated;
DO $$ BEGIN
IF public.get_event_overview('10000000-0000-0000-0000-000000000001')->'metrics'->>'total'<>'0' THEN RAISE EXCEPTION 'RLS bypass'; END IF;
END $$;
RESET ROLE;
DO $$ BEGIN
IF has_function_privilege('anon','public.get_event_overview(uuid)','EXECUTE') THEN RAISE EXCEPTION 'Anon execute leaked'; END IF;
IF (SELECT prosecdef FROM pg_proc WHERE oid='public.get_event_overview(uuid)'::regprocedure) THEN RAISE EXCEPTION 'Unexpected security definer'; END IF;
END $$;
ROLLBACK;
`;
  run('psql', ['-X', '-v', 'ON_ERROR_STOP=1', '-h', directory, '-p', '55439', '-U', 'postgres', '-d', 'postgres'], setup + fs.readFileSync(path.join(root, 'docs/event-overview-rpc.sql'), 'utf8') + tests);
  console.log('Isolated PostgreSQL: SQL executed; cumulative counts, event isolation, geography, caps, empty/template cases, admin eligibility, anon denial and RLS checks passed.');
} finally {
  if (started) run('pg_ctl', ['-D', data, '-m', 'fast', '-w', 'stop']);
  fs.rmSync(directory, { recursive: true, force: true });
}
