import { createAppServer } from './src/server.js';

const { server } = createAppServer();
const port = Number(process.env.PORT || 3000);

server.listen(port, '0.0.0.0', () => {
  console.log(JSON.stringify({
    level: 'info',
    message: 'LCF Regulatory Data Intelligence ready',
    host: '0.0.0.0',
    port,
    runtime: process.env.VERCEL === '1' ? 'vercel' : 'node'
  }));
});
