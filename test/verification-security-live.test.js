import test from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';

process.env.NODE_ENV='test';
process.env.SMS_MODE='unconfigured';
const {VerificationToken}=await import('../src/models/index.js');
const {consumeCode,resendPhoneVerification}=await import('../src/services/auth.js');
const {hashToken}=await import('../src/core/crypto.js');
const uri=process.env.CLASSIC_MART_LIVE_TEST_MONGO_URI;

test('MongoDB verification codes are single-use under concurrency, cap guesses and invalidate failed SMS sends',{skip:!uri},async()=>{
  assert.equal(new URL(uri).hostname,'127.0.0.1');
  assert.match(new URL(uri).pathname,/test|verification/i);
  await mongoose.connect(uri);
  const userId=new mongoose.Types.ObjectId();
  try {
    const token=await VerificationToken.create({userId,purpose:'verify_email',tokenHash:hashToken('123456'),expiresAt:new Date(Date.now()+600000)});
    const claims=await Promise.allSettled(Array.from({length:12},()=>consumeCode(userId,'verify_email','123456')));
    assert.equal(claims.filter(result=>result.status==='fulfilled').length,1);
    assert.equal(claims.filter(result=>result.status==='rejected'&&result.reason.code==='INVALID_CODE').length,11);
    assert.ok((await VerificationToken.findById(token._id)).consumedAt);

    const guesses=await VerificationToken.create({userId,purpose:'verify_phone',tokenHash:hashToken('654321'),expiresAt:new Date(Date.now()+600000)});
    const wrong=await Promise.allSettled(Array.from({length:12},()=>consumeCode(userId,'verify_phone','000000')));
    assert.equal(wrong.filter(result=>result.status==='rejected'&&result.reason.code==='INVALID_CODE').length,12);
    assert.equal((await VerificationToken.findById(guesses._id)).attempts,5);
    await assert.rejects(consumeCode(userId,'verify_phone','654321'),error=>error.code==='INVALID_CODE');
    await VerificationToken.deleteMany({userId,purpose:'verify_phone'});

    const user={_id:userId,emailVerifiedAt:new Date(),phone:'+256700000001',name:'Verification Test'};
    for(let attempt=0;attempt<2;attempt++) await assert.rejects(resendPhoneVerification(user,{ip:'127.0.0.1'}),error=>error.code==='SMS_NOT_CONFIGURED');
    assert.equal(await VerificationToken.countDocuments({userId,purpose:'verify_phone',consumedAt:null}),0);
    const failed=await VerificationToken.find({userId,purpose:'verify_phone'}).select('+tokenHash').lean();
    assert.equal(failed.length,2);
    for(const entry of failed){assert.ok(entry.consumedAt);assert.notEqual(entry.tokenHash,'123456');}
  } finally {await VerificationToken.deleteMany({userId});await mongoose.disconnect();}
});
