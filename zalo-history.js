// Shared by Render webhook and the VPS history service.
export function zaloTime(value) {
 const n=Number(value);
 if(!Number.isFinite(n)||n<1e12||n>9e12)throw Error('Thời gian Zalo không hợp lệ.');
 return new Date(n).toISOString();
}
const types={image:'photo',photo:'photo',gif:'GIF',GIF:'GIF',audio:'voice',voice:'voice',video:'video',sticker:'sticker',file:'file',link:'link',links:'links',location:'location'};
const labels={text:'',image:'[Hình ảnh]',photo:'[Hình ảnh]',gif:'[GIF]',GIF:'[GIF]',audio:'[Tin nhắn thoại]',voice:'[Tin nhắn thoại]',video:'[Video]',sticker:'[Sticker]',file:'[Tệp đính kèm]',link:'[Liên kết]',links:'[Liên kết]',location:'[Vị trí]',business_card:'[Danh thiếp]'};
export function zaloWebhookLabel(event){return labels[String(event||'').replace(/^(user|oa)_send_/,'')]||'[Đính kèm]';}
export function zaloMediaUrl(value){
 try{
  if(typeof value!=='string'||!value.trim())return '';
  const u=new URL(value);
  // Legacy official webhook examples use HTTP CDN URLs. Upgrade only known
  // Zalo CDN domains; never allow arbitrary HTTP or executable schemes.
  if(u.protocol==='http:'&&(/(^|\.)(zdn\.vn|zadn\.vn|zaloapp\.com)$/i.test(u.hostname)))u.protocol='https:';
  return u.protocol==='https:'&&!u.username&&!u.password?u.href:'';
 }catch{return '';}
}
function makeItems(attachments,fallbackType){
 return (Array.isArray(attachments)?attachments:[]).map(a=>{
  const p=a?.payload||{};
  return {type:types[a?.type]||types[fallbackType]||'file',url:zaloMediaUrl(p.url||a?.url),thumb:zaloMediaUrl(p.thumbnail||p.thumb||a?.thumb)};
 }).filter(x=>x.url||x.thumb);
}
function mediaObject(items){
 if(!items.length)return null;
 return {zalo:{type:items[0].type,url:items[0].url,thumb:items[0].thumb,items}};
}
export function zaloWebhookMedia(body){
 const type=String(body?.event_name||'').replace(/^(user|oa)_send_/,'');
 return mediaObject(makeItems(body?.message?.attachments,type));
}
export function normalizeZaloMessage(m,conversationId){
 if(typeof m.message_id!=='string'||!m.message_id||![0,1].includes(m.src))throw Error('Tin Zalo thiếu mã hoặc chiều gửi/nhận.');
 let items=makeItems(m.attachments,m.type);
 if(!items.length){
  const urls=Array.isArray(m.url)?m.url:[m.url];
  items=urls.map(v=>({type:types[m.type]||m.type,url:zaloMediaUrl(v),thumb:zaloMediaUrl(m.thumb)})).filter(x=>x.url||x.thumb);
 }
 return {conversation_id:conversationId,external_message_id:m.message_id,sender_type:m.src===1?'customer':'page',
  message_text:m.type==='text'?String(m.message||''):(labels[m.type]||'[Đính kèm]'),created_at:zaloTime(m.time),attachments:mediaObject(items)};
}
export function legacyOverlap(old,row){
 return old.sender_type===row.sender_type&&old.message_text===row.message_text&&Math.abs(Date.parse(old.created_at)-Date.parse(row.created_at))<=120000;
}
export async function persistZaloMessage(db,row){
 const {data,error}=await db.rpc('binbin_save_zalo_message',{p_row:row});
 if(error)throw Error('Không lưu/bổ sung được tin Zalo. Kiểm tra 01-zalo-media.sql và khóa backend ('+(error.code||'DB')+').');
 return data;
}
export async function saveZaloWebhook(db,row,body){
 const externalId=body.message?.msg_id||body.message?.message_id;
 const message={...row};
 if(typeof externalId==='string'&&externalId)message.external_message_id=externalId;
 if(body.timestamp){try{message.created_at=zaloTime(body.timestamp);}catch{}}
 const media=zaloWebhookMedia(body);if(media)message.attachments=media;
 return persistZaloMessage(db,message);
}
export function registerZaloHistory(app,db,requireAuth){
 const busy=new Set();
 app.post('/api/chat/zalo/history',requireAuth,async(req,res)=>{
  const id=req.body.conversation_id,offset=req.body.offset??0;
  if(typeof id!=='string'||!/^[0-9a-f-]{36}$/i.test(id)||!Number.isSafeInteger(offset)||offset<0||offset>100000)
   return res.status(400).json({message:'Hội thoại hoặc vị trí lịch sử không hợp lệ.'});
  if(busy.has(id))return res.status(409).json({message:'Hội thoại đang đồng bộ, thử lại sau.'});
  busy.add(id);
  try{
   const {data:conv,error:ce}=await db.from('chat_conversations').select('id,customer_id,platform').eq('id',id).single();
   if(ce||conv?.platform!=='zalo')return res.status(404).json({message:'Không tìm thấy hội thoại Zalo.'});
   const {data:token,error:te}=await db.from('social_tokens').select('access_token').eq('platform','zalo').single();
   if(te||!token?.access_token)throw Error('Không đọc được một token OA duy nhất.');
   const query=encodeURIComponent(JSON.stringify({user_id:conv.customer_id,offset,count:10}));
   const response=await fetch(`https://openapi.zalo.me/v2.0/oa/conversation?data=${query}`,{headers:{access_token:token.access_token},signal:AbortSignal.timeout(20000)});
   const body=await response.json();
   if(!response.ok||body.error!==0)return res.status(502).json({message:`Zalo chưa trả lịch sử (HTTP ${response.status}, mã ${body.error??'không rõ'}).`,provider_code:body.error});
   if(!Array.isArray(body.data))throw Error('Zalo trả cấu trúc lịch sử không hợp lệ.');
   const rows=body.data.map(m=>normalizeZaloMessage(m,id));
   let held=0,inserted=0,repaired=0;
   for(const row of rows){
    // Rows carrying the same provider ID can always be repaired. Anonymous
    // legacy rows remain a manual review case; never merge by text/time alone.
    const exact=await db.from('chat_messages').select('id').eq('conversation_id',id).eq('external_message_id',row.external_message_id).maybeSingle();
    if(exact.error)throw Error('Chưa đọc được mã tin đã lưu.');
    if(!exact.data){
     const t=Date.parse(row.created_at);
     const {data:old,error:oe}=await db.from('chat_messages').select('sender_type,message_text,created_at').eq('conversation_id',id).is('external_message_id',null)
      .gte('created_at',new Date(t-120000).toISOString()).lte('created_at',new Date(t+120000).toISOString());
     if(oe)throw Error('Chưa đọc được lịch sử cũ.');
     if((old||[]).some(x=>legacyOverlap(x,row))){held++;continue;}
    }
    const saved=await persistZaloMessage(db,row);if(saved?.inserted)inserted++;if(saved?.media_repaired)repaired++;
   }
   res.json({success:true,fetched:rows.length,inserted,repaired,held_for_review:held,next_offset:offset+rows.length,has_more:rows.length===10});
  }catch(error){console.error('Zalo history:',error.message);res.status(500).json({message:'Đồng bộ chưa hoàn tất. Có thể thử lại; kiểm tra log backend nếu lỗi tiếp diễn.'});}
  finally{busy.delete(id);}
 });
}
