import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const publicRoot = fileURLToPath(new URL('../../public/', import.meta.url));
const versions = new Map();
for (const entry of fs.readdirSync(path.join(publicRoot, 'approved-dashboard'))) {
  if (!/\.(css|js)$/.test(entry)) continue;
  const url = `/approved-dashboard/${entry}`;
  versions.set(url, createHash('sha256').update(fs.readFileSync(path.join(publicRoot, url))).digest('hex').slice(0, 16));
}
export function assetUrl(url) {
  const version = versions.get(url);
  return version ? `${url}?v=${version}` : url;
}
export function isVersionedAsset(url, version) {
  return Boolean(version) && versions.get(url) === version;
}
