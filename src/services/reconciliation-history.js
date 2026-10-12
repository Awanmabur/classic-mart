import mongoose from 'mongoose';
import { AppError } from '../core/errors.js';
import { ReconciliationRun } from '../models/index.js';
import { writeAudit } from './audit.js';
import { queueFinanceAlert } from './finance-notifications.js';

// Recording the result continues an already authorized run. Each money mutation
// independently rechecks current access; this cannot start or repeat a payment.
export async function completeReconciliationHistory(request,run,{checked,matched,updated,failed,errorMessages=[]}){
  const totals={checked,matched,updated,failed};
  if(Object.values(totals).some(value=>!Number.isSafeInteger(value)||value<0)||matched>checked||updated>matched||failed>checked)throw new AppError('Reconciliation result counters are invalid.',500,'RECONCILIATION_TOTAL_INVALID');
  const session=await mongoose.startSession();let result;
  try{await session.withTransaction(async()=>{
    result=await ReconciliationRun.findOneAndUpdate({_id:run._id,country:run.country,startedByUserId:run.startedByUserId,status:'running'},{$set:{...totals,errorMessages:errorMessages.slice(0,100).map(value=>String(value).slice(0,250)),status:failed?'failed':'completed',completedAt:new Date()},$inc:{__v:1}},{session,returnDocument:'after'});
    if(!result)throw new AppError('The reconciliation run already has a recorded result.',409,'RECONCILIATION_RUN_CHANGED');
    await writeAudit(request,'finance.reconciliation_completed',{targetType:'reconciliation_run',targetPublicId:run.publicId,country:run.country,metadata:{...totals,status:result.status},session});
    if(failed)await queueFinanceAlert({country:run.country,kind:'escalation',href:'/finance/reconciliation?country='+run.country+'&selected='+encodeURIComponent(run.publicId)},session);
  });return result;}finally{await session.endSession();}
}
