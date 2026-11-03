import {createHmac,timingSafeEqual,createHash} from 'node:crypto';
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const numeric=v=>typeof v==='string'&&/^\d+$/.test(v);
export function verifyMetaSignature(raw,signature,secret){
 if(!Buffer.isBuffer(raw)||typeof signature!=='string'||!/^sha256=[a-f0-9]{64}$/i.test(signature)||!secret)return false;
 const expected=createHmac('sha256',secret).update(raw).digest();
 return timingSafeEqual(expected,Buffer.from(signature.slice(7),'hex'));
}
function httpsUrl(v){try{return typeof v==='string'&&new URL(v).protocol==='https:'?v:null;}catch{return null;}}
export function normalizeMetaEvents(body,pageId,now=Date.now()){
 if(body?.object!=='page'||!Array.isArray(body.entry))throw Error('Invalid payload');
 const rows=[];
 for(const entry of body.entry){
  if(entry.id!==pageId)continue;
  for(const stream of ['messaging','standby']){
   if(entry[stream]!==undefined&&!Array.isArray(entry[stream]))throw Error('Invalid event list');
   for(const e of entry[stream]||[]){
    const m=e.message;if(!m)continue; // delivery/read/postback events are not messages
    if(typeof m.mid!=='string'||!m.mid||!numeric(e.sender?.id)||!numeric(e.recipient?.id))throw Error('Invalid message');
    const echo=m.is_echo===true;
    if((echo?e.sender.id:e.recipient.id)!==pageId)throw Error('Wrong Page direction');
    const customerId=echo?e.recipient.id:e.sender.id;
    if(customerId===pageId)continue;
    const stamp=Number(e.timestamp);
    if(!Number.isFinite(stamp)||stamp<946684800000||stamp>now+300000)throw Error('Invalid message timestamp');
    const items=(Array.isArray(m.attachments)?m.attachments:[]).slice(0,30).map(a=>({type:String(a.type||'file'),url:httpsUrl(a.payload?.url)}));
    let text=typeof m.text==='string'?m.text:'';
    if(!text)text=items.map(a=>({image:'[Hình ảnh]',video:'[Video]',audio:'[Âm thanh]',file:'[Tệp đính kèm]',location:'[Vị trí]'}[a.type]||'[Đính kèm]')).join(' ')||'[Tin nhắn không có văn bản]';
    rows.push({page_id:pageId,customer_id:customerId,mid:m.mid,sender_type:echo?'page':'customer',stream,
     text,created_at:new Date(stamp).toISOString(),attachments:items.length?{facebook:items}:null});
    if(rows.length>1000)throw Error('Too many messages');
   }
  }
 }
 return rows.sort((a,b)=>a.page_id.localeCompare(b.page_id)||a.customer_id.localeCompare(b.customer_id)||a.created_at.localeCompare(b.created_at));
}
export function validateFacebookSend(b){
 if(!uuid.test(b?.request_id||'')||!uuid.test(b?.conversation_id||'')||typeof b?.text!=='string'||!b.text.trim()||b.text.length>2000||b.media_urls?.length||b.attachments)
  throw Error('Chỉ hỗ trợ văn bản 1–2.000 ký tự trong bản này.');
 return {request_id:b.request_id,conversation_id:b.conversation_id,text:b.text.trim()};
}
export function facebookSendBlock(conv,pageId,now=Date.now()){
 if(conv?.platform!=='facebook'||conv.meta_page_id!==pageId||!numeric(conv.customer_id))return 'Hội thoại chưa được xác nhận thuộc Fanpage này. Hãy nhắn thử từ Messenger trước.';
 const stamp=Date.parse(conv.meta_last_customer_at);
 if(!Number.isFinite(stamp)||stamp>now||now-stamp>=86400000)return 'Chưa có tin khách được xác thực trong 24 giờ qua. Khách cần nhắn lại trước khi trả lời qua API.';
 if(conv.meta_last_stream!=='messaging')return 'Hội thoại đang ở luồng chờ (standby). Kiểm tra định tuyến Meta trước khi gửi từ ứng dụng này.';
 return '';
}
export function registerFacebookChat(app,db,auth,{env=process.env,fetcher=fetch}={}){
 const version=env.META_GRAPH_VERSION;
 function configReady(){return /^v\d+\.\d+$/.test(version||'');}
 async function token(){
  const r=await db.from('social_tokens').select('access_token,page_id').eq('platform','facebook').single();
  if(r.error||!r.data?.access_token||!numeric(r.data.page_id))throw Error('Facebook token/Page config unavailable');
  return r.data;
 }
 const graph=(path,t,options={})=>fetcher(`https://graph.facebook.com/${version}/${path}`,{
  ...options,headers:{Authorization:`Bearer ${t.access_token}`,'Content-Type':'application/json',...options.headers},signal:AbortSignal.timeout(15000)});
 app.get('/webhook/facebook',(req,res)=>{
  const verifyToken=env.FB_VERIFY_TOKEN||'BinBinHotel_2026';
  if(req.query['hub.mode']==='subscribe'&&req.query['hub.verify_token']===verifyToken)return res.status(200).send(req.query['hub.challenge']);
  res.sendStatus(403);
 });
 // Optional enrichment only after the durable message transaction has committed.
 async function enrich(profiles,t){
  const unique=new Map(profiles.map(p=>[p.id,p]));
  for(const p of unique.values()){
   const nameMissing=!p.customer_name||/^Khách(?: hàng)?(?:\s+\d+)?$/iu.test(p.customer_name);
   if(!nameMissing&&p.customer_avatar)continue;
   try{
    const response=await graph(`${p.customer_id}?fields=first_name,last_name,profile_pic`,t);
    const b=await response.json();if(!response.ok||b.error)continue;
    const fields={};const name=[b.first_name,b.last_name].filter(x=>typeof x==='string'&&x.trim()).join(' ').trim();
    if(nameMissing&&name)fields.customer_name=name;
    if(!p.customer_avatar&&httpsUrl(b.profile_pic))fields.customer_avatar=b.profile_pic;
    for(const [key,value] of Object.entries(fields)){
     let q=db.from('chat_conversations').update({[key]:value}).eq('id',p.id).eq('meta_page_id',t.page_id);
     q=p[key]===null?q.is(key,null):q.eq(key,p[key]);
     const r=await q;if(r.error)console.warn('Facebook profile update failed',r.error.code);
    }
   }catch{console.warn('Facebook profile unavailable');}
  }
 }
 app.post('/webhook/facebook',async(req,res)=>{
  if(!env.META_APP_SECRET||!configReady())return res.status(503).send('META_CONFIG_REQUIRED');
  if(!verifyMetaSignature(req.rawBody,req.get('x-hub-signature-256'),env.META_APP_SECRET))return res.sendStatus(403);
  if(req.body?.object!=='page')return res.sendStatus(404);
  try{
   const t=await token();const rows=normalizeMetaEvents(req.body,t.page_id);
   if(!rows.length)return res.status(200).send('EVENT_RECEIVED');
   const {data,error}=await db.rpc('binbin_save_facebook_messages',{p_rows:rows});
   if(error){console.error('Facebook webhook DB',error.code);return res.status(503).send('RETRY_DELIVERY');}
   res.status(200).send('EVENT_RECEIVED');
   console.info('Facebook webhook saved',JSON.stringify({events:rows.length,new_messages:(data||[]).filter(p=>p.inserted).length,standby:rows.filter(r=>r.stream==='standby').length}));
   void enrich(data||[],t);
  }catch{console.error('Facebook webhook processing failed');if(!res.headersSent)res.status(503).send('RETRY_DELIVERY');}
 });
 app.get('/api/chat/facebook/config',auth,async(req,res)=>{
  try{
   const t=await token();
   const {error}=await db.from('facebook_send_requests').select('request_id').limit(1);
   if(error)throw Error('Migration/permissions');
   return res.json({success:true,page_id:t.page_id,graph_version:version||null,webhook_secret_configured:!!env.META_APP_SECRET,
    message:'Kiểm tra cấu hình nội bộ; không xác nhận App Review hoặc quyền định tuyến.'});
  }catch{return res.status(503).json({success:false,message:'Kiểm tra migration, SUPABASE_KEY backend, token Facebook và page_id dạng văn bản trong social_tokens.'});}
 });
 app.post('/api/chat/facebook/send',auth,async(req,res)=>{
  let input;try{input=validateFacebookSend(req.body);}catch(e){return res.status(400).json({state:'invalid',message:e.message});}
  const {request_id,conversation_id,text}=input;
  const hash=createHash('sha256').update(JSON.stringify([conversation_id,text])).digest('hex');
  async function remember(fields){const r=await db.from('facebook_send_requests').update(fields).eq('request_id',request_id);return !r.error;}
  async function saveAccepted(job){
   const {data:conv,error}=await db.from('chat_conversations').select('customer_id,meta_page_id,platform').eq('id',conversation_id).single();
   if(error||conv?.platform!=='facebook'||!numeric(conv.meta_page_id))return false;
   const r=await db.rpc('binbin_save_facebook_messages',{p_rows:[{page_id:conv.meta_page_id,customer_id:conv.customer_id,
    mid:job.external_message_id,sender_type:'page',stream:'sendapi',text,attachments:null,created_at:job.sent_at}]});
   return !r.error;
  }
  async function replay(job){
   if(job.payload_hash!==hash||job.conversation_id!==conversation_id)return res.status(409).json({state:'conflict',message:'Mã yêu cầu đã dùng cho nội dung khác.'});
   if(job.status==='accepted')return res.json({success:true,state:'accepted',saved:await saveAccepted(job),message_id:job.external_message_id});
   if(job.status==='rejected')return res.status(422).json({state:'rejected',provider_code:job.provider_code,message:`Facebook từ chối tin (mã ${job.provider_code}). Kiểm tra quyền, token và định tuyến.`});
   return res.status(202).json({state:'unknown',message:'Chưa rõ kết quả yêu cầu này. Kiểm tra Messenger trước khi gửi lại; hệ thống không tự gọi Facebook lần nữa.'});
  }
  let claimed=false;
  try{
   const old=await db.from('facebook_send_requests').select('*').eq('request_id',request_id).maybeSingle();
   if(old.error)return res.status(503).json({state:'not_started',message:'Chưa đọc được sổ gửi tin. Kiểm tra SQL và khóa backend.'});
   if(old.data)return replay(old.data);
   if(!configReady())return res.status(503).json({state:'not_started',message:'Chưa cấu hình META_GRAPH_VERSION trên backend.'});
   const [cr,t]=await Promise.all([db.from('chat_conversations').select('id,platform,customer_id,meta_page_id,meta_last_customer_at,meta_last_stream').eq('id',conversation_id).single(),token()]);
   if(cr.error)return res.status(404).json({state:'invalid',message:'Không tìm thấy hội thoại.'});
   const block=facebookSendBlock(cr.data,t.page_id);if(block)return res.status(409).json({state:'invalid',message:block});
   const claim=await db.from('facebook_send_requests').insert({request_id,conversation_id,payload_hash:hash,status:'sending'});
   if(claim.error){
    if(claim.error.code!=='23505')return res.status(503).json({state:'not_started',message:'Chưa ghi được yêu cầu. Chưa gọi Facebook.'});
    const again=await db.from('facebook_send_requests').select('*').eq('request_id',request_id).single();
    if(again.error)throw Error('Cannot read claim');return replay(again.data);
   }
   claimed=true;
   let response,b;
   try{
    response=await graph(`${t.page_id}/messages`,t,{method:'POST',body:JSON.stringify({recipient:{id:cr.data.customer_id},messaging_type:'RESPONSE',message:{text}})});
    b=await response.json();
   }catch{await remember({status:'unknown'});return res.status(202).json({state:'unknown',message:'Mất kết nối khi gửi. Chưa rõ Facebook đã nhận; kiểm tra Messenger, không tự gửi lại.'});}
   if(response.status>=400&&response.status<500&&Number.isInteger(b.error?.code)){
    const stored=await remember({status:'rejected',provider_code:b.error.code});
    return res.status(stored?422:202).json({state:stored?'rejected':'unknown',provider_code:b.error.code,message:`Facebook từ chối yêu cầu (mã ${b.error.code}). Kiểm tra quyền, định tuyến và cửa sổ trả lời.`});
   }
   if(!response.ok||b.error||typeof b.message_id!=='string'||!b.message_id||b.recipient_id!==cr.data.customer_id){
    await remember({status:'unknown'});return res.status(202).json({state:'unknown',message:'Phản hồi chưa đủ để xác nhận gửi. Kiểm tra Messenger; không tự gửi lại.'});
   }
   const job={status:'accepted',external_message_id:b.message_id,sent_at:new Date().toISOString()};
   const remembered=await remember(job);const saved=await saveAccepted(job);
   return res.json({success:true,state:'accepted',saved:remembered&&saved,message_id:job.external_message_id});
  }catch{return res.status(503).json({state:claimed?'unknown':'not_started',message:claimed?'Chưa xác nhận xong kết quả. Giữ mã yêu cầu và kiểm tra trạng thái.':'Chưa gửi tin. Kiểm tra cấu hình token/Page và kết nối DB.'});}
 });
}
