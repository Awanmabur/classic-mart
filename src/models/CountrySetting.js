import mongoose from 'mongoose';

const countrySettingSchema = new mongoose.Schema(
  {
    code: {
      type: String,
      required: true,
      unique: true,
      uppercase: true,
      minlength: 2,
      maxlength: 2,
    },
    name: { type: String, required: true, maxlength: 100 },
    currency: {
      type: String,
      required: true,
      uppercase: true,
      minlength: 3,
      maxlength: 3,
    },
    locale: { type: String, required: true, maxlength: 15 },
    timeZone: { type: String, required: true, maxlength: 64 },
    phonePrefix: { type: String, required: true, maxlength: 8 },
    active: { type: Boolean, default: true, index: true },
    taxBps: { type: Number, min: 0, max: 10000, default: 0 },
    platformFeeBps: { type: Number, min: 0, max: 5000, default: 500 },
    freeStandardShippingThresholdMinor: { type: Number, min: 0, default: 0 },
    returnWindowDays: { type: Number, min: 0, max: 365, default: 30 },
    payments: {
      card: { type: Boolean, default: true },
      mobile: { type: Boolean, default: true },
      cod: { type: Boolean, default: true },
    },
    delivery: {
      standardEnabled: { type: Boolean, default: true },
      expressEnabled: { type: Boolean, default: true },
      pickupEnabled: { type: Boolean, default: true },
      defaultStandardSlaHours: { type: Number, min: 1, max: 720, default: 72 },
      defaultExpressSlaHours: { type: Number, min: 1, max: 720, default: 24 },
      requirePhotoForCod: { type: Boolean, default: true },
      requireSignatureForDelivery: { type: Boolean, default: false },
      requirePhotoForFailedAttempt: { type: Boolean, default: true },
    },
    growth: {
      loyaltyEnabled: { type: Boolean, default: true },
      referralEnabled: { type: Boolean, default: true },
      giftCardsEnabled: { type: Boolean, default: true },
      loyaltyPointsPer1000Minor: { type: Number, min: 0, max: 10000, default: 1 },
      referralRewardPoints: { type: Number, min: 0, max: 1000000, default: 100 },
      promoterCommissionBps: { type: Number, min: 0, max: 5000, default: 300 },
    },
    policyVersion: { type: String, maxlength: 40, default: '2026-07' },
  },
  { timestamps: true, optimisticConcurrency: true },
);

export const CountrySetting = mongoose.model(
  'CountrySetting',
  countrySettingSchema,
);
