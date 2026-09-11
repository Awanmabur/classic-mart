function numberAtLeastZero(value){
  const parsed=Number(value||0);
  return Number.isFinite(parsed)?Math.max(0,parsed):0;
}

export function remainingProcurementItems(items,covered=new Map()){
  return Array.from(items||[]).map((item)=>{
    const productPublicId=String(item?.productPublicId||'');
    const variantPublicId=String(item?.variantPublicId||'');
    const key=variantPublicId||productPublicId;
    const originalQuantity=numberAtLeastZero(item?.quantity);
    const coveredQuantity=numberAtLeastZero(covered.get(key));
    const result={
      productPublicId,
      quantity:Math.max(0,originalQuantity-coveredQuantity),
      estimatedUnitMinor:numberAtLeastZero(item?.estimatedUnitMinor),
      note:String(item?.note||''),
    };
    if(variantPublicId) result.variantPublicId=variantPublicId;
    const storePublicId=String(item?.storePublicId||'');if(storePublicId) result.storePublicId=storePublicId;
    const sku=String(item?.sku||'');if(sku) result.sku=sku;
    const title=String(item?.title||'');if(title) result.title=title;
    const variantTitle=String(item?.variantTitle||'');if(variantTitle) result.variantTitle=variantTitle;
    return result;
  }).filter((item)=>(item.variantPublicId||item.productPublicId)&&item.quantity>0);
}

export function remainingApprovedMinor(items,covered=new Map(),{taxBps=0}={}){
  const subtotal=remainingProcurementItems(items,covered).reduce(
    (sum,item)=>sum+(item.estimatedUnitMinor*item.quantity),
    0,
  );
  const rate=Math.max(0,Math.min(10000,Number(taxBps||0)));
  return subtotal+Math.floor(subtotal*rate/10000);
}

