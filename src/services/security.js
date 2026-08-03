import crypto from 'node:crypto';
import dgram from 'node:dgram';
import { env } from '../config/env.js';
import { logger } from '../config/logger.js';
import { hashValue, safeEqual } from '../core/crypto.js';
import { publicId } from '../core/ids.js';
import { Incident, IpBlock, SecurityEvent } from '../models/index.js';

const SENSITIVE_PATH=/^\/(login|signup|forgot-password|reset-password|verify-|mfa|account|admin|seller|moderation|payments|webhooks|api\/)/i;
const severityRank={low:0,medium:1,high:2,critical:3};
const BLOCK_CACHE_LIMIT=10_000;
const BLOCK_CACHE_TTL_MS=15_000;
const CLEAR_CACHE_TTL_MS=15_000;
const BLOCK_HIT_LOG_TTL_MS=60_000;
const blockCache=new Map();
const clearCache=new Map();
const blockHitLogCache=new Map();
let lastRetentionAt=0;

function boundedSet(map,key,value,limit=BLOCK_CACHE_LIMIT){
  if(map.has(key))map.delete(key);
  map.set(key,value);
  while(map.size>limit){const oldest=map.keys().next().value;map.delete(oldest);}
}

export function invalidateIpBlockCache(ipHash){
  blockCache.delete(ipHash);
  clearCache.delete(ipHash);
  blockHitLogCache.delete(ipHash);
}

function redact(value){
  if(!value||typeof value!=='object')return value;
  return JSON.parse(JSON.stringify(value,(key,item)=>/password|passcode|token|secret|cookie|authorization|code|credential|key/i.test(key)?'[REDACTED]':item));
}

