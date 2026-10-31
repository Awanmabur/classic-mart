import net from 'node:net';

/** Validate configuration only; this does not resolve DNS or prove ownership. */
export function assertProductionOrigin(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error('BASE_URL must be a valid HTTPS origin.'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new Error('BASE_URL must be an HTTPS origin without credentials, query, fragment or path.');
  }
  const host = url.hostname.toLowerCase().replace(/\.$/, '');
  if (!host.includes('.') || net.isIP(host.replace(/^\[|\]$/g, ''))
    || /(?:^|\.)(?:example|invalid|test|localhost|local|internal)$/.test(host)
    || /(?:^|\.)example\.(?:com|net|org)$/.test(host)) {
    throw new Error('BASE_URL must use the actual public domain, not an example, local address or IP.');
  }
  return url.origin;
}
