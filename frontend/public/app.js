// Granja Express Cloud - Frontend (JS sin frameworks)
const API = '/api';
const $ = (s) => document.querySelector(s);
const soles = (n) => `S/ ${Number(n || 0).toFixed(2)}`;
const esc = (t) => String(t ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const estado = {
  productos: [],
  categoria: 'Todas',
  carrito: new Map(), // producto_id -> { producto, cantidad }
  metodo: 'EFECTIVO',
  clave: null,        // Idempotency-Key de la venta en curso (se reutiliza en reintentos)
};

// ---------------------------------------------------------------- utilidades
function toast(msg, tipo = '') {
  const t = $('#toast');
  t.textContent = msg;
  t.className = `toast ${tipo}`;
  t.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { t.hidden = true; }, 3500);
}

async function pedir(ruta, opciones = {}, timeoutMs = 8000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(API + ruta, {
      ...opciones,
      signal: ctrl.signal,
      headers: { 'Content-Type': 'application/json', ...(opciones.headers || {}) },
    });
    const datos = await r.json().catch(() => ({}));
    return { ok: r.ok, status: r.status, datos, pod: r.headers.get('X-Pod'), cache: r.headers.get('X-Cache') };
  } finally {
    clearTimeout(timer);
  }
}

function nuevaClave() {
  return (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`);
}

function marcarConexion(ok, texto) {
  const e = $('#estadoConexion');
  e.className = `estado ${ok ? 'ok' : 'mal'}`;
  $('#textoEstado').textContent = texto;
}

// ---------------------------------------------------------------- pestañas
document.querySelectorAll('.tab').forEach((b) => b.addEventListener('click', () => {
  document.querySelectorAll('.tab').forEach((x) => x.classList.toggle('activa', x === b));
  document.querySelectorAll('.vista').forEach((v) => v.classList.toggle('activa', v.id === `vista-${b.dataset.vista}`));
  if (b.dataset.vista === 'ventas') cargarVentas();
  if (b.dataset.vista === 'caja') cargarCaja();
  if (b.dataset.vista === 'sistema') cargarInfo();
}));

// ---------------------------------------------------------------- catálogo
async function cargarProductos() {
  try {
    const r = await pedir('/productos');
    if (!r.ok) throw new Error(r.datos.error || r.status);
    estado.productos = r.datos;
    marcarConexion(true, `En línea · ${r.pod || ''}`);
    $('#metaCatalogo').textContent = `${r.datos.length} productos · caché: ${r.cache || '—'} · atendido por ${r.pod}`;
    pintarCategorias();
    pintarProductos();
  } catch (e) {
    marcarConexion(false, 'Sin conexión');
    $('#metaCatalogo').textContent = 'No se pudo cargar el catálogo. Reintentando…';
  }
}

function pintarCategorias() {
  const cats = ['Todas', ...new Set(estado.productos.map((p) => p.categoria))];
  $('#categorias').innerHTML = cats.map((c) =>
    `<button class="chip ${c === estado.categoria ? 'activo' : ''}" data-cat="${esc(c)}">${esc(c)}</button>`).join('');
  $('#categorias').querySelectorAll('.chip').forEach((b) => b.addEventListener('click', () => {
    estado.categoria = b.dataset.cat;
    pintarCategorias();
    pintarProductos();
  }));
}

function pintarProductos() {
  const q = $('#buscar').value.trim().toLowerCase();
  const lista = estado.productos.filter((p) =>
    (estado.categoria === 'Todas' || p.categoria === estado.categoria) &&
    (!q || p.nombre.toLowerCase().includes(q)));
  $('#productos').innerHTML = lista.map((p) => `
    <button class="producto" data-id="${p.id}" ${p.stock <= 0 ? 'disabled' : ''}>
      <span class="cat">${esc(p.categoria)}</span>
      <span class="nom">${esc(p.nombre)}</span>
      <span class="pie"><span class="precio">${soles(p.precio)}<small>/${esc(p.unidad)}</small></span>
      <span class="stock">Stock ${p.stock}</span></span>
    </button>`).join('') || '<p class="vacio">Sin resultados</p>';
  $('#productos').querySelectorAll('.producto').forEach((b) =>
    b.addEventListener('click', () => agregar(Number(b.dataset.id))));
}
$('#buscar').addEventListener('input', pintarProductos);

// ---------------------------------------------------------------- carrito
function agregar(id, delta = 1) {
  const p = estado.productos.find((x) => x.id === id);
  if (!p) return;
  const actual = estado.carrito.get(id) || { producto: p, cantidad: 0 };
  actual.cantidad += delta;
  if (actual.cantidad <= 0) estado.carrito.delete(id);
  else estado.carrito.set(id, actual);
  estado.clave = null; // el contenido cambió: nueva venta lógica
  pintarCarrito();
}

function pintarCarrito() {
  const items = [...estado.carrito.values()];
  const total = items.reduce((s, i) => s + i.producto.precio * i.cantidad, 0);
  $('#itemsCarrito').innerHTML = items.length ? items.map((i) => `
    <div class="item">
      <span class="nom">${esc(i.producto.nombre)}</span>
      <span class="sub">${soles(i.producto.precio * i.cantidad)}</span>
      <span class="cantidad">
        <button data-id="${i.producto.id}" data-d="-1" aria-label="Quitar uno">−</button>
        ${i.cantidad} ${esc(i.producto.unidad)}
        <button data-id="${i.producto.id}" data-d="1" aria-label="Agregar uno">+</button>
      </span>
    </div>`).join('') : '<p class="vacio">Agrega productos del catálogo</p>';
  $('#itemsCarrito').querySelectorAll('button').forEach((b) =>
    b.addEventListener('click', () => agregar(Number(b.dataset.id), Number(b.dataset.d))));
  $('#totalCarrito').textContent = soles(total);
  $('#btnCobrar').disabled = !items.length;
  $('#claveVenta').textContent = estado.clave ? `Idempotency-Key: ${estado.clave}` : '';
}

document.querySelectorAll('.metodo').forEach((b) => b.addEventListener('click', () => {
  estado.metodo = b.dataset.metodo;
  estado.clave = null;
  document.querySelectorAll('.metodo').forEach((x) => x.classList.toggle('activo', x === b));
}));

$('#btnLimpiar').addEventListener('click', () => {
  estado.carrito.clear();
  estado.clave = null;
  $('#cliente').value = '';
  pintarCarrito();
});

// Cobrar: la MISMA clave se reutiliza si hay timeout o error de red,
// así el servidor nunca registra la venta dos veces.
$('#btnCobrar').addEventListener('click', async () => {
  if (!estado.clave) estado.clave = nuevaClave();
  const cuerpo = {
    cliente: $('#cliente').value.trim() || 'Cliente varios',
    metodo_pago: estado.metodo,
    items: [...estado.carrito.values()].map((i) => ({ producto_id: i.producto.id, cantidad: i.cantidad })),
  };
  const btn = $('#btnCobrar');
  btn.disabled = true;
  btn.textContent = 'Procesando…';
  pintarCarrito();
  try {
    let r;
    for (let intento = 1; intento <= 3; intento++) {
      try {
        r = await pedir('/ventas', {
          method: 'POST',
          headers: { 'Idempotency-Key': estado.clave },
          body: JSON.stringify(cuerpo),
        });
        if (r.status < 500) break;
      } catch (_) { /* timeout o red: se reintenta con la misma clave */ }
      await new Promise((ok) => setTimeout(ok, 400 * intento));
    }
    if (!r) throw new Error('Sin respuesta del servidor');
    if (!r.ok) throw new Error(r.datos.error || `Error ${r.status}`);
    const v = r.datos.venta;
    toast(r.datos.duplicada
      ? `Venta NV-${v.id} ya estaba registrada (reintento seguro)`
      : `Venta NV-${v.id} registrada · ${soles(v.total)} · pod ${r.pod}`, 'ok');
    estado.carrito.clear();
    estado.clave = null;
    $('#cliente').value = '';
    pintarCarrito();
    cargarProductos();
  } catch (e) {
    toast(e.message, 'error');
  } finally {
    btn.textContent = 'Cobrar';
    btn.disabled = !estado.carrito.size;
  }
});

// ---------------------------------------------------------------- ventas
async function cargarVentas() {
  const r = await pedir('/ventas?limite=30').catch(() => null);
  if (!r || !r.ok) { $('#tablaVentas').innerHTML = '<tr><td colspan="8">No se pudo cargar</td></tr>'; return; }
  $('#tablaVentas').innerHTML = r.datos.map((v) => `
    <tr>
      <td>NV-${String(v.id).padStart(6, '0')}</td>
      <td>${new Date(v.creado_en).toLocaleString('es-PE')}</td>
      <td>${esc(v.cliente)}</td>
      <td>${esc(v.metodo_pago)}</td>
      <td class="num">${soles(v.total)}</td>
      <td class="pod">${esc(v.atendido_por)}</td>
      <td><span class="etiqueta ${esc(v.estado_ticket)}">${esc(v.estado_ticket)}</span></td>
      <td><button class="enlace" data-id="${v.id}">Ver ticket</button></td>
    </tr>`).join('') || '<tr><td colspan="8">Aún no hay ventas</td></tr>';
  $('#tablaVentas').querySelectorAll('.enlace').forEach((b) =>
    b.addEventListener('click', () => verTicket(b.dataset.id)));
}
$('#btnRecargarVentas').addEventListener('click', cargarVentas);

async function verTicket(id) {
  const r = await pedir(`/ventas/${id}/ticket`);
  $('#modalTitulo').textContent = `Ticket NV-${String(id).padStart(6, '0')}`;
  $('#modalContenido').textContent = r.datos.listo
    ? r.datos.contenido
    : `El ticket aún no está listo.\nEstado: ${r.datos.estado}\nIntentos: ${r.datos.intentos}\n${r.datos.ultimo_error ? `Último error: ${r.datos.ultimo_error}` : ''}`;
  $('#modal').hidden = false;
}
$('#cerrarModal').addEventListener('click', () => { $('#modal').hidden = true; });
$('#modal').addEventListener('click', (e) => { if (e.target.id === 'modal') $('#modal').hidden = true; });

// ---------------------------------------------------------------- caja
function barras(filas, etiqueta, valor) {
  const max = Math.max(...filas.map(valor), 1);
  return filas.map((f) => `
    <div class="barra-fila"><span>${esc(etiqueta(f))}</span>
      <span class="barra-fondo"><span class="barra-relleno" style="width:${(valor(f) / max) * 100}%"></span></span>
      <strong>${soles(valor(f))}</strong></div>`).join('') || '<p class="vacio">Sin ventas hoy</p>';
}

async function cargarCaja() {
  const r = await pedir('/caja/resumen').catch(() => null);
  if (!r || !r.ok) return toast('No se pudo cargar la caja', 'error');
  const c = r.datos;
  $('#kpiVentas').textContent = c.ventas;
  $('#kpiTotal').textContent = soles(c.total);
  $('#kpiPromedio').textContent = soles(c.ventas ? c.total / c.ventas : 0);
  $('#porMetodo').innerHTML = barras(c.por_metodo, (f) => `${f.metodo_pago} (${f.ventas})`, (f) => f.total);
  $('#topProductos').innerHTML = barras(c.top_productos, (f) => `${f.nombre} (${f.cantidad})`, (f) => f.total);
}
$('#btnRecargarCaja').addEventListener('click', cargarCaja);

// ---------------------------------------------------------------- sistema
async function cargarInfo() {
  const r = await pedir('/info').catch(() => null);
  if (!r || !r.ok) { $('#infoApi').innerHTML = '<dt>Estado</dt><dd>Sin conexión</dd>'; return; }
  const i = r.datos;
  $('#infoApi').innerHTML = `
    <dt>Versión</dt><dd>${esc(i.version)}</dd>
    <dt>Pod</dt><dd>${esc(i.pod)}</dd>
    <dt>Uptime</dt><dd>${i.uptime_s} s</dd>
    <dt>Redis</dt><dd>${esc(i.redis.conexion)}</dd>
    <dt>Circuit breaker</dt><dd>${esc(i.redis.estado)}</dd>`;
}

$('#btnBalanceo').addEventListener('click', async () => {
  const conteo = {};
  const respuestas = await Promise.all(Array.from({ length: 30 }, () => pedir('/info').catch(() => null)));
  respuestas.forEach((r) => { const p = r?.pod || 'error'; conteo[p] = (conteo[p] || 0) + 1; });
  const filas = Object.entries(conteo).map(([pod, n]) => ({ pod, n }));
  const max = Math.max(...filas.map((f) => f.n));
  $('#resultadoBalanceo').innerHTML = filas.map((f) => `
    <div class="barra-fila"><span class="pod">${esc(f.pod)}</span>
      <span class="barra-fondo"><span class="barra-relleno" style="width:${(f.n / max) * 100}%"></span></span>
      <strong>${f.n}</strong></div>`).join('');
});

// ---------------------------------------------------------------- inicio
cargarProductos();
setInterval(cargarProductos, 15000);
