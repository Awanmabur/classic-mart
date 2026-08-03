function numberAtLeastZero(value){
  const parsed=Number(value||0);
  return Number.isFinite(parsed)?Math.max(0,parsed):0;
}

export function remainingProcurementItems(items,covered=new Map()){
  return Array.from(items||[]).map((item)=>{
    const productPublicId=String(item?.productPublicId||'');
    const originalQuantity=numberAtLeastZero(item?.quantity);
    const coveredQuantity=numberAtLeastZero(covered.get(productPublicId));
    return {
      productPublicId,
      quantity:Math.max(0,originalQuantity-coveredQuantity),
      estimatedUnitMinor:numberAtLeastZero(item?.estimatedUnitMinor),
      note:String(item?.note||''),
    };
  }).filter((item)=>item.productPublicId&&item.quantity>0);
}

export function remainingApprovedMinor(items,covered=new Map()){
  return remainingProcurementItems(items,covered).reduce(
    (sum,item)=>sum+(item.estimatedUnitMinor*item.quantity),
    0,
  );
}
