#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"

echo "==> git pull"
git pull

echo "==> pnpm install"
pnpm install

echo "==> build api-server"
pnpm --filter @workspace/api-server run build

echo "==> build eqso-client"
pnpm --filter @workspace/eqso-client run build

echo "==> copy client to api-server/dist/public"
rm -rf artifacts/api-server/dist/public
cp -r artifacts/eqso-client/dist/public artifacts/api-server/dist/public

echo "==> restart service"
sudo systemctl restart eqso

echo "==> done"
