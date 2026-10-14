import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import { EventEmitter } from 'node:events';
import ejs from 'ejs';
import mongoose from 'mongoose';
import request from 'supertest';

const suffix=crypto.randomBytes(8).toString('hex');
process.env.NODE_ENV='test';process.env.SIMPLE_LOGIN='false';process.env.PRIVILEGED_MFA_REQUIRED='true';
process.env.MAIL_MODE='log';process.env.SMS_MODE='log';process.env.REDIS_URL='';
for(const name of ['SESSION_SECRET','TOKEN_PEPPER','SECURITY_INTEGRITY_KEY','DATA_ENCRYPTION_KEY'])process.env[name]=crypto.randomBytes(32).toString('hex');
const uri=process.env.CLASSIC_MART_LIVE_TEST_MONGO_URI;if(uri)process.env.MONGO_URI=uri;
const paths={'admin-seller-approvals':'/admin/seller-approvals','admin-promoter-approvals':'/admin/promoter-approvals','admin-customers':'/admin/customers','admin-products':'/admin/products','admin-categories':'/admin/categories','admin-reviews':'/admin/reviews'};
const csrf=html=>{const match=html.match(/(?:name="_csrf"[^>]*value|name="csrf-token" content)="([^"]+)"/);assert.ok(match,'A real authenticated page supplies CSRF.');return match[1];};

test('Country Admin catalogue source partial renders every actionable domain and escapes persisted source text',async()=>{
  const source=await fs.readFile(new URL('../views/partials/country-admin-catalogue-forms.ejs',import.meta.url),'utf8'),render=ejs.compile(source);
  const name='<script>PRIVATE_SCRIPT</script>',record={publicId:'usr_partial_record',name,country:'UG',status:'active',version:7,createdAt:new Date(),channels:[],niches:[]};
  const selected=[{type:'customer',record,actionable:true},{type:'promoter',record:{...record,publicId:'pvr_partial_record',status:'submitted'},assignment:'unassigned',actionable:true},
    {kind:'category',record:{...record,publicId:'cat_partial_record',slug:'partial',countries:['UG'],attributes:[],active:true},affectedCountries:['UG'],canEdit:true},
    {kind:'brand',record:{...record,publicId:'brd_partial_record',slug:'partial',status:'pending'},affectedCountries:['UG'],canEdit:true},
    {kind:'review',record:{...record,publicId:'rev_partial_record',status:'pending',body:name,rating:4,assignment:{state:'mine'}},order:{publicId:'ord_source'},product:{title:name},store:{name},canAct:true},
    {type:'verification',reviewFlow:{record:{...record,publicId:'kyc_partial_record',status:'submitted',assignment:'mine',legalName:name,sellerType:'individual',reviewHistory:[]},store:{name,country:'UG',status:'pending_verification'},documents:[]}},
    {type:'product',productFlow:{product:{...record,publicId:'prd_partial_record',title:name,status:'submitted',assignment:'mine',description:name,moderation:{reviewHistory:[]}},store:{name,country:'UG',status:'verified'},variants:[],media:[],stocks:[]}}];
  for(const item of selected) {
    const html=render({countryAdminFlow:{country:'UG',selected:item},csrfToken:'csrf-test',formatDate:v=>String(v),formatMoney:v=>String(v)});
    assert.ok(html.includes('name="version" value="7"'));assert.ok(html.includes('name="_csrf" value="csrf-test"'));
    assert.ok(html.includes('&lt;script&gt;PRIVATE_SCRIPT&lt;/script&gt;'));assert.ok(!html.includes('<script>PRIVATE_SCRIPT'));
    assert.match(html,/role-form-section/);assert.ok(!html.includes('/moderation/'));
  }
});

