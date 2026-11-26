// =====================================================================
// Granja Express Cloud - API
// Patrones: cache-aside, idempotencia, outbox transaccional,
// circuit breaker, timeouts, health checks y métricas Prometheus.
// =====================================================================
const crypto = require('crypto');
const express = require('express');
const cfg = require('./config');
const { pool, ping } = require('./db');
const { protegido, estadoBreaker } = require('./redis');
const m = require('./metrics');

const app = express();
app.use(express.json({ limit: '100kb' }));
app.use(m.middlewareMetricas);
app.use((req, res, next) => {
  res.set('X-Pod', cfg.pod); // permite ver qué réplica atendió (balanceo)
  next();
});

const CLAVE_CACHE = 'cache:productos';
const inicio = Date.now();
let cerrando = false;

const envolver = (fn) => (req, res, next) => fn(req, res, next).catch(next);

// ---------------------------------------------------------------------
// Salud: liveness (el proceso vive) y readiness (puede atender tráfico)
// ---------------------------------------------------------------------
app.get('/health', (req, res) => res.json({ status: 'ok', pod: cfg.pod }));

app.get('/ready', envolver(async (req, res) => {
  if (cerrando) return res.status(503).json({ status: 'cerrando' });
  try {
    await ping();
    res.json({ status: 'ready', db: 'ok', redis: estadoBreaker() });
  } catch (err) {
    res.status(503).json({ status: 'not_ready', db: err.message });
  }
}));

app.get('/metrics', envolver(async (req, res) => {
  res.set('Content-Type', m.registro.contentType);
  res.end(await m.registro.metrics());
}));

app.get('/api/info', (req, res) => {
  res.json({
    sistema: 'Granja Express Cloud',
    version: cfg.version,
    pod: cfg.pod,
    uptime_s: Math.round((Date.now() - inicio) / 1000),
    redis: estadoBreaker(),
  });
});

// ---------------------------------------------------------------------
// Productos: patrón cache-aside con Redis (TTL + invalidación)
// Si Redis cae, se lee directo de la BD (degradación controlada)
// ---------------------------------------------------------------------
async function leerProductosBD() {
  const r = await pool.query(
    `SELECT id, nombre, categoria, unidad, precio::float AS precio, stock
       FROM productos WHERE activo = TRUE ORDER BY categoria, nombre`
  );
  return r.rows;
}

async function invalidarCache() {
  try {
    await protegido((r) => r.del(CLAVE_CACHE));
  } catch (_) { /* el TTL corto limita la antigüedad del dato */ }
}

app.get('/api/productos', envolver(async (req, res) => {
  try {
    const enCache = await protegido((r) => r.get(CLAVE_CACHE));
    if (enCache) {
      m.cacheEventos.inc({ resultado: 'hit' });
      res.set('X-Cache', 'HIT');
      return res.json(JSON.parse(enCache));
    }
    m.cacheEventos.inc({ resultado: 'miss' });
    const productos = await leerProductosBD();
    protegido((r) => r.set(CLAVE_CACHE, JSON.stringify(productos), 'EX', cfg.cacheTtl)).catch(() => {});
    res.set('X-Cache', 'MISS');
    return res.json(productos);
  } catch (err) {
    // Redis caído o breaker abierto -> la BD es la fuente de verdad
    m.cacheEventos.inc({ resultado: 'bypass' });
    res.set('X-Cache', 'BYPASS');
    return res.json(await leerProductosBD());
  }
}));

app.post('/api/productos/:id/reponer', envolver(async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const cantidad = parseInt(req.body.cantidad, 10);
  if (!id || !cantidad || cantidad <= 0) {
    return res.status(400).json({ error: 'cantidad debe ser un entero mayor a 0' });
  }
  const r = await pool.query(
    `UPDATE productos SET stock = stock + $1, actualizado_en = NOW()
      WHERE id = $2 RETURNING id, nombre, stock`,
    [cantidad, id]
  );
  if (!r.rowCount) return res.status(404).json({ error: 'producto no existe' });
  await invalidarCache();
  res.json(r.rows[0]);
}));

// ---------------------------------------------------------------------
// Ventas: idempotencia + outbox transaccional
// ---------------------------------------------------------------------
function huella(body) {
  const items = [...(body.items || [])]
    .map((i) => ({ producto_id: Number(i.producto_id), cantidad: Number(i.cantidad) }))
    .sort((a, b) => a.producto_id - b.producto_id);
  const base = JSON.stringify({
    cliente: body.cliente || '',
    metodo_pago: body.metodo_pago || 'EFECTIVO',
    items,
  });
  return crypto.createHash('sha256').update(base).digest('hex');
}

