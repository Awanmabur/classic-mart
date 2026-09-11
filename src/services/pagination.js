import mongoose from 'mongoose';

const MAX_CURSOR_LENGTH=512;

function normalizeDirection(direction){return Number(direction)===1?1:-1;}
function encodeValue(value,type){
  if(type==='date')return new Date(value).toISOString();
  if(type==='number')return Number(value);
  return String(value??'');
}
function decodeValue(value,type){
  if(type==='date'){const d=new Date(value);return Number.isFinite(d.getTime())?d:null;}
  if(type==='number'){const n=Number(value);return Number.isFinite(n)?n:null;}
  return typeof value==='string'?value:null;
}
export function encodeCursor(row,{field='createdAt',type='date'}={}){
  const value=row?.[field],id=row?._id;
  if(value==null||!id)return '';
  return Buffer.from(JSON.stringify({v:encodeValue(value,type),i:String(id)}),'utf8').toString('base64url');
}
export function decodeCursor(raw,{type='date'}={}){
  if(!raw||typeof raw!=='string'||raw.length>MAX_CURSOR_LENGTH)return null;
  try{
    const parsed=JSON.parse(Buffer.from(raw,'base64url').toString('utf8'));
    const value=decodeValue(parsed?.v,type);
    if(value==null||!mongoose.isValidObjectId(parsed?.i))return null;
    return {value,id:new mongoose.Types.ObjectId(parsed.i)};
  }catch{return null;}
}
export function cursorScope(baseScope={},raw,{field='createdAt',direction=-1,type='date'}={}){
  const cursor=decodeCursor(raw,{type});
  if(!cursor)return baseScope;
  const op=normalizeDirection(direction)===1?'$gt':'$lt';
  const boundary={$or:[{[field]:{[op]:cursor.value}},{[field]:cursor.value,_id:{[op]:cursor.id}}]};
  return Object.keys(baseScope||{}).length?{$and:[baseScope,boundary]}:boundary;
}
export function pageResult(rows,{field='createdAt',direction=-1,type='date',limit=50,total=null}={}){
  const hasMore=rows.length>limit;
  const items=hasMore?rows.slice(0,limit):rows;
  return {
    items,
    page:{
      hasMore,
      next:hasMore&&items.length?encodeCursor(items.at(-1),{field,type}):'',
      count:items.length,
      total:Number.isFinite(Number(total))?Number(total):null,
      direction:normalizeDirection(direction),
    },
  };
}
export function cursorSort(field='createdAt',direction=-1){return {[field]:normalizeDirection(direction),_id:normalizeDirection(direction)};}
