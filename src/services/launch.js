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

export function launchEvidenceIssues(evidence,now=new Date()){
  const issues=[];
  const maxAgeMs=env.disasterRecovery.evidenceMaxAgeDays*86_400_000;
  for(const item of evidence){
    if(item.status!=='passed')continue;
    const verifiedAt=item.verifiedAt?new Date(item.verifiedAt):null;
    const validUntil=item.validUntil?new Date(item.validUntil):null;
    if(!verifiedAt||!Number.isFinite(verifiedAt.getTime())||verifiedAt>now)issues.push(`${item.key}: missing or invalid verification timestamp`);
    if(!validUntil||!Number.isFinite(validUntil.getTime())||validUntil<=now)issues.push(`${item.key}: evidence expired or has no validity window`);
    if(verifiedAt&&Number.isFinite(verifiedAt.getTime())){
      if(now-verifiedAt>maxAgeMs)issues.push(`${item.key}: evidence is older than ${env.disasterRecovery.evidenceMaxAgeDays} days`);
      if(validUntil&&validUntil-verifiedAt>maxAgeMs)issues.push(`${item.key}: validity window exceeds evidence age policy`);
    }
  }
  return issues;
}

export function satisfiesLaunchEvidence(item,now=new Date()){
  return Boolean(item&&item.status==='passed'&&launchEvidenceIssues([item],now).length===0
    &&(!RECOVERY_EVIDENCE_KEYS.has(item.key)||recoveryEvidenceIssues([item],now).length===0));
}

export async function ensureLaunchEvidence(){
  for(const [key,label] of REQUIRED_LAUNCH_EVIDENCE){
    await LaunchEvidence.updateOne({key},{$setOnInsert:{key,label,status:'missing'}},{upsert:true});
  }
  return LaunchEvidence.find({key:{$in:REQUIRED_LAUNCH_EVIDENCE.map(([key])=>key)}}).sort({key:1}).lean();
}

export function recoveryEvidenceIssues(evidence,now=new Date()){
  const byKey=new Map(evidence.map(item=>[item.key,item]));
  const issues=launchEvidenceIssues(evidence.filter(item=>RECOVERY_EVIDENCE_KEYS.has(item.key)),now);
  const policy=env.disasterRecovery;
  for(const key of RECOVERY_EVIDENCE_KEYS){
    const item=byKey.get(key);
    if(!item||item.status!=='passed')continue;
    const metrics=item.recoveryMetrics||{};
    if(key==='pitr'){
      if(typeof metrics.rpoMinutes!=='number'||!Number.isFinite(metrics.rpoMinutes)||metrics.rpoMinutes<0)issues.push('pitr: measured RPO is missing or invalid');
      else if(metrics.rpoMinutes>policy.maxRpoMinutes)issues.push(`pitr: measured RPO ${metrics.rpoMinutes}m exceeds ${policy.maxRpoMinutes}m policy`);
    }
    if(key==='backup-restore'||key==='rollback'){
      if(typeof metrics.rtoMinutes!=='number'||!Number.isFinite(metrics.rtoMinutes)||metrics.rtoMinutes<0)issues.push(`${key}: measured RTO is missing or invalid`);
      else if(metrics.rtoMinutes>policy.maxRtoMinutes)issues.push(`${key}: measured RTO ${metrics.rtoMinutes}m exceeds ${policy.maxRtoMinutes}m policy`);
    }
    if(key==='backup-restore'&&(!metrics.sourceSnapshotAt||!metrics.restoredAt))issues.push('backup-restore: snapshot/restore timestamps are required');
    const snapshot=metrics.sourceSnapshotAt?new Date(metrics.sourceSnapshotAt):null;
    const restored=metrics.restoredAt?new Date(metrics.restoredAt):null;
    if((snapshot&&(!Number.isFinite(snapshot.getTime())||snapshot>now||snapshot>new Date(item.verifiedAt)))
      ||(restored&&(!Number.isFinite(restored.getTime())||restored>now||restored>new Date(item.verifiedAt)))
      ||(snapshot&&restored&&snapshot>restored))issues.push(`${key}: recovery timestamps are invalid or out of order`);
  }
  return issues;
}

export async function launchReadiness(){
  const evidence=await ensureLaunchEvidence();
  const unresolved=await SecurityFinding.find({severity:{$in:['high','critical']},status:{$in:['open','acceptance_requested']}}).lean();
  const missing=evidence.filter(item=>item.status!=='passed');
  const evidenceIssues=launchEvidenceIssues(evidence);
  const recoveryIssues=recoveryEvidenceIssues(evidence);
  return {evidence,unresolved,missing,evidenceIssues,recoveryIssues,recoveryPolicy:env.disasterRecovery,ready:missing.length===0&&unresolved.length===0&&evidenceIssues.length===0&&recoveryIssues.length===0};
}
