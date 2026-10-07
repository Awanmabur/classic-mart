import test from 'node:test';
import assert from 'node:assert/strict';
process.env.NODE_ENV='development';
const { CountrySetting } = await import('../src/models/index.js');
const { getCountry, getCountries, clearCountryCache } = await import('../src/services/country.js');

test('concurrent country lookups share one executed refresh and failed refreshes retry', async t => {
  clearCountryCache();
  let executions = 0;
  t.mock.method(CountrySetting, 'find', () => ({ lean: () => ({ exec: async () => {
    executions++; await new Promise(resolve => setTimeout(resolve, 5));
    if (executions === 1) throw new Error('Connection lost');
    return [{ code:'KE', name:'Kenya', currency:'KES', active:true }];
  } }) }));
  await assert.rejects(getCountry('KE'), /Connection lost/);
  const countries=await Promise.all(Array.from({length:20},()=>getCountry('KE')));
  for(const country of countries) assert.equal(country.code,'KE');
  assert.equal(executions,2);
  assert.equal((await getCountries()).length,2);
  clearCountryCache();
});

test('an invalidated in-flight country refresh cannot overwrite the newer configuration', async t => {
  clearCountryCache();
  let resolveOld, executions=0;
  t.mock.method(CountrySetting,'find',()=>({lean:()=>({exec:()=>{
    executions++;
    if(executions===1)return new Promise(resolve=>{resolveOld=resolve;});
    return Promise.resolve([{code:'KE',name:'Updated Kenya',currency:'KES',active:true}]);
  }})}));
  const old=getCountry('KE');
  clearCountryCache();
  assert.equal((await getCountry('KE')).name,'Updated Kenya');
  resolveOld([{code:'KE',name:'Outdated Kenya',currency:'KES',active:true}]);
  assert.equal((await old).name,'Updated Kenya');
  assert.equal((await getCountry('KE')).name,'Updated Kenya');
  clearCountryCache();
});
