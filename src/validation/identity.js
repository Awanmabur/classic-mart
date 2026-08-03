import { z } from 'zod';

const trimmed = (minimum, maximum) =>
  z.string().trim().min(minimum).max(maximum);

const strongPassword = z
  .string()
  .min(12)
  .max(128)
  .regex(/[a-z]/)
  .regex(/[A-Z]/)
  .regex(/\d/);

export const signUpSchema = z
  .object({
    name: trimmed(2, 120),
    email: z.string().trim().email().max(254),
    phone: z
      .string()
      .trim()
      .min(8)
      .max(30)
      .regex(/^\+?[\d\s()-]+$/),
    password: strongPassword,
    confirmPassword: z.string(),
    acceptTerms: z.literal('on'),
    marketing: z.string().optional(),
    referralCode: z.string().trim().max(24).optional(),
  })
  .refine((input) => input.password === input.confirmPassword, {
    message: 'Passwords do not match.',
    path: ['confirmPassword'],
  });

export const loginSchema = z.object({
  identity: trimmed(3, 254),
  password: z.string().min(1).max(128),
  remember: z.string().optional(),
  next: z.string().max(500).optional(),
});

export const codeSchema = z.object({
  code: z.string().trim().regex(/^\d{6}$/),
});

export const forgotSchema = z.object({
  identity: trimmed(3, 254),
});

export const resetSchema = z
  .object({
    publicId: trimmed(10, 80),
    code: z.string().trim().regex(/^\d{6}$/),
    password: strongPassword,
    confirmPassword: z.string(),
  })
  .refine((input) => input.password === input.confirmPassword, {
    message: 'Passwords do not match.',
    path: ['confirmPassword'],
  });

export const onboardingSchema = z.object({
  role: z.enum(['customer', 'business', 'seller', 'promoter', 'delivery']),
  publicName: trimmed(2, 100),
  businessName: z.string().trim().max(140).optional(),
  focus: z.string().trim().max(120).optional(),
  location: trimmed(2, 180),
  bio: z.string().trim().max(1_000).optional(),
  transport: z.string().trim().max(80).optional(),
  teamSize: z.string().trim().max(30).optional(),
});

export const profileSchema = z.object({
  name: trimmed(2, 120),
  phone: z
    .string()
    .trim()
    .min(8)
    .max(30)
    .regex(/^\+?[\d\s()-]+$/),
  country: z.string().trim().length(2).toUpperCase(),
  currency: z.string().trim().length(3).toUpperCase(),
  locale: z.string().trim().min(2).max(15),
  marketing: z.string().optional(),
});

export const passwordChangeSchema = z
  .object({
    currentPassword: z.string().min(1).max(128),
    password: strongPassword,
    confirmPassword: z.string(),
  })
  .refine((input) => input.password === input.confirmPassword, {
    message: 'Passwords do not match.',
    path: ['confirmPassword'],
  });
