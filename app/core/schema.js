// R1.1 schema — runs unchanged on node:sqlite, sql.js and Cloudflare Durable
// Object SQLite (verified locally: triggers, foreign keys, AUTOINCREMENT and
// transaction rollback all work there). Signed and evidentiary tables are
// append-only via triggers.
//
// Out of R1.1 scope and therefore not in this schema (preserved in the R1
// prototype): documents/acknowledgments, training, onboarding, announcements.

const appendOnly = (t) => `
CREATE TRIGGER ${t}_no_update BEFORE UPDATE ON ${t} BEGIN SELECT RAISE(ABORT, '${t} is append-only'); END;
CREATE TRIGGER ${t}_no_delete BEFORE DELETE ON ${t} BEGIN SELECT RAISE(ABORT, '${t} is append-only'); END;`;

// Tables added after the live Hub started (2026-10-16). Each statement is idempotent and runs
// at every start, so an existing database gains them without a reset. Part of SCHEMA too.
export const UPGRADES = `
-- Passkeys (Face ID / fingerprint) on a person's own phone, R1.3. Public keys only; nothing secret.
CREATE TABLE IF NOT EXISTS passkeys (
  id TEXT PRIMARY KEY,
  employee_id TEXT NOT NULL REFERENCES employees(id),
  credential_id TEXT NOT NULL UNIQUE,  -- base64url, chosen by the phone
  public_key_jwk TEXT NOT NULL,
  alg INTEGER NOT NULL,
  sign_count INTEGER NOT NULL DEFAULT 0,
  rp_id TEXT NOT NULL,                 -- web address the passkey belongs to (hub.innerspacecases.com)
  label TEXT NOT NULL,                 -- "iPhone", "Android phone", ...
  transports TEXT,
  backed_up INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  last_used_at TEXT,
  removed_at TEXT,
  removed_by TEXT,
  remove_reason TEXT
);
CREATE INDEX IF NOT EXISTS passkeys_employee ON passkeys (employee_id);
-- Which sessions a passkey started, so removing a lost phone ends the sessions on it.
CREATE TABLE IF NOT EXISTS passkey_sessions (
  token_hash TEXT PRIMARY KEY,
  passkey_id TEXT NOT NULL
);
-- Phone reminders (web push), R1.3. A phone that turned reminders on; pushes carry no content.
CREATE TABLE IF NOT EXISTS push_subscriptions (
  id TEXT PRIMARY KEY,
  employee_id TEXT NOT NULL REFERENCES employees(id),
  endpoint TEXT NOT NULL UNIQUE,       -- the phone's push address (Apple/Google), not secret content
  device TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_ok_at TEXT,
  removed_at TEXT,
  remove_reason TEXT
);
-- What a reminder says. The phone fetches the text after the content-free push arrives.
CREATE TABLE IF NOT EXISTS push_messages (
  id TEXT PRIMARY KEY,
  subscription_id TEXT NOT NULL,
  employee_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  dedupe_key TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  url TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('queued','sent','failed','shown')),
  attempts INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  sent_at TEXT,
  shown_at TEXT,
  detail TEXT,
  UNIQUE (subscription_id, dedupe_key)
);
CREATE INDEX IF NOT EXISTS push_messages_status ON push_messages (status);
-- QuickBooks Time link, R1.3: which QuickBooks Time user each Hub account is (set by management,
-- never guessed from names). Read-only use: "My hours".
CREATE TABLE IF NOT EXISTS qbt_links (
  employee_id TEXT PRIMARY KEY REFERENCES employees(id),
  qbt_user_id TEXT NOT NULL UNIQUE,
  qbt_name TEXT NOT NULL,
  linked_by TEXT NOT NULL,
  linked_at TEXT NOT NULL
);
-- Company documents, R1.3 (owner 2026-10-27): handbook, policies and other documents, each with
-- versions. A published version never changes; a change is a new version. When a version needs an
-- acknowledgment, every active person signs it once (PIN or Face ID), and signatures are append-only.
CREATE TABLE IF NOT EXISTS documents (
  id TEXT PRIMARY KEY,
  category TEXT NOT NULL CHECK (category IN ('handbook','policy','safety','benefits','other')),
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  archived_at TEXT
);
CREATE TABLE IF NOT EXISTS document_versions (
  id TEXT PRIMARY KEY,
  document_id TEXT NOT NULL REFERENCES documents(id),
  status TEXT NOT NULL CHECK (status IN ('draft','published','retired')),
  version_label TEXT NOT NULL,
  effective_date TEXT,
  title_en TEXT NOT NULL,
  title_es TEXT,
  body_en TEXT NOT NULL,
  body_es TEXT,
  ack_required INTEGER NOT NULL DEFAULT 1,
  ack_statement_en TEXT,
  ack_statement_es TEXT,
  content_sha256 TEXT,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  published_by TEXT,
  published_at TEXT,
  retired_at TEXT
);
CREATE INDEX IF NOT EXISTS document_versions_doc ON document_versions (document_id, status);
DROP TRIGGER IF EXISTS document_versions_locked;
CREATE TRIGGER document_versions_locked BEFORE UPDATE ON document_versions WHEN OLD.status != 'draft' AND (
  NEW.title_en IS NOT OLD.title_en OR NEW.title_es IS NOT OLD.title_es OR NEW.body_en IS NOT OLD.body_en OR NEW.body_es IS NOT OLD.body_es OR
  NEW.version_label IS NOT OLD.version_label OR NEW.effective_date IS NOT OLD.effective_date OR NEW.ack_required IS NOT OLD.ack_required OR
  NEW.ack_statement_en IS NOT OLD.ack_statement_en OR NEW.ack_statement_es IS NOT OLD.ack_statement_es OR NEW.content_sha256 IS NOT OLD.content_sha256 OR
  NEW.document_id IS NOT OLD.document_id OR NEW.published_at IS NOT OLD.published_at OR (OLD.status = 'retired' AND NEW.status != 'retired') OR (OLD.status = 'published' AND NEW.status NOT IN ('published','retired')))
BEGIN SELECT RAISE(ABORT, 'published document versions cannot be changed'); END;
CREATE TRIGGER IF NOT EXISTS document_versions_no_delete BEFORE DELETE ON document_versions WHEN OLD.status != 'draft' BEGIN SELECT RAISE(ABORT, 'published document versions cannot be deleted'); END;
CREATE TABLE IF NOT EXISTS document_acks (
  id TEXT PRIMARY KEY,
  version_id TEXT NOT NULL REFERENCES document_versions(id),
  employee_id TEXT NOT NULL REFERENCES employees(id),
  signed_at TEXT NOT NULL,
  language TEXT NOT NULL,
  statement TEXT NOT NULL,
  content_sha256 TEXT NOT NULL,
  identity_json TEXT NOT NULL,
  UNIQUE (version_id, employee_id)
);
CREATE TRIGGER IF NOT EXISTS document_acks_no_update BEFORE UPDATE ON document_acks BEGIN SELECT RAISE(ABORT, 'document_acks is append-only'); END;
CREATE TRIGGER IF NOT EXISTS document_acks_no_delete BEFORE DELETE ON document_acks BEGIN SELECT RAISE(ABORT, 'document_acks is append-only'); END;
-- Time off requests, R1.3 (owner 2026-10-27): the person (or a manager for them) asks, the person's
-- manager or full access approves or declines. An approved request becomes an absence, so that week's
-- report is excused. No medical details are asked for; balances stay in payroll.
CREATE TABLE IF NOT EXISTS time_off_requests (
  id TEXT PRIMARY KEY,
  employee_id TEXT NOT NULL REFERENCES employees(id),
  kind TEXT NOT NULL CHECK (kind IN ('vacation','sick','unpaid','other')),
  start_date TEXT NOT NULL,
  end_date TEXT NOT NULL,
  note TEXT,
  status TEXT NOT NULL CHECK (status IN ('pending','approved','declined','cancelled')),
  requested_by TEXT NOT NULL,
  requested_at TEXT NOT NULL,
  decided_by TEXT,
  decided_at TEXT,
  decision_note TEXT,
  absence_id TEXT,
  cancelled_by TEXT,
  cancelled_at TEXT
);
CREATE INDEX IF NOT EXISTS time_off_dates ON time_off_requests (status, start_date, end_date);
-- InnerPoints link, R1.3: which Order Manager (Quickbase) employee record each Hub account is
-- (set by management, never guessed). Read-only use: "My InnerPoints" on Home.
CREATE TABLE IF NOT EXISTS ip_links (
  employee_id TEXT PRIMARY KEY REFERENCES employees(id),
  ip_emp_id TEXT NOT NULL UNIQUE,
  ip_name TEXT NOT NULL,
  linked_by TEXT NOT NULL,
  linked_at TEXT NOT NULL
);
-- Email per account (optional), R1.3: onboarding invites and signing in with email instead of the ID.
CREATE TABLE IF NOT EXISTS employee_contacts (
  employee_id TEXT PRIMARY KEY REFERENCES employees(id),
  email TEXT UNIQUE,
  updated_at TEXT NOT NULL
);
-- Onboarding invites: a single-use link (72 hours) that lets the person choose their PIN.
CREATE TABLE IF NOT EXISTS invites (
  id TEXT PRIMARY KEY,
  employee_id TEXT NOT NULL REFERENCES employees(id),
  token_hash TEXT NOT NULL UNIQUE,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  sent_to TEXT,
  sent_at TEXT,
  send_detail TEXT,
  opened_at TEXT,
  used_at TEXT,
  revoked_at TEXT
);
CREATE INDEX IF NOT EXISTS invites_employee ON invites (employee_id);
-- One-time challenges for passkey ceremonies (5 minutes). A verified "sign" challenge becomes a
-- single-use signing ticket bound to the exact answers that were shown.
CREATE TABLE IF NOT EXISTS webauthn_challenges (
  id TEXT PRIMARY KEY,
  purpose TEXT NOT NULL CHECK (purpose IN ('register','login','sign')),   -- 'register' rows exist only after PIN (+ code) re-entry
  employee_id TEXT,
  challenge TEXT NOT NULL,
  rp_id TEXT NOT NULL,
  origin TEXT NOT NULL,
  action TEXT,
  content_hash TEXT,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  verified_employee TEXT,
  passkey_id TEXT,
  verified_at TEXT,
  consumed_at TEXT
);
`;

