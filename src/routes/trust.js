import { Router } from 'express';
import { customerView } from '../dashboard/customer-view.js';
import { accountWorkspaceView } from '../dashboard/account-workspace-view.js';
import { primaryWorkspaceFor } from '../dashboard/access.js';
import mongoose from 'mongoose';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { AppError } from '../core/errors.js';
import { decryptSensitive } from '../core/sensitive.js';
import { hasPermission } from '../core/roles.js';
import { env } from '../config/env.js';
import { hydratePlatformAuthorization } from '../services/platform-grants.js';
import { requireAuth, requireVerified } from '../middleware/auth.js';
import { verifyDeferredCsrf } from '../middleware/csrf.js';
import {
  CountrySetting, Dispute, EvidenceDocument, Order, PaymentIntent, Product, Refund, ReturnRequest, Review, RiskSignal, SatisfactionSurvey, SellerOrder, SellerReturnCase, Shipment, Store, StoreMember,
  SupportKnowledge, SupportMacro, SupportTicket, SupportTicketPresence, TrustCase, User,
} from '../models/index.js';
import { createRefund } from '../services/payments.js';
import { customerReturnDto } from '../services/customer-case-projections.js';
import { supportTicketCustomerDto, customerReplySupportTicket, customerReopenSupportTicket } from '../services/support-ticket-pages.js';
import { replyToOwnedDispute, supportEvidenceRecord, warehouseReturnReceiptEvidenceRecord, returnFinancialAllocations } from '../services/support-case-pages.js';
import { financeAccess } from '../services/finance-workspace-access.js';
import { supportAccess } from '../services/support-workspace-access.js';
import { customerTrustCaseDto, customerReviewDto, appealOwnedTrustCase, customerReplyTrustCase, authorizeModerationTrustEvidence, recordModerationTrustEvidenceAccess } from '../services/moderation-trust-pages.js';
import { customerDisputeDto, customerSatisfactionDto, appealOwnedDispute } from '../services/customer-dispute-pages.js';
import { sanitizeAndStoreEvidenceImage, uploadVerificationImage } from '../services/media.js';
import { sendStoredMedia } from '../services/media-delivery.js';
import {
  attachEvidence, createDispute, createExchangeReplacement, createKnowledgeArticle, createPublicSupportTicket, createReturnRequest, createTicket,
  createVerifiedReview, decideReturn, disputeReview, inspectReturn, markReturnReceived, publishReview, reportTrustIssue,
  reviewRiskSignal, reviewTrustCase, submitSatisfaction, supportRequester, supportScope,
} from '../services/trust.js';
import { sendSupportTicketEmail } from '../services/mail.js';
import { setFlash } from '../middleware/view.js';
import { assertOperationalCountry, operationalCountriesFor } from '../services/authorization.js';
import { cursorScope, cursorSort, pageResult } from '../services/pagination.js';
import { writeAudit } from '../services/audit.js';

