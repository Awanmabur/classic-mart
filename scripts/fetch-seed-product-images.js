import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const targetDir = path.join(root, 'public', 'assets', 'products');
const MAX_BYTES = 12 * 1024 * 1024;
const ALLOWED_HOST = 'images.pexels.com';

if (process.env.NODE_ENV === 'production') {
  console.log('[seed-media] development reference-photo download skipped in production.');
  process.exit(0);
}

const sources = [
  ['wireless-headphones.jpg', 'https://images.pexels.com/photos/3394665/pexels-photo-3394665.jpeg?auto=compress&cs=tinysrgb&w=1200', 'https://www.pexels.com/photo/3394665/'],
  ['wireless-headphones-2.jpg', 'https://images.pexels.com/photos/3394666/pexels-photo-3394666.jpeg?auto=compress&cs=tinysrgb&w=1200', 'https://www.pexels.com/photo/3394666/'],
  ['wireless-headphones-3.jpg', 'https://images.pexels.com/photos/11199906/pexels-photo-11199906.jpeg?auto=compress&cs=tinysrgb&w=1200', 'https://www.pexels.com/photo/11199906/'],
  ['smart-watch.jpg', 'https://images.pexels.com/photos/31406900/pexels-photo-31406900.jpeg?auto=compress&cs=tinysrgb&w=1200', 'https://www.pexels.com/photo/31406900/'],
  ['smart-watch-2.jpg', 'https://images.pexels.com/photos/13007642/pexels-photo-13007642.jpeg?auto=compress&cs=tinysrgb&w=1200', 'https://www.pexels.com/photo/13007642/'],
  ['smart-watch-3.jpg', 'https://images.pexels.com/photos/12564670/pexels-photo-12564670.jpeg?auto=compress&cs=tinysrgb&w=1200', 'https://www.pexels.com/photo/12564670/'],
  ['city-backpack.jpg', 'https://images.pexels.com/photos/11726029/pexels-photo-11726029.jpeg?auto=compress&cs=tinysrgb&w=1200', 'https://www.pexels.com/photo/11726029/'],
  ['city-backpack-2.jpg', 'https://images.pexels.com/photos/11726012/pexels-photo-11726012.jpeg?auto=compress&cs=tinysrgb&w=1200', 'https://www.pexels.com/photo/11726012/'],
  ['city-backpack-3.jpg', 'https://images.pexels.com/photos/15522601/pexels-photo-15522601.jpeg?auto=compress&cs=tinysrgb&w=1200', 'https://www.pexels.com/photo/15522601/'],
  ['table-lamp.jpg', 'https://images.pexels.com/photos/7184401/pexels-photo-7184401.jpeg?auto=compress&cs=tinysrgb&w=1200', 'https://www.pexels.com/photo/7184401/'],
  ['table-lamp-2.jpg', 'https://images.pexels.com/photos/3859780/pexels-photo-3859780.jpeg?auto=compress&cs=tinysrgb&w=1200', 'https://www.pexels.com/photo/3859780/'],
  ['table-lamp-3.jpg', 'https://images.pexels.com/photos/8263858/pexels-photo-8263858.jpeg?auto=compress&cs=tinysrgb&w=1200', 'https://www.pexels.com/photo/8263858/'],
  ['running-shoes.jpg', 'https://images.pexels.com/photos/14212621/pexels-photo-14212621.jpeg?auto=compress&cs=tinysrgb&w=1200', 'https://www.pexels.com/photo/14212621/'],
  ['running-shoes-2.jpg', 'https://images.pexels.com/photos/4932920/pexels-photo-4932920.jpeg?auto=compress&cs=tinysrgb&w=1200', 'https://www.pexels.com/photo/4932920/'],
  ['running-shoes-3.jpg', 'https://images.pexels.com/photos/5526492/pexels-photo-5526492.jpeg?auto=compress&cs=tinysrgb&w=1200', 'https://www.pexels.com/photo/5526492/'],
  ['office-keyboard.jpg', 'https://images.pexels.com/photos/18114576/pexels-photo-18114576.jpeg?auto=compress&cs=tinysrgb&w=1200', 'https://www.pexels.com/photo/18114576/'],
  ['office-keyboard-2.jpg', 'https://images.pexels.com/photos/20510020/pexels-photo-20510020.jpeg?auto=compress&cs=tinysrgb&w=1200', 'https://www.pexels.com/photo/20510020/'],
  ['office-keyboard-3.jpg', 'https://images.pexels.com/photos/20510011/pexels-photo-20510011.jpeg?auto=compress&cs=tinysrgb&w=1200', 'https://www.pexels.com/photo/20510011/'],
  ['skin-care-set.jpg', 'https://images.pexels.com/photos/6621462/pexels-photo-6621462.jpeg?auto=compress&cs=tinysrgb&w=1200', 'https://www.pexels.com/photo/6621462/'],
  ['skin-care-set-2.jpg', 'https://images.pexels.com/photos/11935611/pexels-photo-11935611.jpeg?auto=compress&cs=tinysrgb&w=1200', 'https://www.pexels.com/photo/11935611/'],
  ['skin-care-set-3.jpg', 'https://images.pexels.com/photos/4841273/pexels-photo-4841273.jpeg?auto=compress&cs=tinysrgb&w=1200', 'https://www.pexels.com/photo/4841273/'],
  ['vehicle-organizer.jpg', 'https://images.pexels.com/photos/17000836/pexels-photo-17000836.jpeg?auto=compress&cs=tinysrgb&w=1200', 'https://www.pexels.com/photo/17000836/'],
  ['vehicle-organizer-2.jpg', 'https://images.pexels.com/photos/9462680/pexels-photo-9462680.jpeg?auto=compress&cs=tinysrgb&w=1200', 'https://www.pexels.com/photo/9462680/'],
  ['vehicle-organizer-3.jpg', 'https://images.pexels.com/photos/9462672/pexels-photo-9462672.jpeg?auto=compress&cs=tinysrgb&w=1200', 'https://www.pexels.com/photo/9462672/'],
  ['learning-notebook.jpg', 'https://images.pexels.com/photos/8251117/pexels-photo-8251117.jpeg?auto=compress&cs=tinysrgb&w=1200', 'https://www.pexels.com/photo/8251117/'],
  ['learning-notebook-2.jpg', 'https://images.pexels.com/photos/19810873/pexels-photo-19810873.jpeg?auto=compress&cs=tinysrgb&w=1200', 'https://www.pexels.com/photo/19810873/'],
  ['learning-notebook-3.jpg', 'https://images.pexels.com/photos/4554344/pexels-photo-4554344.jpeg?auto=compress&cs=tinysrgb&w=1200', 'https://www.pexels.com/photo/4554344/'],
  ['baby-care-bag.jpg', 'https://images.pexels.com/photos/22434759/pexels-photo-22434759.jpeg?auto=compress&cs=tinysrgb&w=1200', 'https://www.pexels.com/photo/22434759/'],
  ['baby-care-bag-2.jpg', 'https://images.pexels.com/photos/22434771/pexels-photo-22434771.jpeg?auto=compress&cs=tinysrgb&w=1200', 'https://www.pexels.com/photo/22434771/'],
  ['baby-care-bag-3.jpg', 'https://images.pexels.com/photos/22432990/pexels-photo-22432990.jpeg?auto=compress&cs=tinysrgb&w=1200', 'https://www.pexels.com/photo/22432990/'],
  ['pantry-container-set.jpg', 'https://images.pexels.com/photos/27438824/pexels-photo-27438824.jpeg?auto=compress&cs=tinysrgb&w=1200', 'https://www.pexels.com/photo/27438824/'],
  ['pantry-container-set-2.jpg', 'https://images.pexels.com/photos/35916884/pexels-photo-35916884.jpeg?auto=compress&cs=tinysrgb&w=1200', 'https://www.pexels.com/photo/35916884/'],
  ['pantry-container-set-3.jpg', 'https://images.pexels.com/photos/1640776/pexels-photo-1640776.jpeg?auto=compress&cs=tinysrgb&w=1200', 'https://www.pexels.com/photo/1640776/'],
  ['portable-speaker.jpg', 'https://images.pexels.com/photos/7772558/pexels-photo-7772558.jpeg?auto=compress&cs=tinysrgb&w=1200', 'https://www.pexels.com/photo/7772558/'],
  ['portable-speaker-2.jpg', 'https://images.pexels.com/photos/4132534/pexels-photo-4132534.jpeg?auto=compress&cs=tinysrgb&w=1200', 'https://www.pexels.com/photo/4132534/'],
  ['portable-speaker-3.jpg', 'https://images.pexels.com/photos/11764413/pexels-photo-11764413.jpeg?auto=compress&cs=tinysrgb&w=1200', 'https://www.pexels.com/photo/11764413/']
];

