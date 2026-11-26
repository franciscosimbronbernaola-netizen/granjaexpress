#!/usr/bin/env bash
# Elimina los recursos del proyecto. Con "todo" también borra el clúster.
set -uo pipefail
pkill -f "kubectl port-forward" 2>/dev/null || true
kubectl delete namespace granja monitoreo --ignore-not-found
kubectl delete clusterrole prometheus-granja --ignore-not-found
kubectl delete clusterrolebinding prometheus-granja --ignore-not-found
if [ "${1:-}" = "todo" ]; then
  minikube delete
fi
echo "Limpieza terminada."
