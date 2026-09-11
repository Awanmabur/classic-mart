import { Router } from 'express';
import mongoose from 'mongoose';
import rateLimit from 'express-rate-limit';
import { asyncHandler, AppError } from '../core/errors.js';
import { decryptSensitive } from '../core/sensitive.js';
import { publicId, slugify } from '../core/ids.js';
import { hasPermission } from '../core/roles.js';
import {
  Brand,
  Category,
  Product,
  ProductMedia,
  ProductVariant,
  ModerationQaReview,
  SellerVerification,
  Store,
  VerificationDocument,
} from '../models/index.js';
import {
  requireAuth,
  requireOnboarding,
  requirePermission,
  requireVerified,
} from '../middleware/auth.js';
import { noStore } from '../middleware/request.js';
import { setFlash } from '../middleware/view.js';
import { writeAudit } from '../services/audit.js';
import { formatMinorUnits } from '../services/catalogue.js';
import { parseCategoryAttributes } from '../services/catalogue.js';
import { getCountries } from '../services/country.js';
import { addOutboxEvent } from '../services/outbox.js';
import { assertOperationalCountry, operationalCountriesFor, operationalCountryScope } from '../services/authorization.js';
import { cursorScope, cursorSort, pageResult } from '../services/pagination.js';
import {
  brandDecisionSchema,
  categorySchema,
  moderationDecisionSchema,
  verificationDecisionSchema,
} from '../validation/catalogue.js';

const router = Router();
const decisionLimiter = rateLimit({
  windowMs: 15 * 60_000,
  limit: 100,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
});

router.use(
  '/moderation',
  noStore,
  requireAuth,
  requireVerified,
  requireOnboarding,
  requirePermission('catalogue:moderate'),
);

function countryScope(request, productField = 'countries') { return operationalCountryScope(request.user,productField); }
function storeCountryScope(request) { return operationalCountryScope(request.user,'country'); }
function moderationSupervisor(user){return ['country_admin','super_admin'].includes(user?.role);}
function assignedToActor(value,userId){return Boolean(value)&&String(value)===String(userId);}
function escapeRegex(value){return String(value).replace(/[.*+?^${}()|[\]\\]/g,'\\$&');}

const MODERATION_REASON_TEMPLATES=[
  {id:'missing_details',targetType:'product',label:'Missing or unclear product details',text:'Provide complete, accurate product details and remove ambiguous or unsupported claims.'},
  {id:'media_quality',targetType:'product',label:'Media quality or mismatch',text:'Replace the product media with clear images that accurately represent the item being sold.'},
  {id:'restricted_evidence',targetType:'product',label:'Restricted category evidence required',text:'Additional policy or compliance evidence is required before this restricted listing can be approved.'},
  {id:'verification_mismatch',targetType:'verification',label:'Seller verification mismatch',text:'The submitted seller details do not match the verification evidence. Correct the mismatch and resubmit.'},
  {id:'verification_evidence',targetType:'verification',label:'Verification evidence incomplete',text:'Provide complete and current verification evidence that supports the submitted seller identity and business details.'},
];
function moderationReason(body,targetType){
  const typed=String(body?.reason||'').trim();
  if(typed)return typed;
  return MODERATION_REASON_TEMPLATES.find(item=>item.targetType===targetType&&item.id===String(body?.reasonTemplate||''))?.text||'';
}
function shouldQaSample(targetPublicId,highRisk=false){if(highRisk)return true;return [...String(targetPublicId||'')].reduce((sum,char)=>(sum+char.charCodeAt(0))%10,0)===0;}
async function queueQaSample({session,targetType,target,country,decision,reason,reviewerUserId,highRisk=false}){
  if(!shouldQaSample(target.publicId,highRisk))return null;
  const existing=await ModerationQaReview.findOne({targetType,targetPublicId:target.publicId,decision,originalReviewerUserId:reviewerUserId}).session(session);if(existing)return existing;
  const [sample]=await ModerationQaReview.create([{publicId:publicId('mqa'),targetType,targetObjectId:target._id,targetPublicId:target.publicId,country,riskLevel:highRisk?'high':'standard',decision,decisionReason:reason,originalReviewerUserId:reviewerUserId,sampledAt:new Date(),status:'pending'}],{session});return sample;
}

