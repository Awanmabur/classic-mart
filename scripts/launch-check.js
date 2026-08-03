import 'dotenv/config';
import { connectDatabase, disconnectDatabase } from '../src/config/db.js';
import { env } from '../src/config/env.js';
import { launchReadiness } from '../src/services/launch.js';
const configFailures=[];
if(!env.isProduction)configFailures.push('NODE_ENV must be production for launch sign-off');
if(!env.security.launchCountries.length)configFailures.push('LAUNCH_COUNTRIES is empty');
if(!env.security.privilegedMfaRequired)configFailures.push('PRIVILEGED_MFA_REQUIRED is not true');
if(env.security.siem.mode==='off')configFailures.push('SIEM_MODE is off');
if(!env.security.idsEnabled||!env.security.ipsEnabled)configFailures.push('IDS/IPS must be enabled');
await connectDatabase();
try{
  const readiness=await launchReadiness();
  const failures=[...configFailures,...readiness.missing.map(item=>`${item.key}: ${item.status}`),...readiness.unresolved.map(item=>`${item.publicId}: unresolved ${item.severity} finding` )];
  if(failures.length){console.error('Launch gate blocked:\n- '+failures.join('\n- '));process.exitCode=1;}else console.log(`Stage 12 launch gate passed for ${env.security.launchCountries.join(', ')}.`);
}finally{await disconnectDatabase();}
