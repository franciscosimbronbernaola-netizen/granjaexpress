#!/usr/bin/env bash
# =====================================================================
# Granja Express Cloud - Despliegue completo en Minikube (Cloud Shell)
# Uso:  ./scripts/setup.sh            (crea/usa el clúster y despliega todo)
#       RECREAR=1 ./scripts/setup.sh  (borra el clúster y lo crea de nuevo)
# Variables opcionales: CPUS (2), MEMORIA (2200)
# =====================================================================
set -euo pipefail
cd "$(dirname "$0")/.."

CPUS="${CPUS:-2}"
MEMORIA="${MEMORIA:-2200}"
VERDE='\033[0;32m'; AMARILLO='\033[1;33m'; ROJO='\033[0;31m'; NC='\033[0m'
paso() { echo -e "\n${VERDE}==> $*${NC}"; }
aviso() { echo -e "${AMARILLO}[!] $*${NC}"; }
error() { echo -e "${ROJO}[x] $*${NC}"; exit 1; }

# ---------------------------------------------------------------- .env
[ -f .env ] || error "Falta el archivo .env. Copia .env.example a .env y pon la cadena de conexión de Supabase."
grep -q '^DATABASE_URL=postgres' .env || error ".env no tiene DATABASE_URL=postgres..."
grep -q 'TU_PASSWORD\|TU_PROYECTO' .env && error "Reemplaza TU_PASSWORD / TU_PROYECTO en .env con los datos reales de Supabase."

# ---------------------------------------------------------------- clúster
paso "1/7 Clúster Minikube"
if [ "${RECREAR:-0}" = "1" ]; then
  aviso "Borrando clúster anterior..."
  minikube delete || true
fi
if minikube status --format '{{.Host}}' 2>/dev/null | grep -q Running; then
  echo "Minikube ya está corriendo."
  if ! kubectl get pods -n kube-system -l k8s-app=calico-node --no-headers 2>/dev/null | grep -q .; then
    aviso "El clúster actual NO tiene Calico: las NetworkPolicies no se aplicarán."
    aviso "Para tener firewall real entre pods ejecuta:  RECREAR=1 ./scripts/setup.sh"
  fi
else
  minikube start --driver=docker --cpus="$CPUS" --memory="$MEMORIA" --cni=calico
fi
kubectl config use-context minikube >/dev/null

paso "2/7 Addons: metrics-server (HPA) e ingress (balanceador)"
minikube addons enable metrics-server
minikube addons enable ingress

# ---------------------------------------------------------------- imágenes
paso "3/7 Construyendo imágenes dentro de Minikube"
eval "$(minikube docker-env)"
docker build -t granja-api:1.0 ./api
docker build -t granja-worker:1.0 ./worker
docker build -t granja-frontend:1.0 ./frontend
docker images | grep -E 'granja-(api|worker|frontend)'

# ---------------------------------------------------------------- config
paso "4/7 Namespaces, secretos y configuración"
kubectl apply -f k8s/app/00-namespaces.yaml
kubectl -n granja create secret generic granja-secret --from-env-file=.env \
  --dry-run=client -o yaml | kubectl apply -f -

kubectl -n monitoreo create configmap prometheus-config \
  --from-file=prometheus.yml=monitoring/prometheus/prometheus-k8s.yml \
  --from-file=alertas.yml=monitoring/prometheus/alertas.yml \
  --dry-run=client -o yaml | kubectl apply -f -
kubectl -n monitoreo create configmap grafana-datasources \
  --from-file=monitoring/grafana/provisioning/datasources/ \
  --dry-run=client -o yaml | kubectl apply -f -
kubectl -n monitoreo create configmap grafana-proveedores \
  --from-file=monitoring/grafana/provisioning/dashboards/ \
  --dry-run=client -o yaml | kubectl apply -f -
kubectl -n monitoreo create configmap grafana-dashboards \
  --from-file=monitoring/grafana/dashboards/ \
  --dry-run=client -o yaml | kubectl apply -f -
kubectl -n granja create configmap k6-script --from-file=carga.js=loadtest/carga.js \
  --dry-run=client -o yaml | kubectl apply -f -

# ---------------------------------------------------------------- despliegue
paso "5/7 Esperando al Ingress Controller"
kubectl -n ingress-nginx wait --for=condition=ready pod \
  -l app.kubernetes.io/component=controller --timeout=240s

paso "6/7 Desplegando aplicación y monitoreo"
kubectl apply -f k8s/app/
kubectl apply -f k8s/monitoreo/
# Si se cambió código o configuración, reiniciar para tomar la nueva imagen
kubectl -n granja rollout restart deployment/api deployment/worker deployment/frontend >/dev/null
kubectl -n monitoreo rollout restart deployment/prometheus deployment/grafana >/dev/null

for d in redis api worker frontend; do
  kubectl -n granja rollout status deployment/$d --timeout=240s
done
kubectl -n monitoreo rollout status deployment/prometheus --timeout=240s
kubectl -n monitoreo rollout status deployment/grafana --timeout=240s

paso "7/7 Verificación"
kubectl -n granja get pods,svc,hpa,ingress -o wide
echo
kubectl -n monitoreo get pods,svc
echo
API_POD=$(kubectl -n granja get pod -l app=api -o jsonpath='{.items[0].metadata.name}')
if kubectl -n granja exec "$API_POD" -- wget -qO- http://127.0.0.1:3000/ready; then
  echo -e "\n${VERDE}API conectada a Supabase y Redis.${NC}"
else
  aviso "La API no está lista. Revisa: kubectl -n granja logs $API_POD"
fi

echo -e "\n${VERDE}Listo.${NC} Siguiente paso:  ./scripts/acceso.sh"
