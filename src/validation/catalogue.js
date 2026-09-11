import { z } from 'zod';

const cleanText = (minimum, maximum, field) =>
  z
    .string()
    .trim()
    .min(minimum, `${field} is required.`)
    .max(maximum, `${field} is too long.`);

const optionalText = (maximum) =>
  z.string().trim().max(maximum).optional().default('');


const optionalProductVideoUrl = z.string().trim().max(800).optional().default('').superRefine((value, context) => {
  if (!value) return;
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    const allowed = url.protocol === 'https:' && (
      host === 'youtu.be' || host === 'www.youtube.com' || host === 'youtube.com' ||
      host === 'vimeo.com' || host === 'www.vimeo.com'
    );
    if (!allowed) throw new Error('unsupported host');
  } catch {
    context.addIssue({ code: 'custom', message: 'Use one HTTPS YouTube or Vimeo product video URL, or leave it blank.' });
  }
});

const countryCode = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z]{2}$/, 'Choose a valid country.');

export const storeSchema = z.object({
  name: cleanText(2, 140, 'Store name'),
  description: optionalText(1_500),
});

export const verificationSchema = z
  .object({
    sellerType: z.enum(['individual', 'business']),
    legalName: cleanText(2, 180, 'Legal name'),
    registrationNumber: optionalText(80),
    taxNumber: optionalText(80),
    declaration: z.literal('yes', {
      error: 'Accept the declaration before submitting.',
    }),
  })
  .superRefine((value, context) => {
    if (value.sellerType === 'business' && !value.registrationNumber) {
      context.addIssue({
        code: 'custom',
        path: ['registrationNumber'],
        message: 'Business registration number is required.',
      });
    }
  });

export const verificationDecisionSchema = z.object({
  decision: z.enum(['approve', 'reject']),
  reason: optionalText(1_000),
}).superRefine((value, context) => {
  if (value.decision === 'reject' && value.reason.length < 10) {
    context.addIssue({
      code: 'custom',
      path: ['reason'],
      message: 'Give a clear rejection reason of at least 10 characters.',
    });
  }
});

export const verificationAppealSchema = z.object({
  message: cleanText(20, 1_000, 'Appeal message'),
});

export const productSchema = z.object({
  title: cleanText(3, 180, 'Product title'),
  description: cleanText(20, 5_000, 'Description'),
  categoryPublicId: cleanText(5, 100, 'Category'),
  brandPublicId: optionalText(100),
  videoUrl: optionalProductVideoUrl,
  countries: z
    .union([countryCode, z.array(countryCode)])
    .transform((value) => [...new Set(Array.isArray(value) ? value : [value])])
    .pipe(z.array(countryCode).min(1).max(20)),
  tags: optionalText(500).transform((value) =>
    [
      ...new Set(
        value
          .split(',')
          .map((item) => item.trim().toLowerCase())
          .filter(Boolean),
      ),
    ].slice(0, 20),
  ),
});

export const variantSchema = z
  .object({
    sku: z
      .string()
      .trim()
      .toUpperCase()
      .regex(/^[A-Z0-9][A-Z0-9._-]{1,63}$/, 'Use a valid SKU.'),
    barcode: z.string().trim().max(64).regex(/^(?:|[A-Za-z0-9._-]{4,64})$/, 'Use a valid barcode or leave it blank.').optional().default(''),
    title: cleanText(1, 120, 'Variant title'),
    price: z
      .string()
      .trim()
      .regex(/^\d{1,10}(?:\.\d{1,2})?$/, 'Enter a valid non-negative price.'),
    compareAt: z
      .string()
      .trim()
      .regex(/^(?:|\d{1,10}(?:\.\d{1,2})?)$/, 'Enter a valid compare-at price.')
      .default(''),
    weightGrams: z.coerce.number().int().min(0).max(2_000_000).default(0),
    optionName: optionalText(60),
    optionValue: optionalText(80),
    active: z.enum(['yes', 'no']).default('yes'),
  })
  .superRefine((value, context) => {
    if (value.compareAt && Number(value.compareAt) < Number(value.price)) {
      context.addIssue({
        code: 'custom',
        path: ['compareAt'],
        message: 'Compare-at price cannot be lower than the selling price.',
      });
    }
  });

export const mediaMetadataSchema = z.object({
  altText: cleanText(3, 180, 'Image description'),
  position: z.coerce.number().int().min(0).max(30).default(0),
});

export const brandRequestSchema = z.object({
  name: cleanText(2, 100, 'Brand name'),
});

export const brandDecisionSchema = z.object({
  decision: z.enum(['approve', 'reject']),
});

export const categorySchema = z.object({
  name: cleanText(2, 100, 'Category name'),
  description: cleanText(10, 500, 'Category description'),
  restricted: z.enum(['yes', 'no']).default('no'),
  countries: z
    .union([z.literal(''), countryCode, z.array(countryCode)])
    .optional()
    .default('')
    .transform((value) => {
      if (!value) return [];
      return [...new Set(Array.isArray(value) ? value : [value])];
    })
    .pipe(z.array(countryCode).max(20)),
  attributes: optionalText(2_000),
});

export const moderationDecisionSchema = z
  .object({
    decision: z.enum(['approve', 'changes', 'reject']),
    reason: optionalText(1_000),
  })
  .superRefine((value, context) => {
    if (['changes', 'reject'].includes(value.decision) && value.reason.length < 10) {
      context.addIssue({
        code: 'custom',
        path: ['reason'],
        message: 'Explain the required changes in at least 10 characters.',
      });
    }
  });

export const warehouseSchema = z.object({
  name: cleanText(2, 120, 'Warehouse name'),
  country: countryCode,
  city: cleanText(2, 100, 'City'),
  address: cleanText(5, 300, 'Address'),
});

export const stockAdjustmentSchema = z.object({
  variantPublicId: cleanText(5, 100, 'Variant'),
  warehousePublicId: cleanText(5, 100, 'Warehouse'),
  quantity: z.coerce.number().int().min(-1_000_000).max(1_000_000).refine(
    (value) => value !== 0,
    'Quantity cannot be zero.',
  ),
  reason: cleanText(3, 300, 'Reason'),
  reorderPoint: z.coerce.number().int().min(0).max(2_000_000_000).default(0),
});

export const bulkImportSchema = z.object({
  csv: z.string().trim().min(1, 'Paste CSV rows to preview.').max(256_000),
});
