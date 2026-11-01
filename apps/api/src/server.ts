/** Servidor de la aplicación: API REST + frontend estático en un solo proceso. */

import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { config } from './config.ts';
import { initDb } from './db.ts';
import { createServer, Router } from './http.ts';
import { registerAuthRoutes } from './modules/auth.ts';
import { registerCompanyRoutes } from './modules/company.ts';
import { registerClientRoutes } from './modules/clients.ts';
import { registerCatalogRoutes } from './modules/catalog.ts';
import { registerInventoryRoutes } from './modules/inventory.ts';
import { registerInvoicingRoutes } from './modules/invoicing.ts';
import { registerDashboardRoutes } from './modules/dashboard.ts';
import { registerIntegrationRoutes } from './modules/integration.ts';
import { registerPlatformRoutes } from './modules/platform.ts';

export function buildRouter(): Router {
  const router = new Router();
  router.get('/api/health', null, () => ({
    status: 'ok',
    name: 'facturacion-ec',
    version: '1.0.0',
    mode: 'sin dependencias',
    timestamp: new Date().toISOString(),
  }));
  registerAuthRoutes(router);
  registerCompanyRoutes(router);
  registerClientRoutes(router);
  registerCatalogRoutes(router);
  registerInventoryRoutes(router);
  registerInvoicingRoutes(router);
  registerDashboardRoutes(router);
  registerIntegrationRoutes(router);
  registerPlatformRoutes(router);
  return router;
}

export function startServer(port = config.port, host = config.host) {
  initDb();
  const server = createServer(buildRouter());
  return new Promise<{ server: import('node:http').Server; url: string }>((resolve) => {
    server.listen(port, host, () => {
      const address = server.address();
      const actualPort = typeof address === 'object' && address ? address.port : port;
      resolve({ server, url: `http://${host}:${actualPort}` });
    });
  });
}

const isMainModule = process.argv[1]
  ? import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
  : false;
if (isMainModule) {
  startServer()
    .then(({ url }) => {
      console.log(`\n  Facturación Electrónica EC · Plataforma multiempresa`);
      console.log(`  API + Web:        ${url}`);
      console.log(`  Plataforma:       ${config.platformDbPath}`);
      console.log(`  Empresas:         ${config.tenantsDir}/*.db`);
      console.log(`  Superadmin:       superadmin / superadmin123`);
      console.log(`  Empresa demo:     admin / admin123 (COMERCIAL DEMO S.A.)\n`);
    })
    .catch((error) => {
      console.error('No se pudo iniciar el servidor:', error);
      process.exit(1);
    });
}


