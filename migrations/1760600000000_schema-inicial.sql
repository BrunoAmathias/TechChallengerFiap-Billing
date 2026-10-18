-- Up Migration
-- Billing Service: orçamentos, pagamentos (Mercado Pago), outbox e idempotência.

CREATE TABLE IF NOT EXISTS orcamentos (
  id SERIAL PRIMARY KEY,
  os_id INTEGER NOT NULL UNIQUE,
  cliente JSONB NOT NULL,
  veiculo JSONB,
  itens JSONB NOT NULL,
  valor_total NUMERIC(10,2) NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'PENDENTE'
    CHECK (status IN ('PENDENTE', 'APROVADO', 'RECUSADO', 'CANCELADO')),
  motivo VARCHAR(255),
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS pagamentos (
  id SERIAL PRIMARY KEY,
  orcamento_id INTEGER NOT NULL UNIQUE REFERENCES orcamentos(id) ON DELETE CASCADE,
  os_id INTEGER NOT NULL,
  mp_preference_id VARCHAR(100),
  mp_payment_id VARCHAR(100) UNIQUE,
  mp_refund_id VARCHAR(100),
  init_point TEXT,
  status VARCHAR(20) NOT NULL DEFAULT 'PENDENTE'
    CHECK (status IN ('PENDENTE', 'APROVADO', 'REJEITADO', 'EXPIRADO', 'ESTORNADO')),
  valor NUMERIC(10,2) NOT NULL,
  raw JSONB,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_pagamentos_os_id ON pagamentos (os_id);
CREATE INDEX IF NOT EXISTS idx_pagamentos_pendentes ON pagamentos (created_at) WHERE status = 'PENDENTE';

CREATE TABLE IF NOT EXISTS outbox (
  id UUID PRIMARY KEY,
  aggregate_id VARCHAR(100) NOT NULL,
  type VARCHAR(100) NOT NULL,
  payload JSONB NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  published_at TIMESTAMP,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT
);

CREATE INDEX IF NOT EXISTS idx_outbox_pendentes ON outbox (created_at) WHERE published_at IS NULL;

CREATE TABLE IF NOT EXISTS processed_events (
  event_id UUID PRIMARY KEY,
  type VARCHAR(100) NOT NULL,
  processed_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Down Migration
DROP TABLE IF EXISTS processed_events;
DROP TABLE IF EXISTS outbox;
DROP TABLE IF EXISTS pagamentos;
DROP TABLE IF EXISTS orcamentos;