const router=Router();
router.use(['/api/v1/returns','/api/v1/disputes','/api/v1/trust','/api/v1/reviews','/account/trust-cases','/api/v1/support/tickets','/api/v1/finance/returns','/account/returns','/account/support','/account/disputes','/evidence'],(_req,res,next)=>{res.set({'Cache-Control':'private, no-store','X-Robots-Tag':'noindex, nofollow, noarchive'});next();});
const customerReplyLimit=rateLimit({windowMs:15*60_000,limit:30,standardHeaders:'draft-8',legacyHeaders:false});
function customerTrustReturn(request){const value=String(request.body?.returnTo||'');if (['/returns','/support'].includes(value)) return value;return {'/dashboard/returns':'/returns','/dashboard/support':'/support'}[value] || '/account/returns';}
const publicSupportLimit=rateLimit({windowMs:15*60_000,limit:8,standardHeaders:'draft-8',legacyHeaders:false});
const publicTicketSchema=z.object({context:z.enum(['help','contact']).default('help'),name:z.string().trim().min(2).max(120),email:z.string().trim().email().max(254),topic:z.string().trim().min(2).max(100),orderId:z.string().trim().max(100).optional().default(''),message:z.string().trim().min(10).max(2000)});
function publicCategory(topic){const v=String(topic||'').toLowerCase();if(v.includes('order'))return 'order';if(v.includes('return'))return 'return';if(v.includes('payment'))return 'payment';if(v.includes('seller'))return 'seller';if(v.includes('privacy')||v.includes('account'))return 'account';return 'other';}
function publicPriority(topic){const v=String(topic||'').toLowerCase();return v.includes('payment')||v.includes('return')?'high':'normal';}
const returnSchema=z.object({orderId:z.string().min(4).max(100),reason:z.enum(['damaged','wrong_item','not_as_described','counterfeit_suspected','missing_parts','changed_mind','other']),details:z.string().trim().min(10).max(2000),resolution:z.enum(['refund','exchange']),returnMethod:z.enum(['dropoff','pickup']).default('dropoff'),dropoffPointId:z.string().trim().max(100).optional().default(''),items:z.array(z.object({orderLineId:z.string().min(4).max(100),quantity:z.coerce.number().int().min(1).max(99)})).min(1).max(20)});
const disputeSchema=z.object({orderId:z.string().min(4).max(100),category:z.enum(['payment','delivery','item_missing','wrong_item','damaged','counterfeit','refund','seller_conduct','other']),subject:z.string().trim().min(4).max(180),description:z.string().trim().min(10).max(3000)});
const ticketSchema=z.object({orderId:z.string().trim().max(100).optional(),category:z.enum(['order','payment','delivery','return','refund','account','product','seller','other']),subject:z.string().trim().min(4).max(180),priority:z.enum(['low','normal','high','urgent']).default('normal'),message:z.string().trim().min(10).max(2000)});
const reviewSchema=z.object({orderId:z.string().trim().min(4).max(100).optional(),productId:z.string().min(4).max(100),rating:z.coerce.number().int().min(1).max(5),title:z.string().trim().max(140).optional(),body:z.string().trim().min(10).max(2500)});
const trustSchema=z.object({type:z.enum(['counterfeit','prohibited_product','unsafe_product','review_manipulation','seller_conduct']),productId:z.string().trim().max(100).optional(),storeId:z.string().trim().max(100).optional(),description:z.string().trim().min(10).max(2500)}).refine(v=>v.productId||v.storeId,{message:'A product or store is required.'});
function canSupportOperations(user){return hasPermission(user,'support:manage')||user?.role==='super_admin';}
function canTrustOperations(user){return hasPermission(user,'trust:manage')||hasPermission(user,'catalogue:moderate')||user?.role==='super_admin';}
function supportOnly(req,_res,next){if(canSupportOperations(req.user))return next();next(new AppError('Support permission required.',403,'FORBIDDEN'));}
function trustOnly(req,_res,next){if(canTrustOperations(req.user))return next();next(new AppError('Trust/moderation permission required.',403,'FORBIDDEN'));}
function financeOnly(req,_res,next){if(hasPermission(req.user,'finance:manage')||hasPermission(req.user,'finance:country')||req.user?.role==='super_admin')return next();next(new AppError('Finance permission required.',403,'FORBIDDEN'));}
function upload(middleware){return(req,res,next)=>middleware(req,res,error=>{if(error)return next(error);try{verifyDeferredCsrf(req);return next();}catch(csrfError){return next(csrfError);}});}
function escapeRegex(value){return String(value||'').replace(/[.*+?^${}()|[\]\\]/g,'\\$&');}
function supportSlaHours(priority){return priority==='urgent'?4:priority==='high'?12:48;}

