(() => {
  const sidebar=document.getElementById('sidebar');
  const sidebarOverlay=document.getElementById('sidebarOverlay');
  const closeSidebar=()=>{sidebar?.classList.remove('open');sidebarOverlay?.classList.remove('show');document.body.style.overflow='';document.getElementById('mobileMenuBtn')?.setAttribute('aria-expanded','false');};
  document.getElementById('mobileMenuBtn')?.addEventListener('click',()=>{if(sidebar?.classList.contains('open')){closeSidebar();return;}sidebar?.classList.add('open');sidebarOverlay?.classList.add('show');document.body.style.overflow='hidden';document.getElementById('mobileMenuBtn')?.setAttribute('aria-expanded','true');});
  sidebarOverlay?.addEventListener('click',closeSidebar);
  sidebar?.querySelectorAll('a.side-link').forEach((link)=>link.addEventListener('click',closeSidebar));
  const profile=document.getElementById('profileMenu');
  const profileButton=document.getElementById('profileButton');
  const closeProfile=()=>{profile?.classList.remove('show');profileButton?.setAttribute('aria-expanded','false');};
  profileButton?.addEventListener('click',(event)=>{event.stopPropagation();const open=!profile?.classList.contains('show');profile?.classList.toggle('show',open);profileButton.setAttribute('aria-expanded',String(open));});
  document.addEventListener('click',closeProfile);
  document.addEventListener('keydown',(event)=>{if(event.key==='Escape'){closeProfile();closeSidebar();}});
  const csrf=()=>document.querySelector('meta[name="csrf-token"]')?.content||document.querySelector('input[name="_csrf"]')?.value||'';
  document.querySelectorAll('[data-wallet-amount]').forEach((button)=>button.addEventListener('click',()=>{const input=document.getElementById('walletAmount');if(!input)return;input.value=button.dataset.walletAmount||'';document.querySelectorAll('[data-wallet-amount]').forEach((item)=>item.classList.toggle('active',item===button));input.focus();}));
  document.querySelectorAll('[data-address-edit]').forEach((button)=>button.addEventListener('click',()=>{const card=button.closest('[data-address-id]');const form=document.getElementById('addressForm');if(!card||!form)return;form.action=`/addresses/${encodeURIComponent(card.dataset.addressId||'')}`;const set=(name,value)=>{const field=form.elements.namedItem(name);if(field)field.value=value||'';};set('fullName',card.dataset.addressFullName);set('phone',card.dataset.addressPhone);set('address',card.dataset.addressStreet);set('city',card.dataset.addressCity);set('region',card.dataset.addressRegion);set('postalCode',card.dataset.addressPostalCode);set('country',card.dataset.addressCountry);const labels=form.elements.namedItem('label');if(labels?.tagName==='SELECT'&&![...labels.options].some(option=>option.value===card.dataset.addressLabel)){labels.add(new Option(card.dataset.addressLabel,card.dataset.addressLabel));}set('label',card.dataset.addressLabel);set('note',card.dataset.addressNote);const defaultBox=form.elements.namedItem('isDefault');if(defaultBox)defaultBox.checked=card.dataset.addressDefault==='1';const title=document.getElementById('addressFormTitle');if(title)title.textContent='Edit Delivery Address';document.getElementById('addressFormPanel')?.scrollIntoView({behavior:'smooth',block:'start'});}));
  async function api(url,{method='POST',body}={}){const response=await fetch(url,{method,headers:{'content-type':'application/json','x-csrf-token':csrf(),'accept':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});if(!response.ok){let payload={};try{payload=await response.json();}catch{}throw new Error(payload.error?.message||payload.message||(typeof payload.error==='string'?payload.error:'')||'Action failed.');}return response.json();}
  const clearPickupCode=panel=>{const result=panel.querySelector('[data-return-pickup-result]'),button=panel.querySelector('[data-return-pickup-code]');if(result)result.hidden=true;for(const target of panel.querySelectorAll('[data-return-pickup-value],[data-return-pickup-purpose]'))target.textContent='';if(button){button.setAttribute('aria-expanded','false');button.textContent='Show collection code';}};
  document.querySelectorAll('[data-return-pickup-code]').forEach(button=>button.addEventListener('click',async()=>{
    const panel=button.closest('[data-return-pickup]'),status=panel?.querySelector('[data-return-pickup-status]'),result=panel?.querySelector('[data-return-pickup-result]');if(!panel||!status||!result)return;
    if(!result.hidden){clearPickupCode(panel);return;}
    button.disabled=true;status.textContent='Checking your current collection…';status.hidden=false;
    try{const payload=await api('/api/v1/customer/returns/'+encodeURIComponent(button.dataset.returnPickupCode||'')+'/pickup-code',{method:'GET'});if(!/^\d{6}$/.test(String(payload.pickupCode||'')))throw new Error('Your collection code is unavailable.');panel.querySelector('[data-return-pickup-value]').textContent=payload.pickupCode;panel.querySelector('[data-return-pickup-purpose]').textContent=payload.purpose||'Give this code only when the assigned carrier physically collects these goods.';result.hidden=false;status.hidden=true;button.textContent='Hide collection code';button.setAttribute('aria-expanded','true');}
    catch(error){clearPickupCode(panel);status.textContent=error.message;status.hidden=false;}
    finally{button.disabled=false;}
  }));
  window.addEventListener('pagehide',()=>document.querySelectorAll('[data-return-pickup]').forEach(clearPickupCode));
  document.querySelectorAll('[data-wishlist-remove]').forEach(button=>button.addEventListener('click',async()=>{button.disabled=true;try{await api(`/api/v1/storefront/wishlist/${encodeURIComponent(button.dataset.wishlistRemove)}`,{method:'DELETE'});location.reload();}catch(error){window.ClassicMartFlash.show(error.message, { type: 'error' });button.disabled=false;}}));
  document.querySelectorAll('[data-cart-add]').forEach(button=>button.addEventListener('click',async()=>{button.disabled=true;try{await api('/api/v1/cart/items',{body:{productId:button.dataset.product,variantId:button.dataset.variant,quantity:1}});location.href='/cart';}catch(error){window.ClassicMartFlash.show(error.message, { type: 'error' });button.disabled=false;}}));
  document.querySelectorAll('[data-cart-qty]').forEach(button=>button.addEventListener('click',async()=>{button.disabled=true;try{await api(`/api/v1/cart/items/${encodeURIComponent(button.dataset.cartQty)}`,{method:'PATCH',body:{quantity:Number(button.dataset.quantity)}});location.reload();}catch(error){window.ClassicMartFlash.show(error.message, { type: 'error' });button.disabled=false;}}));
  document.querySelectorAll('[data-cart-remove]').forEach(button=>button.addEventListener('click',async()=>{button.disabled=true;try{await api(`/api/v1/cart/items/${encodeURIComponent(button.dataset.cartRemove)}`,{method:'DELETE'});location.reload();}catch(error){window.ClassicMartFlash.show(error.message, { type: 'error' });button.disabled=false;}}));
  document.querySelectorAll('[data-cart-move-wishlist]').forEach(button=>button.addEventListener('click',async()=>{button.disabled=true;try{await api('/api/v1/customer/cart/move-to-wishlist',{body:{variantId:button.dataset.cartMoveWishlist,cartVersion:Number(button.dataset.cartVersion)}});location.reload();}catch(error){window.ClassicMartFlash.show(error.message, { type: 'error' });button.disabled=false;}}));
  document.querySelector('[data-cart-clear]')?.addEventListener('click',async(event)=>{const button=event.currentTarget;button.disabled=true;try{await api('/api/v1/cart',{method:'DELETE'});location.reload();}catch(error){window.ClassicMartFlash.show(error.message, { type: 'error' });button.disabled=false;}});
  document.querySelector('[data-cart-promo]')?.addEventListener('click',async(event)=>{const button=event.currentTarget;const input=document.getElementById('cartPromotionCode');const code=String(input?.value||'').trim();if(!code){input?.focus();return;}button.disabled=true;try{await api('/api/v1/cart/promotions',{body:{code}});location.reload();}catch(error){window.ClassicMartFlash.show(error.message, { type: 'error' });button.disabled=false;}});
  const avatarInput=document.getElementById('customerAvatarInput'),avatarPreview=document.getElementById('customerAvatarPreview'),avatarError=document.getElementById('customerAvatarError');
  let avatarObjectUrl='',avatarSequence=0;
  avatarInput?.addEventListener('change',()=>{
    const file=avatarInput.files?.[0],sequence=++avatarSequence;
    if(avatarObjectUrl){URL.revokeObjectURL(avatarObjectUrl);avatarObjectUrl='';}
    if(avatarError){avatarError.hidden=true;avatarError.textContent='';}
    if(!file)return;
    const invalid=message=>{if(sequence!==avatarSequence)return;avatarInput.value='';if(avatarError){avatarError.textContent=message;avatarError.hidden=false;}};
    if(!['image/jpeg','image/png','image/webp'].includes(file.type)||file.size>5*1024*1024){invalid('Choose a JPEG, PNG or WebP photo up to 5 MB.');return;}
    const previewUrl=URL.createObjectURL(file),image=new Image();avatarObjectUrl=previewUrl;
    image.onload=()=>{if(sequence!==avatarSequence)return;if(image.naturalWidth<320||image.naturalHeight<320){invalid('Choose a photo at least 320 × 320 pixels.');URL.revokeObjectURL(previewUrl);avatarObjectUrl='';return;}if(avatarPreview)avatarPreview.src=previewUrl;};
    image.onerror=()=>{invalid('The selected photo is not a valid image.');URL.revokeObjectURL(previewUrl);if(avatarObjectUrl===previewUrl)avatarObjectUrl='';};
    image.src=previewUrl;
  });
  window.addEventListener('pagehide',()=>{if(avatarObjectUrl)URL.revokeObjectURL(avatarObjectUrl);});
})();
