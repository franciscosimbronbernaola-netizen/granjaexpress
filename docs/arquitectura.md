# Arquitectura técnica · Granja Express Cloud

## 1. Relación con la rúbrica

| Criterio | Dónde está en el repositorio |
|---|---|
| C1 Análisis y arquitectura base | Secciones 2 y 3 de este documento, `db/schema.sql` |
| C2 Contenedorización y orquestación | `*/Dockerfile`, `docker-compose.yml`, `k8s/app/*` |
| C3 Red, monitoreo y escalabilidad | `k8s/app/70-networkpolicies.yaml`, `k8s/monitoreo/*`, `monitoring/*`, HPA en `30-api.yaml`, `loadtest/*` |
| C4 Resiliencia y patrones | `api/src/index.js`, `api/src/redis.js`, `worker/src/index.js`, PDB, probes, `80-backup.yaml`, `scripts/caos.sh` |
| C5 Demostración | `scripts/setup.sh`, `acceso.sh`, `carga.sh`, `caos.sh` |

## 2. Sistema base y migración

**Antes (monolito):** era una aplicación web única (frontend y backend juntos) desplegada como sitio en un hosting serverless, con base de datos gestionada. Si una parte se saturaba, se degradaba todo el sistema, y no había ni métricas propias ni control de la red.

**Después (microservicios):**

| Servicio | Responsabilidad | Estado | Escala |
|---|---|---|---|
| frontend | Interfaz POS y proxy | Sin estado | Horizontal (2-4) |
| api | Reglas de negocio, ventas | Sin estado | Horizontal (2-6) |
| worker | Tickets asíncronos | Sin estado | Horizontal (1-3) |
| redis | Caché y cola | Volátil | Vertical |
| Supabase | Persistencia | Gestionado | Gestionado por proveedor |

## 3. Requerimientos estimados (escenario de campaña)

| Recurso | Base | Pico (campaña) | Justificación |
|---|---|---|---|
| Tráfico | 2 req/s | 40 req/s | 10 cajas + catálogo consultado por clientes |
| CPU API | 0.15 vCPU | 1.2 vCPU | Medido con k6: ~30 ms de CPU por petición pesada |
| RAM API | 2 × 96 MiB | 6 × 192 MiB | Límite por réplica 192 MiB |
| Redis | 48 MiB | 96 MiB | Catálogo < 50 KB + cola |
| Base de datos | < 50 MB/año | n/a | Unas 300 ventas/día × 1 KB con detalle |
| Respaldos | 7 × ~1 MB | n/a | pg_dump comprimido cada 6 h |

**Modelo de despliegue: híbrido IaaS/PaaS.** La aplicación corre en contenedores sobre Kubernetes, donde el equipo controla la red, el escalado y el monitoreo. La base de datos es **PaaS (Supabase/PostgreSQL)**: el proveedor gestiona los parches y los respaldos físicos.

**Almacenamiento:**
- **SQL relacional** para ventas y stock, porque requieren transacciones ACID y la integridad no admite error.
- **Caché en memoria** (Redis) para el catálogo, que se lee mucho y cambia poco.
- **Volumen de bloques** (PVC) para los respaldos.
- Spanner no se justifica para este volumen; sería el siguiente paso si el negocio operara en varias regiones.

## 4. Red y seguridad

### 4.1 Diseño equivalente en GCP (producción)

| Subred | CIDR | Tipo | Contiene |
|---|---|---|---|
| VPC `granja-vpc` | 10.10.0.0/16 | — | 65 536 IPs |
| `publica` | 10.10.1.0/24 | Pública | Balanceador HTTP(S) |
| `app` | 10.10.10.0/24 | Privada | Nodos GKE (frontend, api, worker) |
| `datos` | 10.10.20.0/24 | Privada | Memorystore (Redis) |
| Cloud NAT | — | Salida | Permite que `app` llegue a Supabase sin IP pública |

**Reglas de firewall:**

| Regla | Origen | Destino | Puerto | Acción |
|---|---|---|---|---|
| allow-https | 0.0.0.0/0 | Balanceador | 443 | Permitir |
| allow-lb-to-app | Rango del LB / health checks | `app` | 8080 | Permitir |
| allow-app-to-redis | `app` | `datos` | 6379 | Permitir |
| deny-all-ingress | * | * | * | Denegar (por defecto) |

### 4.2 Implementación en Minikube

Las subredes se representan con **NetworkPolicies** (Calico) en tres capas, más namespaces separados para la aplicación y el monitoreo:

- **Capa pública:** `frontend` solo acepta tráfico del Ingress Controller.
- **Capa de aplicación:** la `api` solo acepta tráfico del `frontend` y de Prometheus.
- **Capa de datos:** `redis` solo acepta tráfico de `api` y `worker`, y no tiene salida a Internet.

Política base: `denegar-todo-ingreso`. Se valida con `./scripts/caos.sh firewall`.

