import mongoose from 'mongoose';
import { ROLES } from '../core/roles.js';

const { Schema } = mongoose;

const consentSchema = new Schema(
  {
    terms: { type: Boolean, required: true },
    privacy: { type: Boolean, required: true },
    marketing: { type: Boolean, default: false },
    recordedAt: { type: Date, required: true },
    policyVersion: { type: String, required: true, default: '2026-07' },
  },
  { _id: false },
);

const roleProfileSchema = new Schema(
  {
    publicName: { type: String, trim: true, maxlength: 100 },
    businessName: { type: String, trim: true, maxlength: 140 },
    focus: { type: String, trim: true, maxlength: 120 },
    location: { type: String, trim: true, maxlength: 180 },
    bio: { type: String, trim: true, maxlength: 1_000 },
    transport: { type: String, trim: true, maxlength: 80 },
    teamSize: { type: String, trim: true, maxlength: 30 },
  },
  { _id: false },
);

const userSchema = new Schema(
  {
    publicId: {
      type: String,
      required: true,
      unique: true,
      immutable: true,
      index: true,
    },
    name: { type: String, required: true, trim: true, maxlength: 120 },
    email: { type: String, required: true, trim: true, maxlength: 254 },
    emailNormalized: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      index: true,
      select: false,
    },
    phone: { type: String, required: true, trim: true, maxlength: 30 },
    phoneNormalized: {
      type: String,
      required: true,
      unique: true,
      index: true,
      select: false,
    },
    passwordHash: { type: String, required: true, select: false },
    role: {
      type: String,
      required: true,
      enum: ROLES,
      default: 'customer',
      index: true,
    },
    status: {
      type: String,
      enum: ['active', 'suspended', 'pending_deletion'],
      default: 'active',
      index: true,
    },
    emailVerifiedAt: Date,
    phoneVerifiedAt: Date,
    onboardingCompletedAt: Date,
    country: {
      type: String,
      uppercase: true,
      minlength: 2,
      maxlength: 2,
      default: 'UG',
      index: true,
    },
    currency: { type: String, uppercase: true, default: 'UGX', maxlength: 3 },
    locale: { type: String, default: 'en-UG', maxlength: 15 },
    timeZone: { type: String, default: 'Africa/Kampala', maxlength: 64 },
    consents: { type: consentSchema, required: true },
    roleProfile: { type: roleProfileSchema, default: () => ({}) },
    preferences: { lowData: { type: Boolean, default: false } },
    security: {
      failedLoginCount: { type: Number, default: 0, min: 0 },
      lockedUntil: Date,
      passwordChangedAt: Date,
      tokenVersion: { type: Number, default: 0, min: 0 },
      mfaEnabled: { type: Boolean, default: false },
      mfaSecretEncrypted: { type: String, select: false },
      mfaPendingSecretEncrypted: { type: String, select: false },
      mfaRecoveryCodeHashes: { type: [String], default: undefined, select: false },
      mfaLastCounter: { type: Number, default: -1, min: -1, select: false },
      mfaEnrolledAt: Date,
      mfaRecoveryGeneratedAt: Date,
      lastLoginAt: Date,
      lastLoginIpHash: { type: String, select: false },
    },
  },
  {
    timestamps: true,
    optimisticConcurrency: true,
    toJSON: {
      transform(_document, result) {
        delete result._id;
        delete result.__v;
        delete result.emailNormalized;
        delete result.phoneNormalized;
        delete result.passwordHash;
        delete result.security?.lastLoginIpHash;
        return result;
      },
    },
  },
);

userSchema.index({ country: 1, role: 1, status: 1 });

export const User = mongoose.model('User', userSchema);
