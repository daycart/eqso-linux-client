#!/usr/bin/env node
/**
 * deploy-to-github.mjs
 * Compila el relay-daemon y sube dist/main.mjs a GitHub.
 * Uso: node artifacts/relay-daemon/deploy-to-github.mjs
 */
import { readFileSync, existsSync } from 'fs';
import { execSync } from 'child_process';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const OWNER       = 'daycart';
const REPO        = 'eqso-linux-client';
const FILE_PATH   = 'artifacts/relay-daemon/dist/main.mjs';
const RAW_URL     = `https://raw.githubusercontent.com/${OWNER}/${REPO}/main/${FILE_PATH}`;
const API_URL     = `https://api.github.com/repos/${OWNER}/${REPO}/contents/${FILE_PATH}`;

const token = process.env.GITHUB_PERSONAL_ACCESS_TOKEN;
if (!token) {
  console.error('ERROR: GITHUB_PERSONAL_ACCESS_TOKEN no está definido');
  process.exit(1);
}

// 1. Compilar
console.log('==> Compilando relay-daemon...');
try {
  execSync('pnpm --filter @workspace/relay-daemon run build', { stdio: 'inherit' });
} catch (e) {
  console.error('ERROR: Fallo la compilación');
  process.exit(1);
}

const distPath = resolve(__dirname, 'dist/main.mjs');
if (!existsSync(distPath)) {
  console.error('ERROR: dist/main.mjs no existe después de compilar');
  process.exit(1);
}

// 2. Leer archivo compilado
const content = readFileSync(distPath);
const b64 = content.toString('base64');
console.log(`==> Archivo listo: ${content.length} bytes`);

// 3. Verificar si ya existe en GitHub (necesitamos el SHA para actualizar)
const headers = {
  Authorization: `Bearer ${token}`,
  Accept: 'application/vnd.github.v3+json',
  'Content-Type': 'application/json',
  'User-Agent': 'eqso-deploy-script',
};

let sha;
const checkResp = await fetch(API_URL, { headers });
if (checkResp.ok) {
  const existing = await checkResp.json();
  sha = existing.sha;
  console.log(`==> Archivo existe en GitHub (SHA: ${sha.slice(0, 10)}...), actualizando...`);
} else {
  console.log('==> Archivo nuevo en GitHub, creando...');
}

// 4. Subir a GitHub
const body = {
  message: `deploy: relay-daemon dist/main.mjs ${new Date().toISOString().slice(0, 16)}`,
  content: b64,
  ...(sha ? { sha } : {}),
};

const uploadResp = await fetch(API_URL, {
  method: 'PUT',
  headers,
  body: JSON.stringify(body),
});

if (!uploadResp.ok) {
  const err = await uploadResp.json();
  console.error('ERROR subiendo a GitHub:', uploadResp.status, JSON.stringify(err));
  process.exit(1);
}

console.log('');
console.log('✓ Subido a GitHub exitosamente');
console.log('');
console.log('En la VM ejecuta:');
console.log('  cd /opt/eqso-asorapa && sudo git pull && sudo systemctl restart eqso-relay@CB');
console.log('');
console.log('O con el script:');
console.log('  sudo /opt/eqso-asorapa/artifacts/relay-daemon/install/vm-deploy.sh');
