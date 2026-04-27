#!/bin/bash
# vm-deploy.sh — Actualiza el relay-daemon desde GitHub y reinicia el servicio
# Uso: sudo /opt/eqso-asorapa/artifacts/relay-daemon/install/vm-deploy.sh

set -e

REPO_DIR="/opt/eqso-asorapa"
SERVICE="eqso-relay@CB"

echo "==> Actualizando desde GitHub..."
cd "$REPO_DIR"
git pull origin main

echo "==> Reiniciando servicio $SERVICE..."
systemctl restart "$SERVICE"
sleep 4

echo "==> Estado del servicio:"
systemctl status "$SERVICE" --no-pager -n 15