function renderModeration(request, response, view) {
  return response.render('moderation-workspace', {
    view,
    moderationReasonTemplates: MODERATION_REASON_TEMPLATES.filter(item => view.section === 'verification-detail' ? item.targetType === 'verification' : item.targetType === 'product'),
    formatMoney: (amount, currency) =>
      formatMinorUnits(amount, currency, request.user.locale),
  });
}

router.get('/moderation', (_request, response) =>
  response.redirect('/moderation/products'),
);

router.get(
  '/moderation/products',
  asyncHandler(async (request, response) => {
    const status = ['submitted', 'approved', 'changes_requested'].includes(
      request.query.status,
    )
      ? request.query.status
      : 'submitted';
    const pageSize=50,field='moderation.submittedAt';
    const filters={search:String(request.query.search||'').trim().slice(0,80),assignment:String(request.query.assignment||''),risk:String(request.query.risk||''),escalated:String(request.query.escalated||'')==='1',secondReview:String(request.query.secondReview||'')==='1'};
    const clauses=[{status,...countryScope(request)}];
    if(filters.assignment==='mine')clauses.push({'moderation.assignedUserId':request.user._id});else if(filters.assignment==='unassigned')clauses.push({$or:[{'moderation.assignedUserId':null},{'moderation.assignedUserId':{$exists:false}}]});
    if(filters.escalated)clauses.push({'moderation.escalatedAt':{$ne:null}});if(filters.secondReview)clauses.push({'moderation.secondReviewRequired':true});
    if(filters.risk==='restricted'){const restrictedCategoryIds=await Category.find({restricted:true}).distinct('_id');clauses.push({categoryId:{$in:restrictedCategoryIds}});}
    if(filters.search){const pattern=new RegExp(escapeRegex(filters.search),'i');clauses.push({$or:[{publicId:pattern},{title:pattern}]});}
    const baseScope=clauses.length===1?clauses[0]:{$and:clauses};
    const [rows,total]=await Promise.all([
      Product.find(cursorScope(baseScope,request.query.after,{field,direction:1}))
        .populate('storeId','name publicId country status')
        .populate('categoryId','name restricted')
        .populate('moderation.assignedUserId','name publicId role')
        .sort(cursorSort(field,1)).limit(pageSize+1).lean(),
      Product.countDocuments(baseScope),
    ]);
    const page=pageResult(rows,{field,direction:1,limit:pageSize,total});
    return renderModeration(request, response, {
      section: 'products',
      products:page.items,
      status,
      queuePage:page.page,
      filters,
    });
  }),
);

router.get(
  '/moderation/products/:publicId',
  asyncHandler(async (request, response) => {
    const product = await Product.findOne({
      publicId: request.params.publicId,
      ...countryScope(request),
    })
      .populate('storeId', 'name publicId country status')
      .populate('categoryId', 'name restricted attributes')
      .populate('brandId', 'name')
      .populate('moderation.assignedUserId','name publicId role')
      .populate('moderation.firstApprovalByUserId','name publicId role')
      .populate('moderation.reviewHistory.actorUserId','name publicId role')
      .lean();
    if (!product) {
      throw new AppError('Product not found.', 404, 'PRODUCT_NOT_FOUND');
    }
    const [variants, media] = await Promise.all([
      ProductVariant.find({ productId: product._id }).sort({ createdAt: 1 }).lean(),
      ProductMedia.find({ productId: product._id })
        .sort({ position: 1 })
        .lean(),
    ]);
    return renderModeration(request, response, {
      section: 'product-detail',
      product,
      variants,
      media,
    });
  }),
);

router.post(
  '/moderation/products/:publicId/claim',
  decisionLimiter,
  asyncHandler(async (request, response) => {
    const now=new Date();
    const product=await Product.findOneAndUpdate(
      {publicId:request.params.publicId,status:'submitted',...countryScope(request),'moderation.firstApprovalByUserId':{$ne:request.user._id},$or:[{'moderation.assignedUserId':null},{'moderation.assignedUserId':{$exists:false}},{'moderation.assignedUserId':request.user._id}]},
      {$set:{'moderation.assignedUserId':request.user._id,'moderation.assignedAt':now},$push:{'moderation.reviewHistory':{action:'claim',actorUserId:request.user._id,at:now}}},
      {returnDocument:'after'},
    );
    if(!product){const existing=await Product.findOne({publicId:request.params.publicId,status:'submitted',...countryScope(request)}).select('moderation.firstApprovalByUserId moderation.assignedUserId').lean();if(!existing)throw new AppError('Submitted product not found.',404,'PRODUCT_NOT_FOUND');if(assignedToActor(existing.moderation?.firstApprovalByUserId,request.user._id))throw new AppError('A different moderator must claim the restricted-category second review.',409,'MODERATION_FOUR_EYES');throw new AppError('This product is already claimed by another moderator.',409,'MODERATION_ALREADY_CLAIMED');}
    await writeAudit(request,'catalogue.product_moderation_claimed',{targetType:'product',targetPublicId:product.publicId});
    return response.redirect(`/moderation/products/${encodeURIComponent(product.publicId)}`);
  }),
);

