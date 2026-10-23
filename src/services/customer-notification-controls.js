import { z } from 'zod';
import { AppError } from '../core/errors.js';
import { Notification, User } from '../models/index.js';
import { currentCustomerAccess, customerTransaction } from './customer-access.js';
import { assertOptionalProcessing } from './optional-processing.js';
import { writeAudit } from './audit.js';

export async function updateCustomerNotificationPreferences(request, rawInput) {
  const input=z.object({orders:z.string().optional(),wishlist:z.string().optional(),offers:z.string().optional(),club:z.string().optional()}).parse(rawInput);
  const preferences={orders:input.orders==='on',wishlist:input.wishlist==='on',offers:input.offers==='on',club:input.club==='on'};
  await customerTransaction(async session=>{
    const actor=await currentCustomerAccess(request,{session,write:true});
    if(preferences.wishlist||preferences.offers||preferences.club)await assertOptionalProcessing(actor._id,{session});
    await User.updateOne({_id:actor._id,status:'active','security.tokenVersion':actor.security.tokenVersion},{$set:{'preferences.notifications':preferences}},{session});
    await writeAudit(request,'customer.notification_preferences_updated',{session,targetType:'user',targetPublicId:actor.publicId,metadata:preferences});
  });
  return preferences;
}

export async function markCustomerNotificationsRead(request, id=null) {
  return customerTransaction(async session=>{
    const actor=await currentCustomerAccess(request,{session,write:true});
    if(id){
      const notification=await Notification.findOne({publicId:id,userId:actor._id}).session(session);
      if(!notification)throw new AppError('Notification not found.',404,'NOTIFICATION_NOT_FOUND');
      if(!notification.readAt){notification.readAt=new Date();await notification.save({session});}
    }else{
      await Notification.updateMany({userId:actor._id,readAt:null},{$set:{readAt:new Date()}},{session});
    }
    await writeAudit(request,'customer.notifications_read',{session,targetType:'user',targetPublicId:actor.publicId,metadata:{all:!id}});
  });
}
