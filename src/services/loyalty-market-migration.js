import mongoose from 'mongoose';
import { AppError } from '../core/errors.js';
import { LoyaltyAccount } from '../models/LoyaltyAccount.js';

const compoundName='loyalty_user_country_unique';
const validCounter=value=>value===undefined||(Number.isSafeInteger(value)&&value>=0);

/** No balance or history rewrite is permitted by this migration. */
export async function inspectLoyaltyMarketMigration(){
  const cursor=LoyaltyAccount.collection.find({},{projection:{userId:1,country:1,points:1,lifetimeEarned:1,lifetimeRedeemed:1,reversalDebtPoints:1},batchSize:500});
  const invalid=[];let count=0,invalidCount=0;
  try{for await(const row of cursor){
    count++;
    if(!mongoose.isObjectIdOrHexString(row.userId)||!/^[A-Z]{2}$/.test(row.country||'')||!['points','lifetimeEarned','lifetimeRedeemed','reversalDebtPoints'].every(field=>validCounter(row[field]))){invalidCount++;if(invalid.length<100)invalid.push(String(row._id));}
  }}finally{await cursor.close();}
  // Database grouping keeps the dry-run bounded even for a large programme.
  // Samples are capped; the counts still include every conflicting source.
  const duplicateGroups=await LoyaltyAccount.collection.aggregate([{$group:{_id:{userId:'$userId',country:'$country'},count:{$sum:1}}},{$match:{count:{$gt:1}}},{$facet:{samples:[{$limit:100}],total:[{$count:'count'}]}}],{allowDiskUse:true}).toArray();
  const duplicates=(duplicateGroups[0]?.samples||[]).map(row=>String(row._id.userId)+':'+row._id.country),duplicateCount=Number(duplicateGroups[0]?.total?.[0]?.count||0);
  let indexes=[];try{indexes=await LoyaltyAccount.collection.indexes();}catch(error){if(error.code!==26)throw error;}
  return {count,invalid,invalidCount,duplicates,duplicateCount,legacyIndexes:indexes.filter(index=>index.unique&&Object.keys(index.key).length===1&&index.key.userId===1).map(index=>index.name)};
}

export async function migrateLoyaltyMarkets(){
  const plan=await inspectLoyaltyMarketMigration();
  if(plan.invalidCount||plan.duplicateCount)throw new AppError('Loyalty market migration requires invalid or duplicate accounts to be reviewed; balances were not changed.',409,'LOYALTY_MIGRATION_PREFLIGHT');
  // The existing global unique index remains in force until its replacement is
  // durably created and independently read back. A failed drop is safe to retry.
  await LoyaltyAccount.collection.createIndex({userId:1,country:1},{unique:true,name:compoundName});
  const indexes=await LoyaltyAccount.collection.indexes();
  if(!indexes.some(index=>index.name===compoundName&&index.unique&&index.key.userId===1&&index.key.country===1&&Object.keys(index.key).length===2))throw new AppError('Loyalty market constraint was not established.',409,'LOYALTY_MIGRATION_INDEX');
  for(const name of plan.legacyIndexes)await LoyaltyAccount.collection.dropIndex(name);
  return {...plan,compoundIndex:compoundName,retiredIndexes:plan.legacyIndexes};
}
