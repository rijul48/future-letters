-- Letters are stored encrypted. Once sent or deleted, the address, subject
-- and body are erased and only timestamps and the status remain.
CREATE TABLE IF NOT EXISTS letters (
  id          TEXT PRIMARY KEY,
  email       TEXT,
  subject_enc TEXT,
  body_enc    TEXT,
  deliver_at  INTEGER NOT NULL,
  tz_offset   INTEGER NOT NULL,
  created_at  INTEGER NOT NULL,
  status      TEXT NOT NULL CHECK (status IN ('pending','scheduled','sending','sent','failed','deleted')),
  token_hash  TEXT NOT NULL,
  attempts    INTEGER NOT NULL DEFAULT 0,
  claimed_at  INTEGER,
  sent_at     INTEGER
);
CREATE INDEX IF NOT EXISTS idx_due   ON letters (status, deliver_at);
CREATE INDEX IF NOT EXISTS idx_email ON letters (email, status);
CREATE INDEX IF NOT EXISTS idx_token ON letters (token_hash);
