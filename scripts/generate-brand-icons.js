import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const root = fileURLToPath(new URL('..', import.meta.url));
const publicPath = (...parts) => path.join(root, 'public', ...parts);
// The cart and red bag are the original mark in the homepage logo. Preserve
// those pixels and their proportions; exclude only the adjacent wordmark.
const mark = await sharp(publicPath('assets', 'classic-mart-logo.png'))
  .extract({ left: 0, top: 0, width: 476, height: 517 })
  .png().toBuffer();

async function favicon(size) {
  return sharp(mark)
    .resize(size - 2, size - 2, { fit: 'contain', background: '#ffffff00' })
    .extend({ top: 1, bottom: 1, left: 1, right: 1, background: '#ffffff00' })
    .png().toBuffer();
}

async function appIcon(size, fraction, filename) {
  const artwork = await sharp(mark)
    .resize(Math.round(size * fraction), Math.round(size * fraction), { fit: 'inside' })
    .png().toBuffer();
  await sharp({ create: { width: size, height: size, channels: 4, background: '#ffffff' } })
    .composite([{ input: artwork, gravity: 'centre' }])
    .png().toFile(publicPath('assets', filename));
}

await fs.writeFile(publicPath('favicon.png'), await favicon(64));
const sizes = [16, 32, 48, 64, 256];
const images = await Promise.all(sizes.map(favicon));
const directory = Buffer.alloc(6 + images.length * 16);
directory.writeUInt16LE(1, 2);
directory.writeUInt16LE(images.length, 4);
let offset = directory.length;
images.forEach((image, index) => {
  const entry = 6 + index * 16;
  directory[entry] = sizes[index] === 256 ? 0 : sizes[index];
  directory[entry + 1] = directory[entry];
  directory.writeUInt16LE(1, entry + 4);
  directory.writeUInt16LE(32, entry + 6);
  directory.writeUInt32LE(image.length, entry + 8);
  directory.writeUInt32LE(offset, entry + 12);
  offset += image.length;
});
await fs.writeFile(publicPath('favicon.ico'), Buffer.concat([directory, ...images]));
await appIcon(180, 0.84, 'apple-touch-icon.png');
await appIcon(192, 0.84, 'pwa-192.png');
await appIcon(512, 0.84, 'pwa-512.png');
// Keep all artwork inside the central 80% safe circle for launcher masks.
await appIcon(512, 0.56, 'pwa-maskable-512.png');
console.log('Generated Classic Mart favicon and app icons from the homepage logo.');
