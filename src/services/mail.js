import nodemailer from 'nodemailer';
import { env } from '../config/env.js';
import { AppError } from '../core/errors.js';

let transporter;

function getTransporter() {
  if (transporter) return transporter;
  if (env.mailMode !== 'smtp') throw new AppError('Email delivery is not configured.', 503, 'MAIL_NOT_CONFIGURED');
  if (!env.smtp.host || !env.smtp.user || !env.smtp.password) {
    throw new AppError(
      'Email delivery is not configured.',
      503,
      'MAIL_NOT_CONFIGURED',
    );
  }
  transporter = nodemailer.createTransport({
    host: env.smtp.host,
    port: env.smtp.port,
    secure: env.smtp.secure,
    auth: { user: env.smtp.user, pass: env.smtp.host.toLowerCase() === 'smtp.gmail.com' ? env.smtp.password.replace(/\s/g, '') : env.smtp.password },
    requireTLS: true,
    ignoreTLS: false,
    tls: { rejectUnauthorized: true, minVersion: 'TLSv1.2' },
    disableFileAccess: true,
    disableUrlAccess: true,
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 30_000,
    pool: true,
    maxConnections: 3,
    maxMessages: 100,
  });
  return transporter;
}

export async function sendVerificationCode({ email, name, code, purpose }) {
  if (env.mailMode === 'log') return { delivered: false, developmentCode: code };

  const safeName = String(name || '').replace(/[&<>"']/g, character => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[character]));
  const reset = purpose === 'password_reset';
  const subject = reset
    ? 'Reset your Classic Mart password'
    : 'Verify your Classic Mart email';
  const heading = reset ? 'Password reset' : 'Verify your email';
  const explanation = reset
    ? 'Use this code to set a new Classic Mart password.'
    : 'Use this code to verify your Classic Mart account.';

  await submitMail({
    from: env.smtp.from,
    to: email,
    subject,
    text: `${heading}\n\nHello ${name},\n\n${explanation}\n\nCode: ${code}\n\nThis code expires in 10 minutes. If you did not request it, ignore this message.`,
    html: `<div style="font-family:Arial,sans-serif;max-width:560px;margin:auto;color:#111a34">
      <h1 style="color:#ff6500">${heading}</h1>
      <p>Hello ${safeName},</p><p>${explanation}</p>
      <p style="font-size:28px;font-weight:700;letter-spacing:8px">${code}</p>
      <p>This code expires in 10 minutes. If you did not request it, ignore this message.</p>
    </div>`,
  });
  return { delivered: true };
}


export async function sendSupportTicketEmail({ email, name = 'Classic Mart customer', ticketId, subject, message }) {
  if (!email) return { delivered: false };
  if (env.mailMode === 'log') return { delivered: false };
  await submitMail({
    from: env.smtp.from,
    to: email,
    subject: `${subject} — ${ticketId}`,
    text: `Hello ${name || 'there'},\n\n${message}\n\nTicket: ${ticketId}\n\nClassic Mart Support`,
  });
  return { delivered: true };
}

export async function sendNotificationEmail({ email, subject, text }) {
  if (!email) throw new AppError('Notification email address is missing.', 422, 'MAIL_RECIPIENT_MISSING');
  if (env.mailMode === 'log') return { delivered: false, developmentSink: true };
  await submitMail({ from: env.smtp.from, to: email, subject: String(subject || 'Classic Mart').slice(0,180), text: String(text || '').slice(0,10000) });
  return { delivered: true, developmentSink: false };
}

// Keep provider responses and credentials out of public errors and logs.
async function submitMail(message) {
  const transport = getTransporter();
  try {
    const result = await transport.sendMail(message);
    if (!result.accepted?.length || result.rejected?.length) throw new Error('Recipient rejected');
    return result;
  } catch {
    throw new AppError('Email delivery failed. Please try again later.', 502, 'MAIL_DELIVERY_FAILED');
  }
}

export async function verifyMailConfiguration() {
  const transport = getTransporter();
  try { await transport.verify(); }
  catch { throw new AppError('SMTP verification failed. Check the host, TLS settings and app password.', 502, 'MAIL_VERIFICATION_FAILED'); }
  return { authenticated: true, encrypted: true };
}
