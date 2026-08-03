import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
const viewDir = path.join(root, 'views');
const viewFiles = fs.readdirSync(viewDir).filter((name) => fs.statSync(path.join(viewDir, name)).isFile());
const ejsFiles = viewFiles.filter((name) => name.endsWith('.ejs'));

function jsFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const location = path.join(dir, entry.name);
    return entry.isDirectory() ? jsFiles(location) : (location.endsWith('.js') ? [location] : []);
  });
}

test('server views use real EJS files and the native EJS engine', () => {
  assert.ok(ejsFiles.length >= 50, 'expected the complete server view set to be EJS');
  assert.equal(viewFiles.filter((name) => name.endsWith('.html')).length, 0);
  const app = read('src/app.js');
  assert.match(app, /set\(['"]view engine['"],\s*['"]ejs['"]\)/);
  assert.doesNotMatch(app, /app\.engine\(['"]html['"]/);
});

test('literal render targets are extensionless and resolve to EJS templates', () => {
  for (const file of jsFiles(path.join(root, 'src'))) {
    const source = fs.readFileSync(file, 'utf8');
    for (const match of source.matchAll(/\.render\(['"]([A-Za-z0-9_-]+)(?:\.(html|ejs))?['"]/g)) {
      assert.equal(match[2], undefined, `${path.relative(root, file)} should render extensionless EJS view names`);
      assert.ok(fs.existsSync(path.join(viewDir, `${match[1]}.ejs`)), `${match[1]}.ejs is missing for ${path.relative(root, file)}`);
    }
  }
});

test('EJS navigation uses clean routes and root-relative local assets', () => {
  for (const name of ejsFiles) {
    const source = read(`views/${name}`);
    assert.doesNotMatch(source, /\b(?:href|action)=["'][^"']*\.html(?:[?#][^"']*)?["']/i, `${name} still links to a .html route`);
    for (const value of source.matchAll(/\b(?:src|href)=["']([^"']+)["']/gi)) {
      const ref = value[1].split(/[?#]/, 1)[0];
      if (!/\.(?:css|js|svg|png|webp|jpe?g|gif)$/i.test(ref) || /^(?:https?:|data:|<%)/i.test(ref)) continue;
      assert.ok(ref.startsWith('/'), `${name} contains relative bundled asset ${ref}`);
      assert.ok(fs.existsSync(path.join(root, 'public', ref.replace(/^\/+/, ''))), `${name} references missing asset ${ref}`);
    }
  }
});

test('browser scripts no longer navigate through legacy .html filenames', () => {
  for (const file of jsFiles(path.join(root, 'public'))) {
    if (file.includes(`${path.sep}assets${path.sep}vendor${path.sep}`)) continue;
    assert.doesNotMatch(fs.readFileSync(file, 'utf8'), /(?:index|login|signup|products|categories|sellers|promoters|search|cart|help|track-order|profile|returns|shipping|privacy|terms|contact)\.html/i, path.relative(root, file));
  }
});

test('legacy external .html URLs remain redirects for old bookmarks only', () => {
  const routes = read('src/routes/public.js');
  assert.match(routes, /router\.get\('\/index\.html'/);
  assert.match(routes, /router\.get\('\/login\.html'/);
  assert.match(routes, /router\.get\(`\/\$\{name\}\.html`/);
});

test('final workspace stylesheet references exist', () => {
  assert.ok(fs.existsSync(path.join(root, 'public/role-dashboard.css')));
  assert.doesNotMatch(read('views/ask-classic.ejs'), /href=["']\/style\.css["']/);
});


test('static EJS links and form actions resolve to registered routes or bundled assets', () => {
  const routeSource = fs.readdirSync(path.join(root, 'src/routes'))
    .filter((name) => name.endsWith('.js'))
    .map((name) => read(`src/routes/${name}`))
    .join('\n');
  for (const name of ejsFiles) {
    const source = read(`views/${name}`);
    for (const match of source.matchAll(/\b(href|action)=["']([^"']+)["']/gi)) {
      const [attribute, raw] = [match[1].toLowerCase(), match[2]];
      if (!raw.startsWith('/') || raw.includes('<%')) continue;
      const clean = raw.split(/[?#]/, 1)[0];
      if (clean === '/') continue;
      if (/\.(?:css|js|json|webmanifest|png|svg|webp|jpe?g|gif)$/i.test(clean)) {
        assert.ok(fs.existsSync(path.join(root, 'public', clean.replace(/^\/+/, ''))), `${name} references missing asset ${clean}`);
        continue;
      }
      assert.ok(routeSource.includes(clean), `${name} ${attribute} points at unregistered static route ${clean}`);
    }
  }
});
