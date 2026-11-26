#!/usr/bin/env bash
# Abre túneles hacia la app (por el Ingress), Grafana y Prometheus.
# Luego en Cloud Shell: botón "Vista previa web" -> "Cambiar puerto".
set -uo pipefail

pkill -f "kubectl port-forward" 2>/dev/null || true
sleep 1

kubectl -n ingress-nginx port-forward svc/ingress-nginx-controller 8080:80 >/tmp/pf-app.log 2>&1 &
kubectl -n monitoreo port-forward svc/grafana 3000:3000 >/tmp/pf-grafana.log 2>&1 &
kubectl -n monitoreo port-forward svc/prometheus 9090:9090 >/tmp/pf-prom.log 2>&1 &
sleep 3

cat <<'EOF'

  Túneles abiertos (en segundo plano):
  ┌──────────────┬────────┬─────────────────────────────────────────┐
  │ Servicio     │ Puerto │ Cómo abrir en Cloud Shell               │
  ├──────────────┼────────┼─────────────────────────────────────────┤
  │ App (POS)    │ 8080   │ Vista previa web -> puerto 8080         │
  │ Grafana      │ 3000   │ Vista previa web -> Cambiar puerto 3000 │
  │ Prometheus   │ 9090   │ Vista previa web -> Cambiar puerto 9090 │
  └──────────────┴────────┴─────────────────────────────────────────┘
  Grafana: entra como invitado o con admin / admin
  Si la vista previa deja de responder, vuelve a ejecutar este script.
  Para cerrar los túneles:  pkill -f "kubectl port-forward"

EOF
