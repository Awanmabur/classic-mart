import crypto from 'node:crypto';
import dns from 'node:dns/promises';
import https from 'node:https';
import net from 'node:net';
import mongoose from 'mongoose';
import { AppError } from '../core/errors.js';
import { env } from '../config/env.js';
import { publicId } from '../core/ids.js';
import { hashToken, hashValue, randomToken, safeEqual } from '../core/crypto.js';
import { encryptSensitive, decryptSensitive } from '../core/sensitive.js';
import { authenticate } from './auth.js';
import { getCountry } from './country.js';
import { writeAudit } from './audit.js';
import {
  ApiClient,
  ApiIdempotency,
  MobileRefreshUse,
  MobileSession,
  OutboxEvent,
  PushDevice,
  StoreMember,
  User,
  WebhookDelivery,
  WebhookEndpoint,
} from '../models/index.js';

const ACCESS_MS = 15 * 60_000;
const REFRESH_MS = 30 * 24 * 60 * 60_000;
const IDEMPOTENCY_MS = 24 * 60 * 60_000;
export const SELLER_API_SCOPES = Object.freeze([
  'catalogue:read','inventory:read','inventory:write','orders:read','orders:fulfil','webhooks:manage',
]);
export const WEBHOOK_EVENTS = Object.freeze(['inventory.updated','order.updated','catalogue.updated','integration.test']);

