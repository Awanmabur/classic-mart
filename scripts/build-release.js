import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';

const root=process.cwd();
const pkg=JSON.parse(fs.readFileSync('package.json','utf8'));
const version=pkg.version;
const outRoot=path.join(root,'dist');
const folderName=`classic-mart-v${version}`;
const stage=path.join(outRoot,folderName);
const zipPath=path.join(outRoot,`${folderName}.zip`);
const allow=['package.json','package-lock.json','Dockerfile','.dockerignore','.gitignore','.env.example','.env.production.example','render.yaml','README.md','PRODUCTION_SETUP.md',`RELEASE_NOTES_v${version}.md`,'UPDATES.md','playwright.config.js','src','public','views','scripts','docs','test','tests','.github'];
const forbiddenNames=new Set(['.env','.git','node_modules','.classic-mart','storage','logs','artifacts','dist','coverage']);
const privateKey=/-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/;
const highRiskKey=/(?:AKIA[0-9A-Z]{16}|ASIA[0-9A-Z]{16}|sk_live_[A-Za-z0-9]{20,}|ghp_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})/;
const suspiciousPem=/-----BEGIN (?:CERTIFICATE REQUEST|ENCRYPTED PRIVATE KEY)-----/;
const textExtensions=new Set(['.js','.mjs','.cjs','.json','.md','.txt','.ejs','.css','.html','.yml','.yaml','.env','.example','.xml','.csv']);

function safeSource(rel){
  const resolved=path.resolve(root,rel);
  if(resolved!==root&&!resolved.startsWith(root+path.sep))throw new Error(`Release source escaped project root: ${rel}`);
  return resolved;
}
function copy(rel){
  const src=safeSource(rel);if(!fs.existsSync(src))return;
  const base=path.basename(rel);if(forbiddenNames.has(base))throw new Error(`Forbidden release path: ${rel}`);
  const lst=fs.lstatSync(src);if(lst.isSymbolicLink())throw new Error(`Symlinks are forbidden in release input: ${rel}`);
  const dst=path.join(stage,rel);
  if(lst.isDirectory()){
    fs.mkdirSync(dst,{recursive:true});
    for(const name of fs.readdirSync(src)){if(forbiddenNames.has(name))continue;copy(path.join(rel,name));}
  }else if(lst.isFile()){
    fs.mkdirSync(path.dirname(dst),{recursive:true});fs.copyFileSync(src,dst);
  }else throw new Error(`Unsupported release filesystem entry: ${rel}`);
}
function walk(dir,out=[]){for(const ent of fs.readdirSync(dir,{withFileTypes:true})){const full=path.join(dir,ent.name);if(ent.isSymbolicLink())throw new Error(`Symlink found inside staged release: ${path.relative(stage,full)}`);if(ent.isDirectory())walk(full,out);else if(ent.isFile())out.push(full);}return out;}
function hashFile(file){return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');}
function looksText(file){const ext=path.extname(file).toLowerCase();return textExtensions.has(ext)||path.basename(file)==='.env.example'||!ext;}
function scanSecrets(file){
  if(fs.statSync(file).size>5*1024*1024||!looksText(file))return [];
  const text=fs.readFileSync(file,'utf8');const findings=[];
  if(privateKey.test(text))findings.push('private key material');
  if(suspiciousPem.test(text))findings.push('private/encrypted key request material');
  if(highRiskKey.test(text))findings.push('recognized production credential pattern');
  return findings;
}

fs.rmSync(stage,{recursive:true,force:true});fs.mkdirSync(stage,{recursive:true});
for(const rel of allow)copy(rel);
const stagedFiles=walk(stage);
const badPaths=[];const secretFindings=[];
for(const file of stagedFiles){
  const rel=path.relative(stage,file).replaceAll('\\','/');
  const segments=rel.split('/');
  if(segments.some(segment=>forbiddenNames.has(segment))||rel==='.env'||(/^\.env\./.test(rel)&&!['.env.example','.env.production.example'].includes(rel)))badPaths.push(rel);
  for(const finding of scanSecrets(file))secretFindings.push(`${rel}: ${finding}`);
}
if(badPaths.length)throw new Error(`Forbidden files entered release: ${badPaths.join(', ')}`);
if(secretFindings.length)throw new Error(`Potential secret material entered release:\n- ${secretFindings.join('\n- ')}`);

const manifest=stagedFiles.map(file=>({path:path.relative(stage,file).replaceAll('\\','/'),sha256:hashFile(file),bytes:fs.statSync(file).size})).sort((a,b)=>a.path.localeCompare(b.path));
fs.writeFileSync(path.join(stage,'RELEASE_MANIFEST.json'),JSON.stringify({name:'classic-mart',version,createdAt:new Date().toISOString(),nodeEngine:pkg.engines?.node||'',secretScan:'passed',forbiddenPathScan:'passed',files:manifest},null,2)+'\n');
fs.rmSync(zipPath,{force:true});
execFileSync('zip',['-qr',zipPath,folderName],{cwd:outRoot,stdio:'inherit'});
const sha=hashFile(zipPath);fs.writeFileSync(`${zipPath}.sha256`,`${sha}  ${path.basename(zipPath)}\n`);
console.log(JSON.stringify({stage,zipPath,sha256:sha,files:manifest.length,secretScan:'passed',forbiddenPathScan:'passed'},null,2));
