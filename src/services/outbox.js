import { publicId } from '../core/ids.js';
import { currentTraceFields, runWithStoredTrace } from '../core/trace.js';
import { MarketingCampaign, OutboxEvent, StoreBroadcast } from '../models/index.js';
import { sendNotificationEmail } from './mail.js';
import { clearStorefrontCache } from './storefront.js';

export async function addOutboxEvent(
  { type, aggregateType, aggregatePublicId, payload },
  session,
) {
  const [event] = await OutboxEvent.create(
    [
      {
        eventId: publicId('evt'),
        ...currentTraceFields(),
        type,
        aggregateType,
        aggregatePublicId,
        payload,
      },
    ],
    session ? { session } : undefined,
  );
  clearStorefrontCache();
  return event;
}


export async function processNotificationOutbox({ limit = 50, workerId=`notifications:${process.pid}`, leaseMs=60_000 } = {}) {
  let checked=0,processed=0,failed=0;const completedAggregates=new Set();
  for(let i=0;i<Math.min(Math.max(Number(limit)||50,1),100);i++){
    const now=new Date();
    const event=await OutboxEvent.findOneAndUpdate(
      {type:{$in:['marketing.campaign_message','store.broadcast','guest.order_access_code','platform.staff_invitation']},availableAt:{$lte:now},$or:[{status:{$in:['pending','failed']}},{status:'processing',lockedUntil:{$lte:now}}]},
      {$set:{status:'processing',lockedBy:workerId,lockedUntil:new Date(now.getTime()+leaseMs)},$inc:{attempts:1}},
      {sort:{createdAt:1},returnDocument:'after'},
    );
    if(!event)break;checked+=1;
    try{
      const result=await runWithStoredTrace({traceId:event.traceId,spanId:event.traceSpanId},()=>sendNotificationEmail({email:event.payload?.email,subject:event.payload?.subject,text:event.payload?.body}));
      event.status='processed';event.processedAt=new Date();event.lastError=result.developmentSink?'Development mail sink: no external email was sent.':'';processed+=1;if(['marketing.campaign_message','store.broadcast'].includes(event.type))completedAggregates.add(event.aggregatePublicId);
    }catch(error){
      event.status=event.attempts>=10?'dead':'failed';event.lastError=String(error.message||error).slice(0,1000);event.availableAt=new Date(Date.now()+Math.min(60,2**Math.min(8,event.attempts))*60_000);failed+=1;
    }
    event.lockedBy='';event.lockedUntil=null;await event.save();
  }
  for(const id of completedAggregates){
    const pending=await OutboxEvent.exists({aggregatePublicId:id,type:{$in:['marketing.campaign_message','store.broadcast']},status:{$in:['pending','processing','failed']}});
    if(!pending){await MarketingCampaign.updateOne({publicId:id,status:'queued'},{$set:{status:'sent',sentAt:new Date()}});await StoreBroadcast.updateOne({publicId:id,status:'queued'},{$set:{status:'sent'}});}
  }
  return {checked,processed,failed};
}
