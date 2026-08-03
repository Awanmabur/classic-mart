function keyPattern(key, global = false) {
  const escaped = String(key).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^[\\t ]*${escaped}[\\t ]*=[\\t ]*(.*)$`, global ? 'gm' : 'm');
}

function unquote(value) {
  const raw = String(value || '').trim();
  if (raw.length >= 2 && ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'")))) {
    return raw.slice(1, -1);
  }
  return raw;
}

export function envValues(source, key) {
  const text = String(source || '');
  const pattern = keyPattern(key, true);
  const values = [];
  let match;
  while ((match = pattern.exec(text)) !== null) values.push(unquote(match[1]));
  return values;
}

export function envLastValue(source, key) {
  const values = envValues(source, key);
  return values.length ? values.at(-1) : '';
}

export function upsertUniqueEnvValue(source, key, value) {
  const text = String(source || '');
  const escaped = String(key).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const without = text
    .split(/\r?\n/)
    .filter((line) => !new RegExp(`^\\s*${escaped}\\s*=`).test(line))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trimEnd();
  const line = `${key}=${String(value ?? '')}`;
  return `${without}${without ? '\n' : ''}${line}\n`;
}
