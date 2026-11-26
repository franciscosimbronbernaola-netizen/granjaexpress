// =====================================================================
// Granja Express Cloud - Worker de tickets
// 1) Consume la cola Redis y genera el ticket de cada venta.
// 2) Reintentos con backoff exponencial + jitter; tras N fallos -> DLQ.
// 3) Relay del outbox: re-publica eventos PENDIENTES o perdidos.
// 4) Deduplicación: un solo ticket por venta (UNIQUE venta_id).
// =====================================================================
const http = require('http');
const os = require('os');
const { Pool } = require('pg');
const Redis = require('ioredis');
const client = require('prom-client');

const cfg = {
  pod: process.env.POD_NAME || os.hostname(),
  databaseUrl: process.env.DATABASE_URL || 'postgres://postgres:postgres@localhost:5432/granja',
  pgSsl: (process.env.PGSSL || 'false') === 'true',
  pgPoolMax: parseInt(process.env.PG_POOL_MAX || '2', 10),
  redisUrl: process.env.REDIS_URL || 'redis://localhost:6379',
  cola: process.env.COLA_TICKETS || 'cola:tickets',
  dlq: process.env.COLA_DLQ || 'cola:tickets:dlq',
  maxIntentos: parseInt(process.env.MAX_INTENTOS || '3', 10),
  probFalla: parseFloat(process.env.PROB_FALLA_TICKET || '0'), // simula fallo del "proveedor de impresión"
  demoraMs: parseInt(process.env.DEMORA_TICKET_MS || '200', 10),
  relayCadaMs: parseInt(process.env.RELAY_CADA_MS || '5000', 10),
  metricsPort: parseInt(process.env.METRICS_PORT || '9100', 10),
};

// ----------------------------- métricas -----------------------------
const registro = new client.Registry();
registro.setDefaultLabels({ pod: cfg.pod, servicio: 'worker' });
client.collectDefaultMetrics({ register: registro });
const procesados = new client.Counter({ name: 'granja_tickets_procesados_total', help: 'Tickets generados', registers: [registro] });
const reintentos = new client.Counter({ name: 'granja_tickets_reintentos_total', help: 'Reintentos de tickets', registers: [registro] });
const enviadosDlq = new client.Counter({ name: 'granja_tickets_dlq_total', help: 'Mensajes enviados a la DLQ', registers: [registro] });
const duplicados = new client.Counter({ name: 'granja_tickets_duplicados_total', help: 'Mensajes repetidos ignorados (ya tenía ticket)', registers: [registro] });
const republicados = new client.Counter({ name: 'granja_outbox_republicados_total', help: 'Eventos re-publicados por el relay', registers: [registro] });
const largoCola = new client.Gauge({ name: 'granja_cola_tickets_largo', help: 'Mensajes en cola', labelNames: ['cola'], registers: [registro] });
const duracion = new client.Histogram({
  name: 'granja_ticket_duracion_seconds', help: 'Tiempo de generación del ticket',
  buckets: [0.05, 0.1, 0.25, 0.5, 1, 2, 5], registers: [registro],
});

// ----------------------------- conexiones ---------------------------
const pool = new Pool({
  connectionString: cfg.databaseUrl,
  ssl: cfg.pgSsl ? { rejectUnauthorized: false } : false,
  max: cfg.pgPoolMax,
  connectionTimeoutMillis: 5000,
  query_timeout: 8000,
});
pool.on('error', (e) => console.error('[db]', e.message));

const opcionesRedis = { maxRetriesPerRequest: null, retryStrategy: (n) => Math.min(n * 500, 5000) };
const redis = new Redis(cfg.redisUrl, opcionesRedis);       // comandos normales
const bloqueante = new Redis(cfg.redisUrl, opcionesRedis);  // BRPOP bloquea la conexión
redis.on('error', (e) => console.warn('[redis]', e.message));
bloqueante.on('error', () => {});

let activo = true;
const dormir = (ms) => new Promise((r) => setTimeout(r, ms));