router.post(
  '/moderation/products/:publicId/release',
  decisionLimiter,
  asyncHandler(async (request, response) => {
    const query={publicId:request.params.publicId,status:'submitted',...countryScope(request)};
    if(!moderationSupervisor(request.user))query['moderation.assignedUserId']=request.user._id;
    const now=new Date();
    const product=await Product.findOneAndUpdate(query,{$set:{'moderation.assignedUserId':null,'moderation.assignedAt':null},$push:{'moderation.reviewHistory':{action:'release',actorUserId:request.user._id,at:now}}},{returnDocument:'after'});
    if(!product)throw new AppError('Only the assigned moderator or a supervisor can release this product.',409,'MODERATION_RELEASE_FORBIDDEN');
    await writeAudit(request,'catalogue.product_moderation_released',{targetType:'product',targetPublicId:product.publicId});
    return response.redirect('/moderation/products');
  }),
);

router.post(
  '/moderation/products/:publicId/escalate',
  decisionLimiter,
  asyncHandler(async (request, response) => {
    const reason=String(request.body.reason||'').trim();if(reason.length<10||reason.length>1000)throw new AppError('Give an escalation reason between 10 and 1000 characters.',422,'MODERATION_ESCALATION_REASON');
    const now=new Date();
    const product=await Product.findOneAndUpdate({publicId:request.params.publicId,status:'submitted',...countryScope(request),'moderation.assignedUserId':request.user._id},{$set:{'moderation.escalatedAt':now,'moderation.escalationReason':reason},$push:{'moderation.reviewHistory':{action:'escalate',actorUserId:request.user._id,reason,at:now}}},{returnDocument:'after'});
    if(!product)throw new AppError('Claim the product before escalating it.',409,'MODERATION_CLAIM_REQUIRED');
    await writeAudit(request,'catalogue.product_moderation_escalated',{targetType:'product',targetPublicId:product.publicId,metadata:{reason}});
    setFlash(request,'success','Product moderation escalated for supervisor attention.');
    return response.redirect(`/moderation/products/${encodeURIComponent(product.publicId)}`);
  }),
);

