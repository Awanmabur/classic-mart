import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';

const root=process.cwd();
if(process.env.NODE_ENV==='production') throw new Error('Refusing to reset local state while NODE_ENV=production.');
if(!process.argv.includes('--yes')){
  throw new Error('This permanently deletes the local .env and .classic-mart database state. Re-run `npm run reset:local -- --yes` to confirm.');
}
const templatePath=path.join(root,'.env.example');
if(!fs.existsSync(templatePath)) throw new Error('.env.example is required before a local reset.');

const stop=spawnSync(process.execPath,['scripts/stop-local-mongo.js'],{cwd:root,stdio:'inherit',windowsHide:true});
if(stop.status!==0) throw new Error('Could not safely stop Classic Mart local MongoDB; local state was not deleted.');

fs.rmSync(path.join(root,'.classic-mart'),{recursive:true,force:true,maxRetries:10,retryDelay:250});
fs.rmSync(path.join(root,'.env'),{force:true});

const secret=()=>crypto.randomBytes(32).toString('hex');
const adminPassword=`Cm!${crypto.randomBytes(12).toString('hex')}9aA`;
let env=fs.readFileSync(templatePath,'utf8');
env=env.replace(/^MONGO_MODE=.*$/m,'MONGO_MODE=local')
  .replace(/^MONGO_URI=.*$/m,'MONGO_URI=')
  .replace(/^SESSION_SECRET=.*$/m,`SESSION_SECRET=${secret()}`)
  .replace(/^TOKEN_PEPPER=.*$/m,`TOKEN_PEPPER=${secret()}`)
  .replace(/^DATA_ENCRYPTION_KEY=.*$/m,`DATA_ENCRYPTION_KEY=${secret()}`)
  .replace(/^SECURITY_INTEGRITY_KEY=.*$/m,`SECURITY_INTEGRITY_KEY=${secret()}`)
  .replace(/^ADMIN_PASSWORD=.*$/m,`ADMIN_PASSWORD=${adminPassword}`);
fs.writeFileSync(path.join(root,'.env'),env,{encoding:'utf8',mode:0o600});

console.log('Classic Mart local state reset. A fresh .env was generated from .env.example with new local secrets.');
console.log('The next `npm run verify:local` will create a brand-new .classic-mart MongoDB replica-set data directory and reseed the platform.');
console.log('Fresh local Super Admin credentials:');
console.log('  Email: admin@classicmart.local');
console.log(`  Password: ${adminPassword}`);