// ------------------------- generación de ticket ----------------------
async function generarTicket(ventaId) {
  const v = await pool.query(
    `SELECT id, cliente, metodo_pago, total::float AS total, atendido_por,
            to_char(creado_en AT TIME ZONE 'America/Lima', 'DD/MM/YYYY HH24:MI:SS') AS fecha
       FROM ventas WHERE id = $1`, [ventaId]
  );
  if (!v.rowCount) throw new Error(`venta ${ventaId} no existe`);
  const d = await pool.query(
    `SELECT nombre, cantidad, precio_unit::float AS pu, subtotal::float AS st
       FROM venta_detalle WHERE venta_id = $1 ORDER BY id`, [ventaId]
  );
  const venta = v.rows[0];
  const linea = '-'.repeat(40);
  const filas = d.rows.map((r) =>
    `${r.nombre.slice(0, 22).padEnd(22)} ${String(r.cantidad).padStart(4)} x ${r.pu.toFixed(2).padStart(6)}\n` +
    `${''.padEnd(30)}S/ ${r.st.toFixed(2).padStart(7)}`
  );
  return [
    '         GRANJA EXPRESS S.A.C.',
    '      Productos de granja - Huánuco',
    '        NOTA DE VENTA (no fiscal)',
    linea,
    `Nro: NV-${String(venta.id).padStart(8, '0')}`,
    `Fecha: ${venta.fecha}`,
    `Cliente: ${venta.cliente}`,
    `Pago: ${venta.metodo_pago}`,
    linea,
    ...filas,
    linea,
    `TOTAL${''.padEnd(25)}S/ ${venta.total.toFixed(2).padStart(7)}`,
    linea,
    `Atendido por: ${venta.atendido_por}`,
    `Ticket generado por: ${cfg.pod}`,
    '       ¡Gracias por su compra!',
  ].join('\n');
}

async function procesar(msg) {
  const fin = duracion.startTimer();
  const ya = await pool.query('SELECT 1 FROM tickets WHERE venta_id = $1', [msg.venta_id]);
  if (ya.rowCount) { // mensaje repetido (relay o reintento): no duplicar
    duplicados.inc();
    await pool.query(`UPDATE outbox SET estado='PROCESADO', procesado_en=COALESCE(procesado_en, NOW()) WHERE venta_id=$1`, [msg.venta_id]);
    return;
  }
  await dormir(cfg.demoraMs); // simula el tiempo del servicio de impresión
  if (Math.random() < cfg.probFalla) throw new Error('servicio de impresión no disponible (simulado)');

  const contenido = await generarTicket(msg.venta_id);
  const con = await pool.connect();
  try {
    await con.query('BEGIN');
    const ins = await con.query(
      `INSERT INTO tickets (venta_id, contenido, intentos, generado_por)
       VALUES ($1, $2, $3, $4) ON CONFLICT (venta_id) DO NOTHING`,
      [msg.venta_id, contenido, (msg.intento || 0) + 1, cfg.pod]
    );
    await con.query(
      `UPDATE outbox SET estado='PROCESADO', procesado_en=NOW(), intentos=$2, ultimo_error=NULL WHERE venta_id=$1`,
      [msg.venta_id, (msg.intento || 0) + 1]
    );
    await con.query('COMMIT');
    if (ins.rowCount) procesados.inc(); else duplicados.inc();
  } catch (e) {
    await con.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    con.release();
    fin();
  }
}

async function manejarFallo(msg, err) {
  const intento = (msg.intento || 0) + 1;
  await pool.query('UPDATE outbox SET intentos=$2, ultimo_error=$3 WHERE venta_id=$1',
    [msg.venta_id, intento, err.message.slice(0, 300)]).catch(() => {});
  if (intento >= cfg.maxIntentos) {
    await redis.lpush(cfg.dlq, JSON.stringify({ ...msg, intento, error: err.message, en: new Date().toISOString() }));
    await pool.query(`UPDATE outbox SET estado='DLQ' WHERE venta_id=$1`, [msg.venta_id]).catch(() => {});
    enviadosDlq.inc();
    console.error(`[worker] venta ${msg.venta_id} -> DLQ tras ${intento} intentos: ${err.message}`);
    return;
  }
  // Backoff exponencial con jitter: 500ms, 1s, 2s... ± aleatorio
  const espera = Math.min(500 * 2 ** (intento - 1), 8000) * (0.5 + Math.random());
  reintentos.inc();
  console.warn(`[worker] venta ${msg.venta_id} falló (intento ${intento}), reintento en ${Math.round(espera)} ms`);
  await dormir(espera);
  await redis.lpush(cfg.cola, JSON.stringify({ ...msg, intento }));
}

