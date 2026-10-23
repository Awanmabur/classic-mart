import { z } from 'zod';
import { AppError } from '../core/errors.js';
import { Cart, CustomerCatalogueState, ProductVariant } from '../models/index.js';
import { currentCustomerAccess, customerTransaction } from './customer-access.js';
import { getOrCreateCart } from './checkout.js';
import { writeAudit } from './audit.js';

const moveSchema = z.object({ variantId: z.string().trim().min(4).max(120), cartVersion: z.coerce.number().int().nonnegative() });

/** Wishlist insertion and removal of exactly the owned variant commit together. */
export async function moveCustomerCartItemToWishlist(request, rawInput) {
  const input = moveSchema.parse(rawInput);
  await currentCustomerAccess(request);
  // Canonical cart creation/guest merging retains the existing checkout behavior.
  const canonical = await getOrCreateCart(request);
  return customerTransaction(async session => {
    const actor = await currentCustomerAccess(request, { session, write: true });
    const cart = await Cart.findOne({ _id: canonical._id, userId: actor._id,
      sessionKey: `account:${actor._id}:${request.country.code}`, country: request.country.code }).session(session);
    if (!cart) throw new AppError('Your cart is unavailable.', 404, 'CART_NOT_FOUND');
    const variant = await ProductVariant.findOne({ publicId: input.variantId }).session(session).lean();
    if (!variant) throw new AppError('Cart item not found.', 404, 'CART_ITEM_NOT_FOUND');
    let state = await CustomerCatalogueState.findOne({ userId: actor._id }).session(session);
    const line = cart.items.find(item => String(item.variantId) === String(variant._id));
    if (!line) {
      // A safe replay succeeds only if this very product was already saved.
      if (state?.wishlistProductIds.some(id => String(id) === String(variant.productId))) return { moved: false, alreadySaved: true };
      throw new AppError('Cart item not found.', 404, 'CART_ITEM_NOT_FOUND');
    }
    if (Number(cart.__v || 0) !== input.cartVersion) throw new AppError('Your cart changed. Reload before moving this item.', 409, 'CART_CHANGED');
    if (String(line.productId) !== String(variant.productId)) throw new AppError('The cart item changed. Reload before continuing.', 409, 'CART_CHANGED');
    if (!state) [state] = await CustomerCatalogueState.create([{ userId: actor._id }], { session });
    if (!state.wishlistProductIds.some(id => String(id) === String(line.productId))) {
      if (state.wishlistProductIds.length >= 500) throw new AppError('Your wishlist is full.', 409, 'WISHLIST_FULL');
      state.wishlistProductIds.push(line.productId);
      await state.save({ session });
    }
    cart.items = cart.items.filter(item => String(item.variantId) !== String(variant._id));
    await cart.save({ session });
    await writeAudit(request, 'customer.cart_item_moved_to_wishlist', { session, targetType: 'cart',
      targetPublicId: cart.publicId, country: cart.country, metadata: { variantPublicId: variant.publicId } });
    return { moved: true, wishlistCount: state.wishlistProductIds.length };
  });
}
