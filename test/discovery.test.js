import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import request from 'supertest';
import discovery from '../src/routes/discovery.js';
import { Product } from '../src/models/index.js';

const app=()=>express().use(discovery).use((error,_request,response,_next)=>response.status(error.status||500).json({code:error.code}));
test('robots allows public and AI crawlers while excluding private customer and operational routes',async()=>{
  const result=await request(app()).get('/robots.txt').expect(200);
  assert.match(result.text,/User-agent: \*\nAllow: \/\n/);
  assert.match(result.text,/Allow: \/sellers/);
  assert.match(result.text,/Allow: \/promoters/);
  for(const path of ['/dashboard','/orders','/addresses','/wallet','/account','/api/'])assert.ok(result.text.includes('Disallow: '+path+'\n'));
  assert.ok(!result.text.includes('Disallow: /categories'));
  const pages=await request(app()).get('/sitemaps/pages.xml').expect(200);
  assert.ok(pages.text.includes('/return-policy</loc>'));
  assert.ok(!pages.text.includes('/dashboard</loc>'));
});
test('sitemaps paginate only published public catalogue records and validate page input',async t=>{
  t.mock.method(Product,'countDocuments',async scope=>{assert.deepEqual(scope,{status:'published',countries:'UG'});return 1001;});
  t.mock.method(Product,'find',scope=>{
    assert.deepEqual(scope,{status:'published',countries:'UG'});
    const query={select(){return query;},sort(value){assert.deepEqual(value,{_id:1});return query;},skip(value){assert.equal(value,1000);return query;},limit(value){assert.equal(value,1000);return query;},lean:async()=>[{publicId:'prd_public',updatedAt:new Date('2026-10-07T00:00:00Z')}]};return query;
  });
  const index=await request(app()).get('/sitemap.xml').expect(200);
  assert.match(index.text,/products\.xml\?page=2/);
  const page=await request(app()).get('/sitemaps/products.xml?page=2').expect(200);
  assert.match(page.text,/\/products\/prd_public<\/loc>/);
  assert.match(page.headers['cache-control'],/public/);
  await request(app()).get('/sitemaps/products.xml?page=-1').expect(404);
  await request(app()).get('/sitemaps/products.xml?page=1&page=2').expect(404);
});
