import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

test('production market selection exposes only active launched countries and never manufactures Uganda', () => {
  const script = `
    import assert from 'node:assert/strict';
    import { registerHooks } from 'node:module';
    let records = [{code:'KE',name:'Kenya',currency:'KES',active:true},{code:'UG',name:'Uganda',active:true}];
    let reads = 0;
    globalThis.countryFixture = {find(query){assert.deepEqual(query,{active:true});reads++;return {lean(){return {exec:async()=>records}}}}};
    registerHooks({resolve(specifier,context,next){
      if(context.parentURL?.endsWith('/src/services/country.js')){
        if(specifier==='../config/env.js')return {url:'data:text/javascript,'+encodeURIComponent('export const env={isTest:false,isProduction:true,security:{launchCountries:["KE"]}}'),shortCircuit:true};
        if(specifier==='../models/index.js')return {url:'data:text/javascript,'+encodeURIComponent('export const CountrySetting=globalThis.countryFixture'),shortCircuit:true};
      }
      return next(specifier,context);
    }});
    const {getCountry,getCountries,clearCountryCache}=await import('./src/services/country.js');
    assert.equal((await getCountry('UG')).code,'KE');
    assert.deepEqual((await getCountries()).map(c=>c.code),['KE']);
    assert.equal(reads,1,'eligible configuration is cached');
    records=[];clearCountryCache();
    assert.deepEqual(await getCountries(),[]);
    await assert.rejects(getCountry('UG'),{status:503,code:'COUNTRY_UNAVAILABLE'});
    records=[{code:'KE',name:'Restored Kenya',active:true}];clearCountryCache();
    assert.equal((await getCountry()).name,'Restored Kenya');
  `;
  const result = spawnSync(process.execPath, ['--input-type=module', '--eval', script], { cwd: new URL('../', import.meta.url), encoding: 'utf8', timeout: 15_000 });
  assert.equal(result.status, 0, result.stderr);
});
