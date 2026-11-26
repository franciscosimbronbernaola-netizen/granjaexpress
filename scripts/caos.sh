#!/usr/bin/env bash
# =====================================================================
# Pruebas de tolerancia a fallos (para la demo en vivo)
# Uso: ./scripts/caos.sh <prueba>
#   pod-api        Elimina una réplica de la API -> Kubernetes la recrea
#   todas-api      Elimina TODAS las réplicas a la vez -> autorecuperación
#   redis          Elimina Redis -> la API sigue vendiendo sin caché (breaker)
#   worker         Elimina el worker -> los tickets esperan en cola/outbox
#   impresora      Sube los fallos de tickets al 60% -> reintentos y DLQ
#   restaurar      Vuelve la probabilidad de fallo a 5%
#   firewall       Prueba que el frontend NO puede llegar directo a Redis
#   estado         Muestra pods, HPA y eventos recientes
# =====================================================================
set -uo pipefail
NS=granja
AZUL='\033[0;36m'; NC='\033[0m'
t() { echo -e "${AZUL}[$(date +%H:%M:%S)] $*${NC}"; }

venta_prueba() {
  local pod clave
  pod=$(kubectl -n $NS get pod -l app=frontend -o jsonpath='{.items[0].metadata.name}')
  clave="caos-$(date +%s%N)"
  kubectl -n $NS exec "$pod" -- wget -qO- --header="Content-Type: application/json" \
    --header="Idempotency-Key: $clave" \
    --post-data='{"cliente":"Prueba de caos","items":[{"producto_id":1,"cantidad":1}]}' \
    http://api:3000/api/ventas 2>&1 | head -c 160; echo
}

case "${1:-}" in
  pod-api)
    V=$(kubectl -n $NS get pod -l app=api -o jsonpath='{.items[0].metadata.name}')
    t "Antes:"; kubectl -n $NS get pods -l app=api
    t "Eliminando $V ..."
    kubectl -n $NS delete pod "$V" --wait=false
    t "Venta durante la falla:"; venta_prueba
    sleep 2; t "Kubernetes recupera el estado deseado:"
    kubectl -n $NS get pods -l app=api
    kubectl -n $NS rollout status deployment/api --timeout=120s
    ;;
  todas-api)
    t "Eliminando TODAS las réplicas de la API..."
    kubectl -n $NS delete pod -l app=api --wait=false
    INICIO=$(date +%s)
    kubectl -n $NS rollout status deployment/api --timeout=180s
    t "Recuperado en $(( $(date +%s) - INICIO )) s (esto es el RTO medido)"
    venta_prueba
    ;;
  redis)
    t "Eliminando Redis..."
    kubectl -n $NS delete pod -l app=redis --wait=false
    sleep 1
    t "Venta con Redis caído (debe responder 201):"; venta_prueba
    t "Catálogo con Redis caído (X-Cache: BYPASS):"
    P=$(kubectl -n $NS get pod -l app=frontend -o jsonpath='{.items[0].metadata.name}')
    kubectl -n $NS exec "$P" -- wget -S -qO- http://api:3000/api/productos 2>&1 | grep -i "x-cache\|x-pod"
    kubectl -n $NS rollout status deployment/redis --timeout=120s
    t "Redis volvió. El relay del worker re-publica los tickets pendientes en ~10 s."
    ;;
  worker)
    t "Eliminando el worker..."
    kubectl -n $NS scale deployment/worker --replicas=0
    for i in 1 2 3; do venta_prueba; done
    t "Ventas guardadas; tickets en cola. Esperando 15 s y levantando el worker..."
    sleep 15
    kubectl -n $NS scale deployment/worker --replicas=1
    kubectl -n $NS rollout status deployment/worker --timeout=120s
    t "El worker procesa lo acumulado. Revisa la pestaña Ventas."
    ;;
  impresora)
    kubectl -n $NS set env deployment/worker PROB_FALLA_TICKET=0.6
    kubectl -n $NS rollout status deployment/worker --timeout=120s
    for i in $(seq 8); do venta_prueba >/dev/null; done
    t "8 ventas creadas con 60% de fallos. Mira los reintentos:"
    sleep 12
    kubectl -n $NS logs deployment/worker --tail=20 | grep -E "reintento|DLQ" || true
    ;;
  restaurar)
    kubectl -n $NS set env deployment/worker PROB_FALLA_TICKET-
    kubectl -n $NS rollout status deployment/worker --timeout=120s
    t "Worker restaurado (usa el valor del ConfigMap: 5%)."
    ;;
  firewall)
    P=$(kubectl -n $NS get pod -l app=frontend -o jsonpath='{.items[0].metadata.name}')
    t "Frontend -> API (permitido):"
    kubectl -n $NS exec "$P" -- wget -qO- -T 3 http://api:3000/health && echo
    t "Frontend -> Redis (bloqueado por NetworkPolicy, debe fallar por timeout):"
    if kubectl -n $NS exec "$P" -- sh -c 'nc -z -w 3 redis 6379' 2>/dev/null; then
      echo "CONECTÓ (¿el clúster tiene Calico? ver ./scripts/setup.sh)"
    else
      echo "BLOQUEADO ✔"
    fi
    t "Frontend -> Internet (bloqueado):"
    if kubectl -n $NS exec "$P" -- wget -qO- -T 3 http://example.com >/dev/null 2>&1; then
      echo "CONECTÓ"
    else
      echo "BLOQUEADO ✔"
    fi
    ;;
  estado)
    kubectl -n $NS get pods -o wide
    echo; kubectl -n $NS get hpa
    echo; kubectl -n $NS get events --sort-by=.lastTimestamp | tail -15
    ;;
  *)
    sed -n '3,14p' "$0"
    ;;
esac
