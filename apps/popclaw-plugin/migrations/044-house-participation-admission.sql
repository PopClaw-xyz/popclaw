-- Local authority and receipts are separate from enabled participation and server ACKs.
CREATE TABLE IF NOT EXISTS house_initial_setup (
  actor_id TEXT NOT NULL, installation_id TEXT NOT NULL, purpose TEXT NOT NULL,
  eligibility_ref TEXT NOT NULL, original_intent_ref TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('pending','completed','cancelled')),
  PRIMARY KEY(actor_id,installation_id,purpose)
);
CREATE TABLE IF NOT EXISTS house_participation_attempts (
  attempt_ref TEXT PRIMARY KEY, admission_request_key TEXT NOT NULL UNIQUE,
  original_intent_ref TEXT NOT NULL, original_operation_ref TEXT NOT NULL,
  plan_digest TEXT NOT NULL, plan_json TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('prepared','committed','not_committed','unknown')),
  receipt_json TEXT,
  UNIQUE(original_intent_ref,original_operation_ref)
);
CREATE TABLE IF NOT EXISTS house_guide_context (
  origin TEXT PRIMARY KEY, binding_digest TEXT NOT NULL, op_seq INTEGER NOT NULL,
  guide_url TEXT NOT NULL, manifest_digest TEXT NOT NULL, guide_digest TEXT,
  guide_body TEXT, delivered_digest TEXT
);
