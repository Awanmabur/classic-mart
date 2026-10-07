import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const read=(file)=>fs.readFileSync(new URL(`../${file}`,import.meta.url),'utf8');

test('verification is enabled by default and bypass is restricted to development and testing',()=>{
  const env=read('src/config/env.js');
  const example=read('.env.example');
  assert.match(env,/simpleLoginMode\s*=\s*nodeEnv\s*!==\s*'production'\s*&&\s*boolean\(process\.env\.SIMPLE_LOGIN,\s*false\)/);
  assert.match(env,/auth:\s*Object\.freeze\(\{[\s\S]*simpleLogin:\s*simpleLoginMode/);
  assert.match(example,/^SIMPLE_LOGIN=false$/m);
  const signup=read('views/signup.ejs');
  assert.doesNotMatch(signup,/verify your email before choosing a workspace/i);
});

test('login accepts email and password only and immediately establishes a session in simple mode',()=>{
  const validation=read('src/validation/identity.js');
  const identity=read('src/routes/identity.js');
  const login=read('views/login.ejs');
  assert.match(validation,/loginSchema\s*=\s*z\.object\(\{[\s\S]*email:\s*z\.string\(\)\.trim\(\)\.email\(\)/);
  const loginBlock=validation.slice(validation.indexOf('export const loginSchema'),validation.indexOf('export const codeSchema'));
  assert.doesNotMatch(loginBlock,/identity:/);
  assert.doesNotMatch(loginBlock,/remember:/);
  assert.match(identity,/authenticate\(input\.email,\s*input\.password,\s*request\)/);
  assert.match(identity,/env\.auth\.simpleLogin/);
  assert.match(identity,/establishSession\(request,\s*user,\s*false\)/);
  assert.match(login,/name="email"/);
  assert.match(login,/type="email"/);
  assert.doesNotMatch(login,/Email or phone number/i);
  assert.doesNotMatch(login,/name="remember"/);
  assert.doesNotMatch(login,/Keep me signed in/i);
});

test('simple login bypasses MFA verification and onboarding gates without removing the underlying features',()=>{
  const auth=read('src/middleware/auth.js');
  const identity=read('src/routes/identity.js');
  assert.match(auth,/requireVerified[\s\S]*env\.auth\.simpleLogin[\s\S]*return next\(\)/);
  assert.match(auth,/requireOnboarding[\s\S]*env\.auth\.simpleLogin[\s\S]*return next\(\)/);
  assert.match(auth,/enforcePrivilegedMfaEnrollment[\s\S]*env\.auth\.simpleLogin[\s\S]*return next\(\)/);
  assert.match(identity,/if \(!env\.auth\.simpleLogin && user\.security\?\.mfaEnabled\)/);
  assert.match(identity,/if \(!env\.auth\.simpleLogin\) \{[\s\S]*verify-email[\s\S]*verify-phone[\s\S]*onboarding/);
  assert.match(identity,/router\.get\('\/mfa'/);
  assert.match(identity,/router\.get\('\/verify-email'/);
});

test('signup does not force OTP or onboarding while simple login mode is enabled',()=>{
  const service=read('src/services/auth.js');
  const identity=read('src/routes/identity.js');
  assert.match(service,/env\.auth\.simpleLogin\s*\?\s*undefined\s*:\s*await issueCode/);
  assert.match(identity,/if \(env\.auth\.simpleLogin\)[\s\S]*account was created[\s\S]*response\.redirect\(loginDestination\(user\)\)/i);
});

test('production retains required OTP and privileged MFA configuration checks',()=>{
  const env=read('src/config/env.js');
  assert.match(env,/SMS_MODE !== 'disabled' && !smsConfigured/);
  assert.match(env,/nodeEnv === 'production' \? 'disabled' : 'log'/);
  assert.match(env,/SMS_MODE === 'esms' && process\.env\.ESMS_API_KEY\?\.startsWith\('esms_live_'\)/);
  assert.match(env,/SMS_MODE === 'twilio' && process\.env\.TWILIO_ACCOUNT_SID/);
  assert.match(env,/if \(!simpleLoginMode && !boolean\(process\.env\.PRIVILEGED_MFA_REQUIRED, true\)\)/);
});
