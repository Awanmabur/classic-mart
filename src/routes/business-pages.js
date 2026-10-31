import { Router } from 'express';
import multer from 'multer';
import { once } from 'node:events';
import rateLimit from '../middleware/rate-limit.js';
import { AppError,asyncHandler } from '../core/errors.js';
import { verifyDeferredCsrf } from '../middleware/csrf.js';
import { setFlash } from '../middleware/view.js';
import { businessPageGates,renderBusinessPage } from '../dashboard/business-page-view.js';
import { BUSINESS_LIVE_ROUTES,BUSINESS_LEGACY_ROUTES } from '../dashboard/business-routes.js';
import { BusinessInvoice } from '../models/index.js';
import { businessAccess,assertBusinessReadAccess,businessTransaction } from '../services/business-access.js';
import { loadBusinessPage,businessFinancialDocument,businessDocumentAccess } from '../services/business-workspace-pages.js';
import { createBusinessOrganization,saveBusinessProfile,inviteBusinessMember,acceptBusinessInvitation,changeBusinessMember,createBusinessBudget,submitBusinessProcurement,decideBusinessProcurement,cancelBusinessProcurement,requestBusinessQuotation,replyBusinessQuotation,acceptBusinessQuotation,saveBusinessTemplate,actBusinessTemplate,requestBusinessCreditTerms,parseProcurementCsv } from '../services/business-operations.js';
import { renderBusinessDocumentPdf } from '../services/business-documents.js';
import { startBusinessInvoicePayment } from '../services/business-payments.js';
import { writeAudit } from '../services/audit.js';

