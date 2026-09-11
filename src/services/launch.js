import { LaunchEvidence, SecurityFinding } from '../models/index.js';
import { env } from '../config/env.js';

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

export const RECOVERY_EVIDENCE_KEYS=Object.freeze(new Set(['backup-restore','pitr','rollback']));

export async function ensureLaunchEvidence(){
  for(const [key,label] of REQUIRED_LAUNCH_EVIDENCE){
    await LaunchEvidence.updateOne({key},{$setOnInsert:{key,label,status:'missing'}},{upsert:true});
  }
  return LaunchEvidence.find({key:{$in:REQUIRED_LAUNCH_EVIDENCE.map(([key])=>key)}}).sort({key:1}).lean();
}

export function recoveryEvidenceIssues(evidence,now=new Date()){
  const byKey=new Map(evidence.map(item=>[item.key,item]));
  const issues=[];
  const policy=env.disasterRecovery;
  for(const key of RECOVERY_EVIDENCE_KEYS){
    const item=byKey.get(key);
    if(!item||item.status!=='passed')continue;
    if(!item.verifiedAt)issues.push(`${key}: missing verification timestamp`);
    const validUntil=item.validUntil?new Date(item.validUntil):null;
    if(!validUntil||validUntil<=now)issues.push(`${key}: evidence expired or has no validity window`);
    const ageMs=item.verifiedAt?now-new Date(item.verifiedAt):Infinity;
    if(ageMs>policy.evidenceMaxAgeDays*86_400_000)issues.push(`${key}: evidence is older than ${policy.evidenceMaxAgeDays} days`);
    const metrics=item.recoveryMetrics||{};
    if(key==='pitr'){
      if(!Number.isFinite(Number(metrics.rpoMinutes)))issues.push('pitr: measured RPO is missing');
      else if(Number(metrics.rpoMinutes)>policy.maxRpoMinutes)issues.push(`pitr: measured RPO ${metrics.rpoMinutes}m exceeds ${policy.maxRpoMinutes}m policy`);
    }
    if(key==='backup-restore'||key==='rollback'){
      if(!Number.isFinite(Number(metrics.rtoMinutes)))issues.push(`${key}: measured RTO is missing`);
      else if(Number(metrics.rtoMinutes)>policy.maxRtoMinutes)issues.push(`${key}: measured RTO ${metrics.rtoMinutes}m exceeds ${policy.maxRtoMinutes}m policy`);
    }
    if(key==='backup-restore'&&(!metrics.sourceSnapshotAt||!metrics.restoredAt))issues.push('backup-restore: snapshot/restore timestamps are required');
  }
  return issues;
}

export async function launchReadiness(){
  const evidence=await ensureLaunchEvidence();
  const unresolved=await SecurityFinding.find({severity:{$in:['high','critical']},status:{$in:['open','acceptance_requested']}}).lean();
  const missing=evidence.filter(item=>item.status!=='passed');
  const recoveryIssues=recoveryEvidenceIssues(evidence);
  return {evidence,unresolved,missing,recoveryIssues,recoveryPolicy:env.disasterRecovery,ready:missing.length===0&&unresolved.length===0&&recoveryIssues.length===0};
}
