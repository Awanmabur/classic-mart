import mongoose from 'mongoose';
import { z } from 'zod';
import { AppError } from '../core/errors.js';
import { BusinessInvoice, Order, PurchaseOrder } from '../models/index.js';
import { businessAccess, businessTransaction, businessSame, assertBusinessReadAccess } from './business-access.js';
import { businessInput, assertBusinessVersion } from './business-operations.js';
import { equalBusinessPolicy } from './business-policy.js';
import { writeAudit } from './audit.js';

/** Shared by all payment entry points, including original-issuer and tracked-order URLs. */
export async function authorizeBusinessOrderPayment(request, source, { businessInvoicePublicId, session = null, paymentStart = false } = {}) {
  if (!source?.businessOrganizationId) throw new AppError('Business payment source is unavailable.',404,'BUSINESS_INVOICE_NOT_FOUND');
  const context=await businessAccess(request,{session,capability:'po'});
  const order=await Order.findOne({_id:source._id,businessOrganizationId:context.org._id,country:context.org.country,'totals.currency':context.org.currency}).session(session);
  const invoice=order&&await BusinessInvoice.findOne({_id:order.businessInvoiceId,publicId:businessInvoicePublicId||order.businessInvoicePublicId,orderId:order._id,orderPublicId:order.publicId,organizationId:context.org._id,country:context.org.country,currency:context.org.currency}).session(session);
  const po=invoice&&await PurchaseOrder.findOne({_id:order.purchaseOrderId,organizationId:context.org._id,orderPublicId:order.publicId,invoicePublicId:invoice.publicId}).session(session);
  if(!order||!invoice||!po||!businessSame(invoice.purchaseOrderId,po._id)||invoice.totalMinor!==order.totals.totalMinor||po.totalMinor!==invoice.totalMinor||invoice.paymentTerms!==po.paymentTerms||!equalBusinessPolicy(po.commercialPolicy,order.policySnapshot))throw new AppError('Business invoice not found in your current company.',404,'BUSINESS_INVOICE_NOT_FOUND');
  if(['void','refunded'].includes(invoice.status)||['cancelled','expired','rejected'].includes(po.status))throw new AppError('This business invoice cannot be paid.',409,'BUSINESS_INVOICE_NOT_PAYABLE');
  if(paymentStart){
    const credit=invoice.paymentTerms==='credit';
    if(invoice.paidMinor!==0||(!credit&&invoice.status!=='awaiting_payment')||(credit&&(!invoice.deliveredAt||!['open','overdue'].includes(invoice.status)||order.fulfillmentState!=='delivered')))throw new AppError('This invoice is not awaiting payment.',409,'BUSINESS_INVOICE_NOT_PAYABLE');
  }
  if(!session)await assertBusinessReadAccess(request,context);
  return order;
}
export async function startBusinessInvoicePayment(request,id,input){
  const data=businessInput(z.object({version:z.coerce.number().int().min(0),idempotencyKey:z.string().regex(/^[A-Za-z0-9:_-]{8,120}$/)}).strict(),input);
  const authorized=await businessTransaction(request,'po',async(context,session)=>{
    const invoice=await BusinessInvoice.findOne({publicId:id,organizationId:context.org._id}).session(session);
    if(!invoice)throw new AppError('Business invoice not found.',404,'BUSINESS_INVOICE_NOT_FOUND');assertBusinessVersion(invoice,data.version);
    const source=await Order.findById(invoice.orderId).session(session);const order=await authorizeBusinessOrderPayment(request,source,{businessInvoicePublicId:invoice.publicId,session,paymentStart:true});
    invoice.timeline.push({type:'payment.requested',message:'An authorized company member requested Pesapal payment.',actorUserId:context.actor._id});await invoice.save({session});
    await writeAudit(request,'business.invoice.payment_requested',{actor:context.actor,targetType:'business_invoice',targetPublicId:invoice.publicId,country:invoice.country,session});
    return{orderPublicId:order.publicId,invoicePublicId:invoice.publicId};
  });
  const {initiatePayment}=await import('./payments.js');
  return initiatePayment(request,{orderId:authorized.orderPublicId,idempotencyKey:data.idempotencyKey,businessInvoicePublicId:authorized.invoicePublicId});
}
