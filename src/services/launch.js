import { LaunchEvidence, SecurityFinding } from '../models/index.js';

export const REQUIRED_LAUNCH_EVIDENCE=Object.freeze([
  ['asvs-review','OWASP ASVS 5.0 self/independent review'],
  ['penetration-test','Independent penetration test'],
  ['load-test','Peak load test'],
  ['stress-soak-test','Stress and soak test'],
  ['provider-failure-test','Payment/notification/provider failure exercise'],
  ['backup-restore','Backup restoration drill'],
  ['pitr','Point-in-time recovery proof'],
  ['rollback','Deployment rollback proof'],
  ['waf','Managed WAF and origin-protection proof'],
  ['siem','SIEM ingestion and alert proof'],
  ['on-call','On-call ownership and runbooks'],
  ['incident-exercise','Incident-response tabletop/live exercise'],
  ['staff-training','Privileged staff security training'],
  ['controlled-pilot','Controlled production pilot'],
  ['legal-review','Legal review'],
  ['payment-review','Payment/provider review'],
  ['tax-review','Tax review'],
  ['privacy-review','Privacy/data-protection review'],
  ['marketplace-policy-review','Marketplace policy review'],
]);

export async function ensureLaunchEvidence(){
  for(const [key,label] of REQUIRED_LAUNCH_EVIDENCE){
    await LaunchEvidence.updateOne({key},{$setOnInsert:{key,label,status:'missing'}},{upsert:true});
  }
  return LaunchEvidence.find({key:{$in:REQUIRED_LAUNCH_EVIDENCE.map(([key])=>key)}}).sort({key:1}).lean();
}

export async function launchReadiness(){
  const evidence=await ensureLaunchEvidence();
  const unresolved=await SecurityFinding.find({severity:{$in:['high','critical']},status:{$in:['open','acceptance_requested']}}).lean();
  const missing=evidence.filter(item=>item.status!=='passed');
  return {evidence,unresolved,missing,ready:missing.length===0&&unresolved.length===0};
}
