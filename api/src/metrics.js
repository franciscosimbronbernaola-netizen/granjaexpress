const client = require('prom-client');
const { pod } = require('./config');

const registro = new client.Registry();
registro.setDefaultLabels({ pod, servicio: 'api' });
client.collectDefaultMetrics({ register: registro }); // CPU, memoria, event loop, GC

const httpPeticiones = new client.Counter({
  name: 'http_requests_total',
  help: 'Total de peticiones HTTP',
  labelNames: ['method', 'route', 'status'],
  registers: [registro],
});

const httpDuracion = new client.Histogram({
  name: 'http_request_duration_seconds',
  help: 'Duración de las peticiones HTTP',
  labelNames: ['method', 'route', 'status'],
  buckets: [0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
  registers: [registro],
});

const ventasTotal = new client.Counter({
  name: 'granja_ventas_total',
  help: 'Ventas registradas correctamente',
  labelNames: ['metodo_pago'],
  registers: [registro],
});

const ventasMonto = new client.Counter({
  name: 'granja_ventas_monto_soles_total',
  help: 'Monto vendido en soles',
  registers: [registro],
});

const ventasDuplicadas = new client.Counter({
  name: 'granja_ventas_duplicadas_evitadas_total',
  help: 'Reintentos con la misma Idempotency-Key que NO generaron otra venta',
  registers: [registro],
});

const ventasRechazadas = new client.Counter({
  name: 'granja_ventas_rechazadas_total',
  help: 'Ventas rechazadas (stock insuficiente, datos inválidos, clave reutilizada)',
  labelNames: ['motivo'],
  registers: [registro],
});

const cacheEventos = new client.Counter({
  name: 'granja_cache_eventos_total',
  help: 'Eventos de caché del catálogo (hit, miss, bypass)',
  labelNames: ['resultado'],
  registers: [registro],
});

const breakerEstado = new client.Gauge({
  name: 'granja_redis_breaker_abierto',
  help: '1 si el circuit breaker hacia Redis está abierto',
  registers: [registro],
});

function middlewareMetricas(req, res, next) {
  if (req.path === '/metrics') return next();
  const fin = httpDuracion.startTimer();
  res.on('finish', () => {
    const ruta = req.route ? (req.baseUrl || '') + req.route.path : 'no_encontrada';
    const etiquetas = { method: req.method, route: ruta, status: String(res.statusCode) };
    httpPeticiones.inc(etiquetas);
    fin(etiquetas);
  });
  next();
}

module.exports = {
  registro,
  middlewareMetricas,
  ventasTotal,
  ventasMonto,
  ventasDuplicadas,
  ventasRechazadas,
  cacheEventos,
  breakerEstado,
};
