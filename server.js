import { openDatabase } from './src/db.js';
import { createAppServer } from './src/server.js';

const port = Number(process.env.PORT || 3000);

let db = null;
let dbError = null;
try {
  db = await openDatabase();
} catch (error) {
  dbError = error;
  console.error(JSON.stringify({
    level: 'fatal',
    message: 'Database could not be opened. Serving /api/health in degraded mode only.',
    error: String(error?.message || error),
  }));
}

const { server } = createAppServer({ db, closeDbOnStop: true });

server.listen(port, '0.0.0.0', () => {
  console.log(JSON.stringify({
    level: 'info',
    message: 'LCF Regulatory Data Intelligence ready',
    host: '0.0.0.0',
    port,
    runtime: process.env.VERCEL === '1' ? 'vercel' : 'node',
    database: db?.dialect || 'not_configured',
    data_mode: db?.dataMode || (dbError ? 'NOT_CONFIGURED' : 'UNKNOWN'),
  }));
});

let shuttingDown = false;
const shutdown = () => {
  if (shuttingDown) return;
  shuttingDown = true;
  server.close(() => process.exit(dbError ? 1 : 0));
  server.closeIdleConnections?.();
  setTimeout(() => { server.closeAllConnections?.(); process.exit(dbError ? 1 : 0); }, 2000).unref();
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
