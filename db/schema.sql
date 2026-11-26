-- =====================================================================
-- Granja Express Cloud - Esquema de base de datos (PostgreSQL / Supabase)
-- Ejecutar en: Supabase > SQL Editor > New query > Run
-- =====================================================================

-- Productos del catálogo
CREATE TABLE IF NOT EXISTS productos (
  id            SERIAL PRIMARY KEY,
  nombre        TEXT        NOT NULL UNIQUE,
  categoria     TEXT        NOT NULL,
  unidad        TEXT        NOT NULL DEFAULT 'und',
  precio        NUMERIC(10,2) NOT NULL CHECK (precio >= 0),
  stock         INTEGER     NOT NULL DEFAULT 0 CHECK (stock >= 0),
  activo        BOOLEAN     NOT NULL DEFAULT TRUE,
  actualizado_en TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Cabecera de venta. idempotency_key evita ventas duplicadas
CREATE TABLE IF NOT EXISTS ventas (
  id              BIGSERIAL PRIMARY KEY,
  idempotency_key TEXT        NOT NULL UNIQUE,
  request_hash    TEXT        NOT NULL,       -- huella del contenido: misma clave + otro contenido = rechazo
  cliente         TEXT        NOT NULL DEFAULT 'Cliente varios',
  metodo_pago     TEXT        NOT NULL DEFAULT 'EFECTIVO',
  total           NUMERIC(10,2) NOT NULL,
  atendido_por    TEXT,                      -- nombre del pod que procesó la venta
  creado_en       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Detalle de venta
CREATE TABLE IF NOT EXISTS venta_detalle (
  id           BIGSERIAL PRIMARY KEY,
  venta_id     BIGINT  NOT NULL REFERENCES ventas(id) ON DELETE CASCADE,
  producto_id  INTEGER NOT NULL REFERENCES productos(id),
  nombre       TEXT    NOT NULL,
  cantidad     INTEGER NOT NULL CHECK (cantidad > 0),
  precio_unit  NUMERIC(10,2) NOT NULL,
  subtotal     NUMERIC(10,2) NOT NULL
);

-- Outbox transaccional: el evento se guarda en la MISMA transacción que la venta.
-- estado: PENDIENTE -> PUBLICADO (en cola Redis) -> PROCESADO (ticket listo) | DLQ (falló N veces)
CREATE TABLE IF NOT EXISTS outbox (
  id           BIGSERIAL PRIMARY KEY,
  venta_id     BIGINT      NOT NULL REFERENCES ventas(id) ON DELETE CASCADE,
  tipo         TEXT        NOT NULL DEFAULT 'GENERAR_TICKET',
  estado       TEXT        NOT NULL DEFAULT 'PENDIENTE'
               CHECK (estado IN ('PENDIENTE','PUBLICADO','PROCESADO','DLQ')),
  intentos     INTEGER     NOT NULL DEFAULT 0,
  ultimo_error TEXT,
  creado_en    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  publicado_en TIMESTAMPTZ,
  procesado_en TIMESTAMPTZ
);

-- Tickets generados por el worker (uno por venta)
CREATE TABLE IF NOT EXISTS tickets (
  id          BIGSERIAL PRIMARY KEY,
  venta_id    BIGINT      NOT NULL UNIQUE REFERENCES ventas(id) ON DELETE CASCADE,
  contenido   TEXT        NOT NULL,
  intentos    INTEGER     NOT NULL DEFAULT 1,
  generado_por TEXT,
  creado_en   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ventas_creado    ON ventas(creado_en DESC);
CREATE INDEX IF NOT EXISTS idx_detalle_venta    ON venta_detalle(venta_id);
CREATE INDEX IF NOT EXISTS idx_outbox_estado   ON outbox(estado, creado_en);

-- Seguridad en Supabase: RLS activado y sin políticas.
-- La API pública de Supabase (anon key) no puede leer ni escribir.
-- Solo el backend, conectado con el usuario postgres por el pooler, accede.
ALTER TABLE productos     ENABLE ROW LEVEL SECURITY;
ALTER TABLE ventas        ENABLE ROW LEVEL SECURITY;
ALTER TABLE venta_detalle ENABLE ROW LEVEL SECURITY;
ALTER TABLE outbox        ENABLE ROW LEVEL SECURITY;
ALTER TABLE tickets       ENABLE ROW LEVEL SECURITY;