router.post('/support/request', publicSupportLimit, async(req,res,next)=>{
  try{
    const raw=publicTicketSchema.parse(req.body);
    const ticket=await createPublicSupportTicket(req,{
      ...raw,
      category:publicCategory(raw.topic),
      priority:publicPriority(raw.topic),
      subject:`${raw.context === 'contact' ? 'Contact' : 'Help'}: ${raw.topic}`,
    });
    await sendSupportTicketEmail({email:raw.email,name:raw.name,ticketId:ticket.publicId,subject:'Classic Mart support request received',message:`We received your request about ${raw.topic}. Our support team will respond through the contact details you provided.`}).catch(error=>req.log?.warn?.({error:error.message,ticketId:ticket.publicId},'Support acknowledgement email failed'));
    setFlash(req,'success',`Support request ${ticket.publicId} received.`,'Your request is in the support queue and is covered by the applicable service-level target.');
    return res.redirect(raw.context === 'contact' ? '/contact' : '/help');
  }catch(error){return next(error);}
});


router.get('/account/returns',requireAuth,requireVerified,async(req,res,next)=>{try{
  const pageSize=25,base={userId:req.user._id};
  const fetchPage=async(Model,cursor,{populate=[]}={})=>{let q=Model.find(cursorScope(base,cursor)).sort(cursorSort()).limit(pageSize+1);for(const spec of populate)q=q.populate(...spec);const [rows,total]=await Promise.all([q.lean(),Model.countDocuments(base)]);return pageResult(rows,{limit:pageSize,total});};
  const [orderPage,returnPage,disputePage,ticketPage,casePage]=await Promise.all([
    fetchPage(Order,req.query.ordersAfter),
    fetchPage(ReturnRequest,req.query.returnsAfter,{populate:[['evidenceDocumentIds','publicId description']]}),
    fetchPage(Dispute,req.query.disputesAfter,{populate:[['evidenceDocumentIds','publicId description']]}),
    fetchPage(SupportTicket,req.query.ticketsAfter,{populate:[['evidenceDocumentIds','publicId description']]}),
    (async()=>{const caseBase={reporterUserId:req.user._id};let q=TrustCase.find(cursorScope(caseBase,req.query.casesAfter)).populate('evidenceDocumentIds','publicId description').sort(cursorSort()).limit(pageSize+1);const [rows,total]=await Promise.all([q.lean(),TrustCase.countDocuments(caseBase)]);return pageResult(rows,{limit:pageSize,total});})(),
  ]);
  const orders=orderPage.items,returns=returnPage.items.map(customerReturnDto),disputes=disputePage.items.map(customerDisputeDto),tickets=ticketPage.items.map(row=>({...supportTicketCustomerDto(row),evidenceDocumentIds:row.evidenceDocumentIds})),cases=casePage.items.map(row=>({...customerTrustCaseDto(row),evidenceDocumentIds:row.evidenceDocumentIds}));
  const surveys=tickets.length?await SatisfactionSurvey.find({userId:req.user._id,ticketPublicId:{$in:tickets.map(t=>t.publicId)}}).lean():[];
  const surveyByTicket=Object.fromEntries(surveys.map(row=>[row.ticketPublicId,row]));
  const returnableLines=[],reviewableLines=[];
  for(const order of orders){if(order.fulfillmentState!=='delivered')continue;for(const item of order.items||[]){const delivered=Number(item.deliveredQuantity||0),remaining=Math.max(0,delivered-Number(item.returnReservedQuantity||0)-Number(item.returnedQuantity||0));if(remaining>0)returnableLines.push({orderPublicId:order.publicId,orderLineId:item.linePublicId,productPublicId:item.productPublicId,title:item.title,variantTitle:item.variantTitle,sku:item.sku,remaining});if(delivered>0)reviewableLines.push({orderPublicId:order.publicId,productPublicId:item.productPublicId,title:item.title,variantTitle:item.variantTitle,sku:item.sku});}}
  const shipmentIds=returns.map(r=>r.returnShipmentPublicId).filter(Boolean),returnPickupCodes={};
  if(shipmentIds.length){const shipments=await Shipment.find({publicId:{$in:shipmentIds},kind:'return',status:{$in:['ready','offered','assigned']}}).select('+pickupCodeEncrypted publicId').lean();const byId=new Map(shipments.map(x=>[x.publicId,x]));for(const ret of returns){const shipment=byId.get(ret.returnShipmentPublicId);if(shipment?.pickupCodeEncrypted)returnPickupCodes[ret.publicId]={shipmentId:shipment.publicId,pickupCode:decryptSensitive(shipment.pickupCodeEncrypted)};}}
  const shell = primaryWorkspaceFor(req.user) !== 'customer' || req.session?.activeStorePublicId
    ? await accountWorkspaceView(req, 'returns')
    : { workspace: 'customer', initialPage: 'returns', allowedWorkspaces: ['customer'], ...await customerView(req, 'returns'), accountSupplement: 'returns' };
  res.set('Cache-Control','private, no-store').render('approved-dashboard', { ...shell,orders,returns,disputes,tickets,cases,surveys,surveyByTicket,returnPickupCodes,returnableLines,reviewableLines,queuePages:{orders:orderPage.page,returns:returnPage.page,disputes:disputePage.page,tickets:ticketPage.page,cases:casePage.page}});
}catch(e){next(e);}});

