import http from 'node:http';
import { spawn } from 'node:child_process';

const host = '127.0.0.1';
const port = Number(process.env.VITE_PORT ?? 5173);

function readExistingServer() {
  return new Promise((resolve) => {
    const request = http.get({ host, port, path: '/', timeout: 750 }, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => {
        body += chunk;
      });
      response.on('end', () => resolve({ ok: true, body }));
    });

    request.on('timeout', () => {
      request.destroy();
      resolve({ ok: false, body: '' });
    });
    request.on('error', () => resolve({ ok: false, body: '' }));
  });
}

const existing = await readExistingServer();
if (existing.ok) {
  if (existing.body.includes('<title>Lin Outliner</title>')) {
    console.log(`Lin Outliner dev server already running on http://${host}:${port}`);
    process.exit(0);
  }
  console.error(`Port ${port} is already in use by a different server.`);
  process.exit(1);
}

const child = spawn('bun', [
  'x',
  'vite',
  '--host',
  host,
  '--port',
  String(port),
  '--strictPort',
], {
  stdio: 'inherit',
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    child.kill(signal);
  });
}

child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  process.exit(code ?? 0);
});