router.post(
  '/moderation/products/:publicId/decision',
  decisionLimiter,
  asyncHandler(async (request, response) => {
    const input = moderationDecisionSchema.parse({...request.body,reason:moderationReason(request.body,'product')});
    const product = await Product.findOne({
      publicId: request.params.publicId,
      status: 'submitted',
      ...countryScope(request),
    });
    if (!product) throw new AppError('Submitted product not found.',404,'PRODUCT_NOT_FOUND');
    if(!assignedToActor(product.moderation?.assignedUserId,request.user._id))throw new AppError('Claim the product before recording a moderation decision.',409,'MODERATION_CLAIM_REQUIRED');
    const [store,category,variantCount,readyMediaCount]=await Promise.all([
      Store.findById(product.storeId),
      Category.findById(product.categoryId).select('restricted').lean(),
      ProductVariant.countDocuments({productId:product._id,active:true}),
      ProductMedia.countDocuments({productId:product._id,status:'ready'}),
    ]);
    if(input.decision==='approve'&&(store?.status!=='verified'||!variantCount||!readyMediaCount))throw new AppError('Approval requires a verified store, active variant and valid media.',409,'PRODUCT_INCOMPLETE');
    const restricted=Boolean(category?.restricted);let outcome='final';
    const session=await mongoose.startSession();
    try{
      await session.withTransaction(async()=>{
        const fresh=await Product.findOne({_id:product._id,status:'submitted','moderation.assignedUserId':request.user._id}).session(session);
        if(!fresh)throw new AppError('The product assignment or review state changed. Reopen the queue and claim it again.',409,'PRODUCT_STATE_CHANGED');
        const now=new Date();
        if(input.decision==='approve'&&restricted&&!fresh.moderation.firstApprovalByUserId){
          fresh.moderation.firstApprovalByUserId=request.user._id;fresh.moderation.firstApprovalAt=now;fresh.moderation.firstApprovalReason=input.reason;fresh.moderation.secondReviewRequired=true;fresh.moderation.assignedUserId=null;fresh.moderation.assignedAt=undefined;fresh.moderation.reviewHistory.push({action:'first_approval',actorUserId:request.user._id,reason:input.reason,at:now});
          await fresh.save({session});
          await addOutboxEvent({type:'catalogue.product_second_review_required',aggregateType:'product',aggregatePublicId:fresh.publicId,payload:{reason:input.reason}},session);
          await writeAudit(request,'catalogue.product_first_approval_recorded',{session,targetType:'product',targetPublicId:fresh.publicId,country:store.country,metadata:{reason:input.reason,restricted:true,secondReviewRequired:true}});
          outcome='second_review_required';product.status='submitted';return;
        }
        if(input.decision==='approve'&&restricted&&assignedToActor(fresh.moderation.firstApprovalByUserId,request.user._id))throw new AppError('Restricted-category approval requires a different second reviewer.',409,'MODERATION_FOUR_EYES');
        fresh.status=input.decision==='approve'?'approved':input.decision==='reject'?'rejected':'changes_requested';
        fresh.moderation.reviewedAt=now;fresh.moderation.reviewedByUserId=request.user._id;fresh.moderation.reason=input.reason;fresh.moderation.secondReviewRequired=false;fresh.moderation.assignedUserId=null;fresh.moderation.assignedAt=undefined;fresh.moderation.reviewHistory.push({action:input.decision,actorUserId:request.user._id,reason:input.reason,at:now});
        await fresh.save({session});
        if(input.decision==='approve')await ProductMedia.updateMany({productId:fresh._id,status:'ready'},{$set:{status:'approved',reviewedAt:now,reviewedByUserId:request.user._id}},{session});
        await addOutboxEvent({type:input.decision==='approve'?'catalogue.product_approved':input.decision==='reject'?'catalogue.product_rejected':'catalogue.product_changes_requested',aggregateType:'product',aggregatePublicId:fresh.publicId,payload:{reason:input.reason}},session);
        await queueQaSample({session,targetType:'product',target:fresh,country:store.country,decision:fresh.status,reason:input.reason,reviewerUserId:request.user._id,highRisk:restricted});
        await writeAudit(request,`catalogue.product_${fresh.status}`,{session,targetType:'product',targetPublicId:fresh.publicId,country:store.country,metadata:{reason:input.reason,restricted,secondReviewRequired:false}});
        product.status=fresh.status;
      });
    }finally{await session.endSession();}
    setFlash(request,'success',outcome==='second_review_required'?'First approval recorded. A different moderator must complete the restricted-category second review.':input.decision==='approve'?'Product approved. The seller can now publish it.':input.decision==='reject'?'Product rejected.':'Changes requested from the seller.');
    return response.redirect('/moderation/products');
  }),
);

router.get(
  '/moderation/verifications',
  asyncHandler(async (request, response) => {
    const storeIds=await Store.find(storeCountryScope(request)).distinct('_id');
    const pageSize=50,field='submittedAt',filters={status:String(request.query.status||''),search:String(request.query.search||'').trim().slice(0,80),assignment:String(request.query.assignment||''),risk:String(request.query.risk||''),escalated:String(request.query.escalated||'')==='1'};
    const statuses=['submitted','appealed','approved','rejected'];const clauses=[{storeId:{$in:storeIds},status:statuses.includes(filters.status)?filters.status:{$in:statuses}}];
    if(filters.assignment==='mine')clauses.push({assignedUserId:request.user._id});else if(filters.assignment==='unassigned')clauses.push({$or:[{assignedUserId:null},{assignedUserId:{$exists:false}}]});
    if(filters.risk==='business')clauses.push({sellerType:'business'});if(filters.escalated)clauses.push({escalatedAt:{$ne:null}});if(filters.search){const pattern=new RegExp(escapeRegex(filters.search),'i');clauses.push({$or:[{publicId:pattern},{legalName:pattern}]});}
    const baseScope=clauses.length===1?clauses[0]:{$and:clauses};
    const [rows,total]=await Promise.all([
      SellerVerification.find(cursorScope(baseScope,request.query.after,{field,direction:1}))
        .populate('storeId','name publicId country status')
        .populate('userId','name email publicId')
        .populate('assignedUserId','name publicId role')
        .sort(cursorSort(field,1)).limit(pageSize+1).lean(),
      SellerVerification.countDocuments(baseScope),
    ]);
    const page=pageResult(rows,{field,direction:1,limit:pageSize,total});
    return renderModeration(request, response, {
      section: 'verifications',
      verifications:page.items,
      queuePage:page.page,
      filters,
    });
  }),
);

