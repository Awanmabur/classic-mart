import test from 'node:test';
import assert from 'node:assert/strict';
import { remainingProcurementItems, remainingApprovedMinor } from '../src/core/procurement.js';

class MongooseLikeSubdocument {
  constructor(value){this._doc=value;}
  get productPublicId(){return this._doc.productPublicId;}
  get quantity(){return this._doc.quantity;}
  get estimatedUnitMinor(){return this._doc.estimatedUnitMinor;}
  get note(){return this._doc.note;}
}

test('remaining procurement math preserves values from Mongoose-like subdocuments',()=>{
  const items=[new MongooseLikeSubdocument({productPublicId:'prod_a',quantity:3,estimatedUnitMinor:1250,note:'keep'})];
  const spread={...items[0]};
  assert.equal(spread.estimatedUnitMinor,undefined,'Regression fixture must demonstrate why object spread is unsafe for Mongoose subdocuments.');
  const covered=new Map([['prod_a',1]]);
  assert.deepEqual(remainingProcurementItems(items,covered),[{productPublicId:'prod_a',quantity:2,estimatedUnitMinor:1250,note:'keep'}]);
  assert.equal(remainingApprovedMinor(items,covered),2500);
});

test('remaining procurement math cannot produce negative release quantities',()=>{
  const items=[{productPublicId:'prod_a',quantity:1,estimatedUnitMinor:2500,note:''}];
  assert.deepEqual(remainingProcurementItems(items,new Map([['prod_a',4]])),[]);
  assert.equal(remainingApprovedMinor(items,new Map([['prod_a',4]])),0);
});
