import 'dotenv/config';
import { projectMongoUri } from '../src/core/project-env.js';
import mongoose from 'mongoose';
import { mongoDatabaseName, mongoUriWithDatabase } from '../src/core/mongo-uri.js';
const sourceUri=projectMongoUri();
if(!sourceUri)throw new Error('MONGO_URI is required.');
const targetUri=String(process.env.BACKUP_DRILL_MONGO_URI||'').trim()||mongoUriWithDatabase(sourceUri,'classic-mart-restore-test');
const sourceDb=mongoDatabaseName(sourceUri),targetDb=mongoDatabaseName(targetUri);
if(!/restore-test$/i.test(targetDb))throw new Error('BACKUP_DRILL_MONGO_URI database name must end in restore-test.');
if(sourceDb===targetDb)throw new Error('Restore-test database must be different from the application database.');
const source=mongoose.createConnection(sourceUri,{serverSelectionTimeoutMS:5000});
const target=mongoose.createConnection(targetUri,{serverSelectionTimeoutMS:5000});
await Promise.all([source.asPromise(),target.asPromise()]);
try{
  await target.dropDatabase();
  const available=(await source.db.listCollections().toArray()).map(x=>x.name);
  const wanted=['users','products','productvariants','stockitems','orders','sellerorders','paymentintents','ledgertransactions','auditlogs','securityevents'];
  const copied={};
  for(const name of wanted.filter(name=>available.includes(name))){
    const docs=await source.db.collection(name).find({}).toArray();
    if(docs.length)await target.db.collection(name).insertMany(docs,{ordered:false});
    const restored=await target.db.collection(name).countDocuments();
    if(restored!==docs.length)throw new Error(`${name}: restored ${restored}, expected ${docs.length}`);
    copied[name]=restored;
  }
  if(!Object.keys(copied).length)throw new Error('No critical collections were available to restore.');
  console.log('Logical restore drill passed:',JSON.stringify({sourceDb,targetDb,copied}));
}finally{await Promise.allSettled([source.close(),target.close()]);}
