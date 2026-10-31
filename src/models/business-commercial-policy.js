import mongoose from 'mongoose';

export const businessCommercialPolicySchema = new mongoose.Schema({
  returnWindowDays: { type: Number, required: true, min: 0, max: 365 },
  platformFeeBps: { type: Number, required: true, min: 0, max: 5000 },
  taxBps: { type: Number, required: true, min: 0, max: 10000 },
  policyVersion: { type: String, required: true, maxlength: 40 },
}, { _id: false });
