import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import multer from 'multer';
import sharp from 'sharp';
import { z } from 'zod';
import { AppError } from '../core/errors.js';
import { requireAuth, requireOnboarding, requirePermission, requireVerified } from '../middleware/auth.js';
import { verifyDeferredCsrf } from '../middleware/csrf.js';
import { loadSellerStore, requireStoreCapability } from '../middleware/store.js';
import { noStore } from '../middleware/request.js';
import { setFlash } from '../middleware/view.js';
import {
  AiEvaluationRun,AiJob,AiModelRegistry,AiPromptVersion,Campaign,CampaignApplication,Product,SupportTicket,TrustCase,
} from '../models/index.js';
import {
  aiObservability,applyCartDraft,approveSellerAiJob,approveSupportAiJob,askClassic,hybridSearch,latestReviewSummary,
  queueAiJob,recommendationsFor,rejectAiJob,runEvaluationSuite,similarProducts,submitAiFeedback,
} from '../services/ai.js';
import { describeImage } from '../services/ai-provider.js';
import { scanUpload } from '../services/malware.js';
import { writeAudit } from '../services/audit.js';
import { createApproval } from '../services/stage9.js';
import { assertOperationalCountry, operationalCountriesFor, operationalCountryScope } from '../services/authorization.js';
import { cursorScope, cursorSort, pageResult } from '../services/pagination.js';

const router=Router();
const aiLimit=rateLimit({windowMs:60_000,limit:20,standardHeaders:'draft-8',legacyHeaders:false});
const imageUpload=multer({storage:multer.memoryStorage(),limits: {fileSize:5*1024*1024,files:1,fields:4, fieldArrayIndexLimit: 16 },fileFilter(_req,file,cb){if(!['image/jpeg','image/png','image/webp','image/avif'].includes(file.mimetype))return cb(new AppError('Upload a JPEG, PNG, WebP or AVIF image.',422,'AI_IMAGE_TYPE_INVALID'));cb(null,true);}}).single('image');
const supportRoles=new Set(['support','country_admin','super_admin']);
const adminRoles=new Set(['country_admin','super_admin']);
function supportOnly(req,_res,next){return supportRoles.has(req.user?.role)?next():next(new AppError('Support access required.',403,'FORBIDDEN'));}
function adminOnly(req,_res,next){return adminRoles.has(req.user?.role)?next():next(new AppError('Administrator access required.',403,'FORBIDDEN'));}
function countryScope(req){return operationalCountryScope(req.user,'country');}
function requireAiFeature(key){return (req,_res,next)=>req.features?.[key]===false?next(new AppError('This Classic AI feature is not enabled for your account/country.',404,'AI_FEATURE_DISABLED')):next();}

router.get('/ask-classic',noStore,requireAiFeature('classic_ai.ask'),async(req,res,next)=>{try{const recommendations=await recommendationsFor(req,{limit:8});res.render('ask-classic',{result:null,recommendations,visualResults:[],question:''});}catch(e){next(e);}});

router.post('/ask-classic',noStore,aiLimit,requireAiFeature('classic_ai.ask'),async(req,res,next)=>{try{const input=z.object({question:z.string().trim().min(2).max(2000)}).parse(req.body);const [result,recommendations]=await Promise.all([askClassic(req,input.question),recommendationsFor(req,{limit:8})]);res.render('ask-classic',{result,recommendations,visualResults:[],question:input.question});}catch(e){next(e);}});

router.post('/ask-classic/cart-drafts/:id/apply',noStore,async(req,res,next)=>{try{await applyCartDraft(req,req.params.id);setFlash(req,'success','AI cart draft was revalidated against live stock and added to your server cart.');res.redirect('/cart');}catch(e){next(e);}});

router.post('/api/v1/ai/feedback',aiLimit,async(req,res,next)=>{try{const input=z.object({usageId:z.string().min(4).max(120),rating:z.enum(['helpful','not_helpful','incorrect','unsafe']),comment:z.string().trim().max(1000).optional().default('')}).parse(req.body);res.status(201).json({feedback:await submitAiFeedback(req,input)});}catch(e){next(e);}});

router.post('/ask-classic/feedback',noStore,aiLimit,async(req,res,next)=>{try{const input=z.object({usageId:z.string().min(4).max(120),rating:z.enum(['helpful','not_helpful','incorrect','unsafe']),comment:z.string().trim().max(1000).optional().default('')}).parse(req.body);await submitAiFeedback(req,input);setFlash(req,'success','Thanks. Your AI feedback was recorded for evaluation.');res.redirect('/ask-classic');}catch(e){next(e);}});

router.get('/api/v1/ai/search',aiLimit,async(req,res,next)=>{try{const input=z.object({q:z.string().trim().min(1).max(120),category:z.string().max(100).optional().default(''),brand:z.string().max(100).optional().default(''),seller:z.string().max(100).optional().default('')}).parse(req.query);res.json(await hybridSearch(req.country,{query:input.q,category:input.category,brand:input.brand,seller:input.seller,limit:40}));}catch(e){next(e);}});

router.get('/api/v1/ai/products/:id/similar',aiLimit,async(req,res,next)=>{try{res.json({products:await similarProducts(req.country,req.params.id,{limit:12})});}catch(e){next(e);}});

router.get('/api/v1/ai/recommendations',aiLimit,async(req,res,next)=>{try{res.set('Cache-Control','private, no-store').json({products:await recommendationsFor(req,{limit:12})});}catch(e){next(e);}});

router.get('/api/v1/ai/products/:id/review-summary',aiLimit,async(req,res,next)=>{try{res.json({summary:await latestReviewSummary(req.country,req.params.id)});}catch(e){next(e);}});

router.post('/ask-classic/visual',noStore,aiLimit,requireAiFeature('classic_ai.ask'),imageUpload,async(req,res,next)=>{try{verifyDeferredCsrf(req);if(!req.file?.buffer)throw new AppError('Choose a product image.',422,'AI_IMAGE_REQUIRED');await scanUpload(req.file.buffer);const normalized=await sharp(req.file.buffer,{failOn:'warning',limitInputPixels:25_000_000}).rotate().resize({width:768,height:768,fit:'inside',withoutEnlargement:true}).jpeg({quality:80}).toBuffer();const described=await describeImage({dataUrl:`data:image/jpeg;base64,${normalized.toString('base64')}`,instructions:'Describe only visible product/category/style/material/color/function details useful for shopping search.',country:req.country.code,role:req.user?.role||'customer'});const results=await hybridSearch(req.country,{query:described.text,limit:16});const recommendations=await recommendationsFor(req,{limit:8});res.render('ask-classic',{result:null,recommendations,visualResults:results.products,question:`Visual search: ${described.text}`});}catch(e){next(e);}});

export default router;
