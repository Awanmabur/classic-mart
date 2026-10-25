import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripVTControlCharacters } from 'node:util';

const MAX_DETAILS = 24_000;
const clean = value => stripVTControlCharacters(typeof value === 'string' ? value : '').replaceAll('\u0000', '');
const escapeData = value => clean(value).replaceAll('%', '%25').replaceAll('\r', '%0D').replaceAll('\n', '%0A');
const escapeProperty = value => escapeData(value).replaceAll(':', '%3A').replaceAll(',', '%2C');

function causes(error) {
  const result = [], seen = new Set();
  for (let current = error; current && !seen.has(current) && result.length < 8; current = current.cause) {
    seen.add(current); result.push(current);
  }
  return result.reverse();
}

function location(data) {
  let file = clean(data.file);
  if (file.startsWith('file:')) {
    try { file = fileURLToPath(file); } catch { file = ''; }
  }
  if (file && path.isAbsolute(file)) {
    const relative = path.relative(process.env.GITHUB_WORKSPACE || process.cwd(), file);
    if (relative && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative)) file = relative;
  }
  const properties = [];
  if (file) properties.push('file=' + escapeProperty(file));
  if (Number.isSafeInteger(data.line) && data.line > 0) properties.push('line=' + data.line);
  if (Number.isSafeInteger(data.column) && data.column > 0) properties.push('col=' + data.column);
  return properties;
}

export function githubFailureAnnotation(data) {
  const error = data.details?.error;
  // Node also reports each enclosing suite/test after a child fails. The child
  // annotation already carries the actual assertion or launch error.
  if (error?.failureType === 'subtestsFailed') return '';
  const title = 'Test failed: ' + (clean(data.name) || 'Unnamed test');
  const details = causes(error).map(cause => {
    if (typeof cause === 'string') return clean(cause);
    const stack = clean(cause.stack), message = clean(cause.message);
    return stack || message;
  }).filter(Boolean);
  const body = [title, ...new Set(details)].join('\n\n').slice(0, MAX_DETAILS);
  return `::error ${[...location(data), 'title=' + escapeProperty(title.slice(0, 1000))].join(',')}::${escapeData(body)}\n`;
}

export default async function* githubTestReporter(source) {
  for await (const event of source) {
    if (event.type !== 'test:fail') continue;
    const annotation = githubFailureAnnotation(event.data);
    if (annotation) yield annotation;
  }
}
