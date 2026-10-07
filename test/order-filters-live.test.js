import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import mongoose from 'mongoose';
import { chromium } from '@playwright/test';
const base=process.env.CLASSIC_MART_LIVE_BASE_URL;
const uri=process.env.CLASSIC_MART_LIVE_TEST_MONGO_URI;
test('real customer orders filter by fulfillment state and customer URLs stay clean',{skip:!base||!uri},async()=>{
  assert.equal(new URL(base).hostname,'127.0.0.1');
  assert.equal(new URL(uri).hostname,'127.0.0.1');
  assert.match(new URL(uri).pathname,/test|verification/);
  await mongoose.connect(uri);
  const browser=await chromium.launch({executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE||undefined,args:['--no-sandbox']});
  let user;
  try{
    const page=await browser.newPage();
    const suffix=crypto.randomBytes(6).toString('hex');
    const email=`filter-${suffix}@example.com`;
    await page.goto(base+'/signup');
    const fields={name:'Order Filter Customer',email,phone:'+25677'+crypto.randomInt(1000000,9999999),password:`Filters-${suffix}A1!`,confirmPassword:`Filters-${suffix}A1!`};
    for(const [name,value] of Object.entries(fields))await page.locator(`[name="${name}"]`).fill(value);
    await page.locator('[name=acceptTerms]').check();await page.getByRole('button',{name:'Create My Account'}).click();await page.waitForURL('**/dashboard/dashboard');
    user=await mongoose.connection.db.collection('users').findOne({emailNormalized:email});
    const states=['unfulfilled','processing','ready','partially_shipped','shipped','partially_delivered','delivered','cancelled'];
    await mongoose.connection.db.collection('orders').insertMany(states.map((fulfillmentState,index)=>({sessionKey:`filter_${suffix}`,idempotencyKey:`filter_${suffix}_${index}`,userId:user._id,publicId:`filter_${suffix}_${index}`,fulfillmentState,paymentState:'paid',status:'confirmed',totals:{totalMinor:1000,currency:'UGX'},items:[{title:'Filter Fixture Product'}],createdAt:new Date(),updatedAt:new Date()})));
    await page.goto(base+'/dashboard/orders#orders');
    await page.waitForURL(base+'/dashboard/orders');
    assert.deepEqual(await page.locator('#orderFilters button').allTextContents(),['All','Processing','Shipped','Delivered']);
    for(const [label,count] of [['All',8],['Processing',3],['Shipped',3],['Delivered',1]]){
      await page.getByRole('button',{name:label,exact:true}).click();
      assert.equal(await page.locator('[data-order-group]:visible').count(),count,label);
      assert.equal(new URL(page.url()).hash,'');
    }
    await page.getByRole('link',{name:'Addresses',exact:true}).click();await page.waitForURL(base+'/dashboard/addresses');
    await page.getByRole('link',{name:/Rewards/}).first().click();await page.waitForURL(base+'/dashboard/rewards');
    assert.equal(new URL(page.url()).hash,'');
    assert.equal(await page.locator('.reward-option form').getAttribute('class'),'dashboard-form');
  }finally{if(user)await mongoose.connection.db.collection('orders').deleteMany({userId:user._id});await browser.close();await mongoose.disconnect();}
});
