import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

for (const identity of [{role:'customer',status:'active'},{role:'seller',status:'active'},{role:'super_admin',status:'suspended'}]) {
  test(`production bootstrap cannot promote or reactivate existing ${identity.role}/${identity.status}`, () => {
    const script = `
      import assert from 'node:assert/strict';
      import {registerHooks} from 'node:module';
      let grantWrites=0,userWrites=0,failed=false;
      const identity=${JSON.stringify(identity)};
      globalThis.bootstrapFixture={
        User:{findOne(){return {select:async()=>({...identity,_id:'existing',save:async()=>{userWrites++}})}},create:async()=>{userWrites++}},
        PlatformGrant:{updateMany:async()=>{grantWrites++},findOne:async()=>{grantWrites++},create:async()=>{grantWrites++}},
        CountrySetting:{updateOne:async()=>{}},Category:{updateOne:async()=>{}}
      };
      globalThis.bootstrapLogger={info(){},fatal(){failed=true}};
      process.on('exit',()=>{assert.equal(failed,true);assert.equal(grantWrites,0);assert.equal(userWrites,0)});
      const stub = source=>({url:'data:text/javascript,'+encodeURIComponent(source),shortCircuit:true});
      registerHooks({resolve(specifier,context,next){
        if(context.parentURL?.endsWith('/scripts/bootstrap-production.js')){
          if(specifier.endsWith('/config/env.js'))return stub('export const env={admin:{email:"trusted@example.test"},security:{launchCountries:["KE"]}}');
          if(specifier.endsWith('/config/db.js'))return stub('export async function connectDatabase(){}; export async function disconnectDatabase(){}');
          if(specifier.endsWith('/config/logger.js'))return stub('export const logger=globalThis.bootstrapLogger');
          if(specifier.endsWith('/models/index.js'))return stub('export const {User,PlatformGrant,CountrySetting,Category}=globalThis.bootstrapFixture');
          if(specifier.endsWith('/core/indexes.js'))return stub('export async function ensureModelIndexes(){};export async function reconcileExpiryIndexes(){};export function ttlIndexEntriesForModels(){return []}');
          if(specifier.endsWith('/core/crypto.js'))return stub('export const normalizeEmail=value=>value.toLowerCase(),normalizePhone=value=>value,hashPassword=async()=>{throw Error("must not hash a promoted user")};');
          if(specifier.endsWith('/services/auth.js'))return stub('export function assertStrongPassword(){throw Error("must not create an existing user")}');
        }
        return next(specifier,context);
      }});
      await import('./scripts/bootstrap-production.js');
    `;
    const result = spawnSync(process.execPath, ['--input-type=module', '--eval', script], { cwd: new URL('../', import.meta.url), encoding:'utf8', timeout:15_000, env:{...process.env,NODE_ENV:'production'} });
    assert.equal(result.status,1,result.stderr);
    assert.equal(result.stderr,'','expected controlled rejection, not an import or assertion failure');
  });
}