function accessToken() { return `cma_${randomToken(32)}`; }
function refreshToken() { return `cmr_${randomToken(48)}`; }
function apiSecret(prefix) { return `cmk_${prefix}.${randomToken(36)}`; }
function nowMinute() { return new Date(Math.floor(Date.now()/60_000)*60_000); }
function bearer(request) { const h=String(request.get('authorization')||''); return h.startsWith('Bearer ')?h.slice(7).trim():''; }
function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(k=>`${JSON.stringify(k)}:${stable(value[k])}`).join(',')}}`;
  return JSON.stringify(value);
}
function requestHash(body) { return crypto.createHash('sha256').update(stable(body ?? null)).digest('hex'); }

function pushGatewayConfigured(){return Boolean(env.stage11.pushGatewayUrl && env.stage11.pushGatewaySecret);}
function pushSignature(timestamp,body){return crypto.createHmac('sha256',env.stage11.pushGatewaySecret).update(`${timestamp}.${body}`).digest('hex');}
export async function queuePushNotification({userId,userPublicId='',title,body,deepLink='/'}){
  if(!userId) throw new AppError('Push notification user is required.',422,'PUSH_USER_REQUIRED');
  const event=await OutboxEvent.create({eventId:publicId('evt'),type:'mobile.push',aggregateType:'user',aggregatePublicId:userPublicId||String(userId),payload:{userId:String(userId),title:String(title||'Classic Mart').slice(0,120),body:String(body||'').slice(0,500),deepLink:String(deepLink||'/').slice(0,500)}});
  return event;
}
export async function processPushOutbox({limit=50}={}){
  if(!pushGatewayConfigured()) return {providerConfigured:false,checked:0,processed:0,failed:0};
  let gateway; try{gateway=new URL(env.stage11.pushGatewayUrl);}catch{throw new AppError('PUSH_GATEWAY_URL is invalid.',500,'PUSH_GATEWAY_INVALID');}
  if(env.isProduction && gateway.protocol!=='https:') throw new AppError('Production push gateway must use HTTPS.',500,'PUSH_GATEWAY_INSECURE');
  const events=await OutboxEvent.find({type:'mobile.push',status:{$in:['pending','failed']},availableAt:{$lte:new Date()}}).sort({createdAt:1}).limit(Math.min(Math.max(Number(limit)||50,1),100));
  let processed=0,failed=0;
  for(const event of events){
    event.status='processing';event.attempts+=1;await event.save();
    try{
      const devices=await PushDevice.find({userId:event.payload?.userId,status:'active'}).select('+tokenEncrypted').lean();
      if(!devices.length){event.status='processed';event.processedAt=new Date();event.lastError='No active push devices.';processed+=1;await event.save();continue;}
      let delivered=0;
      for(const device of devices){
        const payload={platform:device.platform,token:decryptSensitive(device.tokenEncrypted),title:event.payload.title,body:event.payload.body,deepLink:event.payload.deepLink,eventId:event.eventId};
        const raw=JSON.stringify(payload);const timestamp=Math.floor(Date.now()/1000).toString();
        const response=await fetch(gateway,{method:'POST',headers:{'content-type':'application/json','user-agent':'Classic-Mart-Push/1.0','x-classic-mart-event-id':event.eventId,'x-classic-mart-timestamp':timestamp,'x-classic-mart-signature':`v1=${pushSignature(timestamp,raw)}`},body:raw,redirect:'error',signal:AbortSignal.timeout(8000)});
        if(response.ok){delivered+=1;await PushDevice.updateOne({_id:device._id},{$set:{failureCount:0,lastSeenAt:new Date()}});}else{const failures=Number(device.failureCount||0)+1;await PushDevice.updateOne({_id:device._id},{$set:{failureCount:failures,status:failures>=5?'invalid':'active'}});}
      }
      if(delivered<1) throw new Error('Push gateway did not accept any active device delivery.');
      event.status='processed';event.processedAt=new Date();event.lastError='';processed+=1;
    }catch(error){event.status='failed';event.lastError=String(error.message||error).slice(0,1000);event.availableAt=new Date(Date.now()+Math.min(60,2**Math.min(8,event.attempts))*60_000);failed+=1;}
    await event.save();
  }
  return {providerConfigured:true,checked:events.length,processed,failed};
}

export async function issueMobileTokens(user, input, request) {
  if (!user.emailVerifiedAt || !user.phoneVerifiedAt || !user.onboardingCompletedAt) throw new AppError('Complete account verification and onboarding before connecting a mobile client.',403,'MOBILE_ACCOUNT_NOT_READY');
  const familyId=publicId('fam'); const access=accessToken(); const refresh=refreshToken();
  const session=await MobileSession.create({
    publicId:publicId('mob'), familyId, userId:user._id, userTokenVersion:user.security.tokenVersion,
    cartKey:`mobile:${user.publicId}:${familyId}`, deviceName:String(input.deviceName||'Mobile client').trim().slice(0,120),
    platform:['android','ios','web'].includes(input.platform)?input.platform:'other', accessTokenHash:hashToken(access), refreshTokenHash:hashToken(refresh),
    accessExpiresAt:new Date(Date.now()+ACCESS_MS), refreshExpiresAt:new Date(Date.now()+REFRESH_MS), lastUsedAt:new Date(),
  });
  await writeAudit(request,'mobile.session_created',{actor:user,targetType:'mobile_session',targetPublicId:session.publicId,metadata:{platform:session.platform}});
  return {accessToken:access,refreshToken:refresh,tokenType:'Bearer',accessExpiresIn:Math.floor(ACCESS_MS/1000),refreshExpiresIn:Math.floor(REFRESH_MS/1000),session:{id:session.publicId,deviceName:session.deviceName,platform:session.platform}};
}

export async function mobileLogin(input, request) {
  const user=await authenticate(input.identity,input.password,request);
  return issueMobileTokens(user,input,request);
}

export async function refreshMobileTokens(rawRefresh, request) {
  const token=String(rawRefresh||''); if(!token.startsWith('cmr_')) throw new AppError('Refresh token is invalid.',401,'REFRESH_INVALID');
  const tokenHash=hashToken(token); const reused=await MobileRefreshUse.findOne({tokenHash}).select('+tokenHash').lean();
  if(reused){await MobileSession.updateMany({familyId:reused.familyId,revokedAt:null},{$set:{revokedAt:new Date(),revokedReason:'refresh_reuse',reuseDetectedAt:new Date()}});throw new AppError('Refresh-token reuse was detected. Sign in again.',401,'REFRESH_REUSE');}
  const session=await MobileSession.findOne({refreshTokenHash:tokenHash,revokedAt:null,refreshExpiresAt:{$gt:new Date()}}).select('+refreshTokenHash +checkoutReview');
  if(!session) throw new AppError('Refresh token is invalid or expired.',401,'REFRESH_INVALID');
  const user=await User.findById(session.userId); if(!user||user.status!=='active'||user.security.tokenVersion!==session.userTokenVersion){session.revokedAt=new Date();session.revokedReason='account_changed';await session.save();throw new AppError('Mobile session is no longer valid.',401,'MOBILE_SESSION_REVOKED');}
  await MobileRefreshUse.create({tokenHash,familyId:session.familyId,userId:user._id,expiresAt:session.refreshExpiresAt});
  const nextAccess=accessToken(),nextRefresh=refreshToken(); session.accessTokenHash=hashToken(nextAccess);session.refreshTokenHash=hashToken(nextRefresh);session.accessExpiresAt=new Date(Date.now()+ACCESS_MS);session.refreshExpiresAt=new Date(Date.now()+REFRESH_MS);session.lastUsedAt=new Date();await session.save();
  await writeAudit(request,'mobile.session_refreshed',{actor:user,targetType:'mobile_session',targetPublicId:session.publicId});
  return {accessToken:nextAccess,refreshToken:nextRefresh,tokenType:'Bearer',accessExpiresIn:Math.floor(ACCESS_MS/1000),refreshExpiresIn:Math.floor(REFRESH_MS/1000)};
}

export async function authenticateMobile(request,_response,next){
  try{const raw=bearer(request);if(!raw.startsWith('cma_'))throw new AppError('Mobile authentication required.',401,'MOBILE_UNAUTHENTICATED');const hash=hashToken(raw);
    const session=await MobileSession.findOne({accessTokenHash:hash,revokedAt:null,accessExpiresAt:{$gt:new Date()}}).select('+accessTokenHash +checkoutReview');if(!session)throw new AppError('Mobile access token is invalid or expired.',401,'MOBILE_TOKEN_INVALID');
    const user=await User.findById(session.userId);if(!user||user.status!=='active'||user.security.tokenVersion!==session.userTokenVersion)throw new AppError('Mobile session is no longer valid.',401,'MOBILE_SESSION_REVOKED');
    session.lastUsedAt=new Date();await session.save();request.mobileSession=session;request.mobileUser=user;request.mobileCountry=await getCountry(user.country);next();
  }catch(e){next(e);}
}
export async function revokeMobileSession(user,publicIdValue,reason='user_revoked'){const session=await MobileSession.findOne({publicId:publicIdValue,userId:user._id,revokedAt:null});if(!session)throw new AppError('Connected app session was not found.',404,'MOBILE_SESSION_NOT_FOUND');session.revokedAt=new Date();session.revokedReason=reason;await session.save();return session;}
export async function listMobileSessions(user){return MobileSession.find({userId:user._id}).select('publicId deviceName platform lastUsedAt createdAt revokedAt revokedReason').sort({createdAt:-1}).limit(40).lean();}
export function mobileServiceRequest(request){return {user:request.mobileUser,country:request.mobileCountry,session:{cartKey:request.mobileSession.cartKey,checkoutReview:request.mobileSession.checkoutReview||null},ip:request.ip,get:request.get.bind(request),log:request.log||{warn(){}}};}
export async function persistMobileCheckout(request,serviceRequest){request.mobileSession.checkoutReview=serviceRequest.session.checkoutReview||null;request.mobileSession.markModified('checkoutReview');await request.mobileSession.save();}

export async function registerPushDevice(user,input){const token=String(input.token||input.endpoint||'').trim();if(token.length<12||token.length>4096)throw new AppError('Push token or endpoint is invalid.',422,'PUSH_TOKEN_INVALID');const hash=hashToken(token);return PushDevice.findOneAndUpdate({userId:user._id,tokenHash:hash},{$set:{platform:input.platform,label:String(input.label||'').slice(0,120),country:user.country,status:'active',tokenEncrypted:encryptSensitive(token),lastSeenAt:new Date(),revokedAt:null,failureCount:0},$setOnInsert:{publicId:publicId('psh')}},{upsert:true,returnDocument:'after',runValidators:true});}
export async function revokePushDevice(user,publicIdValue){const row=await PushDevice.findOne({publicId:publicIdValue,userId:user._id,status:'active'});if(!row)throw new AppError('Push device not found.',404,'PUSH_DEVICE_NOT_FOUND');row.status='revoked';row.revokedAt=new Date();await row.save();return row;}
export async function listPushDevices(user){return PushDevice.find({userId:user._id}).select('publicId platform label status lastSeenAt createdAt revokedAt').sort({createdAt:-1}).lean();}

function membershipCanDevelop(member){return member&&member.status==='active'&&['owner','admin'].includes(member.role);}
export async function createApiClient({user,store,name,scopes,requestsPerMinute=120,expiresAt=null}){const member=await StoreMember.findOne({userId:user._id,storeId:store._id});if(!membershipCanDevelop(member))throw new AppError('Only store owners/admins can create API clients.',403,'API_CLIENT_FORBIDDEN');const activeCount=await ApiClient.countDocuments({storeId:store._id,status:'active'});if(activeCount>=20)throw new AppError('Revoke an existing API client before creating another.',409,'API_CLIENT_LIMIT');const clean=[...new Set((scopes||[]).filter(x=>SELLER_API_SCOPES.includes(x)))];if(!clean.length)throw new AppError('Choose at least one API scope.',422,'API_SCOPE_REQUIRED');const rpm=Number(requestsPerMinute);if(!Number.isSafeInteger(rpm)||rpm<10||rpm>1200)throw new AppError('Requests per minute must be between 10 and 1200.',422,'API_QUOTA_INVALID');let expiry=null;if(expiresAt){expiry=new Date(expiresAt);if(Number.isNaN(expiry.getTime())||expiry<=new Date())throw new AppError('API client expiry must be a future date.',422,'API_EXPIRY_INVALID');}const prefix=randomToken(8).replace(/[^a-zA-Z0-9]/g,'').slice(0,10);const raw=apiSecret(prefix);const doc=await ApiClient.create({publicId:publicId('api'),storeId:store._id,createdByUserId:user._id,name:String(name||'Seller integration').trim().slice(0,120),keyPrefix:prefix,secretHash:hashToken(raw),scopes:clean,requestsPerMinute:rpm,expiresAt:expiry});return {client:doc,apiKey:raw};}
export async function rotateApiClient({user,store,publicId:clientPublicId}){const member=await StoreMember.findOne({userId:user._id,storeId:store._id});if(!membershipCanDevelop(member))throw new AppError('Only store owners/admins can rotate API clients.',403,'API_CLIENT_FORBIDDEN');const client=await ApiClient.findOne({publicId:clientPublicId,storeId:store._id,status:'active'}).select('+secretHash');if(!client)throw new AppError('API client not found.',404,'API_CLIENT_NOT_FOUND');const raw=apiSecret(client.keyPrefix);client.secretHash=hashToken(raw);client.rotatedAt=new Date();client.quotaCount=0;client.quotaWindowAt=new Date();await client.save();return {client,apiKey:raw};}
export async function revokeApiClient({user,store,publicId:clientPublicId}){const member=await StoreMember.findOne({userId:user._id,storeId:store._id});if(!membershipCanDevelop(member))throw new AppError('Only store owners/admins can revoke API clients.',403,'API_CLIENT_FORBIDDEN');const client=await ApiClient.findOne({publicId:clientPublicId,storeId:store._id,status:'active'});if(!client)throw new AppError('API client not found.',404,'API_CLIENT_NOT_FOUND');client.status='revoked';client.revokedAt=new Date();await client.save();return client;}

async function consumeApiQuota(client){const window=nowMinute();if(!client.quotaWindowAt||client.quotaWindowAt<window){const reset=await ApiClient.findOneAndUpdate({_id:client._id,status:'active'},{$set:{quotaWindowAt:window,quotaCount:1,lastUsedAt:new Date()}},{returnDocument:'after'});if(!reset)throw new AppError('API client is unavailable.',401,'API_CLIENT_INVALID');return reset;}
  const used=await ApiClient.findOneAndUpdate({_id:client._id,status:'active',quotaWindowAt:client.quotaWindowAt,quotaCount:{$lt:client.requestsPerMinute}},{$inc:{quotaCount:1},$set:{lastUsedAt:new Date()}},{returnDocument:'after'});if(!used)throw new AppError('API request quota exceeded.',429,'API_QUOTA_EXCEEDED');return used;}
export async function authenticateApiClient(request,_response,next){try{const raw=bearer(request);if(!/^cmk_[A-Za-z0-9]+\./.test(raw))throw new AppError('Seller API key required.',401,'API_KEY_REQUIRED');const prefix=raw.slice(4).split('.',1)[0];const client=await ApiClient.findOne({keyPrefix:prefix,status:'active',$or:[{expiresAt:null},{expiresAt:{$gt:new Date()}}]}).select('+secretHash');const candidate=hashToken(raw);if(!client||!safeEqual(client.secretHash,candidate))throw new AppError('Seller API key is invalid.',401,'API_KEY_INVALID');request.apiClient=await consumeApiQuota(client);request.apiStore=await mongoose.model('Store').findById(client.storeId);if(!request.apiStore||request.apiStore.status!=='verified')throw new AppError('Seller store is unavailable.',403,'STORE_UNAVAILABLE');next();}catch(e){next(e);}}
export function requireApiScope(scope){return (request,_response,next)=>request.apiClient?.scopes?.includes(scope)?next():next(new AppError('API key does not include the required scope.',403,'API_SCOPE_FORBIDDEN'));}
export async function auditExternalApi(request,action,{targetType='api_client',targetPublicId='',metadata={}}={}){
  return writeAudit(request,action,{actor:{_id:request.apiClient?.createdByUserId,publicId:`api:${request.apiClient?.publicId||'unknown'}`},targetType,targetPublicId:targetPublicId||request.apiClient?.publicId,country:request.apiStore?.country,metadata:{apiClientId:request.apiClient?.publicId,scopes:request.apiClient?.scopes,...metadata}});
}

function privateAddress(address){if(!address)return true;if(address==='::1'||address==='0:0:0:0:0:0:0:1')return true;if(address.startsWith('fe80:')||address.startsWith('fc')||address.startsWith('fd'))return true;if(net.isIP(address)===4){const [a,b]=address.split('.').map(Number);return a===10||a===127||a===0||(a===169&&b===254)||(a===172&&b>=16&&b<=31)||(a===192&&b===168)||(a===100&&b>=64&&b<=127);}return false;}
async function resolveWebhookTarget(rawUrl){let url;try{url=new URL(String(rawUrl));}catch{throw new AppError('Webhook URL is invalid.',422,'WEBHOOK_URL_INVALID');}if(url.protocol!=='https:')throw new AppError('Webhook URL must use HTTPS.',422,'WEBHOOK_HTTPS_REQUIRED');if(url.username||url.password||(url.port&&['22','25','3306','5432','6379','27017','27018'].includes(url.port)))throw new AppError('Webhook URL is not allowed.',422,'WEBHOOK_URL_FORBIDDEN');const host=url.hostname.toLowerCase();if(host==='localhost'||host.endsWith('.local')||privateAddress(host))throw new AppError('Webhook target cannot use a local/private address.',422,'WEBHOOK_SSRF_BLOCKED');let addresses;try{addresses=await dns.lookup(host,{all:true,verbatim:true});}catch{throw new AppError('Webhook host could not be resolved.',422,'WEBHOOK_HOST_UNRESOLVED');}if(!addresses.length||addresses.some(row=>privateAddress(row.address)))throw new AppError('Webhook target resolves to a local/private address.',422,'WEBHOOK_SSRF_BLOCKED');return {url,address:addresses[0].address,family:addresses[0].family};}
export async function assertWebhookTarget(rawUrl){return (await resolveWebhookTarget(rawUrl)).url.toString();}
async function postPinnedWebhook(rawUrl,headers,body){const target=await resolveWebhookTarget(rawUrl);return new Promise((resolve,reject)=>{const request=https.request({protocol:'https:',hostname:target.url.hostname,port:target.url.port||443,path:`${target.url.pathname}${target.url.search}`,method:'POST',headers,servername:target.url.hostname,lookup(_hostname,_options,callback){callback(null,target.address,target.family);}},response=>{const chunks=[];let bytes=0;response.on('data',chunk=>{if(bytes<64_000){const remaining=64_000-bytes;chunks.push(chunk.subarray(0,remaining));bytes+=Math.min(chunk.length,remaining);}});response.on('end',()=>resolve({status:Number(response.statusCode||0),ok:Number(response.statusCode||0)>=200&&Number(response.statusCode||0)<300,body:Buffer.concat(chunks).toString('utf8')}));});request.setTimeout(8000,()=>request.destroy(new Error('Webhook delivery timed out.')));request.on('error',reject);request.end(body);});}
export async function createWebhookEndpoint({user,store,url,events}){const member=await StoreMember.findOne({userId:user._id,storeId:store._id});if(!membershipCanDevelop(member))throw new AppError('Only store owners/admins can create webhooks.',403,'WEBHOOK_FORBIDDEN');const activeCount=await WebhookEndpoint.countDocuments({storeId:store._id,status:{$ne:'revoked'}});if(activeCount>=20)throw new AppError('Revoke an existing webhook endpoint before creating another.',409,'WEBHOOK_LIMIT');const safeUrl=await assertWebhookTarget(url);const clean=[...new Set((events||[]).filter(x=>WEBHOOK_EVENTS.includes(x)))];if(!clean.length)throw new AppError('Choose at least one webhook event.',422,'WEBHOOK_EVENT_REQUIRED');const secret=`whsec_${randomToken(36)}`;const endpoint=await WebhookEndpoint.create({publicId:publicId('whk'),storeId:store._id,createdByUserId:user._id,url:safeUrl,events:clean,secretEncrypted:encryptSensitive(secret),secretLast4:secret.slice(-4)});return {endpoint,secret};}
export async function rotateWebhookSecret({user,store,publicId:endpointPublicId}){const member=await StoreMember.findOne({userId:user._id,storeId:store._id});if(!membershipCanDevelop(member))throw new AppError('Only store owners/admins can rotate webhooks.',403,'WEBHOOK_FORBIDDEN');const endpoint=await WebhookEndpoint.findOne({publicId:endpointPublicId,storeId:store._id,status:{$ne:'revoked'}}).select('+secretEncrypted');if(!endpoint)throw new AppError('Webhook endpoint not found.',404,'WEBHOOK_NOT_FOUND');const secret=`whsec_${randomToken(36)}`;endpoint.secretEncrypted=encryptSensitive(secret);endpoint.secretLast4=secret.slice(-4);endpoint.rotatedAt=new Date();await endpoint.save();return {endpoint,secret};}
export async function revokeWebhookEndpoint({user,store,publicId:endpointPublicId}){const member=await StoreMember.findOne({userId:user._id,storeId:store._id});if(!membershipCanDevelop(member))throw new AppError('Only store owners/admins can revoke webhooks.',403,'WEBHOOK_FORBIDDEN');const endpoint=await WebhookEndpoint.findOne({publicId:endpointPublicId,storeId:store._id,status:{$ne:'revoked'}});if(!endpoint)throw new AppError('Webhook endpoint not found.',404,'WEBHOOK_NOT_FOUND');endpoint.status='revoked';endpoint.revokedAt=new Date();await endpoint.save();return endpoint;}
export async function queueWebhookEvent({storeId,eventType,resourcePublicId,payload}){if(!WEBHOOK_EVENTS.includes(eventType))return 0;const endpoints=await WebhookEndpoint.find({storeId,status:'active',events:eventType}).lean();const eventId=`evt_${hashValue(`${eventType}:${resourcePublicId}:${Date.now()}:${randomToken(8)}`).slice(0,36)}`;let count=0;for(const endpoint of endpoints){try{await WebhookDelivery.create({publicId:publicId('whd'),endpointId:endpoint._id,storeId,eventId,eventType,payload:{resourcePublicId,...payload},nextAttemptAt:new Date()});count++;}catch(e){if(e?.code!==11000)throw e;}}return count;}
export function webhookSignature(secret,timestamp,body){return `v1=${crypto.createHmac('sha256',secret).update(`${timestamp}.${body}`).digest('hex')}`;}
export async function deliverWebhookBatch({limit=30}={}){const rows=await WebhookDelivery.find({status:{$in:['queued','failed']},nextAttemptAt:{$lte:new Date()}}).sort({nextAttemptAt:1}).limit(Math.min(Math.max(Number(limit)||30,1),100));let delivered=0,failed=0;for(const row of rows){const endpoint=await WebhookEndpoint.findOne({_id:row.endpointId,status:'active'}).select('+secretEncrypted');if(!endpoint){row.status='dead';row.errorMessage='Endpoint unavailable';await row.save();continue;}try{const timestamp=Math.floor(Date.now()/1000).toString();const body=JSON.stringify({id:row.eventId,type:row.eventType,createdAt:new Date().toISOString(),data:row.payload});const secret=decryptSensitive(endpoint.secretEncrypted);const response=await postPinnedWebhook(endpoint.url,{'content-type':'application/json','user-agent':'Classic-Mart-Webhook/1.0','x-classic-mart-event-id':row.eventId,'x-classic-mart-timestamp':timestamp,'x-classic-mart-signature':webhookSignature(secret,timestamp,body)},body);row.attempt+=1;row.lastAttemptAt=new Date();row.responseStatus=response.status;row.responseHash=crypto.createHash('sha256').update(response.body).digest('hex');endpoint.lastDeliveryAt=new Date();if(response.ok){row.status='delivered';row.deliveredAt=new Date();row.errorMessage='';endpoint.lastSuccessAt=new Date();endpoint.failureCount=0;delivered++;}else{row.status=row.attempt>=5?'dead':'failed';row.nextAttemptAt=new Date(Date.now()+Math.min(60,2**row.attempt)*60_000);row.errorMessage=`HTTP ${response.status}`;endpoint.failureCount+=1;failed++;}await row.save();await endpoint.save();}catch(e){row.attempt+=1;row.lastAttemptAt=new Date();row.status=row.attempt>=5?'dead':'failed';row.nextAttemptAt=new Date(Date.now()+Math.min(60,2**row.attempt)*60_000);row.errorMessage=String(e.message||'Delivery failed').slice(0,500);endpoint.lastDeliveryAt=new Date();endpoint.failureCount+=1;await row.save();await endpoint.save();failed++;}}return {delivered,failed};}

export async function executeExternalIdempotency(request,operation){const key=String(request.get('idempotency-key')||'').trim();if(key.length<8||key.length>160)throw new AppError('A valid Idempotency-Key header is required for this write.',422,'IDEMPOTENCY_REQUIRED');const hash=requestHash(request.body);let record;try{record=await ApiIdempotency.create({apiClientId:request.apiClient._id,key,requestHash:hash,status:'in_progress',expiresAt:new Date(Date.now()+IDEMPOTENCY_MS)});}catch(e){if(e?.code!==11000)throw e;const existing=await ApiIdempotency.findOne({apiClientId:request.apiClient._id,key}).lean();if(!existing)throw e;if(existing.requestHash!==hash)throw new AppError('This idempotency key was already used with a different request.',409,'IDEMPOTENCY_CONFLICT');if(existing.status==='completed')return {replayed:true,statusCode:existing.statusCode,body:existing.responseBody};throw new AppError('An identical request is already being processed.',409,'IDEMPOTENCY_IN_PROGRESS');}
  try{const result=await operation();record.status='completed';record.statusCode=result.statusCode||200;record.responseBody=result.body;await record.save();return {replayed:false,...result};}catch(e){await ApiIdempotency.deleteOne({_id:record._id});throw e;}}

export async function developerPortalData(user,store){const [clients,webhooks,deliveries]=await Promise.all([ApiClient.find({storeId:store._id}).select('-secretHash').sort({createdAt:-1}).lean(),WebhookEndpoint.find({storeId:store._id}).select('-secretEncrypted').sort({createdAt:-1}).lean(),WebhookDelivery.find({storeId:store._id}).sort({createdAt:-1}).limit(50).lean()]);return {clients,webhooks,deliveries,scopes:SELLER_API_SCOPES,events:WEBHOOK_EVENTS};}
