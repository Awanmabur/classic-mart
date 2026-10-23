import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import mongoose from 'mongoose';
import request from 'supertest';
import sharp from 'sharp';

const base=process.env.CLASSIC_MART_LIVE_BASE_URL, uri=process.env.CLASSIC_MART_LIVE_TEST_MONGO_URI;
const token=html=>html.match(/(?:name="_csrf"[^>]*value|name="csrf-token" content)="([^"]+)"/)[1];
const suffix=()=>crypto.randomBytes(7).toString('hex');
const id=prefix=>`${prefix}_${suffix()}`;
const decode=value=>value.replaceAll('&amp;','&');
const older=(html,label)=>decode(html.match(new RegExp('href="([^"]+)" rel="next">Older '+label))?.[1]||'');

async function withDatabase(work){
  const target=new URL(uri);assert.equal(target.hostname,'127.0.0.1');assert.match(target.pathname,/verification|test/i);
  await mongoose.connect(uri);try{await work(mongoose.connection.db);}finally{await mongoose.disconnect();}
}
async function signup(db,name){
  const tag=suffix(),email=`customer-recovery-${tag}@example.com`,password=`Recovery-${tag}A1!`,agent=request.agent(base);
  const form=await agent.get('/signup').expect(200);
  await agent.post('/signup').type('form').send({name,email,phone:`+2567${crypto.randomInt(10000000,99999999)}`,password,confirmPassword:password,acceptTerms:'on',_csrf:token(form.text)}).expect(302);
  return {agent,user:await db.collection('users').findOne({emailNormalized:email})};
}

