/**
 * Detiene el servidor iniciado con `scripts/servidor-fondo.mjs`.
 *
 * Uso: node scripts/detener-servidor.mjs
 */

import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve('.');
const pidFile = path.join(root, 'data', 'servidor.pid');

if (!fs.existsSync(pidFile)) {
  console.log('No hay un PID registrado (data/servidor.pid). Puede detenerlo manualmente con Stop-Process.');
  process.exit(0);
}

const pid = Number(fs.readFileSync(pidFile, 'utf8').trim());
if (!Number.isInteger(pid) || pid <= 0) {
  console.error('PID inválido en data/servidor.pid');
  process.exit(1);
}

try {
  process.kill(pid, 'SIGTERM');
  console.log(`Servidor detenido (PID ${pid}).`);
} catch (error) {
  if (error.code === 'ESRCH') {
    console.log(`El proceso ${pid} ya no existe.`);
  } else {
    console.error(`No se pudo detener el proceso ${pid}:`, error.message);
    process.exit(1);
  }
} finally {
  fs.rmSync(pidFile, { force: true });
}
