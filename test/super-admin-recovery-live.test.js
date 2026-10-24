import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import { EventEmitter } from 'node:events';
import mongoose from 'mongoose';
import request from 'supertest';

process.env.NODE_ENV='test';
process.env.SIMPLE_LOGIN='false';
process.env.PRIVILEGED_MFA_REQUIRED='true';
process.env.MAIL_MODE='log';
process.env.SMS_MODE='log';
process.env.REDIS_URL='';
for(const key of ['SESSION_SECRET','TOKEN_PEPPER','SECURITY_INTEGRITY_KEY','DATA_ENCRYPTION_KEY'])process.env[key]=crypto.randomBytes(32).toString('hex');
const uri=process.env.CLASSIC_MART_LIVE_TEST_MONGO_URI;
if(uri)process.env.MONGO_URI=uri;
const csrf=html=>{const match=html.match(/(?:name="_csrf"[^>]*value|name="csrf-token" content)="([^"]+)"/);assert.ok(match,'The real page supplies CSRF protection.');return match[1];};

test('Super Admin uses current global grants, genuine MFA, source records and independent decisions', {skip:!uri,timeout:300_000},async t=>{
  assert.equal(new URL(uri).hostname,'127.0.0.1');
  assert.match(new URL(uri).pathname,/test|verification/i);
  const suffix=crypto.randomBytes(7).toString('hex'),transports=[];
  await mongoose.connect(uri,{dbName:'classicmart_super_admin_test_'+suffix});
  try{
    const models=await import('../src/models/index.js');
    const {User,Device,CountrySetting,PlatformGrant,PlatformStaffInvitation,ApprovalRequest,Category,CmsContent,FeatureFlag,PrivacyRequest,OperationalAlert,LaunchEvidence,WorkerHeartbeat,OutboxEvent,AuditLog,Store,StoreMember,SubscriptionPlan,SubscriptionEnrollment,BusinessOrganization,BusinessMember}=models;
    const {createApp}=await import('../src/app.js');
    const {hashPassword,hashToken}=await import('../src/core/crypto.js');
    const {beginMfaEnrollment,confirmMfaEnrollment,totpCode}=await import('../src/services/mfa.js');
    const {superAdminAccess}=await import('../src/services/super-admin-access.js');
    const operations=await import('../src/services/super-admin-operations.js');
    const {loadSuperAdminPage,streamSuperAdminCsv}=await import('../src/services/super-admin-pages.js');
    const {acceptPlatformStaffInvitation}=await import('../src/services/staff-access.js');
    const {requestReviewedSellerSubscription}=await import('../src/services/seller-subscription-operations.js');
    const {SUPER_ADMIN_LIVE_ROUTES}=await import('../src/dashboard/super-admin-routes.js');
    const {logger}=await import('../src/config/logger.js');
    t.mock.method(logger,'error',fields=>{
      if(fields?.err)t.diagnostic(`HTTP ${fields.req?.method||''} ${fields.req?.path||''}: ${fields.err.stack||String(fields.err)}`);
    });
    const app=createApp(null),password='Super-'+suffix+'-A1!',passwordHash=await hashPassword(password);
    let sequence=0;
    const id=prefix=>`${prefix}_super_${suffix}_${++sequence}`;
    for(const Model of Object.values(mongoose.models))await Model.init();
    await CountrySetting.create([
      {code:'UG',name:'Uganda',currency:'UGX',locale:'en-UG',timeZone:'Africa/Kampala',phonePrefix:'+256'},
      {code:'KE',name:'Kenya',currency:'KES',locale:'en-KE',timeZone:'Africa/Nairobi',phonePrefix:'+254'},
      {code:'TZ',name:'Inactive Tanzania',currency:'TZS',locale:'en-TZ',timeZone:'Africa/Dar_es_Salaam',phonePrefix:'+255',active:false},
    ]);
    async function identity(role='customer',{managed=false,enroll=role!=='customer',login=false}={}){
      const index=++sequence,email=`super-${suffix}-${index}@example.com`,phone='+25670'+String(index).padStart(7,'0');
      let user=await User.create({publicId:id('usr'),name:'Super review fixture '+index,email,emailNormalized:email,phone,phoneNormalized:phone,passwordHash,role,status:'active',country:'UG',shoppingCountry:'KE',currency:'KES',operationalCountries:role==='super_admin'?['*']:['UG'],...(managed?{platformAccessManagedAt:new Date()}:{}),emailVerifiedAt:new Date(),phoneVerifiedAt:new Date(),onboardingCompletedAt:new Date(),consents:{terms:true,privacy:true,marketing:true,recordedAt:new Date()}});
      let secret,codes=[];
      if(enroll){const enrollment=await beginMfaEnrollment(user._id,password);secret=enrollment.secret;const confirmed=await confirmMfaEnrollment(user._id,totpCode(secret,{time:Date.now()-30_000}));user=confirmed.user;codes=confirmed.codes;}
      const grant=managed?await PlatformGrant.create({publicId:id('pgr'),userId:user._id,role,operationalCountries:role==='super_admin'?['*']:['UG'],startsAt:new Date(Date.now()-60_000),expiresAt:new Date(Date.now()+86_400_000),status:'active',reason:'Independently authorized review fixture',approvalPublicId:id('apr'),approvedByUserId:new mongoose.Types.ObjectId()}):null;
      const sessionID=crypto.randomUUID(),device=await Device.create({publicId:id('dev'),userId:user._id,sessionHash:hashToken(sessionID),label:'Super fixture',userAgent:'SuperRecovery/1',ipHash:'fixture',lastSeenAt:new Date()});
      const entry={user,grant,device,sessionID,codes};
      entry.scoped=(query={},mfaVerifiedAt=Date.now())=>({user:entry.user,device:entry.device,sessionID:entry.sessionID,session:{userId:String(entry.user._id),tokenVersion:entry.user.security.tokenVersion,mfaVerifiedAt},requiredOperationalWorkspace:role==='super_admin'?'superadmin':undefined,query,id:id('req'),country:{code:'UG'},ip:'127.0.0.1',get:()=> 'SuperRecovery/1'});
      if(login){const transport=new http.Agent({localAddress:'127.0.0.'+(index+50),keepAlive:false});transports.push(transport);entry.client=request.agent(app).use(req=>req.agent(transport));const form=await entry.client.get('/login').expect(200);const signed=await entry.client.post('/login').type('form').send({email,password,_csrf:csrf(form.text)}).expect(302);if(enroll){assert.equal(signed.headers.location,'/mfa');const challenge=await entry.client.get('/mfa').expect(200);await entry.client.post('/mfa').type('form').send({code:totpCode(secret),_csrf:csrf(challenge.text)}).expect(302);}}
      return entry;
    }
    const author=await identity('super_admin',{managed:true,login:true}),reviewer=await identity('super_admin',{managed:true,login:true});
    const customer=await identity('customer',{login:true}),country=await identity('country_admin',{managed:true,login:true}),legacy=await identity('super_admin',{login:true});
    author.csrf=csrf((await author.client.get('/super/overview').expect(200)).text);
    reviewer.csrf=csrf((await reviewer.client.get('/super/overview').expect(200)).text);
    const post=(entry,path,input,status=200)=>entry.client.post(path).set('accept','application/json').set('x-csrf-token',entry.csrf).send(input).expect(status);
    const decide=(entry,approval,status=200)=>post(entry,'/super/approvals/'+approval.publicId+'/decision',{decision:'approve',reason:'Verified independently against the unchanged source record.',version:approval.__v||0},status);
    const reviewReason='Independently reviewed current source and operating policy.';

    await t.test('all 21 destinations use the approved shell and reject raw roles and malformed filters',async()=>{
      assert.equal(Object.keys(SUPER_ADMIN_LIVE_ROUTES).length,21);
      for(const[pageId,path]of Object.entries(SUPER_ADMIN_LIVE_ROUTES)){
        const html=await author.client.get(path).expect(200);
        assert.match(html.text,/data-dashboard-workspace="superadmin"/);assert.ok(html.text.includes('data-page="'+pageId+'"'));assert.match(html.text,/Super Admin/);
        for(const href of Object.values(SUPER_ADMIN_LIVE_ROUTES))assert.ok(html.text.includes('href="'+href+'"'),href);
        assert.doesNotMatch(html.text,/passwordHash|mfaSecretEncrypted|sessionHash|role-selector/);
        assert.match(html.headers['cache-control'],/no-store/);assert.match(html.headers['x-robots-tag'],/noindex/);
        const json=await author.client.get(path).set('accept','application/json').expect(200);assert.equal(json.body.pageId,pageId);assert.equal(json.body.context.currency,null);
      }
      await author.client.get('/dashboard/super-users?country=UG').expect(308).expect('location','/super/users?country=UG');
      for(const entry of [customer,country,legacy])await entry.client.get('/super/users').set('accept','application/json').expect(403);
      await request(app).get('/super/users').set('accept','application/json').expect(401);
      for(const query of ['country=UG&country=KE','country[]=UG','search[$ne]=x','tab=missing','after=broken','revisionBefore=-1'])await author.client.get('/super/settings?'+query).set('accept','application/json').expect(422);
      await author.client.post('/super/settings/features/requests').set('accept','application/json').send({key:'no-csrf'}).expect(403);
      await assert.rejects(operations.requestSuperFeatureChange(author.scoped({},Date.now()-16*60_000),{key:'expired-proof',rolloutPercentage:1,reason:reviewReason}),error=>error.code==='MFA_STEP_UP_REQUIRED');
      const security=await author.client.get('/account/security?next=%2Fsuper%2Fsettings').expect(200);
      await author.client.post('/account/mfa/step-up').type('form').send({_csrf:csrf(security.text),currentPassword:password,code:author.codes[0],next:'/super/settings'}).expect(303).expect('location','/super/settings');
    });

    await t.test('complete market-scoped keysets and CSV retain source values and stop on revoked authority',async()=>{
      const createdAt=new Date('2026-01-02T03:04:05Z');
      await Category.create(Array.from({length:65},(_,index)=>({publicId:id('cat'),name:index===0?'  =SUM(1,2)':'UG category '+index,slug:'super-'+suffix+'-'+index,countries:['UG'],createdAt})));
      await Category.create([{publicId:id('cat'),name:'Global category',slug:'global-super-'+suffix,countries:[],createdAt},{publicId:id('cat'),name:'Kenya category',slug:'ke-super-'+suffix,countries:['KE'],createdAt}]);
      let after='',seen=[];
      do{const response=await author.client.get('/super/categories?country=UG'+(after?'&after='+encodeURIComponent(after):'')).set('accept','application/json').expect(200);assert.equal(response.body.page.total,66);seen.push(...response.body.items.map(row=>row.publicId));after=response.body.page.next;}while(after);
      assert.equal(new Set(seen).size,66);
      const csv=await author.client.get('/super/categories/export.csv?country=UG').expect(200);assert.equal(csv.text.trim().split('\r\n').length,67);assert.match(csv.text,/"'=SUM\(1,2\)"/);assert.ok(!csv.text.includes('Kenya category'));
      assert.equal(await AuditLog.countDocuments({action:'super_admin.records_exported',targetPublicId:'super-categories'}),1);
      class InterruptedResponse extends EventEmitter{
        lines=0;output='';destroyed=false;set(){}end(){this.finished=true;}
        write(value){this.output+=value;if(++this.lines!==2)return true;queueMicrotask(async()=>{await PlatformGrant.updateOne({_id:author.grant._id},{$set:{status:'revoked'}});this.emit('drain');});return false;}
      }
      const interrupted=new InterruptedResponse();
      await assert.rejects(streamSuperAdminCsv(author.scoped({country:'UG'}),interrupted,'super-categories'),error=>/GRANT|FORBIDDEN/.test(error.code));
      assert.equal(interrupted.lines,2);assert.ok(!interrupted.finished);
      await PlatformGrant.updateOne({_id:author.grant._id},{$set:{status:'active'}});
      await Device.updateOne({_id:author.device._id},{$set:{revokedAt:new Date()}});
      await assert.rejects(superAdminAccess(author.scoped()),error=>error.code==='ACCOUNT_UNAVAILABLE');
      await Device.updateOne({_id:author.device._id},{$set:{revokedAt:null}});
      const evidence=await LaunchEvidence.create({key:'super.fixture.control',label:'Recorded recovery evidence',status:'passed',evidence:'Actual fixture evidence',verifiedAt:new Date()});
      const worker=await WorkerHeartbeat.create({workerId:'super.fixture.worker',hostname:'loopback-fixture',pid:1,startedAt:new Date(),lastHeartbeatAt:new Date(),expiresAt:new Date(Date.now()+86_400_000)});
      for(const[tab,record]of [['evidence',evidence],['workers',worker]]){const page=await loadSuperAdminPage(author.scoped({tab}),'super-security');assert.equal(page.rows.length,1);const selected=await loadSuperAdminPage(author.scoped({tab,id:tab==='workers'?record.workerId:record.key}),'super-security');assert.equal(String(selected.selected._id),String(record._id));}
    });

    await t.test('staff invitation acceptance and grants are atomic, independent and bound to the target source',async()=>{
      const target=await identity('customer',{enroll:true});
      const sent=await post(author,'/super/roles/invitations',{email:target.user.email,role:'support',operationalCountries:'UG',warehouseScopes:'',grantDurationDays:30,reason:reviewReason});
      assert.doesNotMatch(JSON.stringify(sent.body),/emailEncrypted|emailHash|tokenHash/);
      const event=await OutboxEvent.findOne({type:'platform.staff_invitation',aggregatePublicId:sent.body.publicId}).lean();
      const token=event.payload.body.match(/\/staff\/invitations\/([A-Za-z0-9_-]+)/)[1];
      const accepted=await acceptPlatformStaffInvitation(target.scoped(),token);
      assert.equal(await PlatformGrant.countDocuments({userId:target.user._id}),0);
      await decide(author,accepted.approval,403);
      await decide(reviewer,accepted.approval);
      const grant=await PlatformGrant.findOne({userId:target.user._id,status:'active'}).lean(),updated=await User.findById(target.user._id);
      assert.equal(grant.role,'support');assert.deepEqual(grant.operationalCountries,['UG']);assert.equal(updated.security.tokenVersion,target.user.security.tokenVersion+1);assert.ok(updated.platformAccessManagedAt);
      assert.equal((await PlatformStaffInvitation.findOne({publicId:sent.body.publicId})).status,'accepted');
      const stale=await identity('customer',{enroll:true});
      const change=await operations.requestSuperStaffChange(author.scoped(),{targetUserPublicId:stale.user.publicId,action:'grant',role:'support',operationalCountries:'UG',warehouseScopes:'',grantDurationDays:30,reason:reviewReason,version:stale.user.__v||0});
      await User.updateOne({_id:stale.user._id},{$inc:{__v:1}});
      await decide(reviewer,change,409);assert.equal(await PlatformGrant.countDocuments({userId:stale.user._id}),0);assert.equal((await ApprovalRequest.findById(change._id)).status,'requested');
      const concurrent=await identity('customer',{enroll:true});
      const approval=await operations.requestSuperStaffChange(author.scoped(),{targetUserPublicId:concurrent.user.publicId,action:'grant',role:'moderator',operationalCountries:'UG',reason:reviewReason,version:concurrent.user.__v||0});
      const decisions=await Promise.allSettled([0,1].map(()=>operations.decideSuperApproval(reviewer.scoped(),approval.publicId,{decision:'approve',reason:reviewReason,version:0})));
      assert.equal(decisions.filter(row=>row.status==='fulfilled').length,1);assert.equal(await PlatformGrant.countDocuments({userId:concurrent.user._id,status:'active'}),1);
    });

    await t.test('market, reward and Club terms require an unchanged source and independent publication',async()=>{
      async function market(){return (await author.client.get('/super/settings?tab=countries&id=UG').set('accept','application/json').expect(200)).body.selected;}
      const current=await market();
      const input={version:current.version,sourceDigest:current.sourceDigest,reason:reviewReason,policyVersion:'super-reviewed-v1',taxBps:0,platformFeeBps:500,freeStandardShippingThresholdMinor:0,returnWindowDays:30,defaultStandardSlaHours:72,defaultExpressSlaHours:24,loyaltyPointsPer1000Minor:0,referralRewardPoints:0,promoterCommissionBps:300,active:'on',card:'on',mobile:'on',cod:'on',standardEnabled:'on',expressEnabled:'on',pickupEnabled:'on',requirePhotoForCod:'on',requirePhotoForFailedAttempt:'on',loyaltyEnabled:'on',referralEnabled:'on',giftCardsEnabled:'on'};
      for(const version of ['',null,false,[]])await post(author,'/super/settings/countries/UG/market',{...input,version},422);
      const proposed=await post(author,'/super/settings/countries/UG/market',input);
      assert.notEqual((await CountrySetting.findOne({code:'UG'})).policyVersion,input.policyVersion);
      await decide(author,proposed.body,403);await decide(reviewer,proposed.body);
      let saved=await CountrySetting.findOne({code:'UG'});assert.equal(saved.policyVersion,input.policyVersion);assert.equal(saved.growth.loyaltyPointsPer1000Minor,0);assert.equal(saved.growth.referralRewardPoints,0);
      let selected=await market();
      const reward=await post(author,'/super/settings/countries/UG/reward',{version:selected.version,sourceDigest:selected.sourceDigest,reason:reviewReason,key:'super-voucher',label:'Reviewed voucher',kind:'voucher',enabled:'true',pointsCost:100,validDays:30,valueMinor:200,minimumSpendMinor:1000,maximumDiscountMinor:200,multiplierBps:10000,trialShippingDiscountBps:0});
      await decide(reviewer,reward.body);saved=await CountrySetting.findOne({code:'UG'});assert.equal(saved.growth.rewardCatalogue[0].valueMinor,200);
      selected=await market();const club=await post(author,'/super/settings/countries/UG/club',{version:selected.version,sourceDigest:selected.sourceDigest,reason:reviewReason,tier:'gold',multiplierBps:15000,standardShippingDiscountBps:1000,minimumSpendMinor:1000});await decide(reviewer,club.body);assert.equal((await CountrySetting.findOne({code:'UG'})).growth.clubBenefits[0].standardShippingDiscountBps,1000);
      selected=await market();const stale=await post(author,'/super/settings/countries/UG/club',{version:selected.version,sourceDigest:selected.sourceDigest,reason:reviewReason,tier:'silver',multiplierBps:12000,standardShippingDiscountBps:0,minimumSpendMinor:0});await CountrySetting.updateOne({code:'UG'},{$set:{platformFeeBps:501},$inc:{__v:1}});await decide(reviewer,stale.body,409);
      const inactive=(await author.client.get('/super/settings?tab=countries&id=TZ').set('accept','application/json').expect(200)).body.selected;
      const reactivate=await post(author,'/super/settings/countries/TZ/market',{...input,version:inactive.version,sourceDigest:inactive.sourceDigest,policyVersion:'tz-reactivated'});await decide(reviewer,reactivate.body);assert.equal((await CountrySetting.findOne({code:'TZ'})).active,true);
    });

    await t.test('typed seller plans publish independently and approval alone grants no entitlement period',async()=>{
      const draft=await post(author,'/super/subscriptions/plans',{key:'super-plan',name:'Reviewed seller plan',description:'Explicit typed seller commercial terms.',country:'UG',priceMinor:1000,cadence:'monthly',productLimit:75,seatLimit:3,campaignLimit:4,analyticsDays:90,analyticsExport:'true',reason:reviewReason});
      assert.equal(draft.body.status,'draft');assert.equal(draft.body.entitlements.seatLimit,3);
      const publication=await post(author,'/super/subscriptions/plans/'+draft.body.publicId+'/publication',{version:draft.body.__v||0,status:'active',reason:reviewReason});
      await decide(author,publication.body,403);await decide(reviewer,publication.body);
      const plan=await SubscriptionPlan.findOne({publicId:draft.body.publicId});assert.equal(plan.status,'active');
      await post(author,'/super/subscriptions/plans/'+plan.publicId,{key:plan.key,name:'Changed published terms',description:'',country:'UG',priceMinor:2000,cadence:'monthly',productLimit:75,seatLimit:3,campaignLimit:4,analyticsDays:90,analyticsExport:true,reason:reviewReason,version:plan.__v},409);
      const seller=await identity('seller');const store=await Store.create({publicId:id('str'),ownerUserId:seller.user._id,name:'Subscription fixture',slug:id('seller'),country:'UG',currency:'UGX',status:'verified'});await StoreMember.create({publicId:id('stm'),storeId:store._id,userId:seller.user._id,role:'owner',status:'active',invitedByUserId:seller.user._id});
      const sellerRequest=seller.scoped();delete sellerRequest.requiredOperationalWorkspace;sellerRequest.store=store;sellerRequest.session.activeStorePublicId=store.publicId;
      const change=await requestReviewedSellerSubscription(sellerRequest,{planPublicId:plan.publicId,note:'Actual seller requests the published terms.'});
      const shown=await author.client.get('/super/subscriptions?tab=requests&id='+change.publicId).expect(200);assert.match(shown.text,/Approval alone does not activate entitlements/);
      await post(reviewer,'/super/subscriptions/requests/'+change.publicId+'/decision',{version:change.__v||0,decision:'approve',reason:reviewReason});
      assert.equal(await SubscriptionEnrollment.countDocuments({storeId:store._id}),0);
    });

    await t.test('privacy forms apply corrections, reviewed retries and restriction release to real records',async()=>{
      const correction=await PrivacyRequest.create({publicId:id('prv'),userId:customer.user._id,userPublicId:customer.user.publicId,country:'UG',type:'correction',identityVerifiedAt:new Date(),details:'Verified correction request.'});
      const shown=await author.client.get('/super/settings?tab=privacy&id='+correction.publicId).expect(200);assert.match(shown.text,/name="apply_name"/);assert.match(shown.text,/name="correction_name"/);
      await post(author,'/super/settings/privacy/'+correction.publicId+'/actions',{version:0,action:'approve',reason:reviewReason},422);
      await post(author,'/super/settings/privacy/'+correction.publicId+'/actions',{version:0,action:'approve',reason:reviewReason,apply_name:'on',correction_name:'Verified corrected customer'});
      assert.equal((await User.findById(customer.user._id)).name,'Verified corrected customer');assert.equal((await PrivacyRequest.findById(correction._id)).status,'completed');
      const failed=await PrivacyRequest.create({publicId:id('prv'),userId:customer.user._id,userPublicId:customer.user.publicId,country:'UG',type:'deletion',status:'failed',identityVerifiedAt:new Date(),attempts:3,lastError:'Interrupted local processing'});
      const recovery=await author.client.get('/super/settings?tab=privacy&id='+failed.publicId).expect(200);assert.match(recovery.text,/Retry after resolving the blocker/);
      await post(author,'/super/settings/privacy/'+failed.publicId+'/actions',{version:0,action:'retry',reason:reviewReason});assert.equal((await PrivacyRequest.findById(failed._id)).status,'approved');
      const restriction=await PrivacyRequest.create({publicId:id('prv'),userId:customer.user._id,userPublicId:customer.user.publicId,country:'UG',type:'restriction',status:'completed',identityVerifiedAt:new Date(),restrictionActive:true});await User.updateOne({_id:customer.user._id},{$set:{'consents.marketing':false}});
      const release=await author.client.get('/super/settings?tab=privacy&id='+restriction.publicId).expect(200);assert.match(release.text,/Release optional processing restriction/);
      await post(author,'/super/settings/privacy/'+restriction.publicId+'/actions',{version:0,action:'release_restriction',reason:reviewReason});assert.equal((await PrivacyRequest.findById(restriction._id)).restrictionActive,false);assert.equal((await User.findById(customer.user._id)).consents.marketing,false);
    });

    await t.test('CMS revision pages, schedules, feature rollouts and security responses preserve their sources',async()=>{
      const created=await post(author,'/super/settings/cms/revisions',{key:'legal.super.fixture',type:'legal',country:'',title:'Reviewed legal fixture',body:'<script>untrusted source text</script>',image:'https://untrusted.example/image',reason:reviewReason});
      const content=await CmsContent.findOne({publicId:created.body.publicId});assert.equal(content.revisions[0].data.image,undefined);
      const preview=await author.client.get('/super/settings?tab=cms&id='+content.publicId).expect(200);assert.match(preview.text,/&lt;script&gt;untrusted source text&lt;\/script&gt;/);
      const publication=await post(author,'/super/settings/cms/'+content.publicId+'/publication',{version:content.__v,revisionVersion:1,action:'publish',scheduledFor:new Date(Date.now()+3_600_000).toISOString(),reason:reviewReason});await decide(author,publication.body,403);await decide(reviewer,publication.body);
      let saved=await CmsContent.findById(content._id);assert.equal(saved.status,'scheduled');assert.equal(saved.activeVersion,0);await post(author,'/super/settings/cms/'+content.publicId+'/cancel-schedule',{version:saved.__v,reason:reviewReason});saved=await CmsContent.findById(content._id);assert.equal(saved.scheduledVersion,0);
      const revisionSource=await CmsContent.create({publicId:id('cms'),key:'help.super.history',type:'help',country:'UG',revisions:Array.from({length:13},(_,index)=>({version:index+1,title:'History '+(index+1),body:'Historical source content',reason:reviewReason,createdByUserId:author.user._id}))});
      const recent=(await author.client.get('/super/settings?tab=cms&id='+revisionSource.publicId).set('accept','application/json').expect(200)).body;assert.equal(recent.selected.revisions.length,10);assert.equal(recent.selected.revisions[0].version,13);assert.ok(recent.items.every(item=>!Object.hasOwn(item,'revisions')));
      const older=(await author.client.get('/super/settings?tab=cms&id='+revisionSource.publicId+'&revisionBefore='+recent.selected.revisionPage.next).set('accept','application/json').expect(200)).body;assert.deepEqual(older.selected.revisions.map(row=>row.version),[3,2,1]);
      const flag=await post(author,'/super/settings/features/requests',{key:'super-reviewed-flag',description:'Reviewed scoped rollout',rolloutPercentage:25,countries:'UG',roles:'customer',enabled:'true',reason:reviewReason});assert.equal(await FeatureFlag.countDocuments({key:'super-reviewed-flag'}),0);await decide(reviewer,flag.body);assert.equal((await FeatureFlag.findOne({key:'super-reviewed-flag'})).rolloutPercentage,25);
      const alert=await OperationalAlert.create({publicId:id('alt'),fingerprint:id('fingerprint'),country:'UG',type:'super_test',severity:'high',title:'Verified operational alert',message:'Fixture needs investigation'});
      await post(author,'/super/security/alerts/'+alert.publicId+'/actions',{version:alert.__v||0,status:'investigating',reason:reviewReason});assert.equal((await OperationalAlert.findById(alert._id)).status,'investigating');
      await post(author,'/super/security/alerts/'+alert.publicId+'/actions',{version:alert.__v||0,status:'resolved',reason:reviewReason},409);
    });

    await t.test('the CMS worker publishes and rolls back the exact independently approved revision with current staff authority',async()=>{
      const {publishScheduledCms,publishedCms}=await import('../src/services/stage9.js');
      const key='legal.dispatch.'+suffix,schedule=new Date(Date.now()+60_000),due=new Date(schedule.getTime()+1);
      const create=raw=>operations.saveSuperCmsRevision(author.scoped(),{key,type:'legal',country:'',title:'Scheduled source',body:'The independently reviewed original publication.',reason:reviewReason,...raw});
      const approve=async row=>operations.decideSuperApproval(reviewer.scoped(),row.publicId,{decision:'approve',reason:reviewReason,version:row.__v||0});
      let content=await create({});
      let approval=await operations.requestSuperCmsPublication(author.scoped(),content.publicId,{version:content.__v,revisionVersion:1,action:'publish',scheduledFor:schedule.toISOString(),reason:reviewReason});
      await approve(approval);
      assert.equal(await publishScheduledCms(new Date(schedule.getTime()-1)),0);
      assert.equal(await publishedCms(key,'UG'),null);
      await PlatformGrant.updateOne({_id:reviewer.grant._id},{$set:{status:'revoked'}});
      assert.equal(await publishScheduledCms(due),0);
      assert.equal((await CmsContent.findById(content._id)).activeVersion,0);
      assert.equal(await AuditLog.countDocuments({action:'cms.scheduled_published',targetPublicId:content.publicId}),0);
      await PlatformGrant.updateOne({_id:reviewer.grant._id},{$set:{status:'active'}});
      assert.equal(await publishScheduledCms(due),1);
      assert.equal((await publishedCms(key,'UG')).body,'The independently reviewed original publication.');
      assert.equal(await publishScheduledCms(due),0);
      content=await CmsContent.findById(content._id);
      assert.equal(content.activeVersion,1);assert.equal(content.scheduledVersion,0);assert.equal(content.status,'published');
      assert.equal(content.revisions[0].publishedAt.getTime(),due.getTime());
      content=await create({version:content.__v,body:'The second independently approved public revision.'});
      approval=await operations.requestSuperCmsPublication(author.scoped(),content.publicId,{version:content.__v,revisionVersion:2,action:'publish',scheduledFor:'',reason:reviewReason});
      await approve(approval);
      assert.equal((await publishedCms(key,'UG')).version,2);
      content=await CmsContent.findById(content._id);
      const rollbackSchedule=new Date(Date.now()+120_000),rollbackDue=new Date(rollbackSchedule.getTime()+1);
      approval=await operations.requestSuperCmsPublication(author.scoped(),content.publicId,{version:content.__v,revisionVersion:1,action:'rollback',scheduledFor:rollbackSchedule.toISOString(),reason:reviewReason});
      await approve(approval);
      assert.equal((await publishedCms(key,'UG')).version,2,'A scheduled rollback preserves the current public revision until it is due.');
      await CmsContent.updateOne({_id:content._id,'revisions.version':1},{$set:{'revisions.$.body':'Changed after the independent decision.'}});
      assert.equal(await publishScheduledCms(rollbackDue),0);
      assert.equal((await CmsContent.findById(content._id)).activeVersion,2);
      await CmsContent.updateOne({_id:content._id,'revisions.version':1},{$set:{'revisions.$.body':'The independently reviewed original publication.'}});
      assert.equal(await publishScheduledCms(rollbackDue),1);
      const restored=await publishedCms(key,'UG');assert.equal(restored.version,1);assert.equal(restored.body,'The independently reviewed original publication.');
      assert.equal(await publishScheduledCms(rollbackDue),0);
      assert.equal(await AuditLog.countDocuments({action:'cms.scheduled_published',targetPublicId:content.publicId}),2);
    });

    await t.test('more than one hundred future or blocked CMS schedules cannot starve a later valid due publication',async()=>{
      const {publishScheduledCms,publishedCms}=await import('../src/services/stage9.js');
      const dueAt=new Date(Date.now()+60_000),clock=new Date(dueAt.getTime()+1),future=new Date(Date.now()+7*86_400_000);
      const scheduled=(kind,index,date)=>({publicId:id('cms'),key:'backpressure.'+suffix+'.'+kind+'.'+index,type:'legal',country:'',status:'scheduled',scheduledVersion:1,
        revisions:[{version:1,title:'Retained '+kind+' source',body:'This unsatisfied source must not publish.',reason:reviewReason,createdByUserId:author.user._id,scheduledFor:date,approvalPublicId:id('missing_approval'),approvedByUserId:reviewer.user._id,dispatchGrantPublicId:reviewer.grant.publicId,dispatchTokenVersion:reviewer.user.security.tokenVersion}]});
      await CmsContent.create(Array.from({length:101},(_,index)=>scheduled('future',index,future)));
      const blocked=await CmsContent.create(Array.from({length:101},(_,index)=>scheduled('blocked',index,new Date(Date.now()-60_000))));
      const key='legal.after.backpressure.'+suffix;
      const content=await operations.saveSuperCmsRevision(author.scoped(),{key,type:'legal',country:'',title:'Actual due source',body:'The valid approved source is eventually published.',reason:reviewReason});
      const approval=await operations.requestSuperCmsPublication(author.scoped(),content.publicId,{version:content.__v,revisionVersion:1,action:'publish',scheduledFor:dueAt.toISOString(),reason:reviewReason});
      await operations.decideSuperApproval(reviewer.scoped(),approval.publicId,{decision:'approve',reason:reviewReason,version:approval.__v||0});
      assert.equal(await publishScheduledCms(clock),0,'The first bounded page contains one hundred unavailable approvals.');
      assert.equal(await publishedCms(key,'UG'),null);
      assert.equal(await publishScheduledCms(clock),1,'A persisted keyset advances past the blocked first page on the next worker cycle.');
      assert.equal((await publishedCms(key,'UG')).body,'The valid approved source is eventually published.');
      assert.equal(await CmsContent.countDocuments({_id:{$in:blocked.map(row=>row._id)},status:'scheduled',activeVersion:0}),101);
      assert.equal(await AuditLog.countDocuments({action:'cms.scheduled_published',targetPublicId:content.publicId}),1);
    });

    await t.test('CMS backlog keysets expose every scoped record beyond fifty and an older source remains editable',async()=>{
      const prefix='backlog.'+suffix,createdAt=new Date('2026-01-03T03:04:05Z');
      const source=(country,index)=>({publicId:id('cms'),key:prefix+'.'+(country||'global')+'.'+index,type:'help',country,createdAt,
        revisions:[{version:1,title:'Backlog source '+(country||'global')+' '+index,body:'PRIVATE_CMS_BODY_'+country+'_'+index,
          reason:reviewReason,createdByUserId:author.user._id}]});
      const owned=await CmsContent.create(Array.from({length:65},(_,index)=>source('UG',index)));
      const global=await CmsContent.create([source('',0),source('',1)]);
      const foreign=await CmsContent.create([source('KE',0),source('KE',1),source('KE',2)]);
      const expected=new Set([...owned,...global].map(row=>row.publicId)),ownedIds=new Set(owned.map(row=>row.publicId));
      const filters={tab:'cms',country:'UG',search:prefix};
      let after='',pageCount=0,lastPage,seen=[];
      do{
        const response=await author.client.get('/super/settings').query({...filters,...(after?{after}:{})}).set('accept','application/json').expect(200);
        const page=response.body;
        const cacheDirectives=new Set(String(response.headers['cache-control']||'').split(',').map(value=>value.trim().toLowerCase()));
        assert.ok(cacheDirectives.has('private'));assert.ok(cacheDirectives.has('no-store'));assert.match(response.headers['x-robots-tag'],/noindex/);
        assert.equal(page.page.total,67);assert.equal(page.selected,null);
        assert.ok(page.items.every(item=>expected.has(item.publicId)&&!Object.hasOwn(item,'revisions')));
        assert.doesNotMatch(JSON.stringify(page.items),/PRIVATE_CMS_BODY_/);
        assert.deepEqual(page.rows.map(row=>row.id),page.items.map(item=>item.publicId));
        seen.push(...page.items.map(item=>item.publicId));
        after=page.page.next;assert.equal(page.page.hasMore,Boolean(after));lastPage=page;
        assert.ok(++pageCount<=4,'The CMS cursor must advance and terminate.');
      }while(after);
      assert.ok(pageCount>1);assert.equal(seen.length,67);assert.equal(new Set(seen).size,67);
      assert.deepEqual([...seen].sort(),[...expected].sort());
      assert.ok(foreign.every(row=>!seen.includes(row.publicId)));
      const olderRow=lastPage.rows.find(row=>ownedIds.has(row.id)&&seen.indexOf(row.id)>50);assert.ok(olderRow);
      assert.ok(seen.indexOf(olderRow.id)>50,'The selected source must be outside the former fifty-record backlog.');
      const selectedQuery=new URL(olderRow.href,'http://localhost').searchParams;
      assert.equal(selectedQuery.get('country'),'UG');assert.equal(selectedQuery.get('tab'),'cms');
      const detail=(await author.client.get(olderRow.href).set('accept','application/json').expect(200)).body.selected;
      assert.equal(detail.publicId,olderRow.id);assert.equal(detail.country,'UG');assert.equal(detail.revisions.length,1);
      const form=await author.client.get(olderRow.href).expect(200);
      assert.match(form.text,/Author the next content revision/);
      const editForm=form.text.match(/<form[^>]*action="\/super\/settings\/cms\/revisions"[\s\S]*?<\/form>/)?.[0];
      assert.ok(editForm);assert.ok(editForm.includes('value="'+detail.key+'"'));assert.ok(editForm.includes('name="version" value="'+detail.version+'"'));
      await author.client.get('/super/settings').query({...filters,country:'KE',id:olderRow.id}).set('accept','application/json').expect(404);
      const edited={key:detail.key,type:detail.type,country:detail.country,version:detail.version,
        title:'Reviewed older backlog source',body:'The original older record now has its next saved private revision.',reason:reviewReason};
      const changed=await post(author,'/super/settings/cms/revisions',edited);
      assert.equal(changed.body.publicId,detail.publicId);
      const saved=await CmsContent.findOne({publicId:detail.publicId}).lean();
      assert.equal(saved.revisions.length,2);assert.equal(saved.revisions[0].body,detail.revisions[0].body);
      assert.equal(saved.revisions[1].version,2);assert.equal(saved.revisions[1].body,edited.body);
      assert.equal(String(saved.revisions[1].createdByUserId),String(author.user._id));
      assert.equal(saved.__v,detail.version+1);assert.equal(saved.activeVersion,0);assert.equal(saved.status,'draft');
      assert.equal(await CmsContent.countDocuments({key:detail.key,country:detail.country}),1);
      assert.ok(await AuditLog.exists({action:'super_admin.cms_revision_created',targetPublicId:detail.publicId,'metadata.version':2}));
      await post(author,'/super/settings/cms/revisions',{...edited,body:'A stale edit must not append another revision.'},409);
      assert.equal((await CmsContent.findById(saved._id)).revisions.length,2);
      const refreshed=(await author.client.get(olderRow.href).set('accept','application/json').expect(200)).body;
      assert.equal(refreshed.selected.revisions[0].body,edited.body);assert.equal(refreshed.page.total,67);
      assert.ok(refreshed.items.every(item=>!Object.hasOwn(item,'revisions')));
      const originalFind=CmsContent.collection.find.bind(CmsContent.collection),projections=[];
      const observed=t.mock.method(CmsContent.collection,'find',(filter,options)=>{projections.push(options?.projection);return originalFind(filter,options);});
      try{
        const exported=await author.client.get('/super/settings/export.csv').query(filters).expect(200);
        assert.equal(exported.text.trim().split('\r\n').length,68);
        assert.ok(exported.text.includes(detail.key));assert.doesNotMatch(exported.text,/PRIVATE_CMS_BODY_|original older record/);
        assert.ok(projections.length>0);assert.ok(projections.every(projection=>projection&&!Object.hasOwn(projection,'revisions')),'The database export cursor must not fetch private revision histories.');
      }finally{observed.mock.restore();}
    });

    await t.test('business credit review uses the current requesting membership and bounded requested terms',async()=>{
      const owner=await identity('business');
      const org=await BusinessOrganization.create({publicId:id('biz'),ownerUserId:owner.user._id,companyName:'Verified credit fixture',country:'UG',currency:'UGX',creditRequestedAt:new Date(),creditRequestedByUserId:owner.user._id,creditRequesterTokenVersion:owner.user.security.tokenVersion,creditRequestedLimitMinor:5000,creditRequestedTermsDays:30});
      await BusinessMember.create({publicId:id('bmem'),organizationId:org._id,userId:owner.user._id,role:'owner',status:'active',acceptedAt:new Date(),invitedByUserId:owner.user._id});
      const shown=await author.client.get('/super/settings?tab=business-credit&id='+org.publicId).expect(200);assert.match(shown.text,/Verified credit fixture/);assert.match(shown.text,/Independent business credit review/);
      await post(reviewer,'/super/settings/business-credit/'+org.publicId+'/decision',{version:0,decision:'approve',limitMinor:6000,termsDays:30,reason:reviewReason},422);
      await post(reviewer,'/super/settings/business-credit/'+org.publicId+'/decision',{version:0,decision:'approve',limitMinor:4000,termsDays:20,reason:reviewReason});const approved=await BusinessOrganization.findById(org._id);assert.equal(approved.creditLimitMinor,4000);assert.equal(approved.invoiceTermsDays,20);assert.equal(String(approved.creditApprovedByUserId),String(reviewer.user._id));
      assert.ok(await AuditLog.exists({action:'business.credit.approve',targetPublicId:org.publicId}));
    });
  }finally{
    t.mock.restoreAll();
    for(const transport of transports)transport.destroy();
    try{await mongoose.connection.dropDatabase();}finally{await mongoose.disconnect();}
  }
});
