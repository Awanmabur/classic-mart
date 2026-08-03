import crypto from 'node:crypto';
import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { publicId } from '../core/ids.js';
import { encryptSensitive } from '../core/sensitive.js';
import { NewsletterSubscription } from '../models/index.js';

const router = Router();
const subscribeLimit = rateLimit({ windowMs: 15 * 60_000, limit: 12, standardHeaders: 'draft-8', legacyHeaders: false });
const schema = z.object({ email: z.string().trim().email().max(254) });

function normalizeEmail(value) { return String(value || '').trim().toLowerCase(); }
function emailHash(value) { return crypto.createHash('sha256').update(value).digest('hex'); }

router.post('/api/v1/newsletter/subscribe', subscribeLimit, async (request, response, next) => {
  try {
    const input = schema.parse(request.body);
    const email = normalizeEmail(input.email);
    const hash = emailHash(email);
    const now = new Date();
    const accountUser = request.user && normalizeEmail(request.user.email) === email ? request.user : null;

    if (accountUser) {
      accountUser.consents.marketing = true;
      accountUser.consents.recordedAt = now;
      await accountUser.save();
    }

    await NewsletterSubscription.findOneAndUpdate(
      { emailHash: hash },
      {
        $set: {
          emailEncrypted: encryptSensitive(email),
          userId: accountUser?._id,
          country: request.country.code,
          status: 'active',
          source: accountUser ? 'account' : 'storefront',
          consentRecordedAt: now,
          lastSubscribedAt: now,
          lastUnsubscribedAt: null,
        },
        $setOnInsert: { publicId: publicId('nws') },
      },
      { upsert: true, returnDocument: 'after', setDefaultsOnInsert: true, runValidators: true },
    );

    response.status(201).set('Cache-Control', 'no-store').json({ subscribed: true, message: 'You are subscribed to Classic Mart updates.' });
  } catch (error) { next(error); }
});

export default router;
