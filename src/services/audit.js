import { AuditLog } from '../models/index.js';
import { hashValue } from '../core/crypto.js';
import { logger } from '../config/logger.js';

function safeMetadata(metadata) {
  if (!metadata || typeof metadata !== 'object') return undefined;
  return JSON.parse(
    JSON.stringify(metadata, (key, value) => {
      if (/password|token|code|secret|cookie|authorization/i.test(key)) {
        return '[REDACTED]';
      }
      return value;
    }),
  );
}

export async function writeAudit(request, action, options = {}) {
  const document = {
    requestId: request.id,
    actorId: options.actor?._id || request.adminActor?._id || request.user?._id,
    actorPublicId: options.actor?.publicId || request.adminActor?.publicId || request.user?.publicId,
    action,
    targetType: options.targetType,
    targetPublicId: options.targetPublicId,
    country: options.country || request.country?.code,
    result: options.result || 'success',
    ipHash: hashValue(request.ip || ''),
    userAgentHash: hashValue(request.get('user-agent') || ''),
    metadata: safeMetadata(options.metadata),
  };
  if (options.session) {
    // Transactional audit evidence is authoritative: failure must abort the caller's transaction.
    await AuditLog.create([document], { session: options.session });
    return;
  }
  try {
    await AuditLog.create(document);
  } catch (error) {
    logger.error(
      { error: error.message, action, requestId: request.id },
      'Failed to write audit record',
    );
  }
}
