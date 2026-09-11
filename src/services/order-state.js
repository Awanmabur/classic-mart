import { Order, Refund, ReturnRequest, SellerOrder, Shipment } from '../models/index.js';

const ACTIVE_RETURN_STATUSES = new Set(['requested','approved','awaiting_return','received','inspected','refund_pending','refund_processing','exchange_pending']);

export function orderDisplayStatus(order) {
  const cancellation = String(order?.cancellationState || 'none');
  const refund = String(order?.refundState || 'none');
  const fulfillment = String(order?.fulfillmentState || 'unfulfilled');
  const payment = String(order?.paymentState || 'unpaid');
  const returns = String(order?.returnState || 'none');
  if (cancellation === 'cancelled') return 'Cancelled';
  if (cancellation === 'requested' || cancellation === 'processing') return 'Cancellation pending';
  if (refund === 'complete' || payment === 'refunded') return 'Refunded';
  if (refund === 'partial' || payment === 'partially_refunded') return 'Partially refunded';
  if (returns === 'returned') return 'Returned';
  if (returns === 'partial_return') return 'Partially returned';
  if (returns === 'requested') return 'Return in progress';
  if (fulfillment === 'delivered') return 'Delivered';
  if (fulfillment === 'partially_delivered') return 'Partially delivered';
  if (fulfillment === 'shipped') return 'Shipped';
  if (fulfillment === 'partially_shipped') return 'Partially shipped';
  if (fulfillment === 'ready') return 'Ready for dispatch';
  if (fulfillment === 'partially_ready') return 'Partially ready';
  if (fulfillment === 'processing') return 'Processing';
  if (payment === 'credit_due') return 'Payment due';
  if (payment === 'paid') return 'Paid';
  if (payment === 'authorized') return 'Payment authorized';
  if (payment === 'pending') return 'Awaiting payment';
  if (payment === 'failed') return 'Payment failed';
  if (String(order?.status || '') === 'expired') return 'Expired';
  return 'Awaiting payment';
}

export function syncLegacyOrderStatus(order) {
  if (!order) return order;
  if (String(order.status) === 'expired' && order.paymentState === 'failed' && order.cancellationState === 'none') return order;
  if (order.cancellationState === 'cancelled') order.status = 'cancelled';
  else if (order.cancellationState === 'requested' || order.cancellationState === 'processing') order.status = 'cancellation_pending';
  else if (order.refundState === 'complete' || order.paymentState === 'refunded') order.status = 'refunded';
  else if (order.refundState === 'partial' || order.paymentState === 'partially_refunded') order.status = 'partially_refunded';
  else if (order.paymentState === 'failed') order.status = 'payment_failed';
  else if (order.paymentState === 'paid') order.status = 'paid';
  else if (order.paymentState === 'credit_due' || (order.paymentMethod === 'cod' && order.paymentState === 'pending') || order.paymentMethod === 'exchange') order.status = 'confirmed';
  else order.status = 'pending_payment';
  return order;
}

function deriveFulfillmentFromSellerOrders(order, sellerOrders, outboundShipment) {
  if (order.fulfillmentState === 'cancelled' || outboundShipment?.status === 'cancelled') return 'cancelled';
  if (outboundShipment?.status === 'delivered') return 'delivered';
  if (['picked_up','in_transit','rescheduled','return_to_sender'].includes(outboundShipment?.status)) return 'shipped';
  if (!sellerOrders.length) return order.fulfillmentState || 'unfulfilled';
  const statuses = sellerOrders.map(row => row.status);
  const fulfilled = statuses.filter(value => value === 'fulfilled').length;
  const ready = statuses.filter(value => value === 'ready').length;
  const processing = statuses.filter(value => value === 'processing').length;
  if (fulfilled === statuses.length) return outboundShipment?.status === 'delivered' ? 'delivered' : 'shipped';
  if (fulfilled > 0) return 'partially_shipped';
  if (ready === statuses.length) return 'ready';
  if (ready > 0) return 'partially_ready';
  if (processing > 0) return 'processing';
  return 'unfulfilled';
}

export async function refreshOrderLifecycle(orderId, { session } = {}) {
  let orderQuery = Order.findById(orderId);
  if (session) orderQuery = orderQuery.session(session);
  const order = await orderQuery;
  if (!order) return null;

  let sellerQuery = SellerOrder.find({ orderId: order._id }).select('status');
  let shipmentQuery = Shipment.findOne({ orderId: order._id, kind: 'outbound' }).select('status');
  let returnQuery = ReturnRequest.find({ orderId: order._id }).select('status');
  let refundQuery = Refund.find({ orderId: order._id, status: { $in: ['pending','processing','completed'] } }).select('status amountMinor');
  if (session) { sellerQuery = sellerQuery.session(session); shipmentQuery = shipmentQuery.session(session); returnQuery = returnQuery.session(session); refundQuery = refundQuery.session(session); }
  const [sellerOrders, outboundShipment, returns, refunds] = await Promise.all([sellerQuery.lean(), shipmentQuery.lean(), returnQuery.lean(), refundQuery.lean()]);

  order.fulfillmentState = deriveFulfillmentFromSellerOrders(order, sellerOrders, outboundShipment);

  const delivered = order.items.reduce((sum, item) => sum + Number(item.deliveredQuantity || 0), 0);
  const returned = order.items.reduce((sum, item) => sum + Number(item.returnedQuantity || 0), 0);
  if (returns.some(row => ACTIVE_RETURN_STATUSES.has(row.status))) order.returnState = 'requested';
  else if (returned > 0 && returned >= delivered && delivered > 0) order.returnState = 'returned';
  else if (returned > 0) order.returnState = 'partial_return';
  else order.returnState = 'none';

  const refundPending = refunds.some(row => row.status === 'pending');
  const refundProcessing = refunds.some(row => row.status === 'processing');
  const completedRefundMinor = refunds.filter(row => row.status === 'completed').reduce((sum, row) => sum + Number(row.amountMinor || 0), 0);
  if (completedRefundMinor >= Number(order.totals?.totalMinor || 0) && completedRefundMinor > 0) order.refundState = 'complete';
  else if (completedRefundMinor > 0) order.refundState = 'partial';
  else if (refundProcessing) order.refundState = 'processing';
  else if (refundPending) order.refundState = 'pending';
  else order.refundState = 'none';

  if (order.fulfillmentState === 'cancelled') {
    const refundStillMoving = order.refundState === 'pending' || order.refundState === 'processing';
    order.cancellationState = refundStillMoving || order.cancellationState === 'processing' || order.status === 'cancellation_pending'
      ? 'processing'
      : 'cancelled';
  } else if (order.status === 'cancellation_pending') order.cancellationState = 'processing';
  else if (!order.cancellation?.requestedAt && !['cancelled','rejected'].includes(order.cancellationState)) order.cancellationState = 'none';

  if (order.refundState === 'complete') order.paymentState = 'refunded';
  else if (order.refundState === 'partial' && order.paymentState !== 'refunded') order.paymentState = 'partially_refunded';

  syncLegacyOrderStatus(order);
  await order.save(session ? { session } : undefined);
  return order;
}
