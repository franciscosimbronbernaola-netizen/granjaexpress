// =====================================================================
// Prueba de carga k6 - Granja Express Cloud
// Simula una campaña: clientes navegando el catálogo, cajeros vendiendo
// (con reintentos usando la misma Idempotency-Key) y carga de CPU para el HPA.
//   BASE_URL  (por defecto el Service del frontend dentro del clúster)
//   DURACION  minutos en carga máxima (por defecto 3)
//   VUS       usuarios virtuales máximos (por defecto 20)
// =====================================================================
import http from 'k6/http';
import { check, sleep } from 'k6';
import { Counter } from 'k6/metrics';

const BASE = __ENV.BASE_URL || 'http://frontend.granja.svc.cluster.local';
const DURACION = `${__ENV.DURACION || 3}m`;
const VUS = parseInt(__ENV.VUS || '20', 10);

const ventasCreadas = new Counter('ventas_creadas');
const ventasRepetidas = new Counter('ventas_reintento_idempotente');

export const options = {
  scenarios: {
    catalogo: {
      executor: 'ramping-vus',
      exec: 'navegar',
      startVUs: 0,
      stages: [
        { duration: '30s', target: Math.ceil(VUS / 2) },
        { duration: DURACION, target: Math.ceil(VUS / 2) },
        { duration: '30s', target: 0 },
      ],
    },
    cpu: {
      executor: 'ramping-vus',
      exec: 'calcular',
      startVUs: 0,
      stages: [
        { duration: '30s', target: Math.ceil(VUS / 2) },
        { duration: DURACION, target: Math.ceil(VUS / 2) },
        { duration: '30s', target: 0 },
      ],
    },
    ventas: {
      executor: 'constant-arrival-rate',
      exec: 'vender',
      rate: 2,                // 2 ventas por segundo
      timeUnit: '1s',
      duration: DURACION,
      startTime: '30s',
      preAllocatedVUs: 5,
      maxVUs: 10,
    },
  },
  thresholds: {
    http_req_failed: ['rate<0.05'],                 // SLO: menos de 5% de errores
    'http_req_duration{escenario:catalogo}': ['p(95)<1500'],
    'checks{tipo:venta}': ['rate>0.95'],
  },
};

const productos = [1, 2, 3, 4, 5, 8, 9, 10, 11, 12];
const metodos = ['EFECTIVO', 'YAPE', 'PLIN', 'TARJETA'];

export function navegar() {
  const r = http.get(`${BASE}/api/productos`, { tags: { escenario: 'catalogo' } });
  check(r, { 'catálogo 200': (x) => x.status === 200 }, { tipo: 'catalogo' });
  sleep(Math.random() * 1.5 + 0.5);
}

export function calcular() {
  const r = http.get(`${BASE}/api/stress?ms=30`, { tags: { escenario: 'cpu' } });
  check(r, { 'stress 200': (x) => x.status === 200 });
  sleep(0.5);
}

export function vender() {
  const clave = `k6-${__VU}-${__ITER}-${Date.now()}`;
  const n = 1 + Math.floor(Math.random() * 3);
  const items = [];
  for (let i = 0; i < n; i++) {
    items.push({ producto_id: productos[Math.floor(Math.random() * productos.length)], cantidad: 1 + Math.floor(Math.random() * 2) });
  }
  // agrupar el mismo producto para que el contenido sea estable
  const agrupado = Object.values(items.reduce((a, it) => {
    a[it.producto_id] = a[it.producto_id] || { producto_id: it.producto_id, cantidad: 0 };
    a[it.producto_id].cantidad += it.cantidad;
    return a;
  }, {}));
  const cuerpo = JSON.stringify({
    cliente: `Cliente k6 ${__VU}`,
    metodo_pago: metodos[Math.floor(Math.random() * metodos.length)],
    items: agrupado,
  });
  const parametros = { headers: { 'Content-Type': 'application/json', 'Idempotency-Key': clave }, tags: { escenario: 'ventas' } };

  const r = http.post(`${BASE}/api/ventas`, cuerpo, parametros);
  const ok = check(r, { 'venta 201': (x) => x.status === 201 }, { tipo: 'venta' });
  if (ok) ventasCreadas.add(1);

  // 20% de las veces el cliente "reintenta" (ej. timeout del navegador): NO debe duplicarse
  if (Math.random() < 0.2) {
    const r2 = http.post(`${BASE}/api/ventas`, cuerpo, parametros);
    check(r2, {
      'reintento devuelve la misma venta': (x) => x.status === 200 && x.json('duplicada') === true,
    }, { tipo: 'idempotencia' });
    ventasRepetidas.add(1);
  }
}
