const TIERS = Object.freeze([
  { id: 'classic', label: 'Classic', minSpendMinor: 0, pointsPerTenThousand: 1, returnDays: 7, freeDeliveryMinor: 120000 },
  { id: 'silver', label: 'Silver', minSpendMinor: 250000, pointsPerTenThousand: 2, returnDays: 14, freeDeliveryMinor: 79900 },
  { id: 'gold', label: 'Gold', minSpendMinor: 500000, pointsPerTenThousand: 3, returnDays: 21, freeDeliveryMinor: 49900 },
  { id: 'platinum', label: 'Platinum', minSpendMinor: 1500000, pointsPerTenThousand: 5, returnDays: 30, freeDeliveryMinor: 0 },
]);

export function customerClubSummary(loyaltyAccount, spendMinor = 0) {
  const safeSpend = Number.isSafeInteger(Number(spendMinor)) ? Math.max(0, Number(spendMinor)) : 0;
  let current = TIERS[0];
  for (const tier of TIERS) if (safeSpend >= tier.minSpendMinor) current = tier;
  const next = TIERS[TIERS.indexOf(current) + 1] || null;
  const progressBase = current.minSpendMinor;
  const progressSpan = next ? Math.max(1, next.minSpendMinor - progressBase) : 1;
  const progressPercent = next ? Math.min(100, Math.max(0, Math.round(((safeSpend - progressBase) / progressSpan) * 100))) : 100;
  return {
    current,
    next,
    progressPercent,
    spendMinor: safeSpend,
    remainingMinor: next ? Math.max(0, next.minSpendMinor - safeSpend) : 0,
    points: Math.max(0, Number(loyaltyAccount?.points || 0)),
    lifetimeEarned: Math.max(0, Number(loyaltyAccount?.lifetimeEarned || 0)),
    tiers: TIERS,
  };
}