router.get(
  '/moderation/catalogue',
  asyncHandler(async (request, response) => {
    const adminScopes = operationalCountriesFor(request.user);
    const isGlobal = adminScopes.includes('*');
    const stores = isGlobal
      ? []
      : await Store.find({ country: { $in: adminScopes } }).select('_id').lean();
    const [categories, brands, countries] = await Promise.all([
      Category.find(
        isGlobal
          ? {}
          : {
              $or: [
                { countries: { $in: adminScopes } },
                { countries: { $size: 0 } },
              ],
            },
      )
        .sort({ name: 1 })
        .lean(),
      Brand.find({
        status: 'pending',
        ...(!isGlobal
          ? { requestedByStoreId: { $in: stores.map((store) => store._id) } }
          : {}),
      })
        .populate('requestedByStoreId', 'name country')
        .sort({ createdAt: 1 })
        .lean(),
      getCountries(),
    ]);
    return renderModeration(request, response, {
      section: 'catalogue-settings',
      categories,
      brands,
      countries,
      canManageCategories: hasPermission(request.user, 'country:manage'),
    });
  }),
);

router.post(
  '/moderation/catalogue/categories',
  decisionLimiter,
  asyncHandler(async (request, response) => {
    if (!hasPermission(request.user, 'country:manage')) {
      throw new AppError(
        'Category management requires country administration permission.',
        403,
        'FORBIDDEN',
      );
    }
    const input = categorySchema.parse(request.body);
    const available = new Set((await getCountries()).map((item) => item.code));
    if (input.countries.some((code) => !available.has(code))) {
      throw new AppError(
        'One or more category countries are unavailable.',
        422,
        'COUNTRY_UNAVAILABLE',
      );
    }
    const grants = operationalCountriesFor(request.user);
    const scopedCountries = grants.includes('*')
      ? input.countries
      : input.countries.filter((code) => grants.includes(code));
    if (!scopedCountries.length) {
      throw new AppError('Choose at least one country within your operational scope.',403,'COUNTRY_SCOPE');
    }
    const category = await Category.create({
      publicId: publicId('cat'),
      name: input.name,
      slug: slugify(input.name),
      description: input.description,
      active: true,
      restricted: input.restricted === 'yes',
      countries: scopedCountries,
      attributes: parseCategoryAttributes(input.attributes),
      createdByUserId: request.user._id,
    });
    await writeAudit(request, 'catalogue.category_created', {
      targetType: 'category',
      targetPublicId: category.publicId,
      metadata: { countries: scopedCountries },
    });
    setFlash(request, 'success', 'Category created from database settings.');
    return response.redirect('/moderation/catalogue');
  }),
);

router.post(
  '/moderation/catalogue/categories/:publicId/toggle',
  decisionLimiter,
  asyncHandler(async (request, response) => {
    if (!hasPermission(request.user, 'country:manage')) {
      throw new AppError(
        'Category management requires country administration permission.',
        403,
        'FORBIDDEN',
      );
    }
    const query = { publicId: request.params.publicId };
    const grants = operationalCountriesFor(request.user);
    if (!grants.includes('*')) {
      query.countries = { $in: grants };
    }
    const category = await Category.findOne(query);
    if (!category) {
      throw new AppError('Category not found.', 404, 'CATEGORY_NOT_FOUND');
    }
    category.active = !category.active;
    await category.save();
    await writeAudit(request, 'catalogue.category_status_changed', {
      targetType: 'category',
      targetPublicId: category.publicId,
      metadata: { active: category.active },
    });
    setFlash(
      request,
      'success',
      `Category ${category.active ? 'activated' : 'deactivated'}.`,
    );
    return response.redirect('/moderation/catalogue');
  }),
);

