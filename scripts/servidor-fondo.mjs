/**
 * Inicia el servidor como proceso independiente (detached) para que siga
 * ejecutándose aunque termine la sesión/herramienta que lo lanzó.
 *
 * Uso:   node scripts/servidor-fondo.mjs
 * Para:  node scripts/detener-servidor.mjs
 *
 * Guarda el PID en data/servidor.pid y la salida en logs/servidor.log.
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

const root = path.resolve('.');
const logsDir = path.join(root, 'logs');
const dataDir = path.join(root, 'data');
fs.mkdirSync(logsDir, { recursive: true });
fs.mkdirSync(dataDir, { recursive: true });

const logFile = path.join(logsDir, 'servidor.log');
const errorFile = path.join(logsDir, 'servidor.err.log');
const pidFile = path.join(dataDir, 'servidor.pid');
const port = Number(process.env.PORT || 4000);
const healthUrl = `http://127.0.0.1:${port}/api/health`;

async function isHealthy() {
  try {
    const response = await fetch(healthUrl, { signal: AbortSignal.timeout(1500) });
    return response.ok;
  } catch {
    return false;
  }
}

async function main() {
  if (await isHealthy()) {
    console.log(`El servidor ya está respondiendo en http://127.0.0.1:${port}`);
    const pid = fs.existsSync(pidFile) ? fs.readFileSync(pidFile, 'utf8').trim() : null;
    if (pid) console.log(`PID registrado: ${pid}`);
    return;
  }

  const out = fs.openSync(logFile, 'a');
  const err = fs.openSync(errorFile, 'a');
  const child = spawn(process.execPath, [path.join(root, 'apps', 'api', 'src', 'server.ts')], {
    cwd: root,
    detached: true,
    windowsHide: true,
    stdio: ['ignore', out, err],
    env: { ...process.env, PORT: String(port) },
  });
  child.unref();
  fs.writeFileSync(pidFile, String(child.pid), 'utf8');

  let healthy = false;
  for (let attempt = 0; attempt < 40; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    if (await isHealthy()) {
      healthy = true;
      break;
    }
  }
  fs.closeSync(out);
  fs.closeSync(err);

  if (!healthy) {
    console.error('El servidor no respondió. Revise logs/servidor.log y logs/servidor.err.log');
    process.exit(1);
  }

  console.log(`Servidor multiempresa iniciado en http://127.0.0.1:${port}`);
  console.log(`  PID:  ${child.pid}  (data/servidor.pid)`);
  console.log(`  Log:  logs/servidor.log`);
  console.log(`  Stop: node scripts/detener-servidor.mjs`);
}

await main();
