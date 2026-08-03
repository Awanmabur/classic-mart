import nodemailer from 'nodemailer';
import { env } from '../config/env.js';
import { AppError } from '../core/errors.js';

let transporter;

function getTransporter() {
  if (transporter) return transporter;
  if (env.mailMode !== 'smtp') return null;
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
    auth: { user: env.smtp.user, pass: env.smtp.password },
    pool: true,
    maxConnections: 3,
    maxMessages: 100,
  });
  return transporter;
}

export async function sendVerificationCode({ email, name, code, purpose }) {
  if (env.mailMode === 'log') return { delivered: false, developmentCode: code };

  const reset = purpose === 'password_reset';
  const subject = reset
    ? 'Reset your Classic Mart password'
    : 'Verify your Classic Mart email';
  const heading = reset ? 'Password reset' : 'Verify your email';
  const explanation = reset
    ? 'Use this code to set a new Classic Mart password.'
    : 'Use this code to verify your Classic Mart account.';

  await getTransporter().sendMail({
    from: env.smtp.from,
    to: email,
    subject,
    text: `${heading}\n\nHello ${name},\n\n${explanation}\n\nCode: ${code}\n\nThis code expires in 10 minutes. If you did not request it, ignore this message.`,
    html: `<div style="font-family:Arial,sans-serif;max-width:560px;margin:auto;color:#111a34">
      <h1 style="color:#ff6500">${heading}</h1>
      <p>Hello ${name},</p><p>${explanation}</p>
      <p style="font-size:28px;font-weight:700;letter-spacing:8px">${code}</p>
      <p>This code expires in 10 minutes. If you did not request it, ignore this message.</p>
    </div>`,
  });
  return { delivered: true };
}


export async function sendSupportTicketEmail({ email, name = 'Classic Mart customer', ticketId, subject, message }) {
  if (!email) return { delivered: false };
  if (env.mailMode === 'log') return { delivered: false };
  await getTransporter().sendMail({
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
  await getTransporter().sendMail({ from: env.smtp.from, to: email, subject: String(subject || 'Classic Mart').slice(0,180), text: String(text || '').slice(0,10000) });
  return { delivered: true, developmentSink: false };
}
