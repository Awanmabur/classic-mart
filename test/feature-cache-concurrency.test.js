import test from 'node:test';
import assert from 'node:assert/strict';
import { FeatureFlag } from '../src/models/index.js';
import { activeFeatureMap, clearActiveFeatureCache } from '../src/services/stage9.js';

test('simultaneous requests share an executed feature query promise',async t=>{
  clearActiveFeatureCache();
  let release,executions=0;
  const pending=new Promise(resolve=>{release=resolve;});
  t.mock.method(FeatureFlag,'find',()=>({lean(){return {then(){throw new Error('Query thenable reused');},exec(){executions++;return pending;}};}}));
  const requests=Array.from({length:20},()=>activeFeatureMap({country:'UG',role:'customer',identity:'test'}));
  release([{key:'test_feature',enabled:true,rolloutPercentage:100}]);
  for(const result of await Promise.all(requests)) assert.equal(result.test_feature,true);
  assert.equal(executions,1);
  clearActiveFeatureCache();
});