function assertSource(url) {
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:' || parsed.hostname !== ALLOWED_HOST) throw new Error('Unapproved seed image host.');
}

async function exists(file) { try { await fs.access(file); return true; } catch { return false; } }

async function fetchOne(name, url) {
  assertSource(url);
  const target = path.join(targetDir, name);
  if (await exists(target)) return { name, status: 'cached' };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  try {
    const response = await fetch(url, { signal: controller.signal, redirect: 'follow', headers: { 'User-Agent': 'Classic-Mart-Seed-Media/1.0' } });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    assertSource(response.url);
    const declaredBytes = Number(response.headers.get('content-length') || 0);
    if (declaredBytes && declaredBytes > MAX_BYTES) throw new Error(`Image exceeds ${MAX_BYTES} bytes`);
    const type = String(response.headers.get('content-type') || '').toLowerCase();
    if (!type.startsWith('image/jpeg')) throw new Error(`Unexpected content type ${type || 'unknown'}`);
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length < 10_000 || buffer.length > MAX_BYTES) throw new Error(`Unexpected image size ${buffer.length}`);
    const temp = `${target}.tmp-${process.pid}`;
    await fs.writeFile(temp, buffer, { mode: 0o640 });
    await fs.rename(temp, target);
    return { name, status: 'downloaded', bytes: buffer.length };
  } finally { clearTimeout(timer); }
}

await fs.mkdir(targetDir, { recursive: true });
let downloaded = 0;
let cached = 0;
let failed = 0;
for (const [name, url] of sources) {
  try {
    const result = await fetchOne(name, url);
    if (result.status === 'downloaded') downloaded += 1; else cached += 1;
    console.log(`[seed-media] ${result.status}: ${name}`);
  } catch (error) {
    failed += 1;
    console.warn(`[seed-media] unavailable: ${name} (${error.message})`);
  }
}
console.log(`[seed-media] complete — downloaded=${downloaded} cached=${cached} unavailable=${failed}`);
if (failed) console.log('[seed-media] Offline fallback remains available; run npm run media:seed-stock later when internet is available.');
