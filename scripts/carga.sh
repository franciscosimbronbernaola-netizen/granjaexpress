#!/usr/bin/env bash
# Lanza la prueba de carga k6 dentro del clúster y muestra cómo escala el HPA.
# Uso: ./scripts/carga.sh [minutos=3] [usuarios=20]
set -euo pipefail
cd "$(dirname "$0")/.."

MIN="${1:-3}"
VUS="${2:-20}"

kubectl -n granja create configmap k6-script --from-file=carga.js=loadtest/carga.js \
  --dry-run=client -o yaml | kubectl apply -f - >/dev/null
kubectl -n granja delete job k6-carga --ignore-not-found >/dev/null

sed -e "s/value: \"3\"/value: \"$MIN\"/" -e "s/value: \"20\"/value: \"$VUS\"/" loadtest/k6-job.yaml \
  | kubectl apply -f -

echo
echo "Carga de $MIN min con $VUS usuarios. Mira Grafana mientras tanto."
echo "Observando el HPA (Ctrl+C para dejar de mirar; la prueba sigue)..."
echo
kubectl -n granja get hpa api -w &
VIGIA=$!
trap 'kill $VIGIA 2>/dev/null' EXIT

LIMITE=$(( $(date +%s) + (MIN + 3) * 60 ))
while [ "$(date +%s)" -lt "$LIMITE" ]; do
  OK=$(kubectl -n granja get job k6-carga -o jsonpath='{.status.succeeded}' 2>/dev/null)
  KO=$(kubectl -n granja get job k6-carga -o jsonpath='{.status.failed}' 2>/dev/null)
  [ "${OK:-0}" -ge 1 ] || [ "${KO:-0}" -ge 1 ] && break
  sleep 5
done
kill $VIGIA 2>/dev/null || true

echo
echo "================ RESULTADO k6 ================"
kubectl -n granja logs job/k6-carga | tail -n 60
echo
kubectl -n granja get hpa
kubectl -n granja get pods -l app=api
