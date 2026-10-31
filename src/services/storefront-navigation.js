import mongoose from 'mongoose';
import { Category, CountrySetting, Product } from '../models/index.js';
import { publicEligibilityStages } from './storefront.js';

// The shared header needs names and links, not product cards, stock, reviews,
// sales history or the member's saved products. Keep these reads separate from
// full catalogue hydration and retain the same public category approval rules.
export async function storefrontNavigation(country) {
  if (!country?.code || !country.currency) return { categories: [] };
  const [market, categories] = await Promise.all([
    CountrySetting.exists({ code: country.code, currency: country.currency, active: true }),
    Category.find({ active: true, $or: [{ countries: mongoose.trusted({ $size: 0 }) }, { countries: country.code }] })
      .select('_id name slug restricted').sort({ name: 1, _id: 1 }).lean(),
  ]);
  if (!market) return { categories: [] };
  const restrictedIds = categories.filter(category => category.restricted).map(category => category._id);
  const eligible = restrictedIds.length ? await Category.aggregate([
    { $match: { _id: { $in: restrictedIds } } },
    { $lookup: { from: Product.collection.name, let: { categoryId: '$_id' }, pipeline: [
      { $match: { status: 'published', countries: country.code, $expr: { $eq: ['$categoryId', '$$categoryId'] } } },
      ...publicEligibilityStages(country),
      // A header needs proof of one eligible listing, not a count or scan of
      // every published product in every restricted category.
      { $limit: 1 }, { $project: { _id: 1 } },
    ], as: '_publicProduct' } },
    { $match: { '_publicProduct.0': { $exists: true } } },
    { $project: { _id: 1 } },
  ]) : [];
  const visibleRestricted = new Set(eligible.map(row => String(row._id)));
  return { categories: categories
    .filter(category => !category.restricted || visibleRestricted.has(String(category._id)))
    .map(category => ({ id: category.slug, slug: category.slug, name: category.name })) };
}
