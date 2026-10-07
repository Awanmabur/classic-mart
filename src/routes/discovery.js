import rateLimit from 'express-rate-limit';
import { Router } from 'express';
import { env } from '../config/env.js';
import { Product } from '../models/index.js';
import { AppError, asyncHandler } from '../core/errors.js';

const router=Router();
const discoveryLimit=rateLimit({windowMs:60_000,limit:60,standardHeaders:'draft-8',legacyHeaders:false});
router.use(['/robots.txt','/sitemap.xml','/sitemaps'],discoveryLimit);
const base=env.baseUrl.replace(/\/$/,'');
const xml=value=>String(value).replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&apos;'}[char]));
const catalogueScope={status:'published',countries:'UG'};
const pageSize=1000;
const publicPages=['/','/products','/categories','/sellers','/promoters','/about','/contact','/help','/press','/privacy','/terms','/cookies','/shipping','/return-policy'];
const privatePaths=['/dashboard','/orders','/wishlist','/addresses','/rewards','/wallet','/support','/profile','/notifications','/club','/account','/cart','/checkout','/api/','/webhooks/','/login','/signup','/verify-','/onboarding','/forgot-password','/reset-password','/mfa','/track-order','/ask-classic','/seller','/promoter','/admin','/super-admin','/operations','/finance','/warehouse','/moderation','/business'];
function sendXml(response,body) {response.set('Cache-Control','public, max-age=60').type('application/xml').send('<?xml version="1.0" encoding="UTF-8"?>\n'+body);}
router.get('/robots.txt',(_request,response)=>response.set('Cache-Control','public, max-age=300').type('text/plain').send('User-agent: *\nAllow: /\nAllow: /sellers\nAllow: /promoters\n'+privatePaths.map(path=>`Disallow: ${path}\n`).join('')+`Sitemap: ${base}/sitemap.xml\n`));
router.get('/sitemap.xml',asyncHandler(async(_request,response)=>{
  const total=await Product.countDocuments(catalogueScope);
  const pages=Math.ceil(total/pageSize);
  const entries=[`${base}/sitemaps/pages.xml`,...Array.from({length:pages},(_,index)=>`${base}/sitemaps/products.xml?page=${index+1}`)];
  sendXml(response,'<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">'+entries.map(url=>`<sitemap><loc>${xml(url)}</loc></sitemap>`).join('')+'</sitemapindex>');
}));
router.get('/sitemaps/pages.xml',(_request,response)=>sendXml(response,'<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">'+publicPages.map(path=>`<url><loc>${xml(base+path)}</loc></url>`).join('')+'</urlset>'));
router.get('/sitemaps/products.xml',asyncHandler(async(request,response)=>{
  const raw=request.query.page??'1';
  if(typeof raw!=='string'||!/^[1-9]\d{0,5}$/.test(raw))throw new AppError('Sitemap page not found.',404,'SITEMAP_NOT_FOUND');
  const offset=(Number(raw)-1)*pageSize;
  if(offset>0 && offset>=await Product.countDocuments(catalogueScope))throw new AppError('Sitemap page not found.',404,'SITEMAP_NOT_FOUND');
  const products=await Product.find(catalogueScope).select('publicId updatedAt').sort({_id:1}).skip(offset).limit(pageSize).lean();
  if(!products.length&&raw!=='1')throw new AppError('Sitemap page not found.',404,'SITEMAP_NOT_FOUND');
  sendXml(response,'<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">'+products.map(product=>`<url><loc>${xml(base+'/products/'+encodeURIComponent(product.publicId))}</loc>${product.updatedAt?`<lastmod>${xml(new Date(product.updatedAt).toISOString())}</lastmod>`:''}</url>`).join('')+'</urlset>');
}));
export default router;