router.post('/api/v1/returns',requireAuth,requireVerified,async(req,res,next)=>{try{const result=await createReturnRequest(req,returnSchema.parse(req.body));res.status(201).json({...result,returnRequest:customerReturnDto(result.returnRequest)});}catch(e){next(e);}});

router.post('/account/returns',requireAuth,requireVerified,async(req,res,next)=>{try{const [orderId,orderLineId]=String(req.body.returnLine||'').split('::');const input=returnSchema.parse({orderId,reason:req.body.reason,details:req.body.details,resolution:req.body.resolution,returnMethod:req.body.returnMethod,dropoffPointId:req.body.dropoffPointId,items:[{orderLineId,quantity:req.body.quantity}]});await createReturnRequest(req,input);res.redirect(customerTrustReturn(req));}catch(e){next(e);}});

router.post('/account/returns/:id/evidence',requireAuth,requireVerified,upload(uploadVerificationImage),async(req,res,next)=>{try{const ret=await ReturnRequest.findOne({publicId:req.params.id,userId:req.user._id});if(!ret)throw new AppError('Return not found.',404,'RETURN_NOT_FOUND');const evidence=await sanitizeAndStoreEvidenceImage({file:req.file,user:req.user,country:ret.country,contextType:'return',contextPublicId:ret.publicId,description:req.body.description});await attachEvidence(ret,evidence);res.redirect(customerTrustReturn(req));}catch(e){next(e);}});

router.post('/account/evidence/:contextType/:id',requireAuth,requireVerified,upload(uploadVerificationImage),async(req,res,next)=>{try{const type=String(req.params.contextType||'');let doc=null,contextType='';if(type==='dispute'){doc=await Dispute.findOne({publicId:req.params.id,userId:req.user._id});contextType='dispute';}else if(type==='support'){doc=await SupportTicket.findOne({publicId:req.params.id,userId:req.user._id});contextType='support';}else if(type==='trust_case'){doc=await TrustCase.findOne({publicId:req.params.id,reporterUserId:req.user._id});contextType='trust_case';}else throw new AppError('Evidence context is invalid.',422,'EVIDENCE_CONTEXT_INVALID');if(!doc)throw new AppError('Case not found.',404,'CASE_NOT_FOUND');const evidence=await sanitizeAndStoreEvidenceImage({file:req.file,user:req.user,country:doc.country,contextType,contextPublicId:doc.publicId,description:req.body.description});await attachEvidence(doc,evidence);res.redirect(customerTrustReturn(req));}catch(e){next(e);}});

