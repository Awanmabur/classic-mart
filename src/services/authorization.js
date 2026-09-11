import mongoose from 'mongoose';
import { AppError } from '../core/errors.js';

export const PLATFORM_OPERATION_ROLES = Object.freeze(new Set(['warehouse','support','moderator','finance','country_admin','super_admin']));

function normalized(values){return [...new Set((values||[]).filter(Boolean).map(value=>String(value).trim().toUpperCase()).filter(value=>/^[A-Z]{2}$/.test(value)))];}

export function operationalCountriesFor(user){
  if(!user)return [];
  const context=user.authorizationContext;
  if(context?.platformManaged){
    const grants=context.activePlatformGrants||[];
    if(grants.some(grant=>grant.role==='super_admin'))return ['*'];
    return normalized(grants.flatMap(grant=>grant.operationalCountries||[]));
  }
  if(user.role==='super_admin')return ['*'];
  if(!PLATFORM_OPERATION_ROLES.has(user.role))return [];
  const explicit=normalized(user.operationalCountries);
  // Legacy fallback exists only until migrate-production converts privileged users into authoritative PlatformGrant records.
  return explicit.length?explicit:normalized([user.country]);
}

export function canOperateCountry(user,country){
  const scopes=operationalCountriesFor(user),code=String(country||'').toUpperCase();
  return scopes.includes('*')||scopes.includes(code);
}

export function assertOperationalCountry(user,country,message='Resource is outside your operational country scope.'){
  if(!canOperateCountry(user,country))throw new AppError(message,403,'COUNTRY_SCOPE');
}

export function operationalCountryScope(user,field='country'){
  const scopes=operationalCountriesFor(user);
  if(scopes.includes('*'))return {};
  if(!scopes.length)return {[field]:{$in:[]}};
  return scopes.length===1?{[field]:scopes[0]}:{[field]:{$in:scopes}};
}

export function warehouseScopesFor(user){
  const context=user?.authorizationContext;if(!context?.platformManaged)return [];
  const grants=context.activePlatformGrants||[];const warehouseGrant=grants.find(grant=>grant.role==='warehouse');
  return warehouseGrant?[...new Set((warehouseGrant.warehouseScopes||[]).map(v=>String(v||'').trim()).filter(Boolean))]:[];
}

export function canOperateWarehouse(user,warehousePublicId){
  const scopes=warehouseScopesFor(user);return !scopes.length||scopes.includes(String(warehousePublicId||''));
}

export function assertWarehouseScope(user,warehousePublicId,message='Warehouse is outside your assigned scope.'){
  if(!canOperateWarehouse(user,warehousePublicId))throw new AppError(message,403,'WAREHOUSE_SCOPE');
}

export function trustedOperationalCountryScope(user,field='country'){
  return mongoose.trusted(operationalCountryScope(user,field));
}
