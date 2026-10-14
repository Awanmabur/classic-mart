import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const publicRoot = fileURLToPath(new URL('../../public/', import.meta.url));
const versions = new Map();
function fingerprint(directory, prefix = '') {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (entry.name.startsWith('.') || entry.isSymbolicLink()) continue;
    const relative = `${prefix}/${entry.name}`;
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) fingerprint(file, relative);
    else if (/\.(css|js|svg|png|ico|jpe?g|webp|woff2?)$/i.test(entry.name)) {
      versions.set(relative, createHash('sha256').update(fs.readFileSync(file)).digest('hex').slice(0, 16));
    }
  }
}
fingerprint(publicRoot);
export function assetUrl(url) {
  const version = versions.get(url);
  return version ? `${url}?v=${version}` : url;
}
export function isVersionedAsset(url, version) {
  return Boolean(version) && versions.get(url) === version;
}

// Version only actual local static assets in HTML tags. Existing versioned URLs,
// authenticated media, canonical links and product URLs keep their own semantics.
export function versionHtmlAssets(html) {
  return html.replace(/<(?:link|script|img|source)\b[^>]*>/gi, (tag) =>
    tag.replace(/\b(src|href)=(['"])(\/[^'"?\s<>]+)\2/gi,
      (_match, attribute, quote, url) => `${attribute}=${quote}${assetUrl(url)}${quote}`));
}
