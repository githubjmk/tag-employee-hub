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

export const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);

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
