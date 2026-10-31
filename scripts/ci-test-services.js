import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { collectCiServiceDiagnostics, githubServiceFailureAnnotation } from './ci-service-diagnostics.js';

const execute = promisify(execFile);
export const ciTestContainers = Object.freeze(['classic-mart-mongo', 'classic-mart-redis']);

// Observe only this workflow's disposable services. Never inspect an environment
// URL, restart a service, or turn an infrastructure failure into a skipped test.
export async function inspectCiTestServices(run = execute) {
  const states = await Promise.all(ciTestContainers.map(async container => {
    try {
      const result = await run('docker', ['inspect', '--format', '{{json .State}}', container], {
        timeout: 5000, maxBuffer: 16_384, windowsHide: true, shell: false,
      });
      const state = JSON.parse(result.stdout);
      if (state.Running === true && state.OOMKilled !== true && state.Dead !== true
        && state.Paused !== true && state.Restarting !== true) return null;
      const exit = Number.isInteger(state.ExitCode) ? state.ExitCode : 'unknown';
      return `${container} is unavailable (exit ${exit}, OOMKilled=${state.OOMKilled === true}).`;
    } catch {
      return `${container} could not be inspected.`;
    }
  }));
  return { healthy: states.every(state => state === null), reason: states.filter(Boolean).join(' ') };
}

async function stopProcessGroup(child, graceMs) {
  if (!child.pid) return;
  const send = signal => {
    try { process.kill(-child.pid, signal); }
    catch (error) { if (error.code !== 'ESRCH') throw error; }
  };
  send('SIGTERM');
  // A descendant can outlive the test runner and ignore SIGTERM. Kill the owned
  // group after a bounded grace period even if the immediate child has exited.
  await delay(graceMs);
  send('SIGKILL');
}

export async function runWithCiTestServices({
  command = process.execPath, args = [], cwd = process.cwd(), env = process.env,
  intervalMs = 10_000, graceMs = 2000, stdio = 'inherit',
  probe = inspectCiTestServices, spawnChild = spawn, stopChild = stopProcessGroup,
  collectDiagnostics = () => collectCiServiceDiagnostics(undefined, { heading: 'CI MongoDB/Redis test service diagnostics' }),
  saveDiagnostics = details => fs.mkdir(path.join(cwd, 'artifacts'), { recursive: true })
    .then(() => fs.writeFile(path.join(cwd, 'artifacts', 'ci-services.txt'), details, { mode: 0o600 })),
  report = message => process.stdout.write(message), signalTarget = process,
} = {}) {
  async function health() {
    try { return await probe(); }
    catch { return { healthy: false, reason: 'CI test services could not be inspected.' }; }
  }
  async function recordFailure(state) {
    let details = `${state.reason || 'CI test services are unavailable.'}\n\n`;
    try { details += await collectDiagnostics(); }
    catch { details += 'Diagnostic collection was unavailable.\n'; }
    try { await saveDiagnostics(details); }
    catch { details += '\nDiagnostic artifact could not be written.\n'; }
    report(githubServiceFailureAnnotation(details, { title: 'CI test service failed' }));
  }
  const initial = await health();
  if (!initial.healthy) {
    await recordFailure(initial);
    return 1;
  }

  let child;
  try { child = spawnChild(command, args, { cwd, env, stdio, detached: true, shell: false }); }
  catch { return 1; }
  let finished = false, polling = false, failed = false, interrupted = 0;
  let pollWork = Promise.resolve(), stopWork;
  const stop = () => stopWork ||= stopChild(child, graceMs);
  const completion = new Promise(resolve => {
    child.once('error', () => resolve(1));
    child.once('close', code => resolve(Number.isInteger(code) ? code : 1));
  });
  const timer = setInterval(() => {
    if (finished || polling || failed || interrupted) return;
    polling = true;
    pollWork = (async () => {
      const state = await health();
      if (!finished && !state.healthy) {
        failed = true;
        clearInterval(timer);
        try { await stop(); }
        finally { await recordFailure(state); }
      }
    })().finally(() => { polling = false; });
    // Completion below awaits this promise and retains the failing status.
    pollWork.catch(() => {});
  }, intervalMs);
  timer.unref();
  const onInterrupt = () => { interrupted = 130; clearInterval(timer); void stop().catch(() => {}); };
  const onTerminate = () => { interrupted = 143; clearInterval(timer); void stop().catch(() => {}); };
  signalTarget.once('SIGINT', onInterrupt);
  signalTarget.once('SIGTERM', onTerminate);
  try {
    const code = await completion;
    finished = true;
    clearInterval(timer);
    await pollWork;
    if (stopWork) await stopWork;
    return failed ? 1 : interrupted || code;
  } finally {
    finished = true;
    clearInterval(timer);
    signalTarget.removeListener('SIGINT', onInterrupt);
    signalTarget.removeListener('SIGTERM', onTerminate);
  }
}
