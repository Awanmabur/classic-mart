import { env } from '../src/config/env.js';
import { registerPesapalIpn } from '../src/services/pesapal.js';

const url=`${env.baseUrl}/webhooks/pesapal`;
if(!env.baseUrl.startsWith('https://'))throw new Error('BASE_URL must be HTTPS before registering a Pesapal IPN URL.');
const result=await registerPesapalIpn(url,'POST');
console.log(JSON.stringify({url,ipnId:result?.ipn_id||result?.ipnId||'',status:result?.status||'',message:result?.message||''},null,2));
