const plain = value => value?.toObject ? value.toObject() : value;
const evidence = value => (value || []).filter(row => row.publicId).map(row => ({ publicId: row.publicId, description: row.description || '' }));

export function customerReturnDto(document) {
  const row = plain(document);
  if (!row) return null;
  return { publicId: row.publicId, orderPublicId: row.orderPublicId, country: row.country,
    status: row.status, reason: row.reason, details: row.details, resolution: row.resolution,
    returnMethod: row.returnMethod, dropoffPointPublicId: row.dropoffPointPublicId || '',
    eligibleUntil: row.eligibleUntil, policyVersion: row.policyVersion,
    createdAt: row.createdAt, updatedAt: row.updatedAt, version: Number(row.__v ?? row.version ?? 0),
    refundPublicId: row.refundPublicId || '', returnShipmentPublicId: row.returnShipmentPublicId || '',
    replacementOrderPublicId: row.replacementOrderPublicId || '',
    financeReferral: row.financeReferral?.requestedAt ? { requestedAt: row.financeReferral.requestedAt } : null,
    inspection: row.inspection?.inspectedAt ? { condition: row.inspection.condition, inspectedAt: row.inspection.inspectedAt } : null,
    items: (row.items || []).map(item => ({ orderLineId: item.orderLineId, productPublicId: item.productPublicId,
      variantPublicId: item.variantPublicId, title: item.title, variantTitle: item.variantTitle,
      sku: item.sku, quantity: item.quantity, unitPriceMinor: item.unitPriceMinor,
      requestedRefundMinor: item.requestedRefundMinor, inspectedQuantity: item.inspectedQuantity,
      warehouseInspectionStatus: item.warehouseInspectionStatus, intakeReceivedAt: item.intakeReceivedAt || null })),
    evidenceDocumentIds: evidence(row.evidenceDocumentIds),
    timeline: (row.timeline || []).map(event => ({ type: event.type, message: event.message, at: event.at })),
  };
}

export function customerRefundDto(document) {
  const row = plain(document);
  if (!row) return null;
  return { publicId: row.publicId, returnPublicId: row.returnPublicId || '', amountMinor: row.amountMinor,
    currency: row.currency, status: row.status, provider: row.provider,
    completedAt: row.completedAt || null, createdAt: row.createdAt, updatedAt: row.updatedAt };
}
