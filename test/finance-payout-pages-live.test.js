import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import { EventEmitter } from 'node:events';
import mongoose from 'mongoose';
import request from 'supertest';
process.env.NODE_ENV='test';process.env.SIMPLE_LOGIN='false';process.env.PRIVILEGED_MFA_REQUIRED='true';process.env.MAIL_MODE='log';process.env.SMS_MODE='log';process.env.REDIS_URL='';
for(const key of ['SESSION_SECRET','TOKEN_PEPPER','SECURITY_INTEGRITY_KEY','DATA_ENCRYPTION_KEY'])process.env[key]=crypto.randomBytes(32).toString('hex');
const uri=process.env.CLASSIC_MART_LIVE_TEST_MONGO_URI;if(uri)process.env.MONGO_URI=uri;
const csrf=html=>html.match(/(?:name="_csrf"[^>]*value|name="csrf-token" content)="([^"]+)"/)[1];

test('Finance payout operations complete reserved Seller and Promoter funds with independent, scoped evidence', {skip:!uri,timeout:180000},async t=>{
  assert.equal(new URL(uri).hostname,'127.0.0.1');assert.match(new URL(uri).pathname,/verification|test/i);
  const suffix=crypto.randomBytes(7).toString('hex');await mongoose.connect(uri,{dbName:'classicmart_finance_payout_test_'+suffix});
  const models=await import('../src/models/index.js');const {User,CountrySetting,Store,StoreMember,PromoterVerification,PlatformGrant,Order,Campaign,CommissionEntry,Payout,PayoutAccount,LedgerTransaction,AuditLog,Notification,Device}=models;
  const {createApp}=await import('../src/app.js');const {hashPassword,hashToken}=await import('../src/core/crypto.js');const {encryptSensitive}=await import('../src/core/sensitive.js');const {totpCode}=await import('../src/services/mfa.js');
  const payments=await import('../src/services/payments.js');const {ensureLedgerAccount,postLedgerTransaction,accountBalanceMinor}=await import('../src/services/money.js');
  const {loadFinancePayoutPage,actOnFinancePayout,reviewFinanceAppeal,streamFinancePayoutCsv}=await import('../src/services/finance-payout-pages.js');
  const password='Finance-'+suffix+'-A1!',passwordHash=await hashPassword(password),transports=[],app=createApp(null);let sequence=0;
  const scoped=actor=>({user:actor.user,device:actor.device,sessionID:actor.sessionID,session:{userId:String(actor.user._id),tokenVersion:actor.user.security.tokenVersion,mfaVerifiedAt:Date.now()},...(actor.role==='finance'?{requiredOperationalWorkspace:'finance'}:{}),query:{},id:'req_fp_'+suffix+'_'+(++sequence),get:()=>'',ip:'127.0.0.1'});
  async function actor(role='finance',{country='UG',countries=[country],managed=false,mfa=true}={}) {
    const n=++sequence,email=`finance-payout-${suffix}-${n}@example.com`,secret='JBSWY3DPEHPK3PXP';
    const user=await User.create({publicId:'usr_fp_'+suffix+'_'+n,name:'Finance '+n,email,emailNormalized:email,phone:'+25670'+String(n).padStart(7,'0'),phoneNormalized:'+25670'+String(n).padStart(7,'0'),passwordHash,role:managed?'customer':role,country,currency:country==='KE'?'KES':'UGX',locale:'en-UG',operationalCountries:countries,emailVerifiedAt:new Date(),onboardingCompletedAt:new Date(),...(managed?{platformAccessManagedAt:new Date()}:{}),security:{mfaEnabled:mfa,mfaSecretEncrypted:mfa?encryptSensitive(secret):undefined,mfaLastCounter:-1},consents:{terms:true,privacy:true,recordedAt:new Date()}});
    let grant;if(managed)grant=await PlatformGrant.create({publicId:'pgr_fp_'+suffix+'_'+n,userId:user._id,role,operationalCountries:countries,status:'active',startsAt:new Date(Date.now()-60000),expiresAt:new Date(Date.now()+86400000),reason:'Authorized Finance fixture',approvalPublicId:'apr_fp_'+suffix+'_'+n,approvedByUserId:user._id});
    const transport=new http.Agent({localAddress:'127.0.0.'+(n+30),keepAlive:false});transports.push(transport);const client=request.agent(app).use(req=>req.agent(transport));
    const login=await client.get('/login').expect(200);const response=await client.post('/login').type('form').send({email,password,_csrf:csrf(login.text)}).expect(302);
    if(mfa){assert.equal(response.headers.location,'/mfa');const challenge=await client.get('/mfa').expect(200);await client.post('/mfa').type('form').send({_csrf:csrf(challenge.text),code:totpCode(secret)}).expect(302);}
    const sessionID=crypto.randomUUID(),device=await Device.create({publicId:'dev_fp_'+suffix+'_'+n,userId:user._id,sessionHash:hashToken(sessionID),label:'Current Finance payout fixture',userAgent:'Finance payout regression',ipHash:hashToken(transport.options.localAddress),lastSeenAt:new Date()});
    return {user,client,grant,role,sessionID,device};
  }
  async function fund(ownerType,ownerPublicId,amountMinor,country='UG',currency='UGX') {
    const payable=await ensureLedgerAccount({code:ownerType==='store'?'seller_payable':'promoter_payable',type:'liability',ownerType,ownerPublicId,country,currency});
    const cash=await ensureLedgerAccount({code:'finance_fixture_cash',type:'asset',ownerType:'platform',ownerPublicId:'classic-mart',country,currency});
    await postLedgerTransaction({idempotencyKey:'fund_fp_'+suffix+'_'+(++sequence),referenceType:'verified_test_settlement',referencePublicId:'set_fp_'+sequence,country,currency,description:'Verified initial settlement fixture',entries:[{account:cash,debitMinor:amountMinor,creditMinor:0},{account:payable,debitMinor:0,creditMinor:amountMinor}]});return payable;
  }
  try {
    for(const Model of Object.values(mongoose.connection.models))await Model.init();
    await CountrySetting.create([{code:'UG',name:'Uganda',currency:'UGX',locale:'en-UG',timeZone:'Africa/Kampala',phonePrefix:'+256',active:true},{code:'KE',name:'Kenya',currency:'KES',locale:'en-KE',timeZone:'Africa/Nairobi',phonePrefix:'+254',active:true}]);
    const approver=await actor('finance',{managed:true}),operator=await actor(),backup=await actor(),kenya=await actor('finance',{country:'KE'}),multi=await actor('finance',{countries:['UG','KE']}),promoter=await actor('promoter',{mfa:false}),seller=await actor('seller'),customer=await actor('customer',{mfa:false});
    await PromoterVerification.create({publicId:'prv_fp_'+suffix,userId:promoter.user._id,country:'UG',status:'verified'});
    const store=await Store.create({publicId:'sto_fp_'+suffix,ownerUserId:seller.user._id,name:'Verified payout store',slug:'finance-payout-'+suffix,country:'UG',currency:'UGX',status:'verified'});
    await StoreMember.create({publicId:'stm_fp_'+suffix,storeId:store._id,userId:seller.user._id,role:'owner',status:'active',acceptedAt:new Date(),invitedByUserId:seller.user._id});
    const sellerReq=()=>({...scoped(seller),store});
    const destination={beneficiary_name:'PRIVATE_BENEFICIARY',account_bank:'PRIVATE_BANK',account_number:'PRIVATE_ACCOUNT_1234'};
    const promoterAccount=await payments.savePayoutAccount(scoped(promoter),{method:'bank',label:'  =Promoter destination',destination});
    const sellerAccount=await payments.savePayoutAccount(sellerReq(),{method:'bank',label:'Seller bank destination',destination});
    const promoterPayable=await fund('promoter',String(promoter.user._id),20000),sellerPayable=await fund('store',store.publicId,30000);
    const campaign=await Campaign.create({publicId:'cmp_fp_'+suffix,country:'UG',scope:'marketplace',systemManaged:true,name:'Settled payout campaign',status:'active',commissionBps:1000});
    const orderId=new mongoose.Types.ObjectId();await Order.collection.insertOne({_id:orderId,publicId:'ord_fp_'+suffix,country:'UG',totals:{currency:'UGX',totalMinor:200000},createdAt:new Date(),paymentState:'paid',contact:{email:'PRIVATE_BUYER_EMAIL'}});
    const commission=await CommissionEntry.create({publicId:'com_fp_'+suffix,orderId,orderPublicId:'ord_fp_'+suffix,campaignId:campaign._id,promoterUserId:promoter.user._id,touchId:new mongoose.Types.ObjectId(),storePublicId:store.publicId,productPublicId:'prd_fp_'+suffix,amountMinor:20000,currency:'UGX',commissionBps:1000,policyVersion:'fixture',status:'payable',payableAt:new Date()});
    let promoterPayout,sellerPayout,attempt;
    await t.test('pending encrypted destinations require independent, audited current-scope verification',async()=>{
      const stored=await PayoutAccount.findOne({publicId:promoterAccount.publicId}).select('+destinationEncrypted');assert.ok(!stored.destinationEncrypted.includes('PRIVATE_ACCOUNT'));assert.ok(!JSON.stringify(promoterAccount).includes('destinationEncrypted'));
      await assert.rejects(payments.reviewPayoutAccount(scoped(kenya),promoterAccount.publicId,{decision:'verify',reason:'Independent documented destination check.'}),error=>error.code==='FINANCE_COUNTRY_FORBIDDEN');
      const own=await PayoutAccount.create({publicId:'poa_self_fp_'+suffix,ownerUserId:operator.user._id,ownerType:'promoter',country:'UG',currency:'UGX',method:'bank',label:'Own destination',destinationEncrypted:encryptSensitive(JSON.stringify(destination))});
      await assert.rejects(payments.reviewPayoutAccount(scoped(operator),own.publicId,{decision:'verify',reason:'Denied self verification.'}),error=>error.code==='FOUR_EYES_REQUIRED');
      const accountPage=await approver.client.get('/finance/payouts?tab=destinations&destination='+promoterAccount.publicId).expect(200);assert.match(accountPage.text,/Record destination review/);assert.doesNotMatch(accountPage.text,/PRIVATE_BENEFICIARY|PRIVATE_BANK|PRIVATE_ACCOUNT/);
      await approver.client.post('/finance/payouts/destinations/'+promoterAccount.publicId+'/review').send({decision:'verify',reason:'Missing CSRF',version:0}).expect(403);
      await approver.client.post('/finance/payouts/destinations/'+promoterAccount.publicId+'/review').set('accept','application/json').set('x-csrf-token',csrf(accountPage.text)).send({decision:'verify',reason:'Verified independently against the supplied bank evidence.',version:0}).expect(200);
      await payments.reviewPayoutAccount(scoped(approver),sellerAccount.publicId,{decision:'verify',reason:'Verified seller bank documentation.'});
      assert.equal(await AuditLog.countDocuments({action:'finance.payout_account_verified'}),2);
    });
    await t.test('real owner requests reserve actual funds and notify scoped Finance recipients once',async()=>{
      promoterPayout=await payments.requestPayout(scoped(promoter),{payoutAccountId:promoterAccount.publicId,amountMinor:5000,idempotencyKey:'payout_promoter_fp_'+suffix});sellerPayout=await payments.requestPayout(sellerReq(),{payoutAccountId:sellerAccount.publicId,amountMinor:6000,idempotencyKey:'payout_seller_fp_'+suffix});
      assert.equal(await accountBalanceMinor(promoterPayable._id),15000);assert.equal(await accountBalanceMinor(sellerPayable._id),24000);
      const notices=await Notification.find({type:'finance_work',href:{$regex:promoterPayout.publicId}}).lean();assert.ok(notices.some(row=>String(row.userId)===String(approver.user._id)));assert.ok(!notices.some(row=>String(row.userId)===String(kenya.user._id)));assert.ok(!JSON.stringify(notices).includes('PRIVATE_'));
      const before=await Notification.countDocuments({type:'finance_work'});await payments.requestPayout(scoped(promoter),{payoutAccountId:promoterAccount.publicId,amountMinor:5000,idempotencyKey:'payout_promoter_fp_'+suffix});assert.equal(await Notification.countDocuments({type:'finance_work'}),before);
      await assert.rejects(payments.requestPayout(scoped(promoter),{payoutAccountId:promoterAccount.publicId,amountMinor:6000,idempotencyKey:'payout_promoter_fp_'+suffix}),error=>error.code==='PAYOUT_IDEMPOTENCY_CONFLICT');
    });
    await t.test('Finance pages preserve the approved role and keep bank, buyer and session data private',async()=>{
      const page=await approver.client.get('/finance/payouts?record='+promoterPayout.publicId).expect(200);assert.match(page.text,/data-dashboard-workspace="finance"/);assert.match(page.text,/Approve reserved payout/);assert.match(page.headers['cache-control'],/no-store/);assert.match(page.headers['x-robots-tag'],/noindex/);assert.doesNotMatch(page.text,/PRIVATE_ACCOUNT|PRIVATE_BUYER|PRIVATE_BENEFICIARY|role-selector|Classic Club/);
      const json=await approver.client.get('/finance/payouts?record='+promoterPayout.publicId).set('accept','application/json').expect(200);assert.equal(json.body.rows.length,2);assert.ok(!JSON.stringify(json.body).includes('destinationEncrypted'));assert.ok(!JSON.stringify(json.body).includes('ownerUserId'));
      await customer.client.get('/finance/payouts').set('accept','application/json').expect(403);await promoter.client.get('/finance/payouts').set('accept','application/json').expect(403);
      await kenya.client.get('/finance/payouts?record='+promoterPayout.publicId).set('accept','application/json').expect(404);
      await approver.client.get('/finance/payouts?status[]=approved').set('accept','application/json').expect(422);await approver.client.get('/finance/payouts?after=broken').set('accept','application/json').expect(422);
      const csv=await approver.client.get('/finance/payouts/export.csv').expect(200);assert.match(csv.text,/'  =Promoter destination/);assert.doesNotMatch(csv.text,/PRIVATE_ACCOUNT|PRIVATE_BENEFICIARY|destinationEncrypted|ownerUserId/);
    });
    await t.test('approval is independent and stale decisions or missing holds cannot fabricate a transfer',async()=>{
      await assert.rejects(payments.approvePayout(scoped(approver),promoterPayout.publicId,{version:99}),error=>error.code==='PAYOUT_STATE_CHANGED');
      const approved=await payments.approvePayout(scoped(approver),promoterPayout.publicId,{version:0,reason:'Reserved amount and verified destination independently reviewed.'});assert.equal(approved.status,'approved');
      await assert.rejects(payments.submitPayout(scoped(approver),promoterPayout.publicId),error=>error.code==='FOUR_EYES_REQUIRED');
      const fabricated=await Payout.create({publicId:'pyo_fabricated_fp_'+suffix,idempotencyKey:'fabricated_fp_'+suffix,ownerUserId:promoter.user._id,requestedByUserId:promoter.user._id,payoutAccountId:(await PayoutAccount.findOne({publicId:promoterAccount.publicId}))._id,currency:'UGX',amountMinor:999,status:'requested'});
      await assert.rejects(payments.approvePayout(scoped(operator),fabricated.publicId),error=>error.code==='PAYOUT_HOLD_REQUIRED');await Payout.deleteOne({_id:fabricated._id});
    });
    await t.test('concurrent submitters claim exactly one immutable attempt; only its operator can open and confirm it',async()=>{
      const results=await Promise.allSettled([payments.submitPayout(scoped(operator),promoterPayout.publicId),payments.submitPayout(scoped(backup),promoterPayout.publicId)]);assert.equal(results.filter(row=>row.status==='fulfilled').length,1);assert.equal(results.filter(row=>row.status==='rejected').length,1);
      const payout=await Payout.findOne({publicId:promoterPayout.publicId});attempt=payout.submissionAttemptId;assert.ok(attempt);assert.equal(payout.status,'submitting');
      const submitter=String(payout.submittedByUserId)===String(operator.user._id)?operator:backup,other=submitter===operator?backup:operator;promoterPayout.submitter=submitter;promoterPayout.other=other;
      const page=await submitter.client.get('/finance/payouts?record='+payout.publicId).expect(200);assert.doesNotMatch(page.text,/PRIVATE_ACCOUNT/);
      await submitter.client.get('/finance/payouts/'+payout.publicId+'/destination').set('accept','application/json').expect(404);
      await other.client.post('/finance/payouts/'+payout.publicId+'/destination').type('form').send({_csrf:csrf((await other.client.get('/finance/payouts')).text)}).expect(403);
      const revealed=await submitter.client.post('/finance/payouts/'+payout.publicId+'/destination').type('form').send({_csrf:csrf(page.text)}).expect(200);assert.match(revealed.text,/PRIVATE_ACCOUNT_1234/);assert.match(revealed.headers['cache-control'],/no-store/);assert.equal(await AuditLog.countDocuments({action:'finance.payout_destination_opened',targetPublicId:payout.publicId}),1);
      await assert.rejects(payments.confirmPayoutSubmission(scoped(other),payout.publicId,{reference:'BANK_TRANSFER_001'}),error=>error.code==='PAYOUT_SUBMITTER_REQUIRED');
      await assert.rejects(payments.confirmPayoutSubmission(scoped(submitter),payout.publicId,{reference:'BANK_TRANSFER_001',submissionAttemptId:'changed-attempt'}),error=>error.code==='PAYOUT_ATTEMPT_CHANGED');
      const submitted=await payments.confirmPayoutSubmission(scoped(submitter),payout.publicId,{reference:'BANK_TRANSFER_001',submissionAttemptId:attempt});assert.equal(submitted.status,'submitted');assert.equal(await accountBalanceMinor(promoterPayable._id),15000);
    });
    await t.test('UNKNOWN preserves the hold and reference until an independent paid reconciliation settles commissions once',async()=>{
      await payments.markPayoutUnknown(scoped(promoterPayout.other),promoterPayout.publicId,{reason:'Bank response is ambiguous; checking the original reference.',submissionAttemptId:attempt});
      await assert.rejects(payments.submitPayout(scoped(operator),promoterPayout.publicId),error=>error.code==='PAYOUT_SUBMISSION_CLAIMED');
      await assert.rejects(payments.reconcilePayout(scoped(approver),promoterPayout.publicId,{reference:'DIFFERENT_REFERENCE',success:true,message:'Denied reference replacement'}),error=>error.code==='PAYOUT_REFERENCE_FROZEN');
      await assert.rejects(payments.reconcilePayout(scoped(promoterPayout.submitter),promoterPayout.publicId,{reference:'BANK_TRANSFER_001',success:true,message:'Denied self reconciliation'}),error=>error.code==='FOUR_EYES_REQUIRED');
      const paid=await payments.reconcilePayout(scoped(approver),promoterPayout.publicId,{reference:'BANK_TRANSFER_001',success:true,message:'Independent bank receipt confirms beneficiary paid.',submissionAttemptId:attempt});assert.equal(paid.status,'paid');assert.equal(paid.submissionAttemptId,attempt);assert.equal((await CommissionEntry.findById(commission._id)).paidAmountMinor,5000);assert.equal(await accountBalanceMinor(promoterPayable._id),15000);assert.equal(await LedgerTransaction.countDocuments({idempotencyKey:'payout-paid:'+promoterPayout.publicId}),1);
      await assert.rejects(payments.reconcilePayout(scoped(approver),promoterPayout.publicId,{reference:'BANK_TRANSFER_001',success:true}),error=>error.code==='PAYOUT_NOT_FOUND');assert.equal(await LedgerTransaction.countDocuments({idempotencyKey:'payout-paid:'+promoterPayout.publicId}),1);
    });
    await t.test('failed external Seller transfer restores reserved funds without settling any commission',async()=>{
      await payments.approvePayout(scoped(approver),sellerPayout.publicId);const claimed=await payments.submitPayout(scoped(operator),sellerPayout.publicId);await payments.confirmPayoutSubmission(scoped(operator),sellerPayout.publicId,{reference:'BANK_FAILED_002',submissionAttemptId:claimed.submissionAttemptId});
      const failed=await payments.reconcilePayout(scoped(backup),sellerPayout.publicId,{reference:'BANK_FAILED_002',success:false,message:'Independent bank evidence confirms the transfer never disbursed.'});assert.equal(failed.status,'failed');assert.equal(await accountBalanceMinor(sellerPayable._id),30000);assert.equal(await LedgerTransaction.countDocuments({idempotencyKey:'payout-reverse:'+sellerPayout.publicId}),1);
    });
    await t.test('rejection and submission race cannot both finalize an approved reservation',async()=>{
      const payout=await payments.requestPayout(sellerReq(),{payoutAccountId:sellerAccount.publicId,amountMinor:4000,idempotencyKey:'payout_race_fp_'+suffix});await payments.approvePayout(scoped(approver),payout.publicId);
      const results=await Promise.allSettled([payments.submitPayout(scoped(operator),payout.publicId),payments.rejectPayout(scoped(backup),payout.publicId,{reason:'Documented payout cancelled before sending money.'})]);assert.equal(results.filter(row=>row.status==='fulfilled').length,1);const saved=await Payout.findById(payout._id);assert.ok(['submitting','rejected'].includes(saved.status));const balance=await accountBalanceMinor(sellerPayable._id);assert.equal(balance,saved.status==='rejected'?30000:26000);
    });
    await t.test('current grant, role, token and MFA revocations fail closed at direct service boundaries',async()=>{
      const deniedKey='payout_revoked_device_fp_'+suffix,accounts=await PayoutAccount.countDocuments();
      await Device.updateOne({_id:seller.device._id},{$set:{revokedAt:new Date()}});
      try{
        await assert.rejects(payments.requestPayout(sellerReq(),{payoutAccountId:sellerAccount.publicId,amountMinor:1000,idempotencyKey:deniedKey}),error=>error.code==='ACCOUNT_UNAVAILABLE');
        await assert.rejects(payments.savePayoutAccount(sellerReq(),{method:'bank',label:'Revoked browser cannot save',destination}),error=>error.code==='ACCOUNT_UNAVAILABLE');
      }finally{await Device.updateOne({_id:seller.device._id},{$unset:{revokedAt:1}});}
      assert.equal(await Payout.countDocuments({idempotencyKey:deniedKey}),0);assert.equal(await PayoutAccount.countDocuments(),accounts);
      const payout=await payments.requestPayout(sellerReq(),{payoutAccountId:sellerAccount.publicId,amountMinor:1000,idempotencyKey:'payout_security_fp_'+suffix});
      await PlatformGrant.updateOne({_id:approver.grant._id},{$set:{status:'suspended'}});await assert.rejects(payments.approvePayout(scoped(approver),payout.publicId),error=>error.code==='FINANCE_GRANT_UNAVAILABLE');await PlatformGrant.updateOne({_id:approver.grant._id},{$set:{status:'active'}});
      await User.updateOne({_id:operator.user._id},{$set:{'security.mfaEnabled':false}});await assert.rejects(payments.approvePayout(scoped(operator),payout.publicId),error=>error.code==='MFA_ENROLLMENT_REQUIRED');await User.updateOne({_id:operator.user._id},{$set:{'security.mfaEnabled':true}});
      await User.updateOne({_id:operator.user._id},{$inc:{'security.tokenVersion':1}});await assert.rejects(payments.approvePayout(scoped(operator),payout.publicId),error=>error.code==='ACCOUNT_UNAVAILABLE');await User.updateOne({_id:operator.user._id},{$set:{'security.tokenVersion':0}});
      await assert.rejects(payments.approvePayout(scoped(customer),payout.publicId),error=>error.code==='FINANCE_FORBIDDEN');
    });
    await t.test('audit failure rolls back approvals, reference transitions and financial reversals',async()=>{
      const payout=await payments.requestPayout(sellerReq(),{payoutAccountId:sellerAccount.publicId,amountMinor:1000,idempotencyKey:'payout_audit_fp_'+suffix}),before=await accountBalanceMinor(sellerPayable._id);
      t.mock.method(AuditLog,'create',async()=>{throw new Error('Finance audit unavailable');});try{await assert.rejects(payments.approvePayout(scoped(approver),payout.publicId),/Finance audit unavailable/);await assert.rejects(payments.rejectPayout(scoped(operator),payout.publicId,{reason:'Recorded rejected destination correction.'}),/Finance audit unavailable/);}finally{t.mock.restoreAll();}
      assert.equal((await Payout.findById(payout._id)).status,'requested');assert.equal(await accountBalanceMinor(sellerPayable._id),before);assert.equal(await LedgerTransaction.countDocuments({idempotencyKey:'payout-release:'+payout.publicId}),0);
    });
    await t.test('payout totals cover every row and retain separate configured currencies across pagination',async()=>{
      const keAccount=await PayoutAccount.create({publicId:'poa_ke_fp_'+suffix,ownerUserId:promoter.user._id,ownerType:'promoter',country:'KE',currency:'KES',label:'Kenya destination',method:'bank',destinationEncrypted:encryptSensitive(JSON.stringify(destination)),status:'verified'}),ugAccount=await PayoutAccount.findOne({publicId:promoterAccount.publicId});
      const time=new Date();await Payout.insertMany(Array.from({length:34},(_,n)=>({publicId:'pyo_page_fp_'+suffix+'_'+n,idempotencyKey:'page_fp_'+suffix+'_'+n,ownerUserId:promoter.user._id,requestedByUserId:promoter.user._id,payoutAccountId:n<32?ugAccount._id:keAccount._id,currency:n<32?'UGX':'KES',amountMinor:n<32?1:999,status:'failed',createdAt:time})));
      const first=await loadFinancePayoutPage({...scoped(multi),query:{status:'failed',country:''}});assert.equal(first.page.total,35);assert.equal(first.rows.length,30);assert.equal(first.summary.find(row=>row.status==='failed'&&row.currency==='KES').amountMinor,1998);assert.equal(first.summary.find(row=>row.status==='failed'&&row.currency==='UGX').amountMinor,6032);
      const second=await loadFinancePayoutPage({...scoped(multi),query:{status:'failed',country:'',after:first.page.next}});assert.equal(second.rows.length,5);assert.ok(second.rows.every(row=>!first.rows.some(previous=>previous.id===row.id)));
      const scopedUG=await loadFinancePayoutPage({...scoped(approver),query:{status:'failed'}});assert.equal(scopedUG.page.total,33);assert.ok(scopedUG.summary.every(row=>row.currency==='UGX'));
    });
    await t.test('Commission appeals are reachable and estimates never become payable until posted',async()=>{
      const appealed=await CommissionEntry.create({publicId:'com_appeal_fp_'+suffix,orderId,orderPublicId:'ord_fp_'+suffix,campaignId:campaign._id,promoterUserId:promoter.user._id,touchId:new mongoose.Types.ObjectId(),storePublicId:store.publicId,productPublicId:'prd_appeal_fp_'+suffix,amountMinor:1200,reversedAmountMinor:1200,currency:'UGX',commissionBps:1000,policyVersion:'fixture',status:'reversed',appeal:{status:'pending',message:'Please independently review this unposted estimate reversal.',submittedAt:new Date()}});
      const page=await approver.client.get('/finance/payouts?tab=appeals&appeal='+appealed.publicId).expect(200);assert.match(page.text,/Record appeal decision/);assert.match(page.text,/without creating withdrawable funds/);assert.doesNotMatch(page.text,/PRIVATE_BUYER/);
      const before=await accountBalanceMinor(promoterPayable._id);const accepted=await reviewFinanceAppeal(scoped(approver),appealed.publicId,{decision:'accept',reason:'Independent review approves restoring the estimate.',version:0});assert.equal(accepted.status,'pending');assert.equal(accepted.appeal.status,'accepted');assert.equal(await accountBalanceMinor(promoterPayable._id),before);
      await assert.rejects(reviewFinanceAppeal(scoped(approver),appealed.publicId,{decision:'accept',reason:'Duplicate review refused',version:0}),error=>error.code==='COMMISSION_APPEAL_NOT_FOUND');
    });
    await t.test('malformed encrypted destinations fail closed without leaking plaintext or creating an attempt',async()=>{
      const bad=await PayoutAccount.create({publicId:'poa_bad_fp_'+suffix,ownerUserId:promoter.user._id,ownerType:'promoter',country:'UG',currency:'UGX',label:'Malformed encrypted destination',method:'bank',destinationEncrypted:'PRIVATE_MALFORMED_CIPHERTEXT',status:'pending'});
      await assert.rejects(payments.reviewPayoutAccount(scoped(approver),bad.publicId,{decision:'verify',reason:'Independent verification attempt'}),error=>error.code==='PAYOUT_DESTINATION_INVALID'&&!error.message.includes('PRIVATE_'));assert.equal((await PayoutAccount.findById(bad._id)).status,'pending');
      await payments.reviewPayoutAccount(scoped(approver),bad.publicId,{decision:'reject',reason:'Encryption cannot be decoded; request a corrected destination.'});assert.equal((await PayoutAccount.findById(bad._id)).status,'disabled');
    });
    await t.test('one external reference cannot claim two transfers across different countries and currencies',async()=>{
      const kenyaOwner=await actor('promoter',{country:'KE',mfa:false});await PromoterVerification.create({publicId:'prv_ke_ref_fp_'+suffix,userId:kenyaOwner.user._id,country:'KE',status:'verified'});
      const keDestination=await payments.savePayoutAccount(scoped(kenyaOwner),{method:'bank',label:'Kenya payout reference check',destination});await payments.reviewPayoutAccount(scoped(kenya),keDestination.publicId,{decision:'verify',reason:'Independent Kenya bank verification.'});
      await fund('promoter',String(kenyaOwner.user._id),10000,'KE','KES');
      const ugPayout=await payments.requestPayout(sellerReq(),{payoutAccountId:sellerAccount.publicId,amountMinor:1000,idempotencyKey:'reuse_ug_fp_'+suffix}),kePayout=await payments.requestPayout(scoped(kenyaOwner),{payoutAccountId:keDestination.publicId,amountMinor:1000,idempotencyKey:'reuse_ke_fp_'+suffix});
      await payments.approvePayout(scoped(approver),ugPayout.publicId);await payments.approvePayout(scoped(kenya),kePayout.publicId);
      const ugAttempt=await payments.submitPayout(scoped(operator),ugPayout.publicId),keAttempt=await payments.submitPayout(scoped(multi),kePayout.publicId);
      const reference='ONE_EXTERNAL_RECEIPT_'+suffix;
      const results=await Promise.allSettled([payments.confirmPayoutSubmission(scoped(operator),ugPayout.publicId,{reference,submissionAttemptId:ugAttempt.submissionAttemptId}),payments.confirmPayoutSubmission(scoped(multi),kePayout.publicId,{reference,submissionAttemptId:keAttempt.submissionAttemptId})]);
      assert.equal(results.filter(row=>row.status==='fulfilled').length,1);const failure=results.find(row=>row.status==='rejected');assert.equal(failure.reason.code,'PAYOUT_REFERENCE_REUSED');
      const saved=await Payout.find({_id:{$in:[ugPayout._id,kePayout._id]}}).lean();assert.equal(saved.filter(row=>row.status==='submitted').length,1);assert.equal(saved.filter(row=>row.status==='submitting').length,1);assert.equal(await LedgerTransaction.countDocuments({idempotencyKey:{$in:['payout-paid:'+ugPayout.publicId,'payout-paid:'+kePayout.publicId]}}),0);
      const indexes=await Payout.collection.indexes();assert.ok(indexes.some(index=>index.name==='unique_payout_external_reference'&&index.unique));
    });
    await t.test('read-only migration preflight reports legacy reference collisions without returning bank references',async()=>{
      const {payoutReferenceConflicts}=await import('../src/services/payout-reference-preflight.js'),account=await PayoutAccount.findOne({publicId:promoterAccount.publicId});
      const common={ownerUserId:promoter.user._id,requestedByUserId:promoter.user._id,payoutAccountId:account._id,currency:'UGX',amountMinor:1,status:'paid',providerReference:'PRIVATE_LEGACY_RECEIPT_'+suffix,createdAt:new Date()};
      // Historical missing provider metadata is a distinct key in MongoDB, but
      // the safety preflight treats its effective provider as external.
      await Payout.collection.insertMany([{...common,publicId:'pyo_legacy_missing_fp_'+suffix,idempotencyKey:'legacy_missing_fp_'+suffix},{...common,publicId:'pyo_legacy_external_fp_'+suffix,idempotencyKey:'legacy_external_fp_'+suffix,disbursementProvider:'external'}]);
      const before=await Payout.countDocuments({providerReference:common.providerReference}),result=await payoutReferenceConflicts();assert.equal(result.groups,1);assert.equal(result.payouts,2);assert.ok(result.examples[0].payoutPublicIds.includes('pyo_legacy_missing_fp_'+suffix));assert.ok(!JSON.stringify(result).includes(common.providerReference));assert.equal(await Payout.countDocuments({providerReference:common.providerReference}),before);
      await Payout.deleteMany({publicId:{$in:['pyo_legacy_missing_fp_'+suffix,'pyo_legacy_external_fp_'+suffix]}});
    });
    await t.test('CSV stops after a grant is revoked during delivery instead of exporting further scoped records',async()=>{
      class Output extends EventEmitter {constructor(){super();this.chunks=[];this.destroyed=false;}type(){return this;}set(){return this;}end(){this.ended=true;}write(chunk){this.chunks.push(chunk);if(this.chunks.length===2){PlatformGrant.updateOne({_id:approver.grant._id},{$set:{status:'suspended'}}).then(()=>this.emit('drain'),error=>this.emit('error',error));return false;}return true;}}
      const output=new Output();try {await assert.rejects(streamFinancePayoutCsv(scoped(approver),output),error=>error.code==='FINANCE_GRANT_UNAVAILABLE');assert.equal(output.chunks.length,2);}finally{await PlatformGrant.updateOne({_id:approver.grant._id},{$set:{status:'active'}});}
    });
  } finally {for(const transport of transports)transport.destroy();for(const Model of Object.values(mongoose.connection.models))await Model.init();await mongoose.connection.db.dropDatabase();await mongoose.disconnect();}
});
