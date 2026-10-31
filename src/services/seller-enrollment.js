import mongoose from 'mongoose';
import { env } from '../config/env.js';
import { AppError } from '../core/errors.js';
import { PlatformGrant, User } from '../models/index.js';
import { writeAudit } from './audit.js';

async function enrollmentActor(request, session = null) {
  const actor = request.user?._id ? await User.findById(request.user._id).session(session) : null;
  if (!actor || actor.status !== 'active' || request.session?.userId !== String(actor._id) ||
    actor.security.tokenVersion !== request.session?.tokenVersion || actor.security.tokenVersion !== request.user.security?.tokenVersion) {
    throw new AppError('Sign in again before starting your seller account.', 403, 'ACCOUNT_UNAVAILABLE');
  }
  if (!env.auth.simpleLogin && !actor.emailVerifiedAt) throw new AppError('Verify your email before starting your seller account.', 403, 'EMAIL_UNVERIFIED');
  // Managed staff accounts stay dedicated to their approved operational grants,
  // including when a grant has expired or the compatibility role is customer.
  if (actor.platformAccessManagedAt || await PlatformGrant.exists({ userId: actor._id }).session(session) || !['customer', 'seller'].includes(actor.role)) {
    throw new AppError('This account cannot enrol itself as a seller.', 403, 'SELLER_ENROLLMENT_FORBIDDEN');
  }
  return actor;
}

export async function sellerEnrollmentPreview(request) {
  return enrollmentActor(request);
}

export async function enrollCustomerAsSeller(request, input) {
  const session = await mongoose.startSession();
  let actor;
  try {
    await session.withTransaction(async () => {
      actor = await enrollmentActor(request, session);
      // A browser retry or a second concurrent confirmation must not rewrite
      // the now-established seller's profile or emit another enrolment event.
      if (actor.role === 'seller') return;
      if (actor.__v !== input.version) throw new AppError('Your profile changed. Reload this page before starting your seller account.', 409, 'SELLER_ENROLLMENT_CONFLICT');
      actor.role = 'seller';
      actor.roleProfile = {
        publicName: input.publicName, businessName: input.businessName, focus: input.focus,
        location: input.location, bio: input.bio, transport: input.transport, teamSize: input.teamSize,
      };
      actor.onboardingCompletedAt ||= new Date();
      // The optimistic version write fences concurrent grant provisioning and
      // account changes; transaction retries recheck the fresh account above.
      await actor.save({ session });
      await writeAudit(request, 'identity.seller_enrolled', { actor, targetType: 'user', targetPublicId: actor.publicId,
        country: actor.country, metadata: { previousRole: 'customer', role: 'seller' }, session });
    });
    return actor;
  } finally {
    await session.endSession();
  }
}