function stable(value){
  if(Array.isArray(value))return `[${value.map(stable).join(',')}]`;
  if(value&&typeof value==='object')return `{${Object.keys(value).sort().map(key=>`${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

function eventIntegrityPayload(event){
  return {
    publicId:event.publicId,
    occurredAt:new Date(event.occurredAt).toISOString(),
    requestId:event.requestId||'',type:event.type,category:event.category,severity:event.severity,result:event.result,
    country:event.country||'',actorPublicId:event.actorPublicId||'',ipHash:event.ipHash||'',userAgentHash:event.userAgentHash||'',
    method:event.method||'',path:event.path||'',statusCode:event.statusCode||0,metadata:event.metadata||null,
  };
}

export function signSecurityEvent(event){return crypto.createHmac('sha256',env.security.integrityKey).update(stable(eventIntegrityPayload(event))).digest('hex');}
export function verifySecurityEventIntegrity(event){return safeEqual(signSecurityEvent(event),event.integrity);}

export async function writeSecurityEvent(request,type,options={}){
  try{
    const event={
      publicId:publicId('sec'),occurredAt:new Date(),requestId:request?.id||options.requestId||'',type,
      category:options.category||'other',severity:options.severity||'medium',result:options.result||'detected',
      country:options.country||request?.country?.code||request?.user?.country||'',actorUserId:options.actor?._id||request?.adminActor?._id||request?.user?._id,
      actorPublicId:options.actor?.publicId||request?.adminActor?.publicId||request?.user?.publicId||'',
      ipHash:options.ipHash||hashValue(request?.ip||''),userAgentHash:options.userAgentHash||hashValue(request?.get?.('user-agent')||''),
      method:String(options.method||request?.method||'').slice(0,16),path:String(options.path||request?.path||request?.originalUrl||'').slice(0,500),
      statusCode:Number(options.statusCode||0)||undefined,metadata:redact(options.metadata),
      siemStatus:env.security.siem.mode==='off'?'disabled':'pending',siemNextAttemptAt:new Date(),
    };
    event.integrity=signSecurityEvent(event);
    return await SecurityEvent.create(event);
  }catch(error){logger.error({error:error.message,type,requestId:request?.id},'Failed to write security event');return null;}
}

async function activeBlock(ipHash){
  const now=Date.now();
  const cached=blockCache.get(ipHash);
  if(cached){
    if(cached.expiresAt>now)return cached.document;
    blockCache.delete(ipHash);
  }
  const clearUntil=clearCache.get(ipHash);
  if(clearUntil&&clearUntil>now)return null;
  clearCache.delete(ipHash);
  const row=await IpBlock.findOne({ipHash,revokedAt:null,expiresAt:{$gt:new Date(now)}}).select('+ipHash');
  if(row)boundedSet(blockCache,ipHash,{expiresAt:Math.min(new Date(row.expiresAt).getTime(),now+BLOCK_CACHE_TTL_MS),document:row});
  else boundedSet(clearCache,ipHash,now+CLEAR_CACHE_TTL_MS);
  return row;
}

async function createOrExtendBlock(ipHash,{reason,severity='high',sourceEventPublicId='',minutes=60}={}){
  const now=new Date();
  const current=await IpBlock.findOne({ipHash,revokedAt:null,expiresAt:{$gt:now}}).select('+ipHash');
  if(current){current.expiresAt=new Date(Math.max(current.expiresAt.getTime(),Date.now()+minutes*60_000));current.reason=reason||current.reason;current.hitCount+=1;current.lastHitAt=now;await current.save();invalidateIpBlockCache(ipHash);boundedSet(blockCache,ipHash,{expiresAt:Math.min(current.expiresAt.getTime(),Date.now()+BLOCK_CACHE_TTL_MS),document:current});return current;}
  const created=await IpBlock.create({publicId:publicId('blk'),ipHash,reason:String(reason||'Hostile request activity').slice(0,500),severity,sourceEventPublicId,expiresAt:new Date(Date.now()+minutes*60_000),hitCount:1,lastHitAt:now});
  invalidateIpBlockCache(ipHash);boundedSet(blockCache,ipHash,{expiresAt:Math.min(created.expiresAt.getTime(),Date.now()+BLOCK_CACHE_TTL_MS),document:created});
  return created;
}

function threatFromRequest(request){
  const method=String(request.method||'').toUpperCase();
  const target=String(request.originalUrl||request.url||'');
  let decoded=target;
  try{decoded=decodeURIComponent(target);}catch{}
  const haystack=`${target}\n${decoded}`.toLowerCase();
  const ua=String(request.get?.('user-agent')||'').toLowerCase();
  if(['TRACE','TRACK','CONNECT'].includes(method))return {type:'http.unsafe_method',category:'reconnaissance',severity:'critical',reason:`Unsafe HTTP method ${method}`};
  if(/(?:^|\/)(?:\.env|\.git(?:\/|$)|wp-admin|wp-login\.php|phpmyadmin|server-status|actuator\/env|vendor\/phpunit)/i.test(decoded))return {type:'recon.secret_probe',category:'reconnaissance',severity:'critical',reason:'Secret or administrative file reconnaissance'};
  if(/(?:\.\.\/|\.\.\\|%2e%2e|%252e%252e)/i.test(target))return {type:'attack.path_traversal',category:'injection',severity:'high',reason:'Path traversal probe'};
  if(/(?:<script|%3cscript|javascript:|onerror\s*=|onload\s*=)/i.test(haystack))return {type:'attack.xss_probe',category:'injection',severity:'high',reason:'Cross-site scripting probe'};
  if(/(?:union\s+(?:all\s+)?select|(?:'|%27)\s*or\s+['\d]|sleep\s*\(|benchmark\s*\(|information_schema)/i.test(haystack))return {type:'attack.sql_injection_probe',category:'injection',severity:'high',reason:'SQL injection style probe'};
  if(/\$\{jndi:(?:ldap|rmi|dns|iiop|http)/i.test(haystack))return {type:'attack.jndi_probe',category:'injection',severity:'critical',reason:'JNDI/Log4Shell style probe'};
  if(/(?:sqlmap|nikto|masscan|zgrab|acunetix|nessus|nuclei|wpscan|dirbuster|gobuster)/i.test(ua))return {type:'recon.scanner_user_agent',category:'reconnaissance',severity:'high',reason:'Known automated scanner user agent'};
  return null;
}

async function securityIncidentForBlock(request,detection,event,block){
  if(!['high','critical'].includes(detection.severity))return;
  const severity=detection.severity==='critical'?'sev1':'sev2';
  const title=`Security IPS block: ${detection.type}`.slice(0,180);
  const existing=await Incident.findOne({status:{$ne:'resolved'},severity,title,createdAt:{$gt:new Date(Date.now()-60*60_000)}});
  if(existing)return;
  await Incident.create({
    publicId:publicId('inc'),country:request?.country?.code||request?.user?.country||'',severity,title,
    summary:`Classic Mart blocked hostile activity classified as ${detection.type}. Review correlated security event ${event?.publicId||'unavailable'} and IPS block ${block?.publicId||'unavailable'}.`,
    timeline:[{type:'security.ips_blocked',message:String(detection.reason||'Hostile request activity').slice(0,500)}],
  });
}

async function thresholdBlock(request,detection,event){
  const ipHash=event?.ipHash||hashValue(request.ip||'');
  const threshold=detection.severity==='critical'?1:detection.severity==='high'?3:8;
  let count=threshold;
  if(detection.severity!=='critical'){
    const since=new Date(Date.now()-10*60_000);
    const minimumRank=severityRank[detection.severity]??1;
    const relevantSeverities=Object.entries(severityRank).filter(([,rank])=>rank>=minimumRank).map(([name])=>name);
    count=await SecurityEvent.countDocuments({ipHash,occurredAt:{$gte:since},severity:{$in:relevantSeverities},result:{$in:['detected','blocked','failure']}});
  }
  if(count<threshold)return false;
  const minutes=detection.severity==='critical'?240:detection.severity==='high'?90:30;
  try{
    const block=await createOrExtendBlock(ipHash,{reason:detection.reason,severity:detection.severity==='critical'?'critical':'high',sourceEventPublicId:event?.publicId||'',minutes});
    await writeSecurityEvent(request,'ips.ip_blocked',{category:'abuse',severity:detection.severity,result:'blocked',ipHash,metadata:{reason:detection.reason,sourceEvent:event?.publicId||'',blockPublicId:block.publicId,expiresAt:block.expiresAt}});
    await securityIncidentForBlock(request,detection,event,block);
  }catch(error){
    logger.error({error:error.message,requestId:request?.id,type:detection.type},'IPS persistence failed after block threshold');
  }
  return true;
}

function securityDatabaseReady(){
  return IpBlock.db?.readyState===1&&SecurityEvent.db?.readyState===1;
}

export async function securityShield(request,response,next){
  try{
    if(!env.security.idsEnabled)return next();
    const ipHash=hashValue(request.ip||'');
    if(!securityDatabaseReady()){
      const detection=threatFromRequest(request);
      if(detection&&env.security.ipsEnabled&&detection.severity==='critical'){
        logger.warn({requestId:request.id,type:detection.type},'Blocking critical request while security persistence is unavailable');
        return response.status(403).send('Request blocked.');
      }
      return next();
    }
    const block=await activeBlock(ipHash);
    if(block){
      const now=Date.now();
      const nextLogAt=blockHitLogCache.get(ipHash)||0;
      if(nextLogAt<=now){
        boundedSet(blockHitLogCache,ipHash,now+BLOCK_HIT_LOG_TTL_MS);
        Promise.allSettled([
          IpBlock.updateOne({_id:block._id,revokedAt:null},{$inc:{hitCount:1},$set:{lastHitAt:new Date(now)}}),
          writeSecurityEvent(request,'ips.block_hit',{category:'abuse',severity:block.severity==='critical'?'critical':'high',result:'blocked',ipHash,metadata:{blockPublicId:block.publicId,reason:block.reason}}),
        ]).catch(()=>{});
      }
      return response.status(403).send('Request blocked.');
    }
    const detection=threatFromRequest(request);
    if(detection){const event=await writeSecurityEvent(request,detection.type,{category:detection.category,severity:detection.severity,result:'detected',ipHash,metadata:{reason:detection.reason}});const blocked=env.security.ipsEnabled?await thresholdBlock(request,detection,event):false;if(blocked)return response.status(403).send('Request blocked.');}
    response.on('finish',()=>{
      if(!env.security.idsEnabled||!SENSITIVE_PATH.test(request.path||'')||![401,403,429].includes(response.statusCode))return;
      const detection={type:'abuse.sensitive_endpoint_failure',category:'abuse',severity:response.statusCode===429?'high':'medium',reason:`Repeated ${response.statusCode} responses on sensitive endpoints`};
      writeSecurityEvent(request,detection.type,{category:detection.category,severity:detection.severity,result:'failure',statusCode:response.statusCode,ipHash}).then(event=>env.security.ipsEnabled?thresholdBlock(request,detection,event):false).catch(error=>logger.warn({error:error.message},'Security response correlation failed'));
    });
    return next();
  }catch(error){logger.error({error:error.message,requestId:request.id},'Security shield failed');return next();}
}

export function originGuard(request,response,next){
  if(env.security.originGuard.mode!=='header')return next();
  const supplied=String(request.get(env.security.originGuard.header)||'');
  if(supplied&&safeEqual(supplied,env.security.originGuard.secret))return next();
  writeSecurityEvent(request,'origin.guard_rejected',{category:'authorization',severity:'high',result:'blocked'}).catch(()=>{});
  return response.status(403).send('Origin access rejected.');
}

function cefEscape(value){return String(value??'').replaceAll('\\','\\\\').replaceAll('\r','\\r').replaceAll('\n','\\n').replaceAll('|','\\|').replaceAll('=','\\=');}
function cef(event){return `CEF:0|Classic Technologies|Classic Mart|2.13.6|${cefEscape(event.type)}|${cefEscape(event.type)}|${event.severity==='critical'?10:event.severity==='high'?8:event.severity==='medium'?5:2}|rt=${new Date(event.occurredAt).getTime()} request=${cefEscape(event.requestId)} requestMethod=${cefEscape(event.method)} requestContext=${cefEscape(event.path)} outcome=${cefEscape(event.result)} cs1Label=country cs1=${cefEscape(event.country)} cs2Label=actor cs2=${cefEscape(event.actorPublicId)} cs3Label=ipHash cs3=${cefEscape(event.ipHash)} cs4Label=userAgentHash cs4=${cefEscape(event.userAgentHash)}`;}
function exportPayload(event){return {id:event.publicId,occurredAt:event.occurredAt,requestId:event.requestId,type:event.type,category:event.category,severity:event.severity,result:event.result,country:event.country,actorPublicId:event.actorPublicId,ipHash:event.ipHash,userAgentHash:event.userAgentHash,method:event.method,path:event.path,statusCode:event.statusCode,metadata:event.metadata};}

async function sendUdp(body){return new Promise((resolve,reject)=>{const socket=dgram.createSocket('udp4');const buffer=Buffer.from(body);const timer=setTimeout(()=>{socket.close();reject(new Error('SIEM UDP timeout'));},env.security.siem.timeoutMs);socket.send(buffer,env.security.siem.udpPort,env.security.siem.udpHost,(error)=>{clearTimeout(timer);socket.close();if(error)reject(error);else resolve();});});}
async function sendHttp(body,contentType){const headers={'content-type':contentType,'user-agent':'Classic-Mart-SIEM/2.13.6'};if(env.security.siem.token)headers.authorization=`Bearer ${env.security.siem.token}`;const response=await fetch(env.security.siem.url,{method:'POST',headers,body,signal:AbortSignal.timeout(env.security.siem.timeoutMs)});if(!response.ok)throw new Error(`SIEM HTTP ${response.status}`);}

async function siemDeliveryIncident(event,errorMessage){
  const title='SIEM security-event delivery exhausted retries';
  const existing=await Incident.findOne({status:{$ne:'resolved'},severity:'sev2',title,createdAt:{$gt:new Date(Date.now()-60*60_000)}});
  if(!existing)await Incident.create({publicId:publicId('inc'),country:event.country||'',severity:'sev2',title,summary:`Security event ${event.publicId} could not be delivered to the configured SIEM after repeated retries.`,timeline:[{type:'security.siem_delivery_dead',message:String(errorMessage||'SIEM delivery exhausted retries').slice(0,500)}]});
  await writeSecurityEvent(null,'security.siem_delivery_dead',{category:'operations',severity:'high',result:'error',country:event.country,ipHash:hashValue('siem-system'),userAgentHash:hashValue('siem-system'),metadata:{eventPublicId:event.publicId,error:String(errorMessage||'').slice(0,300)}});
}

async function integrityIncident(event){
  const title='Security event integrity verification failed';
  const existing=await Incident.findOne({status:{$ne:'resolved'},severity:'sev1',title,createdAt:{$gt:new Date(Date.now()-60*60_000)}});
  if(!existing)await Incident.create({publicId:publicId('inc'),country:event.country||'',severity:'sev1',title,summary:`Security event ${event.publicId} failed HMAC verification and was refused SIEM export.`,timeline:[{type:'security.integrity_failure',message:`Refused export of ${event.publicId}.`} ]});
  await writeSecurityEvent(null,'security.event_integrity_failure',{category:'integrity',severity:'critical',result:'error',country:event.country,ipHash:hashValue('integrity-system'),userAgentHash:hashValue('integrity-system'),metadata:{eventPublicId:event.publicId}});
}

export async function processSiemQueue({limit=50}={}){
  if(env.security.siem.mode==='off')return {sent:0,failed:0,dead:0,disabled:true};
  const rows=await SecurityEvent.find({siemStatus:{$in:['pending','retry']},siemNextAttemptAt:{$lte:new Date()}}).select('+integrity +ipHash +userAgentHash').sort({siemNextAttemptAt:1}).limit(Math.min(Math.max(Number(limit)||50,1),200));
  let sent=0,failed=0,dead=0;
  for(const row of rows){
    if(!verifySecurityEventIntegrity(row.toObject())){row.siemStatus='dead';row.siemLastError='Integrity verification failed';row.siemLastAttemptAt=new Date();await row.save();dead+=1;await integrityIncident(row);continue;}
    try{
      const body=env.security.siem.format==='cef'?cef(row):JSON.stringify(exportPayload(row));
      if(env.security.siem.mode==='udp')await sendUdp(body);else await sendHttp(body,env.security.siem.format==='cef'?'application/cef':'application/json');
      row.siemStatus='sent';row.siemAttempts+=1;row.siemLastAttemptAt=new Date();row.siemSentAt=new Date();row.siemLastError='';await row.save();sent+=1;
    }catch(error){
      row.siemAttempts+=1;row.siemLastAttemptAt=new Date();row.siemLastError=String(error.message||'SIEM delivery failed').slice(0,500);row.siemStatus=row.siemAttempts>=8?'dead':'retry';row.siemNextAttemptAt=new Date(Date.now()+Math.min(60,2**Math.min(row.siemAttempts,6))*60_000);await row.save();if(row.siemStatus==='dead'){dead+=1;await siemDeliveryIncident(row,row.siemLastError);}else failed+=1;
    }
  }
  return {sent,failed,dead,disabled:false};
}

export async function securityRetention({force=false}={}){
  const now=Date.now();
  if(!force&&now-lastRetentionAt<60*60_000)return {deleted:0,skipped:true};
  lastRetentionAt=now;
  const normalBefore=new Date(now-env.security.eventRetentionDays*24*60*60_000);
  const highBefore=new Date(now-env.security.highEventRetentionDays*24*60*60_000);
  const [normalResult,highResult]=await Promise.all([
    SecurityEvent.deleteMany({occurredAt:{$lt:normalBefore},severity:{$in:['low','medium']},siemStatus:{$in:['sent','disabled']}}),
    SecurityEvent.deleteMany({occurredAt:{$lt:highBefore},severity:{$in:['high','critical']},siemStatus:{$in:['sent','disabled']}}),
  ]);
  await IpBlock.deleteMany({expiresAt:{$lt:new Date(now-7*24*60*60_000)}});
  return {deleted:normalResult.deletedCount+highResult.deletedCount,deletedNormal:normalResult.deletedCount,deletedHigh:highResult.deletedCount,skipped:false};
}
