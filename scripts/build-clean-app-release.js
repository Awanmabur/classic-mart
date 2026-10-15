import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { rewriteRuntimePackage } from './runtime-package.js';

const root = process.cwd();
const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
const version = pkg.version;
const outRoot = path.join(root, 'dist');
const folderName = `classic-mart-v${version}-clean`;
const stage = path.join(outRoot, folderName);
const zipPath = path.join(outRoot, `${folderName}.zip`);

const allow = [
  'package.json','package-lock.json','Dockerfile','.dockerignore','.env.example','.env.production.example',
  'README.md','PRODUCTION_SETUP.md','docs/production/staged-launch.md','render.yaml','src','public','views',
  'scripts/runtime-package.js','scripts/run-production.js','scripts/bootstrap-production.js','scripts/migrate-production.js',
  'scripts/pesapal-register-ipn.js','scripts/launch-check.js','scripts/check-production-data.js',
  'scripts/deploy-smoke.js','scripts/backup-drill.js','scripts/check-r2.js','scripts/verify-mail.js','scripts/verify-sms.js','scripts/verify-mongo.js',
  'scripts/seed-initial-catalogue.js','scripts/reset-admin-password.js','scripts/launch-evidence.js','scripts/staff-access.js','scripts/operator-input.js'
];

const forbiddenExact = new Set([
  'test','tests','.github','playwright.config.js','scripts/ensure-local-mongo.js','scripts/stop-local-mongo.js',
  'scripts/reset-local.js','scripts/seed.js','scripts/fetch-seed-product-images.js','scripts/audit-integration.js',
  'scripts/audit-concurrency.js','scripts/load-smoke.js','scripts/run-tests.js','scripts/check-project.js',
  'scripts/check-imports.js','scripts/check-release-scripts.js','scripts/security-check.js','scripts/security-check-path.js',
  'scripts/security-sbom.js','scripts/audit-frontend.js','scripts/audit-functionality.js','scripts/build-release.js',
  'scripts/build-production-release.js','scripts/build-clean-app-release.js','src/core/local-mongo.js',
  'public/assets/products','public/dashboard-assets','dashboard-preview','CLEAN_MANIFEST.json','PRODUCTION_MANIFEST.json','RELEASE_MANIFEST.json','UPDATES.md',
  'public/approved-dashboard/script.js','public/approved-dashboard/role-workspaces.js','public/approved-dashboard/enhancements.js','public/approved-dashboard/session-controls.js'
]);
const forbiddenNames = new Set(['.env','.git','node_modules','.classic-mart','storage','logs','artifacts','dist','coverage']);
const privateKey = /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/;
const highRiskKey = /(?:AKIA[0-9A-Z]{16}|ASIA[0-9A-Z]{16}|sk_live_[A-Za-z0-9]{20,}|ghp_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})/;

function normalized(rel){return rel.replaceAll('\\','/').replace(/^\.\//,'');}
function blocked(rel){const n=normalized(rel);return forbiddenExact.has(n)||[...forbiddenExact].some(item=>n.startsWith(`${item}/`));}
function copy(rel){
  const n=normalized(rel); if(blocked(n)) return;
  const src=path.resolve(root,n); if(!fs.existsSync(src)) return;
  const st=fs.lstatSync(src); if(st.isSymbolicLink()) throw new Error(`Symlink forbidden: ${n}`);
  const dst=path.join(stage,n);
  if(st.isDirectory()){
    fs.mkdirSync(dst,{recursive:true});
    for(const name of fs.readdirSync(src)) copy(`${n}/${name}`);
  }else{
    fs.mkdirSync(path.dirname(dst),{recursive:true});
    fs.copyFileSync(src,dst);
  }
}
function walk(dir,out=[]){for(const ent of fs.readdirSync(dir,{withFileTypes:true})){const full=path.join(dir,ent.name);if(ent.isSymbolicLink())throw new Error(`Symlink forbidden: ${full}`);if(ent.isDirectory())walk(full,out);else out.push(full);}return out;}
function sha(file){return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');}

fs.rmSync(stage,{recursive:true,force:true});
fs.mkdirSync(stage,{recursive:true});
for(const rel of allow) copy(rel);
// Runtime packages carry only their actual operating guide, not source-only
// documentation links and engineering commands that are deliberately omitted.
fs.writeFileSync(path.join(stage,'README.md'),[
  '# Classic Mart', '',
  'This package includes the application and deliberate initial catalogue setup.',
  'Use Node.js 24 and install the committed lockfile with `npm ci`.', '',
  'Read [production setup](PRODUCTION_SETUP.md) and',
  '[staged launch operations](docs/production/staged-launch.md) for configuration,',
  'released roles, staff access, launch evidence and remaining verification requirements.', '',
  'Configure transaction-capable MongoDB, Redis and private R2 through your environment manager.',
  'Run `npm run db:verify` and `npm run media:r2:check` before `npm run dev`.',
  'Initial catalogue import is explicit: `INITIAL_CATALOGUE_CONFIRM=SEED_REAL_CLASSIC_MART npm run db:setup`.',
  'Never import development data into an existing production database.', '',
  'Production startup uses `npm run start:production`; launch sign-off uses `npm run launch:check`.',
  'Real Gmail/eSMS/Pesapal delivery and production infrastructure require configured credentials and verification.',
  'The full source, design references and engineering tests are in the source release.', '',
].join('\n'));
for (const required of ['scripts/seed-initial-catalogue.js','src/config/initial-catalogue.js']) {
  if (!fs.existsSync(path.join(stage, required))) throw new Error(`Clean app artifact is missing required initial catalogue setup file: ${required}`);
}

rewriteRuntimePackage(stage, 'clean');

const files=walk(stage);
const bad=[]; const secrets=[];
for(const file of files){
  const rel=normalized(path.relative(stage,file));
  if(rel.split('/').some(segment=>forbiddenNames.has(segment))||blocked(rel)) bad.push(rel);
  if(fs.statSync(file).size<5*1024*1024&&/\.(?:js|json|md|txt|ejs|css|html|ya?ml|example)$/.test(rel)){
    const text=fs.readFileSync(file,'utf8');
    if(privateKey.test(text)||highRiskKey.test(text)) secrets.push(rel);
  }
}
if(bad.length) throw new Error(`Unnecessary/local paths entered clean app artifact: ${bad.join(', ')}`);
if(secrets.length) throw new Error(`Potential secret material entered clean app artifact: ${secrets.join(', ')}`);

const manifest=files.map(file=>({path:normalized(path.relative(stage,file)),sha256:sha(file),bytes:fs.statSync(file).size})).sort((a,b)=>a.path.localeCompare(b.path));
fs.writeFileSync(path.join(stage,'CLEAN_MANIFEST.json'),JSON.stringify({name:'classic-mart',version,kind:'clean-app',createdAt:new Date().toISOString(),files:manifest},null,2)+'\n');
fs.rmSync(zipPath,{force:true});
execFileSync('zip',['-qr',zipPath,folderName],{cwd:outRoot,stdio:'inherit'});
const digest=sha(zipPath);
fs.writeFileSync(`${zipPath}.sha256`,`${digest}  ${path.basename(zipPath)}\n`);
console.log(JSON.stringify({stage,zipPath,sha256:digest,files:manifest.length},null,2));