export const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);
${UPGRADES}

CREATE TABLE employees (
  id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  preferred_language TEXT NOT NULL DEFAULT 'en',
  status TEXT NOT NULL CHECK (status IN ('active','terminated')),
  start_date TEXT NOT NULL,
  end_date TEXT,
  supervisor_id TEXT REFERENCES employees(id),
  roles TEXT NOT NULL,
  department TEXT,
  pin_salt TEXT,
  pin_hash TEXT,                       -- NULL until the employee sets a PIN
  pin_set_at TEXT,
  setup_code_hash TEXT,                -- one-time code from HR/supervisor (first sign-in or reset)
  setup_code_expires TEXT,
  setup_code_issued_by TEXT,
  failed_logins INTEGER NOT NULL DEFAULT 0,
  locked_until TEXT,
  lockouts_24h TEXT NOT NULL DEFAULT '[]',
  hard_locked INTEGER NOT NULL DEFAULT 0,
  totp_secret TEXT,                    -- elevated roles only
  totp_last_counter INTEGER NOT NULL DEFAULT -1,
  phone_on_file INTEGER NOT NULL DEFAULT 0,
  sms_phone TEXT,                      -- E.164 mobile number for urgent safety texts (management safety contacts only)
  sim_fail_sms INTEGER NOT NULL DEFAULT 0,   -- prototype only: simulated SMS failures for this recipient
  created_at TEXT NOT NULL
);