router.get('/api/v1/returns/:id/pickup-code',requireAuth,requireVerified,async(req,res,next)=>{try{const ret=await ReturnRequest.findOne({publicId:req.params.id,userId:req.user._id});if(!ret?.returnShipmentPublicId)throw new AppError('Return pickup is not active.',404,'RETURN_PICKUP_NOT_FOUND');const shipment=await Shipment.findOne({publicId:ret.returnShipmentPublicId,kind:'return'}).select('+pickupCodeEncrypted');if(!shipment)throw new AppError('Return pickup is not active.',404,'RETURN_PICKUP_NOT_FOUND');res.set('Cache-Control','private, no-store').json({pickupCode:decryptSensitive(shipment.pickupCodeEncrypted),shipmentId:shipment.publicId});}catch(e){next(e);}});


router.post('/account/disputes',requireAuth,requireVerified,async(req,res,next)=>{try{await createDispute(req,disputeSchema.parse(req.body));res.redirect(customerTrustReturn(req));}catch(e){next(e);}});

router.post('/account/disputes/:id/appeal',requireAuth,requireVerified,customerReplyLimit,async(req,res,next)=>{try{verifyDeferredCsrf(req);await appealOwnedDispute(req,req.params.id,req.body);res.redirect(303,customerTrustReturn(req));}catch(e){next(e);}});

router.post('/account/support',requireAuth,requireVerified,async(req,res,next)=>{try{await createTicket(req,ticketSchema.parse(req.body));res.redirect(customerTrustReturn(req));}catch(e){next(e);}});

for(const [path,operation,key] of [['support','customer','ticket'],['disputes','dispute','dispute']]){
  const reply=operation==='customer'?customerReplySupportTicket:replyToOwnedDispute;
  router.post('/account/'+path+'/:id/reply',requireAuth,requireVerified,customerReplyLimit,async(req,res,next)=>{try{verifyDeferredCsrf(req);await reply(req,req.params.id,req.body);setFlash(req,'success','Your reply has been saved.');res.redirect(303,customerTrustReturn(req));}catch(e){next(e);}});
  router.post('/api/v1/'+(path==='support'?'support/tickets':path)+'/:id/reply',requireAuth,requireVerified,customerReplyLimit,async(req,res,next)=>{try{verifyDeferredCsrf(req);res.set('Cache-Control','private, no-store').json({[key]:await reply(req,req.params.id,req.body)});}catch(e){next(e);}});
}
router.post('/api/v1/support/tickets/:id/reopen',requireAuth,requireVerified,customerReplyLimit,async(req,res,next)=>{try{verifyDeferredCsrf(req);res.set('Cache-Control','private, no-store').json({ticket:await customerReopenSupportTicket(req,req.params.id,req.body)});}catch(e){next(e);}});

router.post('/account/support/:id/csat',requireAuth,requireVerified,async(req,res,next)=>{try{const input=z.object({rating:z.coerce.number().int().min(1).max(5),comment:z.string().trim().max(1000).default('')}).parse(req.body);await submitSatisfaction(req,req.params.id,input);res.redirect(customerTrustReturn(req));}catch(e){next(e);}});

router.post('/account/support/:id/reopen',requireAuth,requireVerified,async(req,res,next)=>{try{verifyDeferredCsrf(req);await customerReopenSupportTicket(req,req.params.id,{...req.body,message:req.body.message||'Customer requested more help.'});setFlash(req,'success','Support ticket reopened.');res.redirect(customerTrustReturn(req));}catch(e){next(e);}});

router.post('/account/reviews',requireAuth,requireVerified,async(req,res,next)=>{try{const [orderId,productId]=String(req.body.reviewLine||'').split('::');await createVerifiedReview(req,reviewSchema.parse({orderId,productId,rating:req.body.rating,title:req.body.title,body:req.body.body}));res.redirect(customerTrustReturn(req));}catch(e){next(e);}});

router.post('/account/trust-report',requireAuth,requireVerified,async(req,res,next)=>{try{await reportTrustIssue(req,trustSchema.parse(req.body));res.redirect(customerTrustReturn(req));}catch(e){next(e);}});