Otras medidas de seguridad:
- Contenedores **sin root**.
- **Secretos** fuera del código (Secret creado desde `.env`).
- **SSL** hacia Supabase.
- **RLS activo** en todas las tablas, para que la API pública de Supabase no exponga datos.
- **Límite de peticiones** en el Ingress.

## 5. Monitoreo

- **Recolección pull:** Prometheus descubre los pods anotados con `prometheus.io/scrape`.
- **Métricas propias:**
  - `http_requests_total`, `http_request_duration_seconds` (histograma).
  - `granja_ventas_*`, `granja_cache_eventos_total`, `granja_tickets_*`, `granja_redis_breaker_abierto`.
- **Infraestructura:** CPU y memoria por proceso (prom-client) y por contenedor (cAdvisor).
- **Cuatro señales doradas** en el dashboard: latencia (p50, p95, p99), tráfico (req/s), errores (% 5xx) y saturación (CPU, réplicas, cola).
- **Alertas accionables** (`monitoring/prometheus/alertas.yml`): ApiSinReplicas, ApiPocasReplicas, TasaErroresAlta, LatenciaP95Alta, CpuApiSaturada, RedisCircuitBreakerAbierto, ColaTicketsAcumulada y MensajesEnDLQ.

## 6. Escalabilidad y elasticidad

| Estrategia | Implementación |
|---|---|
| Horizontal reactiva | HPA de la API: CPU objetivo 60%, de 2 a 6 réplicas |
| Fórmula | réplicas = ⌈ réplicas_actuales × uso_actual / objetivo ⌉. Ej.: ⌈2 × 150 / 60⌉ = 5 |
| Subida rápida | +2 pods cada 15 s, sin ventana de estabilización |
| Bajada controlada | −1 pod cada 30 s tras 60 s estables (evita oscilación) |
| Vertical | requests/limits por contenedor; Redis escala vertical (más memoria) |
| Programada (propuesta) | Antes de una campaña anunciada: `kubectl scale` o subir `minReplicas` |
| Cuello compartido | Pool de 3 conexiones por réplica: 6 × 3 = 18, dentro del límite del pooler |

## 7. Patrones de diseño cloud y resiliencia

| Patrón | Problema que resuelve | Dónde |
|---|---|---|
| **Cache-aside + TTL** | Catálogo muy consultado | `GET /api/productos` |
| **Idempotencia** (`Idempotency-Key` + UNIQUE + huella SHA-256) | Cobros duplicados por reintentos | `POST /api/ventas` |
| **Outbox transaccional** | Venta guardada pero evento perdido | Tabla `outbox` + relay en el worker |
| **Cola + worker asíncrono** | El ticket no debe frenar la venta | Redis `cola:tickets` |
| **Retry con backoff + jitter** | Fallos transitorios del servicio de impresión | `worker/src/index.js` |
| **Dead Letter Queue** | Mensajes que fallan siempre | `cola:tickets:dlq` + estado `DLQ` |
| **Circuit breaker** | Redis caído no debe tumbar la API | `api/src/redis.js` |
| **Timeouts** | Esperas indefinidas | pg, Redis, Nginx, Ingress |
| **Degradación controlada** | Sin caché se sigue vendiendo | `X-Cache: BYPASS` |
| **Bulkhead** | Aislar recursos | Pools separados API/worker, limits por pod |
| **Health checks** | Sacar réplicas enfermas | startup, readiness (BD) y liveness |
| **Rolling update + PDB** | Actualizar sin caída | `maxUnavailable: 0`, `minAvailable: 1` |
| **Bloqueo ordenado de filas** | Interbloqueos al vender | `SELECT … FOR UPDATE` ordenado por id |

## 8. Alta disponibilidad y DRP

| Objetivo | Valor | Cómo se cumple |
|---|---|---|
| SLO disponibilidad | 99.5 % mensual | ≥ 2 réplicas, probes, PDB |
| SLO latencia | p95 < 500 ms en `/api/*` | HPA + caché |
| RTO (falla de pod) | < 30 s | Medido con `caos.sh todas-api` |
| RTO (pérdida del clúster) | < 15 min | `setup.sh` reconstruye todo desde Git (IaC) |
| RPO | ≤ 6 h (respaldo propio) / PITR del proveedor | CronJob pg_dump + respaldos de Supabase |

**Dominios de falla:**

| Falla | Efecto | Mitigación |
|---|---|---|
| Pod de API | Ninguno visible | Réplicas + Service |
| Redis | Más latencia en el catálogo; ventas OK | Breaker + outbox |
| Worker | Tickets retrasados | Cola + relay |
| Supabase / región | Sin ventas (`/ready` falla) | Dependencia compartida: documentada; en producción, réplica de lectura en otra región |

**Procedimiento de restauración:**
1. Descargar el último respaldo del volumen.
2. Crear un proyecto Supabase nuevo.
3. Restaurar: `gunzip -c respaldo.sql.gz | psql "$NUEVA_URL"`.
4. Actualizar `.env` y correr `./scripts/setup.sh`.