CREATE TABLE devices (
  id TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  registered_by TEXT NOT NULL REFERENCES employees(id),
  registered_at TEXT NOT NULL,
  revoked_at TEXT
);

CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,
  employee_id TEXT NOT NULL REFERENCES employees(id),
  device_id TEXT REFERENCES devices(id),
  shared_device INTEGER NOT NULL,
  must_set_pin INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  last_seen TEXT NOT NULL,
  idle_minutes INTEGER NOT NULL,
  absolute_expires_at TEXT NOT NULL,
  revoked_at TEXT,
  revoke_reason TEXT
);

CREATE TABLE esign_consents (
  id TEXT PRIMARY KEY,
  employee_id TEXT NOT NULL REFERENCES employees(id),
  version TEXT NOT NULL,
  choice TEXT NOT NULL CHECK (choice IN ('electronic','paper')),
  language TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE absences (
  id TEXT PRIMARY KEY,
  employee_id TEXT NOT NULL REFERENCES employees(id),
  start_date TEXT NOT NULL,
  end_date TEXT NOT NULL,
  reason TEXT NOT NULL CHECK (reason IN ('leave','vacation','other')),   -- never a medical reason
  recorded_by TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE survey_assignments (
  id TEXT PRIMARY KEY,
  employee_id TEXT NOT NULL REFERENCES employees(id),
  week_id TEXT NOT NULL,
  template_id TEXT NOT NULL,
  expected INTEGER NOT NULL,
  workdays INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('open','submitted','paper','excused')),
  excuse_reason TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (employee_id, week_id)
);

CREATE TABLE survey_drafts (
  assignment_id TEXT PRIMARY KEY REFERENCES survey_assignments(id),
  employee_id TEXT NOT NULL,
  answers_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE survey_submissions (
  id TEXT PRIMARY KEY,
  assignment_id TEXT NOT NULL UNIQUE REFERENCES survey_assignments(id),
  employee_id TEXT NOT NULL REFERENCES employees(id),
  idempotency_key TEXT NOT NULL UNIQUE,
  payload_json TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  signed_at TEXT NOT NULL,
  late INTEGER NOT NULL,
  has_safety INTEGER NOT NULL,
  has_obstacle INTEGER NOT NULL
);

CREATE TABLE survey_amendments (
  id TEXT PRIMARY KEY,
  submission_id TEXT NOT NULL REFERENCES survey_submissions(id),
  employee_id TEXT NOT NULL REFERENCES employees(id),
  payload_json TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  signed_at TEXT NOT NULL
);

-- Supervisor sign-off. More than one only when the employee amends after sign-off.
CREATE TABLE supervisor_reviews (
  id TEXT PRIMARY KEY,
  submission_id TEXT NOT NULL REFERENCES survey_submissions(id),
  reviewer_id TEXT NOT NULL REFERENCES employees(id),
  closure TEXT NOT NULL CHECK (closure IN ('no_action','action_assigned','referred')),
  payload_json TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  signed_at TEXT NOT NULL
);

-- Conversation around a report, in the order it happened: clarification requests,
-- employee responses, "seen" acknowledgments, supervisor notes, plus markers for
-- sign-offs and corrections. Review state is derived from this order (not from
-- timestamps, which can tie). Nothing here changes the answers.
CREATE TABLE review_events (
  id TEXT PRIMARY KEY,
  submission_id TEXT NOT NULL REFERENCES survey_submissions(id),
  actor_id TEXT NOT NULL REFERENCES employees(id),
  kind TEXT NOT NULL CHECK (kind IN ('clarification_requested','clarification_withdrawn','employee_response','employee_seen','supervisor_note','signed_off','amended')),
  text TEXT NOT NULL,
  text_hash TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE paper_events (
  id TEXT PRIMARY KEY,
  assignment_id TEXT NOT NULL REFERENCES survey_assignments(id),
  recorded_by TEXT NOT NULL REFERENCES employees(id),
  event TEXT NOT NULL CHECK (event IN ('paper_requested','paper_received','declined_to_sign')),
  note TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE safety_reports (
  id TEXT PRIMARY KEY,
  reporter_id TEXT NOT NULL REFERENCES employees(id),
  confidential INTEGER NOT NULL DEFAULT 0,
  type TEXT NOT NULL CHECK (type IN ('imminent','injury','injury_followup','unsafe_equipment','hazard','unsafe_condition','near_miss','suggestion')),
  priority TEXT NOT NULL CHECK (priority IN ('urgent','high','normal','low')),
  area TEXT,
  location TEXT,
  equipment TEXT,
  description TEXT NOT NULL,
  immediate_action TEXT,
  source TEXT NOT NULL CHECK (source IN ('direct','survey')),
  source_ref TEXT,
  owner_id TEXT REFERENCES employees(id),
  created_at TEXT NOT NULL,
  response_due_at TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('new','acknowledged','in_progress','pending_verification','closed')),
  acknowledged_at TEXT, acknowledged_by TEXT,
  resolution TEXT, resolution_by TEXT, resolution_at TEXT,
  verified_by TEXT, closed_at TEXT,
  escalation_level INTEGER NOT NULL DEFAULT 0,
  last_reminder_at TEXT
);
CREATE TRIGGER safety_reports_content_locked BEFORE UPDATE ON safety_reports
WHEN NEW.description IS NOT OLD.description OR NEW.reporter_id IS NOT OLD.reporter_id
  OR NEW.type IS NOT OLD.type OR NEW.created_at IS NOT OLD.created_at
  OR NEW.confidential IS NOT OLD.confidential OR NEW.source_ref IS NOT OLD.source_ref
BEGIN SELECT RAISE(ABORT, 'safety report content is locked'); END;
CREATE TRIGGER safety_reports_no_delete BEFORE DELETE ON safety_reports BEGIN SELECT RAISE(ABORT, 'safety_reports is append-only'); END;

CREATE TABLE safety_events (
  id TEXT PRIMARY KEY,
  report_id TEXT NOT NULL REFERENCES safety_reports(id),
  actor_id TEXT REFERENCES employees(id),
  kind TEXT NOT NULL,
  detail_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE corrective_actions (
  id TEXT PRIMARY KEY,
  source_type TEXT NOT NULL CHECK (source_type IN ('safety_report','survey','manual')),
  source_id TEXT,
  category TEXT NOT NULL CHECK (category IN ('safety','operational')),
  title TEXT NOT NULL,
  description TEXT,
  priority TEXT NOT NULL CHECK (priority IN ('urgent','high','normal','low')),
  assigned_to TEXT NOT NULL REFERENCES employees(id),
  due_date TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('open','in_progress','pending_verification','closed')),
  resolution TEXT, closure_evidence TEXT, done_by TEXT, done_at TEXT,
  verified_by TEXT, closed_at TEXT,
  created_by TEXT NOT NULL, created_at TEXT NOT NULL,
  last_reminder_at TEXT
);

CREATE TABLE ca_events (
  id TEXT PRIMARY KEY,
  ca_id TEXT NOT NULL REFERENCES corrective_actions(id),
  actor_id TEXT REFERENCES employees(id),
  kind TEXT NOT NULL,
  detail_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE attachments (
  id TEXT PRIMARY KEY,
  entity_type TEXT NOT NULL CHECK (entity_type IN ('safety_report','corrective_action')),
  entity_id TEXT NOT NULL,
  uploaded_by TEXT NOT NULL REFERENCES employees(id),
  filename TEXT NOT NULL,
  mime TEXT NOT NULL,
  size INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  data_b64 TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE notifications (
  id TEXT PRIMARY KEY,
  recipient_id TEXT NOT NULL REFERENCES employees(id),
  channel TEXT NOT NULL CHECK (channel IN ('in_app','sms','email')),
  kind TEXT NOT NULL,
  ref TEXT,
  urgent INTEGER NOT NULL,
  subject TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('queued','sent','delivered','failed','cancelled')),  -- sent = accepted by the text gateway, waiting for its delivery receipt
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT NOT NULL,
  last_error TEXT,
  delivered_at TEXT,
  seen_at TEXT,
  backup_for TEXT,
  provider TEXT,                       -- text gateway used (e.g. goto, simulator)
  provider_id TEXT,                    -- gateway message id, matched against delivery receipts
  sent_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX notifications_provider ON notifications (provider_id);
CREATE INDEX notifications_due ON notifications (status, next_attempt_at);
CREATE INDEX notifications_ref ON notifications (ref);

CREATE TABLE notification_attempts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  notification_id TEXT NOT NULL REFERENCES notifications(id),
  at TEXT NOT NULL,
  ok INTEGER NOT NULL,
  detail TEXT NOT NULL
);

CREATE TABLE audit_events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL,
  actor_id TEXT,
  action TEXT NOT NULL,
  entity TEXT,
  entity_id TEXT,
  detail_json TEXT NOT NULL,
  prev_hash TEXT NOT NULL,
  hash TEXT NOT NULL
);
${appendOnly('survey_submissions')}
${appendOnly('survey_amendments')}
${appendOnly('supervisor_reviews')}
${appendOnly('review_events')}
${appendOnly('paper_events')}
${appendOnly('esign_consents')}
${appendOnly('safety_events')}
${appendOnly('ca_events')}
${appendOnly('attachments')}
${appendOnly('notification_attempts')}
${appendOnly('audit_events')}
`;