router.post('/account/trust-cases/:id/reply',requireAuth,requireVerified,customerReplyLimit,async(req,res,next)=>{try{verifyDeferredCsrf(req);await customerReplyTrustCase(req,req.params.id,req.body);setFlash(req,'success','Your report reply has been saved.');res.redirect(303,customerTrustReturn(req));}catch(e){next(e);}});
for(const [path,operation] of [['reply',customerReplyTrustCase],['appeal',appealOwnedTrustCase]])router.post('/api/v1/trust/cases/:id/'+path,requireAuth,requireVerified,customerReplyLimit,async(req,res,next)=>{try{verifyDeferredCsrf(req);res.set('Cache-Control','private, no-store').json({case:customerTrustCaseDto(await operation(req,req.params.id,req.body))});}catch(e){next(e);}});
router.post('/account/trust-cases/:id/appeal',requireAuth,requireVerified,customerReplyLimit,async(req,res,next)=>{try{verifyDeferredCsrf(req);await appealOwnedTrustCase(req,req.params.id,req.body);setFlash(req,'success','Your report appeal has been saved for independent review.');res.redirect(303,customerTrustReturn(req));}catch(e){next(e);}});

router.post('/api/v1/disputes',requireAuth,requireVerified,async(req,res,next)=>{try{res.status(201).json({dispute:customerDisputeDto(await createDispute(req,disputeSchema.parse(req.body)))});}catch(e){next(e);}});

router.post('/api/v1/support/tickets',requireAuth,requireVerified,async(req,res,next)=>{try{res.status(201).json({ticket:supportTicketCustomerDto(await createTicket(req,ticketSchema.parse(req.body)))});}catch(e){next(e);}});

router.post('/api/v1/support/tickets/:id/csat',requireAuth,requireVerified,async(req,res,next)=>{try{const input=z.object({rating:z.coerce.number().int().min(1).max(5),comment:z.string().trim().max(1000).default('')}).parse(req.body);res.status(201).json({survey:customerSatisfactionDto(await submitSatisfaction(req,req.params.id,input))});}catch(e){next(e);}});

router.post('/api/v1/reviews',requireAuth,requireVerified,async(req,res,next)=>{try{res.status(201).json({review:customerReviewDto(await createVerifiedReview(req,reviewSchema.parse(req.body)))});}catch(e){next(e);}});

router.post('/api/v1/trust/reports',requireAuth,requireVerified,async(req,res,next)=>{try{res.status(201).json({case:customerTrustCaseDto(await reportTrustIssue(req,trustSchema.parse(req.body)))});}catch(e){next(e);}});