const router=Router();
const mutateLimiter=rateLimit({scope:'business-actions:1',windowMs:15*60_000,limit:90,standardHeaders:'draft-8',legacyHeaders:false});
router.use('/business',...businessPageGates());
function body(request){const{_csrf,...data}=request.body||{};return data;}
function itemsBody(request){const data=body(request);if(!data.items&&data.variantPublicId){const{variantPublicId,quantity,note,...rest}=data;return{...rest,items:[{variantPublicId,quantity,note:note||''}]};}return data;}
function done(request,response,result,path,message='Business changes saved.'){if(request.accepts(['html','json'])==='json')return response.json(result);setFlash(request,'success',message);return response.redirect(303,path);}
for(const[pageId,path]of Object.entries(BUSINESS_LIVE_ROUTES))router.get(path,asyncHandler(async(request,response)=>renderBusinessPage(request,response,pageId,await loadBusinessPage(request,pageId.slice(9)))));
for(const[pageId,path]of Object.entries(BUSINESS_LEGACY_ROUTES))router.get('/dashboard/'+pageId,...businessPageGates(),asyncHandler(async(request,response)=>{await businessAccess(request,{allowEmpty:true});return response.redirect(308,path+new URL(request.originalUrl,'http://localhost').search);}));
router.get('/business',asyncHandler(async(request,response)=>{await businessAccess(request,{allowEmpty:true});return response.redirect(308,'/business/overview'+new URL(request.originalUrl,'http://localhost').search);}));
for(const[old,path]of [['suppliers','quotes'],['payments','invoices'],['reports','invoices']])router.get('/business/'+old,asyncHandler(async(request,response)=>{await businessAccess(request);return response.redirect(308,'/business/'+path+new URL(request.originalUrl,'http://localhost').search);}));
router.post('/business/workspace',mutateLimiter,asyncHandler(async(request,response)=>{verifyDeferredCsrf(request);const data=body(request);if(typeof data.organizationPublicId!=='string')throw new AppError('Select a valid company.',422,'BUSINESS_ORGANIZATION_INVALID');const access=await businessAccess(request,{organizationPublicId:data.organizationPublicId});request.session.activeBusinessPublicId=access.org.publicId;return done(request,response,{publicId:access.org.publicId},'/business/overview');}));
const actions=[
  ['/business/organizations',createBusinessOrganization,'/business/overview'],
  ['/business/profile',saveBusinessProfile,'/business/settings'],
  ['/business/members',inviteBusinessMember,'/business/settings'],
  ['/business/budgets',createBusinessBudget,'/business/settings'],
  ['/business/credit-terms',requestBusinessCreditTerms,'/business/settings'],
  ['/business/requests',submitBusinessProcurement,'/business/orders',true],
  ['/business/quotes',requestBusinessQuotation,'/business/quotes'],
  ['/business/templates',saveBusinessTemplate,'/business/templates',true],
];
for(const[path,operation,redirect,items]of actions)router.post(path,mutateLimiter,asyncHandler(async(request,response)=>{verifyDeferredCsrf(request);const result=await operation(request,items?itemsBody(request):body(request));if(path==='/business/organizations')request.session.activeBusinessPublicId=result.publicId;return done(request,response,result,redirect);}));
for(const[path,operation,redirect]of [
  ['/business/invitations/:id/accept',acceptBusinessInvitation,'/business/overview'],
  ['/business/members/:id',changeBusinessMember,'/business/settings'],
  ['/business/requests/:id/decision',decideBusinessProcurement,'/business/orders'],
  ['/business/requests/:id/cancel',cancelBusinessProcurement,'/business/orders'],
  ['/business/quotes/:id/reply',replyBusinessQuotation,'/business/quotes'],
  ['/business/quotes/:id/accept',acceptBusinessQuotation,'/business/orders'],
  ['/business/templates/:id/actions',actBusinessTemplate,'/business/templates'],
])router.post(path,mutateLimiter,asyncHandler(async(request,response)=>{verifyDeferredCsrf(request);const result=await operation(request,request.params.id,body(request));return done(request,response,result,redirect);}));
router.post('/business/invoices/:id/pay',mutateLimiter,asyncHandler(async(request,response)=>{verifyDeferredCsrf(request);const result=await startBusinessInvoicePayment(request,request.params.id,body(request));if(request.accepts(['html','json'])==='json')return response.json(result);if(result.checkoutUrl)return response.redirect(303,result.checkoutUrl);return response.redirect(303,'/business/invoices');}));
const csvUpload=multer({storage:multer.memoryStorage(),limits:{fileSize:500_000,files:1,fields:8},fileFilter(_request,file,next){if(!file.originalname.toLowerCase().endsWith('.csv'))return next(new AppError('Upload the procurement CSV template.',422,'BUSINESS_CSV_INVALID'));return next(null,true);}}).single('csv');
router.get('/business/requests/import/template.csv',asyncHandler(async(request,response)=>{await businessAccess(request,{capability:'buy'});response.attachment('classic-mart-procurement-template.csv');return response.type('text/csv').send('variantPublicId,quantity,note\r\n');}));
router.post('/business/requests/import',mutateLimiter,csvUpload,asyncHandler(async(request,response)=>{verifyDeferredCsrf(request);const data=body(request);const result=await submitBusinessProcurement(request,{...data,items:parseProcurementCsv(request.file?.buffer.toString('utf8')||'')});return done(request,response,result,'/business/orders');}));
router.get('/business/documents/:id',asyncHandler(async(request,response)=>{const document=await businessDocumentAccess(request,request.params.id);return response.render('business-document',{document});}));
router.get('/business/documents/:id/pdf',asyncHandler(async(request,response)=>{const document=await businessDocumentAccess(request,request.params.id);response.attachment(`${document.documentNumber.replace(/[^A-Za-z0-9_-]/g,'-')}.pdf`);return response.type('application/pdf').send(renderBusinessDocumentPdf(document));}));
router.get('/business/financial-documents/:id',asyncHandler(async(request,response)=>{const document=await businessFinancialDocument(request,request.params.id);if(request.accepts(['html','json'])==='json')return response.json(document);return response.render('financial-document',{document});}));
const csvCell=value=>{let text=String(value??'');if(/^[\s\u0000-\u001f]*[=+@-]/u.test(text))text="'"+text;return'"'+text.replaceAll('"','""')+'"';};
router.get('/business/statement.csv',asyncHandler(async(request,response)=>{
  const context=await businessAccess(request);await businessTransaction(request,null,async(access,session)=>writeAudit(request,'business.statement.exported',{actor:access.actor,targetType:'business_organization',targetPublicId:access.org.publicId,country:access.org.country,session}));
  response.attachment('classic-mart-business-statement.csv');response.type('text/csv; charset=utf-8');
  const write=async row=>{if(response.destroyed)throw new AppError('Export connection closed.',499,'EXPORT_CLOSED');if(!response.write(row.map(csvCell).join(',')+'\r\n'))await Promise.race([once(response,'drain'),once(response,'close').then(()=>{throw new AppError('Export connection closed.',499,'EXPORT_CLOSED');})]);};
  await write(['Invoice','Issued','Currency','Total','Paid','Outstanding','Status','Due']);
  const cursor=BusinessInvoice.find({organizationId:context.org._id,country:context.org.country,currency:context.org.currency}).sort({createdAt:1,_id:1}).select('invoiceNumber issuedAt currency totalMinor paidMinor status dueAt').lean().cursor();
  try{for await(const row of cursor){await assertBusinessReadAccess(request,context);await write([row.invoiceNumber,row.issuedAt?.toISOString(),row.currency,row.totalMinor,row.paidMinor,Math.max(0,row.totalMinor-row.paidMinor),row.status,row.dueAt?.toISOString()]);}await assertBusinessReadAccess(request,context);return response.end();}finally{await cursor.close();}
}));
export default router;
