import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { stripVTControlCharacters } from 'node:util';

const clean = value => stripVTControlCharacters(String(value ?? ''))
  .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, '');

export function collectCiServiceDiagnostics(run = spawnSync, { heading = 'CI MongoDB/Redis startup diagnostics' } = {}) {
  const sections = [heading];
  for (const container of ['classic-mart-mongo', 'classic-mart-redis']) {
    for (const args of [['inspect', '--format', '{{json .State}}', container], ['logs', '--tail', '60', container]]) {
      let result;
      try { result = run('docker', args, { encoding: 'utf8', timeout: 5000, maxBuffer: 16_384, shell: false, windowsHide: true }); }
      catch (error) { result = { error }; }
      const status = Number.isInteger(result.status) ? result.status : 'unavailable';
      const errorCode = clean(result.error?.code || '');
      sections.push(`${container} ${args[0]} (exit ${status}${errorCode ? `, ${errorCode}` : ''})`,
        clean(`${result.stdout || ''}${result.stderr || ''}`).slice(-5000) || '(no output)');
    }
  }
  return sections.join('\n\n') + '\n';
}

export function githubServiceFailureAnnotation(details, { title = 'CI service startup failed' } = {}) {
  const escaped = clean(details).slice(0, 24_000).replaceAll('%', '%25').replaceAll('\r', '%0D').replaceAll('\n', '%0A');
  const escapedTitle = clean(title).replaceAll('%', '%25').replaceAll('\r', '%0D').replaceAll('\n', '%0A').replaceAll(',', '%2C').replaceAll(':', '%3A');
  return `::error title=${escapedTitle}::${escaped}\n`;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  // This observer must not replace the startup step's original exit status.
  let details;
  try { details = collectCiServiceDiagnostics(); }
  catch { details = 'CI service startup failed; diagnostic collection was unavailable.\n'; }
  try {
    fs.mkdirSync('artifacts', { recursive: true });
    fs.writeFileSync('artifacts/ci-services.txt', details, { encoding: 'utf8', mode: 0o600 });
  } catch { details += '\nDiagnostic artifact could not be written.\n'; }
  process.stdout.write(githubServiceFailureAnnotation(details));
}