router.post(
  '/moderation/catalogue/brands/:publicId/decision',
  decisionLimiter,
  asyncHandler(async (request, response) => {
    const input = brandDecisionSchema.parse(request.body);
    const brand = await Brand.findOne({
      publicId: request.params.publicId,
      status: 'pending',
    });
    if (!brand) throw new AppError('Brand not found.', 404, 'BRAND_NOT_FOUND');
    if (request.user.role !== 'super_admin') {
      const store = await Store.findById(brand.requestedByStoreId).select('country').lean();
      if (!store) throw new AppError('Brand not found.',404,'BRAND_NOT_FOUND');
      assertOperationalCountry(request.user,store.country,'Brand not found.');
    }
    brand.status = input.decision === 'approve' ? 'approved' : 'rejected';
    brand.reviewedByUserId = request.user._id;
    await brand.save();
    await writeAudit(request, `catalogue.brand_${brand.status}`, {
      targetType: 'brand',
      targetPublicId: brand.publicId,
    });
    setFlash(request, 'success', `Brand ${brand.status}.`);
    return response.redirect('/moderation/catalogue');
  }),
);

router.get(
  '/moderation/verifications/:publicId',
  asyncHandler(async (request, response) => {
    const verification = await SellerVerification.findOne({
      publicId: request.params.publicId,
    })
      .select('+registrationNumber +taxNumber')
      .populate('storeId', 'name publicId country status')
      .populate('userId', 'name email phone publicId')
      .populate('assignedUserId','name publicId role')
      .populate('reviewHistory.actorUserId','name publicId role')
      .lean();
    if (!verification) {
      throw new AppError(
        'Verification not found.',
        404,
        'VERIFICATION_NOT_FOUND',
      );
    }
    if (request.user.role !== 'super_admin') {
      assertOperationalCountry(request.user,verification.storeId?.country,'Verification not found.');
    }
    const documents = await VerificationDocument.find({
      verificationId: verification._id,
    })
      .sort({ createdAt: -1 })
      .lean();
    verification.registrationNumber = decryptSensitive(
      verification.registrationNumber,
    );
    verification.taxNumber = decryptSensitive(verification.taxNumber);
    return renderModeration(request, response, {
      section: 'verification-detail',
      verification,
      documents,
    });
  }),
);

router.post(
  '/moderation/verifications/:publicId/claim',
  decisionLimiter,
  asyncHandler(async (request,response)=>{
    const storeIds=await Store.find(storeCountryScope(request)).distinct('_id');const now=new Date();
    const verification=await SellerVerification.findOneAndUpdate({publicId:request.params.publicId,storeId:{$in:storeIds},status:{$in:['submitted','appealed']},$or:[{assignedUserId:null},{assignedUserId:{$exists:false}},{assignedUserId:request.user._id}]},{$set:{assignedUserId:request.user._id,assignedAt:now},$push:{reviewHistory:{action:'claim',actorUserId:request.user._id,at:now}}},{returnDocument:'after'});
    if(!verification){const exists=await SellerVerification.exists({publicId:request.params.publicId,storeId:{$in:storeIds},status:{$in:['submitted','appealed']}});if(!exists)throw new AppError('Reviewable verification not found.',404,'VERIFICATION_NOT_FOUND');throw new AppError('This verification is already claimed by another moderator.',409,'MODERATION_ALREADY_CLAIMED');}
    await writeAudit(request,'seller.verification_claimed',{targetType:'seller_verification',targetPublicId:verification.publicId});
    return response.redirect(`/moderation/verifications/${encodeURIComponent(verification.publicId)}`);
  }),
);

router.post(
  '/moderation/verifications/:publicId/release',
  decisionLimiter,
  asyncHandler(async (request,response)=>{
    const storeIds=await Store.find(storeCountryScope(request)).distinct('_id');const query={publicId:request.params.publicId,storeId:{$in:storeIds},status:{$in:['submitted','appealed']}};if(!moderationSupervisor(request.user))query.assignedUserId=request.user._id;const now=new Date();
    const verification=await SellerVerification.findOneAndUpdate(query,{$set:{assignedUserId:null,assignedAt:null},$push:{reviewHistory:{action:'release',actorUserId:request.user._id,at:now}}},{returnDocument:'after'});
    if(!verification)throw new AppError('Only the assigned moderator or a supervisor can release this verification.',409,'MODERATION_RELEASE_FORBIDDEN');
    await writeAudit(request,'seller.verification_released',{targetType:'seller_verification',targetPublicId:verification.publicId});
    return response.redirect('/moderation/verifications');
  }),
);

