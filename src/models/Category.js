import mongoose from 'mongoose';

const { Schema } = mongoose;

const attributeSchema = new Schema(
  {
    key: { type: String, required: true, trim: true, maxlength: 60 },
    label: { type: String, required: true, trim: true, maxlength: 80 },
    type: {
      type: String,
      required: true,
      enum: ['text', 'number', 'boolean', 'select'],
    },
    required: { type: Boolean, default: false },
    options: {
      type: [{ type: String, trim: true, maxlength: 80 }],
      default: [],
    },
  },
  { _id: false },
);

const categorySchema = new Schema(
  {
    publicId: {
      type: String,
      required: true,
      unique: true,
      immutable: true,
      index: true,
    },
    name: { type: String, required: true, trim: true, maxlength: 100 },
    slug: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
      maxlength: 100,
      index: true,
    },
    description: { type: String, trim: true, maxlength: 500, default: '' },
    active: { type: Boolean, default: true, index: true },
    restricted: { type: Boolean, default: false, index: true },
    countries: {
      type: [
        {
          type: String,
          uppercase: true,
          minlength: 2,
          maxlength: 2,
        },
      ],
      default: [],
    },
    attributes: {
      type: [attributeSchema],
      validate: {
        validator: (items) => items.length <= 30,
        message: 'A category can define at most 30 attributes.',
      },
      default: [],
    },
    createdByUserId: { type: Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true },
);

categorySchema.index({ active: 1, name: 1 });

export const Category = mongoose.model('Category', categorySchema);