router.get('/evidence/:id',requireAuth,requireVerified,async(req,res,next)=>{try{
  const actor=await User.findById(req.user._id).select('+operationalCountries');
  if(!actor||actor.status!=='active'||actor.security.tokenVersion!==req.user.security.tokenVersion||actor.security.tokenVersion!==req.session.tokenVersion)throw new AppError('Your account or session is unavailable.',403,'ACCOUNT_UNAVAILABLE');
  await hydratePlatformAuthorization(actor);
  const currentRequest={...req,user:actor,session:req.session,query:{}};
  if(primaryWorkspaceFor(actor)==='support'){
    const evidence=await supportEvidenceRecord(currentRequest,req.params.id);
    return sendStoredMedia(res,evidence.storageKey,{cacheControl:'private, no-store',contentType:'image/webp',contentDisposition:'inline'});
  }
  if(primaryWorkspaceFor(actor)==='moderator'){
    const evidence=await authorizeModerationTrustEvidence(currentRequest,req.params.id);
    return sendStoredMedia(res,evidence.storageKey,{cacheControl:'private, no-store',contentType:'image/webp',contentDisposition:'inline',authorize:async()=>{
      const current=await recordModerationTrustEvidenceAccess(currentRequest,req.params.id,evidence.storageKey);
      if(current.storageKey!==evidence.storageKey)throw new AppError('Evidence access changed. Reload before continuing.',403,'EVIDENCE_ACCESS_CHANGED');
    }});
  }
  const evidence=await EvidenceDocument.findOne({publicId:req.params.id,status:'ready'}).select('+storageKey');
  if(!evidence)throw new AppError('Evidence not found.',404,'EVIDENCE_NOT_FOUND');
  const customerReceipt=evidence.documentType==='return_receipt'&&evidence.contextType==='return'&&await ReturnRequest.exists({publicId:evidence.contextPublicId,userId:actor._id,country:evidence.country,evidenceDocumentIds:evidence._id,'items.orderLineId':evidence.contextLinePublicId});
  if(evidence.documentType==='return_receipt'&&!customerReceipt&&String(evidence.ownerUserId)===String(actor._id)){
    const receipt=await warehouseReturnReceiptEvidenceRecord(currentRequest,evidence.publicId);
    return sendStoredMedia(res,receipt.storageKey,{cacheControl:'private, no-store',contentType:'image/webp',contentDisposition:'inline'});
  }
  let permitted=evidence.documentType==='return_receipt'?Boolean(customerReceipt):String(evidence.ownerUserId)===String(actor._id),staff=false;
  if(!permitted&&evidence.contextType==='return')permitted=Boolean(await ReturnRequest.exists({publicId:evidence.contextPublicId,userId:actor._id,country:evidence.country,evidenceDocumentIds:evidence._id,...(evidence.contextLinePublicId?{'items.orderLineId':evidence.contextLinePublicId}:{})}));
  if(!permitted&&['return','seller_return','dispute','support'].includes(evidence.contextType)&&canSupportOperations(actor)){
    await supportAccess(currentRequest,{workspace:false,country:evidence.country});
    const Model={return:ReturnRequest,seller_return:SellerReturnCase,dispute:Dispute,support:SupportTicket}[evidence.contextType];
    permitted=Boolean(await Model.exists({publicId:evidence.contextPublicId,country:evidence.country,evidenceDocumentIds:evidence._id}));staff=true;
  }
  if(!permitted&&['return','dispute'].includes(evidence.contextType)&&primaryWorkspaceFor(actor)==='finance'){
    await financeAccess(currentRequest,{country:evidence.country});
    const Model=evidence.contextType==='return'?ReturnRequest:Dispute;
    permitted=Boolean(await Model.exists({publicId:evidence.contextPublicId,country:evidence.country,evidenceDocumentIds:evidence._id}));staff=true;
  }
  if(!permitted&&evidence.contextType==='seller_return'){
    const sellerCase=await SellerReturnCase.findOne({publicId:evidence.contextPublicId,country:evidence.country,evidenceDocumentIds:evidence._id}).select('storeId').lean();
    if(sellerCase){const store=await Store.findById(sellerCase.storeId).select('ownerUserId').lean();permitted=String(store?.ownerUserId||'')===String(actor._id)||Boolean(await StoreMember.exists({storeId:sellerCase.storeId,userId:actor._id,status:'active',role:mongoose.trusted({$in:['owner','admin','support']})}));staff=permitted;}
  }
  if(!permitted&&((['delivery_verification','delivery_job'].includes(evidence.contextType)&&['country_admin','super_admin','finance'].includes(actor.role))||(evidence.contextType==='trust_case'&&canTrustOperations(actor)))){
    assertOperationalCountry(actor,evidence.country);
    permitted=Boolean(await CountrySetting.exists({code:evidence.country,active:true}));staff=permitted;
  }
  if(staff&&!env.auth.simpleLogin&&env.security.privilegedMfaRequired&&!actor.security.mfaEnabled)throw new AppError('Authenticator enrollment is required for private operational evidence.',403,'MFA_ENROLLMENT_REQUIRED');
  if(!permitted)throw new AppError('Evidence access denied.',403,'FORBIDDEN');
  const fresh=await User.findById(actor._id).select('status security.tokenVersion security.mfaEnabled').lean();
  if(fresh?.status!=='active'||fresh.security.tokenVersion!==actor.security.tokenVersion||staff&&!env.auth.simpleLogin&&env.security.privilegedMfaRequired&&!fresh.security.mfaEnabled)throw new AppError('Evidence access changed. Reload before continuing.',403,'ACCOUNT_UNAVAILABLE');
  await sendStoredMedia(res,evidence.storageKey,{cacheControl:'private, no-store',contentType:'image/webp',contentDisposition:'inline'});
}catch(e){next(e);}});

