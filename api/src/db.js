const { Pool } = require('pg');
const cfg = require('./config');

const pool = new Pool({
  connectionString: cfg.databaseUrl,
  ssl: cfg.pgSsl ? { rejectUnauthorized: false } : false,
  max: cfg.pgPoolMax,               // pocas conexiones por réplica: el pooler de Supabase tiene límite
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,    // timeout: no esperar indefinidamente a la BD
  query_timeout: 8000,
});

pool.on('error', (err) => console.error('[db] error en conexión inactiva:', err.message));

async function ping() {
  const r = await pool.query('SELECT 1 AS ok');
  return r.rows[0].ok === 1;
}

module.exports = { pool, ping };
