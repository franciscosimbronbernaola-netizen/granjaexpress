const os = require('os');

module.exports = {
  port: parseInt(process.env.PORT || '3000', 10),
  pod: process.env.POD_NAME || os.hostname(),
  version: process.env.APP_VERSION || '1.0.0',

  // Base de datos (Supabase usa el pooler: puerto 6543, modo transacción)
  databaseUrl: process.env.DATABASE_URL || 'postgres://postgres:postgres@localhost:5432/granja',
  pgSsl: (process.env.PGSSL || 'false') === 'true',
  pgPoolMax: parseInt(process.env.PG_POOL_MAX || '3', 10),

  // Redis: caché del catálogo + cola de tickets
  redisUrl: process.env.REDIS_URL || 'redis://localhost:6379',
  cacheTtl: parseInt(process.env.CACHE_TTL_SECONDS || '30', 10),
  colaTickets: process.env.COLA_TICKETS || 'cola:tickets',

  // Circuit breaker hacia Redis
  breakerUmbral: parseInt(process.env.BREAKER_UMBRAL || '3', 10),
  breakerEsperaMs: parseInt(process.env.BREAKER_ESPERA_MS || '10000', 10),
};