async function bucleConsumidor() {
  console.log(`[worker] ${cfg.pod} escuchando ${cfg.cola} (prob. falla ${cfg.probFalla})`);
  while (activo) {
    let item;
    try {
      item = await bloqueante.brpop(cfg.cola, 5);
    } catch (e) {
      await dormir(1000);
      continue;
    }
    if (!item) continue;
    let msg;
    try { msg = JSON.parse(item[1]); } catch (_) { continue; }
    try {
      await procesar(msg);
    } catch (err) {
      await manejarFallo(msg, err).catch((e) => console.error('[worker] error manejando fallo:', e.message));
    }
  }
}

// ------------------------------ relay outbox --------------------------
// Re-publica: PENDIENTE con > 10 s (Redis falló al vender) y
// PUBLICADO con > 2 min sin procesar (mensaje perdido si Redis reinició).
async function relay() {
  const con = await pool.connect();
  try {
    await con.query('BEGIN');
    const r = await con.query(
      `SELECT id, venta_id, intentos FROM outbox
        WHERE (estado = 'PENDIENTE' AND creado_en < NOW() - INTERVAL '10 seconds')
           OR (estado = 'PUBLICADO' AND publicado_en < NOW() - INTERVAL '2 minutes')
        ORDER BY id LIMIT 50
        FOR UPDATE SKIP LOCKED`
    );
    for (const row of r.rows) {
      await redis.lpush(cfg.cola, JSON.stringify({ venta_id: Number(row.venta_id), outbox_id: Number(row.id), intento: row.intentos, relay: true }));
      await con.query(`UPDATE outbox SET estado='PUBLICADO', publicado_en=NOW() WHERE id=$1`, [row.id]);
      republicados.inc();
    }
    await con.query('COMMIT');
    if (r.rowCount) console.log(`[relay] ${r.rowCount} evento(s) re-publicado(s)`);
  } catch (e) {
    await con.query('ROLLBACK').catch(() => {});
    console.warn('[relay]', e.message);
  } finally {
    con.release();
  }
}

async function bucleRelay() {
  while (activo) {
    await relay().catch(() => {});
    try {
      largoCola.set({ cola: 'tickets' }, await redis.llen(cfg.cola));
      largoCola.set({ cola: 'dlq' }, await redis.llen(cfg.dlq));
    } catch (_) { /* Redis caído */ }
    await dormir(cfg.relayCadaMs);
  }
}

// --------------------------- servidor métricas ------------------------
const servidor = http.createServer(async (req, res) => {
  if (req.url === '/metrics') {
    res.setHeader('Content-Type', registro.contentType);
    return res.end(await registro.metrics());
  }
  if (req.url === '/health') {
    res.setHeader('Content-Type', 'application/json');
    return res.end(JSON.stringify({ status: 'ok', pod: cfg.pod, redis: redis.status }));
  }
  res.statusCode = 404;
  res.end();
});
servidor.listen(cfg.metricsPort, () => console.log(`[worker] métricas en :${cfg.metricsPort}/metrics`));

bucleConsumidor();
bucleRelay();

function apagar() {
  console.log('[worker] SIGTERM: terminando el mensaje actual y saliendo...');
  activo = false;
  setTimeout(async () => {
    servidor.close();
    bloqueante.disconnect();
    redis.disconnect();
    await pool.end().catch(() => {});
    process.exit(0);
  }, 6000).unref();
}
process.on('SIGTERM', apagar);
process.on('SIGINT', apagar);
