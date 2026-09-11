import { spawn } from 'node:child_process';

if (process.env.NODE_ENV !== 'production') {
  throw new Error('NODE_ENV must be production for the production process supervisor.');
}

const childSpecs = [
  ['web', 'src/server.js'],
  ['worker', 'src/worker.js'],
];
const children = new Map();
let shuttingDown = false;
let requestedSignal = 'SIGTERM';
let exitCode = 0;

function startChild(name, entrypoint) {
  const child = spawn(process.execPath, [entrypoint], {
    cwd: process.cwd(),
    env: process.env,
    stdio: 'inherit',
  });
  children.set(name, child);
  child.on('exit', (code, signal) => {
    children.delete(name);
    if (!shuttingDown) {
      exitCode = Number.isInteger(code) && code !== 0 ? code : 1;
      console.error(`[production] ${name} exited unexpectedly (code=${code ?? 'null'}, signal=${signal ?? 'none'}); stopping sibling process.`);
      shutdown('SIGTERM');
      return;
    }
    if (children.size === 0) process.exit(exitCode);
  });
  child.on('error', (error) => {
    console.error(`[production] failed to start ${name}: ${error.message}`);
    if (!shuttingDown) {
      exitCode = 1;
      shutdown('SIGTERM');
    }
  });
}

function shutdown(signal = 'SIGTERM') {
  if (shuttingDown) return;
  shuttingDown = true;
  requestedSignal = signal === 'SIGINT' ? 'SIGINT' : 'SIGTERM';
  for (const child of children.values()) {
    if (!child.killed) child.kill(requestedSignal);
  }
  const forceTimer = setTimeout(() => {
    for (const child of children.values()) {
      if (!child.killed) child.kill('SIGKILL');
    }
    process.exit(exitCode || (requestedSignal === 'SIGINT' ? 130 : 0));
  }, 15_000);
  forceTimer.unref();
  if (children.size === 0) process.exit(exitCode);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

for (const [name, entrypoint] of childSpecs) startChild(name, entrypoint);
