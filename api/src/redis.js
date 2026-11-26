// Redis protegido con un circuit breaker.
// Cerrado: llamadas normales. Abierto: falla rápido sin tocar Redis.
// Semiabierto: tras la espera deja pasar una llamada de prueba.
const Redis = require('ioredis');
const cfg = require('./config');
const { breakerEstado } = require('./metrics');

const redis = new Redis(cfg.redisUrl, {
  lazyConnect: false,
  enableOfflineQueue: false,    // si Redis no está, error inmediato (no encolar en memoria)
  maxRetriesPerRequest: 1,
  connectTimeout: 2000,
  commandTimeout: 1000,         // timeout por comando
  retryStrategy: (intento) => Math.min(intento * 500, 5000),
});
redis.on('error', (err) => console.warn('[redis]', err.message));

const breaker = { estado: 'CERRADO', fallos: 0, abiertoHasta: 0 };

function abrir() {
  breaker.estado = 'ABIERTO';
  breaker.abiertoHasta = Date.now() + cfg.breakerEsperaMs;
  breakerEstado.set(1);
  console.warn(`[breaker] ABIERTO por ${cfg.breakerEsperaMs} ms`);
}

function cerrar() {
  if (breaker.estado !== 'CERRADO') console.info('[breaker] CERRADO, Redis recuperado');
  breaker.estado = 'CERRADO';
  breaker.fallos = 0;
  breakerEstado.set(0);
}

async function protegido(fn) {
  if (breaker.estado === 'ABIERTO') {
    if (Date.now() < breaker.abiertoHasta) throw new Error('circuit breaker abierto');
    breaker.estado = 'SEMIABIERTO';
  }
  try {
    const r = await fn(redis);
    cerrar();
    return r;
  } catch (err) {
    breaker.fallos += 1;
    if (breaker.estado === 'SEMIABIERTO' || breaker.fallos >= cfg.breakerUmbral) abrir();
    throw err;
  }
}

function estadoBreaker() {
  return { estado: breaker.estado, fallos: breaker.fallos, conexion: redis.status };
}

module.exports = { redis, protegido, estadoBreaker };
