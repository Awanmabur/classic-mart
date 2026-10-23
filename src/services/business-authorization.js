import mongoose from 'mongoose';
import { BusinessMember, BusinessOrganization, CountrySetting, PlatformGrant } from '../models/index.js';

/** Navigation only: purchasing services always reload authoritative access. */
export async function hydrateBusinessAuthorization(request) {
  const actor = request.user;
  if (actor?.businessMembershipContext) delete actor.businessMembershipContext;
  if (!actor?._id || actor.status !== 'active' || !['customer','business'].includes(actor.role) || actor.platformAccessManagedAt) return null;
  if (await PlatformGrant.exists({ userId: actor._id })) return null;
  const members = await BusinessMember.find({ userId: actor._id, status: 'active', acceptedAt: mongoose.trusted({ $type: 'date' }) }).lean();
  const orgs = await BusinessOrganization.find({ _id: mongoose.trusted({ $in: members.map(row => row.organizationId) }), status: 'active' }).sort({ createdAt: 1 }).lean();
  const valid = orgs.filter(org => {
    const member = members.find(row => String(row.organizationId) === String(org._id));
    return (member.role === 'owner') === (String(org.ownerUserId) === String(actor._id));
  });
  const requested = request.session?.activeBusinessPublicId;
  const org = requested ? valid.find(row => row.publicId === requested) : valid.find(row => String(row.ownerUserId) === String(actor._id)) || valid[0];
  if (!org || !await CountrySetting.exists({ code: org.country, currency: org.currency, active: true, timeZone: mongoose.trusted({ $type: 'string', $ne: '' }) })) return null;
  const context = { active: true, organizationPublicId: org.publicId };
  Object.defineProperty(actor, 'businessMembershipContext', { value: context, configurable: true, enumerable: false });
  return context;
}
