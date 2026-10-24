import { publicId } from '../core/ids.js';
import { currentTraceFields, runWithStoredTrace } from '../core/trace.js';
import { MarketingCampaign, OutboxEvent, StoreBroadcast } from '../models/index.js';
import { sendNotificationEmail } from './mail.js';
import { clearStorefrontCache } from './storefront.js';
import { prepareFinanceDigestDelivery, finishFinanceDigestDelivery } from './finance-weekly-reports.js';
import { prepareSupportDigestDelivery, finishSupportDigestDelivery } from './support-weekly-reports.js';
import { prepareSupportTicketDelivery, finishSupportTicketDelivery } from './support-ticket-pages.js';
import { prepareSellerOrderNotificationDelivery } from './customer-notification-policy.js';

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


export async function processNotificationOutbox({ limit = 50, workerId=`notifications:${process.pid}`, leaseMs=60_000, sendEmail=sendNotificationEmail } = {}) {
  let checked=0,processed=0,failed=0;const completedAggregates=new Set();
  for(let i=0;i<Math.min(Math.max(Number(limit)||50,1),100);i++){
    const now=new Date();
    const event=await OutboxEvent.findOneAndUpdate(
      {type:{$in:['marketing.campaign_message','store.broadcast','guest.order_access_code','platform.staff_invitation','seller.team_invitation','seller.verification_notification','catalogue.product_notification','seller.order_notification','finance.weekly_report','support.weekly_report','support.ticket_reply']},availableAt:{$lte:now},$or:[{status:{$in:['pending','failed']}},{status:'processing',lockedUntil:{$lte:now}}]},
      {$set:{status:'processing',lockedBy:workerId,lockedUntil:new Date(now.getTime()+leaseMs)},$inc:{attempts:1}},
      {sort:{createdAt:1},returnDocument:'after'},
    );
    if(!event)break;checked+=1;
    try{
      const financeDigest=event.type==='finance.weekly_report',supportDigest=event.type==='support.weekly_report',supportReply=event.type==='support.ticket_reply',marketingCampaign=event.type==='marketing.campaign_message',storeBroadcast=event.type==='store.broadcast',orderUpdate=event.type==='seller.order_notification';
      const message=financeDigest?await prepareFinanceDigestDelivery(event):supportDigest?await prepareSupportDigestDelivery(event):supportReply?await prepareSupportTicketDelivery(event):marketingCampaign?await (await import('./country-admin-growth-pages.js')).prepareMarketingCampaignDelivery(event):storeBroadcast?await (await import('./seller-growth.js')).prepareStoreBroadcastDelivery(event):orderUpdate?await prepareSellerOrderNotificationDelivery(event):event.type==='seller.team_invitation'?await (await import('./seller-team-pages.js')).prepareStoreTeamInvitationDelivery(event):{email:event.payload?.email,subject:event.payload?.subject,text:event.payload?.body};
      const result=message?await runWithStoredTrace({traceId:event.traceId,spanId:event.traceSpanId},()=>sendEmail(message)):null;
      if(financeDigest&&message)await finishFinanceDigestDelivery(event,result);
      if(supportDigest&&message)await finishSupportDigestDelivery(event,result);
      if(supportReply){
        if(message)await finishSupportTicketDelivery(event,result);
        else{event.payload={...event.payload,deliveryStatus:'cancelled',deliveryProcessedAt:new Date().toISOString()};event.markModified('payload');}
      }
      if(marketingCampaign||storeBroadcast||orderUpdate||event.type==='seller.team_invitation'){event.payload={...event.payload,deliveryStatus:!message?'cancelled':result?.developmentSink?'development_sink':'delivered',deliveryProcessedAt:new Date().toISOString()};event.markModified('payload');}
      event.status='processed';event.processedAt=new Date();event.lastError=!message?(financeDigest?'Finance report':supportDigest?'Support report':marketingCampaign?'Marketing campaign':storeBroadcast?'Store broadcast':orderUpdate?'Order update':event.type==='seller.team_invitation'?'Store team invitation':'Support reply')+' cancelled: current delivery authorization is unavailable.':result?.developmentSink?'Development mail sink: no external email was sent.':'';processed+=1;if(['marketing.campaign_message','store.broadcast'].includes(event.type))completedAggregates.add(event.aggregatePublicId);
    }catch(error){
      event.status=event.attempts>=10?'dead':'failed';event.lastError=String(error.message||error).slice(0,1000);event.availableAt=new Date(Date.now()+Math.min(60,2**Math.min(8,event.attempts))*60_000);failed+=1;
    }
    event.lockedBy='';event.lockedUntil=null;await event.save();
  }
  for(const id of completedAggregates){
    const pending=await OutboxEvent.exists({aggregatePublicId:id,type:{$in:['marketing.campaign_message','store.broadcast']},status:{$in:['pending','processing','failed']}});
    const dead=await OutboxEvent.exists({aggregatePublicId:id,type:'marketing.campaign_message',status:'dead'});
    if(!pending&&!dead){await MarketingCampaign.updateOne({publicId:id,status:'running'},{$set:{status:'completed',completedAt:new Date()}});await StoreBroadcast.updateOne({publicId:id,status:'queued'},{$set:{status:'sent'}});}
  }
  return {checked,processed,failed};
}