test('Country Admin six catalogue pages read complete scoped sources, current claims, authenticated forms and revocable CSV', {skip:!uri,timeout:240_000},async t=>{
  const parsed=new URL(uri);assert.equal(parsed.hostname,'127.0.0.1');assert.equal(parsed.port,'27019');assert.match(parsed.pathname,/verification|test/i);
  const transports=[];await mongoose.connect(uri,{dbName:'classicmart_country_admin_pages_test_'+suffix});
  try {
    const {createApp}=await import('../src/app.js');const models=await import('../src/models/index.js');
    const {User,PlatformGrant,CountrySetting,Store,Product,Category,PromoterVerification,SellerVerification,AuditLog,Device}=models;
    const {hashPassword,hashToken}=await import('../src/core/crypto.js');const {beginMfaEnrollment,confirmMfaEnrollment,totpCode}=await import('../src/services/mfa.js');
    const {loadCountryAdminCataloguePage,countryAdminCatalogueAction,streamCountryAdminCatalogueCsv}=await import('../src/services/country-admin-catalogue-pages.js');
    await Promise.all(Object.values(mongoose.models).map(Model=>Model.init()));
    await CountrySetting.create([{code:'UG',name:'Uganda',currency:'UGX',locale:'en-UG',timeZone:'Africa/Kampala',phonePrefix:'+256'},
      {code:'KE',name:'Kenya',currency:'KES',locale:'en-KE',timeZone:'Africa/Nairobi',phonePrefix:'+254'},
      {code:'TZ',name:'Foreign source market',currency:'TZS',locale:'en-TZ',timeZone:'Africa/Dar_es_Salaam',phonePrefix:'+255'}]);
    const app=createApp(null),password='Country-Admin-Pages-'+suffix+'-A1!',passwordHash=await hashPassword(password);let sequence=0;
    const id=prefix=>prefix+'_cap_'+suffix+'_'+ ++sequence;
    async function actor({role='customer',country='UG',managed=false,scope=['UG','KE']}={}) {
      const number=++sequence,email='country-admin-pages-'+suffix+'-'+number+'@example.com',phone='+25670'+String(number).padStart(7,'0');
      let user=await User.create({publicId:id('usr'),name:'Recorded '+role+' '+number,email,emailNormalized:email,phone,phoneNormalized:phone,passwordHash,role,country,shoppingCountry:'TZ',currency:'UGX',
        platformAccessManagedAt:managed?new Date():undefined,emailVerifiedAt:new Date(),phoneVerifiedAt:new Date(),onboardingCompletedAt:new Date(),consents:{terms:true,privacy:true,recordedAt:new Date()}});
      const grant=managed?await PlatformGrant.create({publicId:id('pgr'),userId:user._id,role:'country_admin',operationalCountries:scope,status:'active',startsAt:new Date(Date.now()-60000),expiresAt:new Date(Date.now()+86400000),reason:'Actual isolated Country Admin grants',approvalPublicId:id('apr'),approvedByUserId:new mongoose.Types.ObjectId()}):null;
      return {user,grant,email};
    }
    async function authenticate(entry) {
      const enrollment=await beginMfaEnrollment(entry.user._id,password);await confirmMfaEnrollment(entry.user._id,totpCode(enrollment.secret,{time:Date.now()-30000}));
      const transport=new http.Agent({localAddress:'127.0.0.60',keepAlive:false});transports.push(transport);const agent=request.agent(app).use(req=>req.agent(transport));
      const form=await agent.get('/login').expect(200);await agent.post('/login').type('form').send({email:entry.email,password,_csrf:csrf(form.text)}).expect(302).expect('location','/mfa');
      const challenge=await agent.get('/mfa').expect(200),sessionResponse=await agent.post('/mfa').type('form').send({code:totpCode(enrollment.secret),_csrf:csrf(challenge.text)}).expect(302);
      const cookie=sessionResponse.headers['set-cookie'].find(value=>value.startsWith('cm.sid=')),signed=decodeURIComponent(cookie.split(';')[0].slice('cm.sid='.length));
      entry.sessionID=signed.slice(2,signed.lastIndexOf('.'));entry.device=await Device.findOne({userId:entry.user._id,revokedAt:null}).select('+sessionHash');assert.equal(hashToken(entry.sessionID),entry.device.sessionHash);entry.agent=agent;entry.user=await User.findById(entry.user._id);return entry;
    }
    const admin=await authenticate(await actor({managed:true})),contender=await actor({managed:true});
    const contenderMfa=await beginMfaEnrollment(contender.user._id,password);await confirmMfaEnrollment(contender.user._id,totpCode(contenderMfa.secret,{time:Date.now()-30000}));
    const sourceOwner=await actor({role:'seller'}),sourceStore=await Store.create({publicId:id('str'),ownerUserId:sourceOwner.user._id,name:'Current Uganda catalogue source',slug:id('store'),country:'UG',currency:'UGX',status:'verified'});
    const foreignOwner=await actor({role:'seller',country:'TZ'}),foreignStore=await Store.create({publicId:id('str'),ownerUserId:foreignOwner.user._id,name:'Foreign source must be absent',slug:id('store'),country:'TZ',currency:'TZS',status:'verified'});
    const category=await Category.create({publicId:id('cat'),name:'Source category',slug:id('category'),countries:['UG']}),at=new Date();
    const products=await Product.create(Array.from({length:31},(_,index)=>({publicId:id('prd'),storeId:sourceStore._id,ownerUserId:sourceOwner.user._id,categoryId:category._id,title:index===0?'=HYPERLINK("https://example.invalid","record")':'Recorded source product '+index,slug:id('product'),description:'Actual persisted submitted product for Country Admin source verification.',countries:['TZ'],status:'submitted',moderation:{submittedAt:at}})));
    const foreignProduct=await Product.create({publicId:id('prd'),storeId:foreignStore._id,ownerUserId:foreignOwner.user._id,categoryId:category._id,title:'Foreign Storecountry product',slug:id('product'),description:'Foreign source with deceptively local selling label.',countries:['UG'],status:'submitted',moderation:{submittedAt:at}});
    await actor({role:'customer'});await actor({role:'customer',country:'TZ'});
    const promoter=await actor({role:'promoter'});await PromoterVerification.create({publicId:id('pvr'),userId:promoter.user._id,country:'UG',status:'submitted',channels:['https://example.com/real-channel'],niches:['Household'],audienceSize:1200,disclosureAcceptedAt:at,submittedAt:at});
    const applicant=await actor({role:'seller'}),applicantStore=await Store.create({publicId:id('str'),ownerUserId:applicant.user._id,name:'Actual pending seller',slug:id('store'),country:'UG',currency:'UGX',status:'pending_verification'});
    const verification=await SellerVerification.create({publicId:id('kyc'),storeId:applicantStore._id,userId:applicant.user._id,sellerType:'individual',legalName:'Genuine pending seller',status:'submitted',submittedAt:at});
    const core=async(entry=admin,options={})=>{const user=await User.findById(entry.user._id);return {id:id('req'),user,session:{userId:String(user._id),tokenVersion:user.security.tokenVersion},...(entry.sessionID?{sessionID:entry.sessionID,device:entry.device}:{}),query:{country:'UG',...options.query},params:options.publicId?{publicId:options.publicId}:{},body:options.body || {},ip:'127.0.0.60',get:()=> 'CountryAdminSourceLive/1.0'};};

    await t.test('six canonical pages preserve approved Admin shell, live JSON and duplicate-filter/CSRF gates',async()=>{
      for(const [pageId,path] of Object.entries(paths)) {
        const response=await admin.agent.get(path+'?country=UG').expect(200);assert.ok(response.text.includes('data-dashboard-workspace="admin"'));assert.ok(response.text.includes('data-dashboard-page="'+pageId+'"'));assert.match(response.headers['cache-control'],/no-store/);assert.doesNotMatch(response.text,/Development preview|id="roleSwitcher"/);
        const json=await admin.agent.get(path+'?country=UG').set('Accept','application/json').expect(200);assert.equal(json.body.pageId,pageId);assert.equal(json.body.metrics.length,4);assert.ok(json.body.page.count<=25);
      }
      await admin.agent.get('/admin/products?country=UG&country=TZ').expect(422);
      await admin.agent.post('/admin/products/'+products[0].publicId+'/claim?country=UG').type('form').send({version:0}).expect(403);
      const detail=await admin.agent.get('/admin/products/'+products[0].publicId+'?country=UG').expect(200);assert.match(detail.text,/Product evidence|Claim Product/);assert.doesNotMatch(detail.text,/ownerUserId|storageKey/);
      const denied=await admin.agent.get('/admin/products/'+foreignProduct.publicId+'?country=UG').set('Accept','application/json').expect(403);
      assert.equal(denied.body.error.code,'COUNTRY_ADMIN_COUNTRY_FORBIDDEN');assert.ok(!JSON.stringify(denied.body).includes(foreignProduct.publicId));
      const seller=await admin.agent.get('/admin/seller-approvals/'+verification.publicId+'?country=UG').expect(200);assert.match(seller.text,/Seller evidence|Genuine pending seller/);
    });
    await t.test('complete counts and tied-date keyset pages use Storecountry and omit private source identifiers',async()=>{
      let after='',seen=[];
      do {const flow=await loadCountryAdminCataloguePage(await core(admin,{query:{after}}),'admin-products');assert.equal(flow.page.total,31);assert.equal(flow.metrics[0].value,31);assert.ok(flow.page.count<=25);assert.ok(flow.items.every(row=>row.store.country==='UG'));assert.ok(flow.items.every(row=>row.ownerUserId===undefined && row._id===undefined));seen.push(...flow.items.map(row=>row.publicId));after=flow.page.hasMore?flow.page.next:'';}while(after);
      assert.equal(seen.length,31);assert.equal(new Set(seen).size,31);assert.ok(!seen.includes(foreignProduct.publicId));
      await assert.rejects(loadCountryAdminCataloguePage(await core(admin,{query:{after:'invalid'}}),'admin-products'),error=>error.code==='COUNTRY_ADMIN_FILTER_INVALID');
      const customers=await loadCountryAdminCataloguePage(await core(),'admin-customers');assert.ok(customers.items.every(row=>row.publicId !== admin.user.publicId && row.publicId !== contender.user.publicId && row.country==='UG'));assert.equal(customers.items.length,1);
    });
    await t.test('real competing claims, version conflicts and audit rollback leave no false successful state',async()=>{
      const product=products[1];const action=async(entry,version)=>countryAdminCatalogueAction(await core(entry,{publicId:product.publicId,body:{version}}),'admin-products','claim');
      const settled=await Promise.allSettled([action(admin,0),action(contender,0)]);assert.equal(settled.filter(row=>row.status==='fulfilled').length,1);assert.equal(settled.filter(row=>row.status==='rejected').length,1);
      assert.ok((await Product.findById(product._id)).moderation.assignedUserId);await assert.rejects(action(admin,0),error=>error.status===409);
      const clean=products[2],original=AuditLog.create;AuditLog.create=async()=>{throw new Error('Isolated audit failure');};
      try {await assert.rejects(countryAdminCatalogueAction(await core(admin,{publicId:clean.publicId,body:{version:0}}),'admin-products','claim'),/Isolated audit failure/);}finally{AuditLog.create=original;}
      const current=await Product.findById(clean._id);assert.equal(current.__v,0);assert.equal(current.moderation.assignedUserId,null);
    });
    await t.test('streaming CSV is formula-safe, audited and stops when current grant is revoked between rows',async()=>{
      class Response extends EventEmitter {constructor(){super();this.data='';this.destroyed=false;this.writableEnded=false;}type(){return this;}set(){return this;}write(value){this.data+=value;return true;}end(){this.writableEnded=true;}}
      const response=new Response();await streamCountryAdminCatalogueCsv(await core(),response,'admin-products');assert.ok(response.writableEnded);assert.ok(response.data.includes("'="));assert.ok(!response.data.includes('Foreign Storecountry'));assert.ok(await AuditLog.exists({action:'country_admin.catalogue_exported',actorId:admin.user._id,'metadata.pageId':'admin-products'}));
      const revoked=new Response();let rows=0;
      revoked.write=function(value){this.data+=value;if(++rows===2){const self=this;PlatformGrant.updateOne({_id:admin.grant._id},{$set:{status:'revoked'},$inc:{__v:1}}).then(()=>self.emit('drain'));return false;}return true;};
      await assert.rejects(streamCountryAdminCatalogueCsv(await core(),revoked,'admin-products'),error=>error.status===403);assert.equal(rows,2);assert.equal(revoked.writableEnded,false);
    });
  } finally {for(const transport of transports)transport.destroy();await mongoose.connection.dropDatabase();await mongoose.disconnect();}
});