test('owned order histories use stable keysets and server status filters beyond the former limit', {skip:!base||!uri}, async()=>withDatabase(async db=>{
  const {agent,user}=await signup(db,'History Recovery'),{agent:other,user:otherUser}=await signup(db,'Other History');
  const now=new Date(Date.now()-60_000),tag=suffix(),rows=[];
  for(let index=0;index<69;index++)rows.push({_id:new mongoose.Types.ObjectId(),publicId:`ord_history_${tag}_${index}`,userId:user._id,country:'UG',status:'paid',paymentState:'paid',fulfillmentState:index<35?'processing':index<66?'shipped':'delivered',returnState:'none',totals:{totalMinor:1000,currency:'UGX'},items:[{title:`History purchase ${index}`}],createdAt:now,updatedAt:now});
  await db.collection('orders').insertMany([...rows,{...rows[0],_id:new mongoose.Types.ObjectId(),publicId:id('ord_foreign'),userId:otherUser._id,items:[{title:'FOREIGN_HISTORY_PRIVATE'}]}]);
  let page=await agent.get('/orders').expect(200),next=older(page.text,'orders');assert.ok(next);assert.doesNotMatch(page.text,/FOREIGN_HISTORY_PRIVATE/);
  const seen=new Set([...page.text.matchAll(/Order #(ord_history_[A-Za-z0-9_]+)/g)].map(row=>row[1]));
  const firstCursor=next;
  while(next){page=await agent.get(next).expect(200);for(const row of page.text.matchAll(/Order #(ord_history_[A-Za-z0-9_]+)/g)){assert.ok(!seen.has(row[1]));seen.add(row[1]);}next=older(page.text,'orders');}
  assert.equal(seen.size,69);
  await other.get(firstCursor).expect(422);
  await agent.get(firstCursor.slice(0,-1)+(firstCursor.endsWith('A')?'B':'A')).expect(422);
  page=await agent.get('/orders?status=shipped').expect(200);assert.equal([...page.text.matchAll(/data-order-group="shipped"/g)].length,30);assert.doesNotMatch(page.text,/data-order-group="processing"/);
  next=older(page.text,'orders');assert.ok(next);assert.equal([...((await agent.get(next).expect(200)).text.matchAll(/data-order-group="shipped"/g))].length,1);
  await agent.get(firstCursor+'&status=shipped').expect(422);
  await agent.get('/orders?status=invalid').expect(422);
}));

test('saved addresses edit all fields, protect versions and maintain one default under concurrent writes', {skip:!base||!uri}, async()=>withDatabase(async db=>{
  const {agent,user}=await signup(db,'Address Recovery'),{agent:other}=await signup(db,'Other Address');
  const page=await agent.get('/addresses').expect(200),csrf=token(page.text);
  const address={fullName:'Address Recovery',label:'Home',phone:'+256700000001',address:'Recovery Test Street',city:'Kampala',country:'UG',note:'Gate opens inward',isDefault:'on',_csrf:csrf};
  await Promise.all([agent.post('/addresses').type('form').send(address).expect(302),agent.post('/addresses').type('form').send({...address,label:'Office'}).expect(302)]);
  let addresses=await db.collection('customeraddresses').find({userId:user._id,archivedAt:null}).toArray();assert.equal(addresses.length,2);assert.equal(addresses.filter(row=>row.isDefault).length,1);
  const target=addresses.find(row=>row.isDefault),edit=await agent.get('/addresses?edit='+target.publicId).expect(200);assert.match(edit.text,/Edit Delivery Address/);assert.match(edit.text,/Gate opens inward/);
  await other.get('/addresses?edit='+target.publicId).expect(404);
  const otherPage=await other.get('/addresses').expect(200);
  await other.post('/addresses/'+target.publicId).type('form').send({...address,_csrf:token(otherPage.text)}).expect(404);
  await agent.post('/addresses/'+target.publicId).type('form').send({...address,version:target.__v||0,note:'Updated private delivery note',address:'Updated Recovery Street',_csrf:token(edit.text)}).expect(302);
  await agent.post('/addresses/'+target.publicId).type('form').send({...address,version:target.__v||0,_csrf:token(edit.text)}).expect(409);
  const updated=await db.collection('customeraddresses').findOne({_id:target._id});assert.equal(updated.note,'Updated private delivery note');assert.equal(updated.address,'Updated Recovery Street');
  await agent.post('/addresses/'+target.publicId+'/archive').type('form').send({_csrf:csrf}).expect(302);
  addresses=await db.collection('customeraddresses').find({userId:user._id,archivedAt:null}).toArray();assert.equal(addresses.length,1);assert.equal(addresses[0].isDefault,true);
}));

test('move to wishlist commits only the selected owned cart variant and survives replay, stale requests and rollback', {skip:!base||!uri}, async()=>withDatabase(async db=>{
  const {agent,user}=await signup(db,'Cart Recovery'),{agent:other,user:otherUser}=await signup(db,'Other Cart');
  let page=await agent.get('/cart').expect(200);const csrf=token(page.text);
  await other.get('/cart').expect(200);
  const productId=new mongoose.Types.ObjectId(),v1=new mongoose.Types.ObjectId(),v2=new mongoose.Types.ObjectId(),p1=id('var'),p2=id('var'),storeId=new mongoose.Types.ObjectId();
  await db.collection('productvariants').insertMany([{_id:v1,publicId:p1,productId,storeId,active:true,title:'First variant',priceMinor:1000,currency:'UGX'},{_id:v2,publicId:p2,productId,storeId,active:true,title:'Second variant',priceMinor:1000,currency:'UGX'}]);
  await db.collection('carts').updateOne({userId:user._id,country:'UG'},{$set:{items:[{productId,variantId:v1,quantity:2},{productId,variantId:v2,quantity:3}],__v:7}});
  const endpoint='/api/v1/customer/cart/move-to-wishlist';
  const otherToken=token((await other.get('/cart').expect(200)).text);
  await other.post(endpoint).set('x-csrf-token',otherToken).send({variantId:p1,cartVersion:7}).expect(404);
  await agent.post(endpoint).send({variantId:p1,cartVersion:7}).expect(403);
  await agent.post(endpoint).set('x-csrf-token',csrf).send({variantId:p1,cartVersion:7}).expect(200);
  let cart=await db.collection('carts').findOne({userId:user._id,country:'UG'});assert.equal(cart.items.length,1);assert.equal(String(cart.items[0].variantId),String(v2));assert.equal(cart.items[0].quantity,3);
  let state=await db.collection('customercataloguestates').findOne({userId:user._id});assert.ok(state.wishlistProductIds.some(value=>String(value)===String(productId)));
  await agent.post(endpoint).set('x-csrf-token',csrf).send({variantId:p1,cartVersion:7}).expect(200);
  await db.collection('carts').updateOne({_id:cart._id},{$push:{items:{productId,variantId:v1,quantity:1}},$inc:{__v:1}});
  await agent.post(endpoint).set('x-csrf-token',csrf).send({variantId:p1,cartVersion:7}).expect(409);
  const otherProduct=new mongoose.Types.ObjectId();await db.collection('productvariants').updateOne({_id:v2},{$set:{productId:otherProduct}});
  await db.collection('carts').updateOne({_id:cart._id,'items.variantId':v2},{$set:{'items.$.productId':otherProduct}});
  await db.collection('customercataloguestates').updateOne({_id:state._id},{$set:{wishlistProductIds:Array.from({length:500},()=>new mongoose.Types.ObjectId())}});
  cart=await db.collection('carts').findOne({_id:cart._id});
  await agent.post(endpoint).set('x-csrf-token',csrf).send({variantId:p2,cartVersion:cart.__v}).expect(409);
  assert.equal((await db.collection('carts').findOne({_id:cart._id})).items.length,2);
  assert.equal(await db.collection('customercataloguestates').countDocuments({userId:otherUser._id}),0);
}));

test('wallet statement exports every owned ledger posting, opening and closing balances and no foreign account', {skip:!base||!uri}, async()=>withDatabase(async db=>{
  const {agent,user}=await signup(db,'Statement Recovery'),{user:foreign}=await signup(db,'Foreign Statement');
  const accountId=new mongoose.Types.ObjectId(),otherId=new mongoose.Types.ObjectId(),foreignId=new mongoose.Types.ObjectId();
  await db.collection('ledgeraccounts').insertMany([{_id:accountId,publicId:id('acc'),code:'customer_wallet',ownerType:'customer',ownerPublicId:user.publicId,ownerId:user._id,country:'UG',currency:'UGX',type:'liability',active:true},{_id:foreignId,publicId:id('acc'),code:'customer_wallet',ownerType:'customer',ownerPublicId:foreign.publicId,country:'UG',currency:'UGX',type:'liability',active:true}]);
  const rows=[],day=new Date(Date.now()-3*86400000),from=new Date(day);from.setUTCHours(0,0,0,0);
  for(let index=0;index<63;index++){
    const before=index<3,credit=before?100:index%2?10:0,debit=before?0:index%2?0:4;
    const at=new Date(from.getTime()+(before?-3600000:index*60000));
    rows.push({_id:new mongoose.Types.ObjectId(),publicId:id('ltx'),idempotencyKey:id('statement'),referenceType:'verification',referencePublicId:`own_${index}`,country:'UG',currency:'UGX',description:index===3?'=UNTRUSTED_CSV_FORMULA':'Wallet verification',postedAt:at,createdAt:at,entries:[{accountId,accountPublicId:'owned_wallet',debitMinor:debit,creditMinor:credit},{accountId:otherId,accountPublicId:'clearing',debitMinor:credit,creditMinor:debit}]});
  }
  rows.push({...rows[0],_id:new mongoose.Types.ObjectId(),publicId:id('ltx'),idempotencyKey:id('statement'),referencePublicId:'FOREIGN_LEDGER_SECRET',entries:[{accountId:foreignId,accountPublicId:'foreign_wallet',debitMinor:0,creditMinor:100},{accountId:otherId,accountPublicId:'clearing',debitMinor:100,creditMinor:0}]});
  await db.collection('ledgertransactions').insertMany(rows);
  const statement=await agent.get('/wallet/statement.csv?from='+from.toISOString().slice(0,10)).expect(200);
  assert.match(statement.headers['cache-control'],/no-store/);assert.match(statement.text,/"opening_balance".*"300"/);assert.match(statement.text,/"closing_balance".*"480"/);assert.equal((statement.text.match(/"verification"/g)||[]).length,60);assert.match(statement.text,/"'=UNTRUSTED_CSV_FORMULA"/);assert.doesNotMatch(statement.text,/FOREIGN_LEDGER_SECRET/);
  await agent.get('/wallet/statement.csv?from=2026-02-30').expect(422);
}));

test('private avatars validate real raster data, replace and delete with durable physical cleanup records', {skip:!base||!uri}, async()=>withDatabase(async db=>{
  const {agent,user}=await signup(db,'Avatar Recovery'),{agent:other}=await signup(db,'Other Avatar');
  let page=await agent.get('/profile').expect(200),csrf=token(page.text);
  const photo=await sharp({create:{width:400,height:400,channels:3,background:'#c04800'}}).jpeg().withMetadata({exif:{IFD0:{Artist:'PRIVATE_METADATA_SHOULD_BE_REMOVED'}}}).toBuffer();
  await agent.post('/account/avatar').field('_csrf',csrf).attach('avatar',Buffer.from('<svg onload="alert(1)"></svg>'),{filename:'forged.jpg',contentType:'image/jpeg'}).expect(422);
  await agent.post('/account/avatar').field('_csrf',csrf).attach('avatar',photo,{filename:'portrait.jpg',contentType:'image/jpeg'}).expect(302);
  let assets=await db.collection('customeravatars').find({userId:user._id}).toArray(),current=assets.find(row=>row.current);assert.ok(current);assert.equal(current.width,320);assert.equal(current.height,320);
  const image=await agent.get('/account/avatar').expect(200).expect('Content-Type',/image\/webp/);assert.match(image.headers['cache-control'],/no-store/);const info=await sharp(image.body).metadata();assert.equal(info.width,320);assert.equal(info.height,320);assert.equal(info.exif,undefined);
  await other.get('/account/avatar?v='+current.publicId).expect(404);
  await request(base).get('/account/avatar').expect(302);
  const tooSmall=await sharp({create:{width:319,height:400,channels:3,background:'#fff'}}).png().toBuffer();
  await agent.post('/account/avatar').field('_csrf',csrf).attach('avatar',tooSmall,{filename:'small.png',contentType:'image/png'}).expect(422);
  await agent.post('/account/avatar').field('_csrf',csrf).attach('avatar',photo,{filename:'replacement.jpg',contentType:'image/jpeg'}).expect(302);
  assets=await db.collection('customeravatars').find({userId:user._id}).toArray();assert.equal(assets.filter(row=>row.current).length,1);assert.equal(assets.find(row=>String(row._id)===String(current._id)).status,'pending_delete');
  await agent.post('/account/avatar/delete').type('form').send({_csrf:csrf}).expect(302);await agent.get('/account/avatar').expect(404);
  assert.equal(await db.collection('customeravatars').countDocuments({userId:user._id,current:true}),0);assert.equal(await db.collection('customeravatars').countDocuments({userId:user._id,status:'pending_delete'}),2);
}));

test('avatar physical cleanup reclaims crashed worker leases and abandoned staging objects', {skip:!uri||process.env.MEDIA_STORAGE_DRIVER==='r2'}, async()=>withDatabase(async db=>{
  const {putMediaObject,readMediaObjectBuffer}=await import('../src/services/object-storage.js');
  const {processCustomerAvatarCleanup}=await import('../src/services/customer-avatars.js');
  const userId=new mongoose.Types.ObjectId(),keys=[`avatar-recovery-tests/${suffix()}.cmv`,`avatar-recovery-tests/${suffix()}.cmv`,`avatar-recovery-tests/${suffix()}.cmv`];
  for(const key of keys)await putMediaObject(key,Buffer.from('durable-private-test-object'));
  await db.collection('customeravatars').insertMany(keys.map((storageKey,index)=>({publicId:id('avt'),userId,storageKey,mimeType:'image/webp',sizeBytes:34,width:320,height:320,checksumSha256:'a'.repeat(64),current:false,status:['staged','deleting','deleted'][index],cleanupAfter:new Date(0),lockedUntil:index===1?new Date(0):null,leaseToken:index===1?'crashed-worker':'',attempts:0,createdAt:new Date(),updatedAt:new Date()})));
  await processCustomerAvatarCleanup({workerId:'verification-avatar-recovery',limit:100});
  const rows=await db.collection('customeravatars').find({userId}).toArray();assert.equal(rows.length,3);assert.ok(rows.every(row=>row.status==='deleted'&&!row.current));
  for(const key of keys)await assert.rejects(readMediaObjectBuffer(key),{code:'MEDIA_OBJECT_NOT_FOUND'});
}));
