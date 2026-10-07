import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { spawn } from 'node:child_process';
import nodemailer from 'nodemailer';

process.env.NODE_ENV = 'test';
process.env.MAIL_MODE = 'smtp';
process.env.SMTP_HOST = 'smtp.gmail.com';
process.env.SMTP_USER = 'verification@example.com';
process.env.SMTP_PASSWORD = 'aaaa bbbb cccc dddd';
process.env.SMTP_FROM = 'verification@example.com';
let options, submitted, reject = false;
nodemailer.createTransport = value => {
  options = value;
  return {
    async sendMail(message) { submitted = message; if(reject) throw new Error('PRIVATE_PROVIDER_RESPONSE'); return {accepted:[message.to],rejected:[]}; },
    async verify() { if(reject) throw new Error('PRIVATE_PROVIDER_RESPONSE'); return true; },
  };
};
const {sendVerificationCode,verifyMailConfiguration} = await import('../src/services/mail.js');

test('Gmail transport requires verified TLS, uses app passwords and escapes user HTML',async()=>{
  await sendVerificationCode({email:'verification@example.com',name:'<a href="https://attacker.invalid">Name</a>',code:'123456',purpose:'verify_email'});
  assert.equal(options.requireTLS,true);
  assert.equal(options.ignoreTLS,false);
  assert.equal(options.tls.rejectUnauthorized,true);
  assert.equal(options.tls.minVersion,'TLSv1.2');
  assert.equal(options.disableFileAccess,true);
  assert.equal(options.disableUrlAccess,true);
  assert.equal(options.auth.pass,'aaaabbbbccccdddd');
  assert.doesNotMatch(submitted.html,/<a href="https:\/\/attacker/);
  assert.match(submitted.html,/&lt;a href=&quot;/);
  assert.match(submitted.text,/123456/);
  assert.deepEqual(await verifyMailConfiguration(),{authenticated:true,encrypted:true});
});

test('SMTP errors do not expose provider responses to users',async()=>{
  reject=true;
  await assert.rejects(sendVerificationCode({email:'verification@example.com',name:'Name',code:'123456',purpose:'verify_email'}),error=>error.code==='MAIL_DELIVERY_FAILED'&&!error.message.includes('PRIVATE_PROVIDER_RESPONSE'));
  await assert.rejects(verifyMailConfiguration(),error=>error.code==='MAIL_VERIFICATION_FAILED'&&!error.message.includes('PRIVATE_PROVIDER_RESPONSE'));
});

test('real SMTP transport refuses STARTTLS downgrade before sending authentication or message',async()=>{
  const commands=[];
  const sockets=new Set();
  const server=net.createServer(socket=>{
    sockets.add(socket);socket.on('close',()=>sockets.delete(socket));socket.write('220 verification SMTP\r\n');let buffer='';
    socket.on('data',chunk=>{buffer+=chunk.toString();let newline;while((newline=buffer.indexOf('\r\n'))>=0){const line=buffer.slice(0,newline);buffer=buffer.slice(newline+2);commands.push(line.split(' ')[0]);if(line.startsWith('EHLO'))socket.write('250-verification\r\n250 AUTH PLAIN LOGIN\r\n');else if(line==='STARTTLS')socket.write('500 TLS unavailable\r\n');else socket.write('500 Unexpected command\r\n');}});
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  try {
    const output=await new Promise((resolve,rejectChild)=>{
      const child=spawn(process.execPath,['scripts/verify-mail.js'],{env:{...process.env,SMTP_HOST:'127.0.0.1',SMTP_PORT:String(server.address().port),SMTP_SECURE:'false'},stdio:['ignore','pipe','pipe']});let stdout='',stderr='';child.stdout.on('data',chunk=>stdout+=chunk);child.stderr.on('data',chunk=>stderr+=chunk);child.on('error',rejectChild);child.on('close',code=>resolve({code,stdout,stderr}));
    });
    assert.equal(output.code,1);
    assert.match(output.stderr,/MAIL_VERIFICATION_FAILED/);
    assert.ok(commands.includes('STARTTLS'));
    assert.ok(!commands.includes('AUTH'));
    assert.ok(!commands.includes('MAIL'));
  } finally { for(const socket of sockets)socket.destroy();await new Promise(resolve=>server.close(resolve)); }
});