router.post(
  '/moderation/verifications/:publicId/escalate',
  decisionLimiter,
  asyncHandler(async (request,response)=>{
    const reason=String(request.body.reason||'').trim();if(reason.length<10||reason.length>1000)throw new AppError('Give an escalation reason between 10 and 1000 characters.',422,'MODERATION_ESCALATION_REASON');const storeIds=await Store.find(storeCountryScope(request)).distinct('_id');const now=new Date();
    const verification=await SellerVerification.findOneAndUpdate({publicId:request.params.publicId,storeId:{$in:storeIds},status:{$in:['submitted','appealed']},assignedUserId:request.user._id},{$set:{escalatedAt:now,escalationReason:reason},$push:{reviewHistory:{action:'escalate',actorUserId:request.user._id,reason,at:now}}},{returnDocument:'after'});
    if(!verification)throw new AppError('Claim the verification before escalating it.',409,'MODERATION_CLAIM_REQUIRED');
    await writeAudit(request,'seller.verification_escalated',{targetType:'seller_verification',targetPublicId:verification.publicId,metadata:{reason}});setFlash(request,'success','Seller verification escalated for supervisor attention.');
    return response.redirect(`/moderation/verifications/${encodeURIComponent(verification.publicId)}`);
  }),
);

router.post(
  '/moderation/verifications/:publicId/decision',
  decisionLimiter,
  asyncHandler(async (request, response) => {
    const input=verificationDecisionSchema.parse({...request.body,reason:moderationReason(request.body,'verification')});
    const verification=await SellerVerification.findOne({publicId:request.params.publicId,status:{$in:['submitted','appealed']}});
    if(!verification)throw new AppError('Reviewable verification not found.',404,'VERIFICATION_NOT_FOUND');
    const store=await Store.findById(verification.storeId);if(!store)throw new AppError('Verification store not found.',404,'STORE_NOT_FOUND');if(request.user.role!=='super_admin')assertOperationalCountry(request.user,store.country,'Verification not found.');
    if(!assignedToActor(verification.assignedUserId,request.user._id))throw new AppError('Claim the verification before recording a moderation decision.',409,'MODERATION_CLAIM_REQUIRED');
    const reviewableDocumentStatuses=verification.status==='appealed'?['ready','rejected']:['ready'];
    const documentTypes=new Set((await VerificationDocument.find({verificationId:verification._id,status:{$in:reviewableDocumentStatuses}}).select('documentType').lean()).map(item=>item.documentType));
    const hasRequiredDocuments=documentTypes.has('identity')&&(verification.sellerType!=='business'||documentTypes.has('registration'));if(input.decision==='approve'&&!hasRequiredDocuments)throw new AppError('Required verification documents are missing.',409,'DOCUMENT_REQUIRED');
    const session=await mongoose.startSession();
    try{await session.withTransaction(async()=>{
      const freshVerification=await SellerVerification.findOne({_id:verification._id,status:{$in:['submitted','appealed']},assignedUserId:request.user._id}).session(session);const freshStore=await Store.findById(store._id).session(session);if(!freshVerification||!freshStore)throw new AppError('The verification assignment or review state changed. Reopen the queue and claim it again.',409,'VERIFICATION_STATE_CHANGED');const now=new Date();
      freshVerification.status=input.decision==='approve'?'approved':'rejected';freshVerification.reviewedAt=now;freshVerification.reviewedByUserId=request.user._id;freshVerification.reviewReason=input.reason;freshVerification.assignedUserId=null;freshVerification.assignedAt=undefined;freshVerification.reviewHistory.push({action:input.decision,actorUserId:request.user._id,reason:input.reason,at:now});await freshVerification.save({session});
      freshStore.status=input.decision==='approve'?'verified':'pending_verification';freshStore.verifiedAt=input.decision==='approve'?now:undefined;await freshStore.save({session});
      await VerificationDocument.updateMany({verificationId:freshVerification._id,status:{$in:reviewableDocumentStatuses}},{$set:{status:input.decision==='approve'?'approved':'rejected',reviewedAt:now,reviewedByUserId:request.user._id}},{session});
      await addOutboxEvent({type:`seller.verification_${freshVerification.status}`,aggregateType:'seller_verification',aggregatePublicId:freshVerification.publicId,payload:{storePublicId:freshStore.publicId,reason:input.reason}},session);
      await queueQaSample({session,targetType:'seller_verification',target:freshVerification,country:freshStore.country,decision:freshVerification.status==='approved'?'approved':'rejected',reason:input.reason,reviewerUserId:request.user._id,highRisk:freshVerification.sellerType==='business'});
      await writeAudit(request,`seller.verification_${freshVerification.status}`,{session,targetType:'seller_verification',targetPublicId:freshVerification.publicId,country:freshStore.country,metadata:{reason:input.reason}});
      verification.status=freshVerification.status;
    });}finally{await session.endSession();}
    setFlash(request,'success',input.decision==='approve'?'Seller verified.':'Verification rejected with a recorded reason.');return response.redirect('/moderation/verifications');
  }),
);


