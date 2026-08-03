import { publicId } from '../core/ids.js';
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


export async function processNotificationOutbox({ limit = 50 } = {}) {
  const events = await OutboxEvent.find({ type: { $in: ['marketing.campaign_message','store.broadcast'] }, status: { $in: ['pending','failed'] }, availableAt: { $lte: new Date() } }).sort({ createdAt: 1 }).limit(limit);
  let processed = 0; let failed = 0;
  for (const event of events) {
    event.status = 'processing'; event.attempts += 1; await event.save();
    try {
      const result = await sendNotificationEmail({ email: event.payload?.email, subject: event.payload?.subject, text: event.payload?.body });
      event.status = 'processed'; event.processedAt = new Date(); event.lastError = result.developmentSink ? 'Development mail sink: no external email was sent.' : '';
      processed += 1;
    } catch (error) {
      event.status = 'failed'; event.lastError = String(error.message || error).slice(0,1000); event.availableAt = new Date(Date.now() + Math.min(60, 2 ** Math.min(8,event.attempts)) * 60_000); failed += 1;
    }
    await event.save();
  }
  const aggregateIds = [...new Set(events.filter(e=>e.status==='processed').map(e=>e.aggregatePublicId))];
  for (const id of aggregateIds) {
    const pending = await OutboxEvent.exists({ aggregatePublicId:id, type:{ $in:['marketing.campaign_message','store.broadcast'] }, status:{ $in:['pending','processing','failed'] } });
    if (!pending) { await MarketingCampaign.updateOne({ publicId:id, status:'queued' }, { $set:{ status:'sent', sentAt:new Date() } }); await StoreBroadcast.updateOne({ publicId:id, status:'queued' }, { $set:{ status:'sent' } }); }
  }
  return { checked: events.length, processed, failed };
}
