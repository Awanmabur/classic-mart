import test from 'node:test';
import assert from 'node:assert/strict';
import { canonicalPhone } from '../src/core/phone.js';
import { profileSchema } from '../src/validation/identity.js';

test('selected countries enforce their national phone lengths and normalize trunk prefixes', () => {
  for (const [country,prefix] of [['UG','256'],['KE','254'],['TZ','255'],['RW','250'],['SS','211']]) {
    assert.equal(canonicalPhone('0700 000 000',country),`+${prefix}700000000`);
    assert.throws(()=>canonicalPhone('070000',country),{code:'INVALID_PHONE'});
    assert.throws(()=>canonicalPhone('070000000000',country),{code:'INVALID_PHONE'});
  }
  assert.equal(canonicalPhone('(202) 555-0123','US'),'+12025550123');
  assert.throws(()=>canonicalPhone('202555012','US'),{code:'INVALID_PHONE'});
  assert.throws(()=>canonicalPhone('+254700000000','UG'),{code:'INVALID_PHONE'});
});

test('international numbers, malformed input and profile edits use the same length guard', () => {
  assert.equal(canonicalPhone('+256 700 000 000'),'+256700000000');
  for (const phone of ['+25670000000','+2567000000000','+999700000000','700000000','+256700000000 ext 123','call +256700000000']) {
    assert.throws(()=>canonicalPhone(phone),{code:'INVALID_PHONE'});
    assert.equal(profileSchema.safeParse({name:'Customer',phone,country:'UG',currency:'UGX',locale:'en-UG'}).success,false);
  }
});
