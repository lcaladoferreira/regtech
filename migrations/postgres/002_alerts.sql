CREATE TABLE IF NOT EXISTS alert_subscribers (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','ACTIVE','UNSUBSCRIBED')),
  delivery_mode TEXT NOT NULL DEFAULT 'IMMEDIATE' CHECK (delivery_mode IN ('IMMEDIATE','DAILY')),
  authorities_json TEXT NOT NULL DEFAULT '["*"]',
  topics_json TEXT NOT NULL DEFAULT '["ALL"]',
  manage_token_hash TEXT NOT NULL UNIQUE,
  consent_at TIMESTAMPTZ NOT NULL,
  confirmed_at TIMESTAMPTZ,
  unsubscribed_at TIMESTAMPTZ,
  last_digest_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_alert_subscribers_status_mode ON alert_subscribers(status, delivery_mode);

CREATE TABLE IF NOT EXISTS alert_deliveries (
  id TEXT PRIMARY KEY,
  subscriber_id TEXT NOT NULL REFERENCES alert_subscribers(id) ON DELETE CASCADE,
  change_id TEXT NOT NULL REFERENCES regulatory_changes(id) ON DELETE CASCADE,
  delivery_type TEXT NOT NULL CHECK (delivery_type IN ('IMMEDIATE','DAILY')),
  status TEXT NOT NULL CHECK (status IN ('SENT','FAILED')),
  provider_message_id TEXT,
  sent_at TIMESTAMPTZ,
  error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(subscriber_id, change_id, delivery_type)
);
CREATE INDEX IF NOT EXISTS idx_alert_deliveries_subscriber ON alert_deliveries(subscriber_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_alert_deliveries_change ON alert_deliveries(change_id);