router.post('/api/v1/finance/returns/:id/refund',requireAuth,requireVerified,financeOnly,async(req,res,next)=>{try{
  verifyDeferredCsrf(req);
  const context=await financeAccess(req,{workspace:false,country:''}),ret=await ReturnRequest.findOne({publicId:req.params.id,...context.countryScope});
  if(!ret)throw new AppError('Return not found.',404,'RETURN_NOT_FOUND');
  const version=z.coerce.number().int().nonnegative().parse(req.body.version),order=await Order.findById(ret.orderId);
  const snapshot=await returnFinancialAllocations({returnRequest:ret,order,statuses:['refund_pending','refund_processing','refunded']});
  const refund=await createRefund(req,{orderId:ret.orderPublicId,amountMinor:snapshot.amountMinor,reason:'Approved return '+ret.publicId,idempotencyKey:'return-refund:'+ret.publicId,allocations:snapshot.allocations,returnPublicId:ret.publicId,returnVersion:version});
  const fresh=await ReturnRequest.findById(ret._id).select('publicId status refundPublicId __v').lean();
  res.set('Cache-Control','private, no-store').status(201).json({refund:{publicId:refund.publicId,status:refund.status,amountMinor:refund.amountMinor,currency:refund.currency,returnPublicId:refund.returnPublicId},returnRequest:{publicId:fresh.publicId,status:fresh.status,refundPublicId:fresh.refundPublicId,version:fresh.__v}});
}catch(e){next(e);}});

router.post('/api/v1/seller/reviews/:id/dispute',requireAuth,requireVerified,async(req,res,next)=>{try{const input=z.object({reason:z.string().trim().min(10).max(1000)}).parse(req.body);res.json({review:customerReviewDto(await disputeReview(req,req.params.id,input.reason))});}catch(e){next(e);}});

router.post('/api/v1/disputes/:id/appeal',requireAuth,requireVerified,customerReplyLimit,async(req,res,next)=>{try{verifyDeferredCsrf(req);res.set('Cache-Control','private, no-store').json({dispute:await appealOwnedDispute(req,req.params.id,req.body)});}catch(e){next(e);}});

router.get('/api/v1/support/knowledge',async(req,res,next)=>{try{const limit=Math.max(1,Math.min(100,Number(req.query.limit)||50)),base={country:req.country.code,status:'published'};const [rows,total]=await Promise.all([SupportKnowledge.find(cursorScope(base,req.query.after,{field:'publishedAt'})).select('publicId title slug body category publishedAt').sort(cursorSort('publishedAt')).limit(limit+1).lean(),SupportKnowledge.countDocuments(base)]);const page=pageResult(rows,{field:'publishedAt',limit,total});res.json({articles:page.items,page:page.page});}catch(e){next(e);}});

router.get('/api/v1/reviews/product/:productId',async(req,res,next)=>{try{const limit=Math.max(1,Math.min(100,Number(req.query.limit)||50)),base={productPublicId:req.params.productId,status:'published',country:req.country.code};const [rows,total]=await Promise.all([Review.find(cursorScope(base,req.query.after,{field:'publishedAt'})).select('publicId rating title body verifiedPurchase publishedAt createdAt').sort(cursorSort('publishedAt')).limit(limit+1).lean(),Review.countDocuments(base)]);const page=pageResult(rows,{field:'publishedAt',limit,total});res.set('Cache-Control','public, max-age=30').json({reviews:page.items,page:page.page});}catch(e){next(e);}});

export default router;