async function ventaCompleta(cliente, ventaId) {
  const v = await cliente.query(
    `SELECT id, cliente, metodo_pago, total::float AS total, atendido_por, creado_en
       FROM ventas WHERE id = $1`,
    [ventaId]
  );
  const d = await cliente.query(
    `SELECT producto_id, nombre, cantidad, precio_unit::float AS precio_unit, subtotal::float AS subtotal
       FROM venta_detalle WHERE venta_id = $1 ORDER BY id`,
    [ventaId]
  );
  return { ...v.rows[0], items: d.rows };
}

class ErrorNegocio extends Error {
  constructor(status, mensaje, motivo) {
    super(mensaje);
    this.status = status;
    this.motivo = motivo;
  }
}

app.post('/api/ventas', envolver(async (req, res) => {
  const clave = req.get('Idempotency-Key');
  if (!clave || clave.length < 8 || clave.length > 100) {
    m.ventasRechazadas.inc({ motivo: 'sin_clave' });
    return res.status(400).json({ error: 'Falta el header Idempotency-Key (8 a 100 caracteres)' });
  }
  const items = Array.isArray(req.body.items) ? req.body.items : [];
  if (!items.length || items.some((i) => !Number(i.producto_id) || !(Number(i.cantidad) > 0))) {
    m.ventasRechazadas.inc({ motivo: 'datos_invalidos' });
    return res.status(400).json({ error: 'items debe tener producto_id y cantidad > 0' });
  }
  const metodo = ['EFECTIVO', 'YAPE', 'PLIN', 'TARJETA'].includes(req.body.metodo_pago)
    ? req.body.metodo_pago : 'EFECTIVO';
  const cliente = (req.body.cliente || 'Cliente varios').toString().slice(0, 120);
  const hash = huella(req.body);

  const con = await pool.connect();
  try {
    let ventaId;
    let outboxId;
    try {
      await con.query('BEGIN');

      // 1) Reservar la clave. Si ya existe, otra petición igual ya creó la venta.
      const ins = await con.query(
        `INSERT INTO ventas (idempotency_key, request_hash, cliente, metodo_pago, total, atendido_por)
         VALUES ($1, $2, $3, $4, 0, $5)
         ON CONFLICT (idempotency_key) DO NOTHING
         RETURNING id`,
        [clave, hash, cliente, metodo, cfg.pod]
      );

      if (!ins.rowCount) {
        await con.query('ROLLBACK');
        const previa = await con.query(
          'SELECT id, request_hash FROM ventas WHERE idempotency_key = $1', [clave]
        );
        if (!previa.rowCount) {
          return res.status(409).json({ error: 'La venta con esa clave se está procesando, reintente' });
        }
        if (previa.rows[0].request_hash !== hash) {
          m.ventasRechazadas.inc({ motivo: 'clave_reutilizada' });
          return res.status(422).json({ error: 'Esa Idempotency-Key ya se usó con otro contenido' });
        }
        m.ventasDuplicadas.inc();
        res.set('Idempotent-Replayed', 'true');
        return res.status(200).json({ duplicada: true, venta: await ventaCompleta(con, previa.rows[0].id) });
      }
      ventaId = ins.rows[0].id;

      // 2) Descontar stock con bloqueo de fila (orden fijo para evitar interbloqueos)
      const ordenados = [...items].sort((x, y) => x.producto_id - y.producto_id);
      let total = 0;
      for (const it of ordenados) {
        const p = await con.query(
          'SELECT id, nombre, precio, stock FROM productos WHERE id = $1 AND activo = TRUE FOR UPDATE',
          [it.producto_id]
        );
        if (!p.rowCount) throw new ErrorNegocio(404, `Producto ${it.producto_id} no existe`, 'producto_no_existe');
        const prod = p.rows[0];
        const cant = parseInt(it.cantidad, 10);
        if (prod.stock < cant) {
          throw new ErrorNegocio(409, `Stock insuficiente de ${prod.nombre} (hay ${prod.stock})`, 'sin_stock');
        }
        const subtotal = Math.round(Number(prod.precio) * cant * 100) / 100;
        total += subtotal;
        await con.query('UPDATE productos SET stock = stock - $1, actualizado_en = NOW() WHERE id = $2', [cant, prod.id]);
        await con.query(
          `INSERT INTO venta_detalle (venta_id, producto_id, nombre, cantidad, precio_unit, subtotal)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [ventaId, prod.id, prod.nombre, cant, prod.precio, subtotal]
        );
      }
      total = Math.round(total * 100) / 100;
      await con.query('UPDATE ventas SET total = $1 WHERE id = $2', [total, ventaId]);

      // 3) Outbox: el evento queda guardado en la misma transacción que la venta
      const ob = await con.query('INSERT INTO outbox (venta_id) VALUES ($1) RETURNING id', [ventaId]);
      outboxId = ob.rows[0].id;

      await con.query('COMMIT');
      m.ventasTotal.inc({ metodo_pago: metodo });
      m.ventasMonto.inc(total);
    } catch (err) {
      await con.query('ROLLBACK').catch(() => {});
      if (err instanceof ErrorNegocio) {
        m.ventasRechazadas.inc({ motivo: err.motivo });
        return res.status(err.status).json({ error: err.message });
      }
      throw err;
    }

    // 4) Fuera de la transacción: publicar en la cola. Si Redis falla, el relay
    //    del worker publicará el evento PENDIENTE más tarde (no se pierde).
    try {
      await protegido((r) => r.lpush(cfg.colaTickets, JSON.stringify({ venta_id: ventaId, outbox_id: outboxId, intento: 0 })));
      await con.query(
        `UPDATE outbox SET estado = 'PUBLICADO', publicado_en = NOW() WHERE id = $1 AND estado = 'PENDIENTE'`,
        [outboxId]
      );
    } catch (err) {
      console.warn(`[ventas] venta ${ventaId} guardada; ticket queda PENDIENTE (${err.message})`);
    }
    await invalidarCache();
    return res.status(201).json({ duplicada: false, venta: await ventaCompleta(con, ventaId) });
  } finally {
    con.release();
  }
}));

app.get('/api/ventas', envolver(async (req, res) => {
  const limite = Math.min(parseInt(req.query.limite || '20', 10) || 20, 100);
  const r = await pool.query(
    `SELECT v.id, v.cliente, v.metodo_pago, v.total::float AS total, v.atendido_por, v.creado_en,
            COALESCE(o.estado, 'SIN_EVENTO') AS estado_ticket
       FROM ventas v
       LEFT JOIN outbox o ON o.venta_id = v.id
      ORDER BY v.id DESC
      LIMIT $1`,
    [limite]
  );
  res.json(r.rows);
}));

app.get('/api/ventas/:id/ticket', envolver(async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const t = await pool.query(
    'SELECT contenido, intentos, generado_por, creado_en FROM tickets WHERE venta_id = $1', [id]
  );
  if (t.rowCount) return res.json({ listo: true, ...t.rows[0] });
  const o = await pool.query('SELECT estado, intentos, ultimo_error FROM outbox WHERE venta_id = $1', [id]);
  if (!o.rowCount) return res.status(404).json({ error: 'venta no existe' });
  return res.status(202).json({ listo: false, ...o.rows[0] });
}));

// ---------------------------------------------------------------------
// Caja: resumen del día (hora de Lima)
// ---------------------------------------------------------------------
app.get('/api/caja/resumen', envolver(async (req, res) => {
  const hoy = `(v.creado_en AT TIME ZONE 'America/Lima')::date = (NOW() AT TIME ZONE 'America/Lima')::date`;
  const [tot, porMetodo, top] = await Promise.all([
    pool.query(`SELECT COUNT(*)::int AS ventas, COALESCE(SUM(total),0)::float AS total FROM ventas v WHERE ${hoy}`),
    pool.query(`SELECT metodo_pago, COUNT(*)::int AS ventas, SUM(total)::float AS total
                  FROM ventas v WHERE ${hoy} GROUP BY metodo_pago ORDER BY total DESC`),
    pool.query(`SELECT d.nombre, SUM(d.cantidad)::int AS cantidad, SUM(d.subtotal)::float AS total
                  FROM venta_detalle d JOIN ventas v ON v.id = d.venta_id
                 WHERE ${hoy} GROUP BY d.nombre ORDER BY total DESC LIMIT 5`),
  ]);
  res.json({ ...tot.rows[0], por_metodo: porMetodo.rows, top_productos: top.rows });
}));

// ---------------------------------------------------------------------
// Carga de CPU controlada para la demo del HPA (máx. 500 ms por petición)
// ---------------------------------------------------------------------
app.get('/api/stress', (req, res) => {
  const ms = Math.min(parseInt(req.query.ms || '100', 10) || 100, 500);
  const fin = Date.now() + ms;
  let x = 0;
  while (Date.now() < fin) x += Math.sqrt(Math.random() * 1e6);
  res.json({ pod: cfg.pod, ms, resultado: Math.round(x) % 1000 });
});

// ---------------------------------------------------------------------
app.use((req, res) => res.status(404).json({ error: 'ruta no encontrada' }));
app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
  console.error('[error]', err.message);
  res.status(500).json({ error: 'error interno', detalle: err.message });
});

const servidor = app.listen(cfg.port, () => {
  console.log(`Granja Express API v${cfg.version} en puerto ${cfg.port} (pod ${cfg.pod})`);
});

// Apagado ordenado: Kubernetes envía SIGTERM antes de matar el pod
function apagar(senal) {
  console.log(`[api] ${senal} recibido, cerrando...`);
  cerrando = true;
  servidor.close(async () => {
    await pool.end().catch(() => {});
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10000).unref();
}
process.on('SIGTERM', () => apagar('SIGTERM'));
process.on('SIGINT', () => apagar('SIGINT'));