router.get(
  '/moderation/qa',
  asyncHandler(async (request,response)=>{
    const status=['pending','completed'].includes(String(request.query.status||''))?String(request.query.status):'pending';
    const baseScope={status,...operationalCountryScope(request.user,'country')};const field='sampledAt',pageSize=50;
    const [rows,total]=await Promise.all([
      ModerationQaReview.find(cursorScope(baseScope,request.query.after,{field,direction:1}))
        .populate('originalReviewerUserId','name publicId role')
        .populate('qaReviewerUserId','name publicId role')
        .sort(cursorSort(field,1)).limit(pageSize+1).lean(),
      ModerationQaReview.countDocuments(baseScope),
    ]);
    const page=pageResult(rows,{field,direction:1,limit:pageSize,total});
    return renderModeration(request,response,{section:'qa',samples:page.items,status,queuePage:page.page});
  }),
);

router.post(
  '/moderation/qa/:publicId/review',
  decisionLimiter,
  asyncHandler(async(request,response)=>{
    const outcome=String(request.body.outcome||'');const note=String(request.body.note||'').trim();
    if(!['upheld','coaching','escalated'].includes(outcome))throw new AppError('Choose a valid QA outcome.',422,'MODERATION_QA_OUTCOME');
    if(note.length<10||note.length>1000)throw new AppError('QA review notes must contain 10 to 1000 characters.',422,'MODERATION_QA_NOTE');
    const sample=await ModerationQaReview.findOne({publicId:request.params.publicId,status:'pending',...operationalCountryScope(request.user,'country')});
    if(!sample)throw new AppError('Pending moderation QA sample not found.',404,'MODERATION_QA_NOT_FOUND');
    if(assignedToActor(sample.originalReviewerUserId,request.user._id))throw new AppError('A moderator cannot QA their own decision.',403,'MODERATION_QA_FOUR_EYES');
    const session=await mongoose.startSession();
    try{await session.withTransaction(async()=>{
      const fresh=await ModerationQaReview.findOne({_id:sample._id,status:'pending'}).session(session);if(!fresh)throw new AppError('This QA sample has already been reviewed.',409,'MODERATION_QA_STATE');
      if(assignedToActor(fresh.originalReviewerUserId,request.user._id))throw new AppError('A moderator cannot QA their own decision.',403,'MODERATION_QA_FOUR_EYES');
      fresh.status='completed';fresh.qaReviewerUserId=request.user._id;fresh.reviewedAt=new Date();fresh.outcome=outcome;fresh.note=note;await fresh.save({session});
      if(outcome==='escalated')await addOutboxEvent({type:'moderation.qa_escalated',aggregateType:fresh.targetType,aggregatePublicId:fresh.targetPublicId,payload:{qaPublicId:fresh.publicId,note}},session);
    });}finally{await session.endSession();}
    await writeAudit(request,'moderation.qa_reviewed',{targetType:'moderation_qa',targetPublicId:sample.publicId,country:sample.country,metadata:{targetType:sample.targetType,targetPublicId:sample.targetPublicId,outcome,note}});
    setFlash(request,'success','Moderation QA review recorded.');return response.redirect('/moderation/qa');
  }),
);

export default router;
