import { ProductAlert, ProductVariant, StockItem } from '../models/index.js';
import mongoose from 'mongoose';
import { AppError } from '../core/errors.js';
import { releaseExpiredReservations } from './checkout.js';
import { stage9Maintenance } from './stage9.js';
import { stage10Maintenance } from './ai.js';
import { processBusinessRecurrence } from './business-operations.js';
import { processCustomerAvatarCleanup } from './customer-avatars.js';
import { sellerSubscriptionMaintenance } from './seller-subscription-operations.js';
import { applyDuePriceSchedules } from './seller-growth.js';
import { processNotificationOutbox } from './outbox.js';
import { deliverWebhookBatch, processPushOutbox, queuePushNotification } from './stage11.js';
import { processSiemQueue, securityRetention } from './security.js';
import { processPesapalEvents } from './payments.js';
import { ageBusinessInvoices } from './business-fulfillment.js';
import { expirePrivacyExports, processPrivacyRequests } from './privacy.js';
import { scanBusinessInvariants } from './invariants.js';
import { scanMaintenanceBatch } from './maintenance-scan.js';
import { expirePlatformGrants } from './platform-grants.js';
import { queueWeeklyFinanceReports } from './finance-weekly-reports.js';
import { queueWeeklySupportReports } from './support-weekly-reports.js';
import { optionalNotificationRecipient } from './customer-notification-policy.js';

let lastInvariantScanAt=0;

async function currentProductState(productId) {
  const variants = await ProductVariant.find({ productId, active: true }).select('_id priceMinor').lean();
  if (!variants.length) return { priceMinor: null, available: 0 };
  const priceMinor = Math.min(...variants.map((variant) => Number(variant.priceMinor)).filter(Number.isFinite));
  const stock = await StockItem.aggregate([
    { $match: { variantId: { $in: variants.map((variant) => variant._id) } } },
    { $group: { _id: null, onHand: { $sum: '$onHand' }, reserved: { $sum: '$reserved' }, damaged: { $sum: '$damaged' }, quarantined: { $sum: '$quarantined' } } },
    { $project: { available: { $max: [0, { $subtract: ['$onHand', { $add: ['$reserved', '$damaged', '$quarantined'] }] }] } } },
  ]);
  return { priceMinor: Number.isFinite(priceMinor) ? priceMinor : null, available: stock[0]?.available || 0 };
}

export async function evaluateProductAlerts({ limit = 250 } = {}) {
  const { rows: alerts, passCompleted } = await scanMaintenanceBatch(ProductAlert, 'product_alerts_active', { status: 'active' }, { limit });
  const cache = new Map();
  let triggered = 0;
  for (const alert of alerts) {
    // A muted alert stays active and can be evaluated after re-enabling alerts.
    if (!await optionalNotificationRecipient(alert.userId, 'wishlist')) continue;
    const key = String(alert.productId);
    let state = cache.get(key);
    if (!state) {
      state = await currentProductState(alert.productId);
      cache.set(key, state);
    }
    const previous = alert.lastKnownPriceMinor;
    const priceDrop = alert.type === 'price_drop' && state.priceMinor != null && (
      (alert.targetPriceMinor != null && state.priceMinor <= alert.targetPriceMinor) ||
      (alert.targetPriceMinor == null && previous != null && state.priceMinor < previous)
    );
    const restocked = alert.type === 'restock' && state.available > 0;
    if (priceDrop || restocked) {
      const session = await mongoose.startSession();
      let claimed = 0;
      try {
        await session.withTransaction(async () => {
          claimed = 0;
          const current = await ProductAlert.findOne({ _id: alert._id, status: 'active' }).session(session).lean();
          if (current && (String(current.productId) !== String(alert.productId) || current.type !== alert.type
            || current.targetPriceMinor !== alert.targetPriceMinor || current.lastKnownPriceMinor !== alert.lastKnownPriceMinor)) return;
          if (!current || !await optionalNotificationRecipient(current.userId, 'wishlist', { session })) return;
          // The queue fences current preferences/privacy in the same transaction.
          // An unavailable recipient leaves the alert active; an outbox failure
          // rolls back its claim so the worker can retry without losing an alert.
          const notification = await queuePushNotification({ userId: current.userId, category: 'wishlist',
            title: priceDrop ? 'Classic Mart price alert' : 'Classic Mart restock alert',
            body: priceDrop ? 'A product you follow has reached your price alert.' : 'A product you follow is back in stock.',
            deepLink: `/open/product/${encodeURIComponent(current.productPublicId)}` }, { session });
          if (!notification) return;
          const updated = await ProductAlert.updateOne({ _id: current._id, status: 'active', __v: current.__v || 0 },
            { $set: { status: 'triggered', triggeredAt: new Date(), lastKnownPriceMinor: state.priceMinor ?? previous }, $inc: { __v: 1 } }, { session });
          if (updated.modifiedCount !== 1) throw new AppError('This product alert changed. Retry its evaluation.', 409, 'PRODUCT_ALERT_CHANGED');
          claimed = 1;
        });
        triggered += claimed;
      } finally { await session.endSession(); }
    } else if (state.priceMinor != null && state.priceMinor !== previous) {
      await ProductAlert.updateOne({ _id: alert._id, status: 'active' }, { $set: { lastKnownPriceMinor: state.priceMinor } });
    }
  }
  return { checked: alerts.length, triggered, passCompleted };
}

export async function runMaintenanceCycle() {
  await releaseExpiredReservations();
  const alerts = await evaluateProductAlerts();
  const stage9 = await stage9Maintenance();
  const pricing = await applyDuePriceSchedules();
  const recurringProcurement = await processBusinessRecurrence();
  const businessInvoices = await ageBusinessInvoices();
  const privacy = await processPrivacyRequests();
  const privacyExpired = await expirePrivacyExports();
  const customerAvatarCleanup = await processCustomerAvatarCleanup();
  const sellerSubscriptions = await sellerSubscriptionMaintenance();
  const platformGrantsExpired = await expirePlatformGrants();
  const pesapal = await processPesapalEvents();
  const financeReports = await queueWeeklyFinanceReports();
  const supportReports = await queueWeeklySupportReports();
  const notifications = await processNotificationOutbox();
  const stage10 = await stage10Maintenance();
  const webhooks = await deliverWebhookBatch();
  const push = await processPushOutbox();
  const siem = await processSiemQueue();
  const securityRetentionResult = await securityRetention();
  let invariants=null;
  if(Date.now()-lastInvariantScanAt>=5*60_000){invariants=await scanBusinessInvariants();lastInvariantScanAt=Date.now();}
  return { alerts, stage9, pricing, recurringProcurement, businessInvoices, privacy, privacyExpired, customerAvatarCleanup, sellerSubscriptions, platformGrantsExpired, pesapal, financeReports, supportReports, notifications, stage10, webhooks, push, siem, securityRetention: securityRetentionResult, invariants };
}
