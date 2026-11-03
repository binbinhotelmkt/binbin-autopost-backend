import {createHmac,timingSafeEqual,createHash} from 'node:crypto';
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const numeric=v=>typeof v==='string'&&/^\d+$/.test(v);
export function verifyMetaSignature(raw,signature,secret){
 if(!Buffer.isBuffer(raw)||typeof signature!=='string'||!/^sha256=[a-f0-9]{64}$/i.test(signature)||!secret)return false;
 const expected=createHmac('sha256',secret).update(raw).digest();
 return timingSafeEqual(expected,Buffer.from(signature.slice(7),'hex'));
}
function httpsUrl(v){try{return typeof v==='string'&&new URL(v).protocol==='https:'?v:null;}catch{return null;}}
export function normalizeMetaEvents(body,accountId,now=Date.now()){
 if(body?.object!=='instagram'||!Array.isArray(body.entry))throw Error('Invalid payload');
 const rows=[];
 for(const entry of body.entry){
  if(entry.id!==accountId)continue;
  for(const stream of ['messaging','standby']){
   if(entry[stream]!==undefined&&!Array.isArray(entry[stream]))throw Error('Invalid event list');
   for(const e of entry[stream]||[]){
    const m=e.message;if(!m||m.is_deleted)continue; // delivery/read/postback events are not messages
    if(typeof m.mid!=='string'||!m.mid||!numeric(e.sender?.id)||!numeric(e.recipient?.id))throw Error('Invalid message');
    const echo=m.is_echo===true||e.sender.id===accountId;
    if((echo?e.sender.id:e.recipient.id)!==accountId)throw Error('Wrong Instagram direction');
    const customerId=echo?e.recipient.id:e.sender.id;
    if(customerId===accountId)continue;
    const stamp=Number(e.timestamp);
    if(!Number.isFinite(stamp)||stamp<946684800000||stamp>now+300000)throw Error('Invalid message timestamp');
    const items=(Array.isArray(m.attachments)?m.attachments:[]).slice(0,30).map(a=>({type:String(a.type||'file'),url:httpsUrl(a.payload?.url)}));
    let text=typeof m.text==='string'?m.text:'';
    if(!text)text=items.map(a=>({image:'[Hình ảnh]',video:'[Video]',audio:'[Âm thanh]',file:'[Tệp đính kèm]',location:'[Vị trí]'}[a.type]||'[Đính kèm]')).join(' ')||'[Tin nhắn không có văn bản]';
    rows.push({account_id:accountId,customer_id:customerId,mid:m.mid,sender_type:echo?'page':'customer',stream,
     text,created_at:new Date(stamp).toISOString(),attachments:items.length?{instagram:items}:null});
    if(rows.length>1000)throw Error('Too many messages');
   }
  }
 }
 return rows.sort((a,b)=>a.account_id.localeCompare(b.account_id)||a.customer_id.localeCompare(b.customer_id)||a.created_at.localeCompare(b.created_at));
}
export function validateInstagramSend(b){
 if(!uuid.test(b?.request_id||'')||!uuid.test(b?.conversation_id||'')||typeof b?.text!=='string'||!b.text.trim()||Buffer.byteLength(b.text,'utf8')>1000||b.media_urls?.length||b.attachments)
  throw Error('Chỉ gửi văn bản ngắn trong bản này. Tin Instagram quá dài; hãy rút ngắn hoặc chia tin.');
 return {request_id:b.request_id,conversation_id:b.conversation_id,text:b.text.trim()};
}
export function instagramSendBlock(conv,accountId,now=Date.now()){
 if(conv?.platform!=='instagram'||conv.instagram_account_id!==accountId||!numeric(conv.customer_id))return 'Hội thoại chưa được xác nhận thuộc tài khoản Instagram này. Hãy nhắn thử từ Instagram trước.';
 const stamp=Date.parse(conv.meta_last_customer_at);
 if(!Number.isFinite(stamp)||stamp>now||now-stamp>=86400000)return 'Chưa có tin khách được xác thực trong 24 giờ qua. Khách cần nhắn lại trước khi trả lời qua API.';
 if(conv.meta_last_stream!=='messaging')return 'Hội thoại đang ở luồng chờ (standby). Kiểm tra định tuyến Meta trước khi gửi từ ứng dụng này.';
 return '';
}
export function registerInstagramChat(app,db,auth,{env=process.env,fetcher=fetch}={}){
 const version=env.IG_CHAT_GRAPH_VERSION||env.META_GRAPH_VERSION;
 function configReady(){return /^v\d+\.\d+$/.test(version||'');}
 async function token(){
  if(!env.IG_CHAT_ACCESS_TOKEN||!numeric(env.IG_CHAT_ACCOUNT_ID))throw Error('Instagram chat token/account config unavailable');
  return {access_token:env.IG_CHAT_ACCESS_TOKEN,account_id:env.IG_CHAT_ACCOUNT_ID};
 }
 // Unified Login uses the Meta Graph host and its own dedicated chat token.
 const graph=(path,t,options={})=>{
  const url=new URL(`https://graph.facebook.com/${version}/${path}`);
  if(env.META_APP_SECRET)url.searchParams.set('appsecret_proof',createHmac('sha256',env.META_APP_SECRET).update(t.access_token).digest('hex'));
  return fetcher(url.href,{...options,headers:{Authorization:`Bearer ${t.access_token}`,'Content-Type':'application/json',...options.headers},signal:AbortSignal.timeout(15000)});
 };
 app.get('/webhook/instagram',(req,res)=>{
  const verifyToken=env.IG_CHAT_VERIFY_TOKEN||'BinBinHotel_Instagram_2026';
  if(req.query['hub.mode']==='subscribe'&&req.query['hub.verify_token']===verifyToken)return res.status(200).type('text/plain').send(req.query['hub.challenge']);
  res.sendStatus(403);
 });
 // Optional enrichment only after the durable message transaction has committed.
 async function enrich(profiles,t){
  const unique=new Map(profiles.map(p=>[p.id,p]));
  for(const p of unique.values()){
   const nameMissing=!p.customer_name||/^Khách(?: hàng)?(?:\s+\d+)?$/iu.test(p.customer_name);
   if(!nameMissing&&p.customer_avatar)continue;
   try{
    const response=await graph(`${p.customer_id}?fields=name,username,profile_pic`,t);
    const b=await response.json();if(!response.ok||b.error)continue;
    const fields={};const name=typeof b.name==='string'&&b.name.trim()?b.name.trim():(typeof b.username==='string'?b.username.trim():'');
    if(nameMissing&&name)fields.customer_name=name;
    if(!p.customer_avatar&&httpsUrl(b.profile_pic))fields.customer_avatar=b.profile_pic;
    for(const [key,value] of Object.entries(fields)){
     let q=db.from('chat_conversations').update({[key]:value}).eq('id',p.id).eq('instagram_account_id',t.account_id);
     q=p[key]===null?q.is(key,null):q.eq(key,p[key]);
     const r=await q;if(r.error)console.warn('Instagram profile update failed',r.error.code);
    }
   }catch{console.warn('Instagram profile unavailable');}
  }
 }
 app.post('/webhook/instagram',async(req,res)=>{
  if(!env.META_APP_SECRET||!configReady())return res.status(503).send('META_CONFIG_REQUIRED');
  if(!verifyMetaSignature(req.rawBody,req.get('x-hub-signature-256'),env.META_APP_SECRET))return res.sendStatus(403);
  if(req.body?.object!=='instagram')return res.sendStatus(404);
  try{
   const t=await token();const rows=normalizeMetaEvents(req.body,t.account_id);
   if(!rows.length)return res.status(200).send('EVENT_RECEIVED');
   const {data,error}=await db.rpc('binbin_save_instagram_messages',{p_rows:rows});
   if(error){console.error('Instagram webhook DB',error.code);return res.status(503).send('RETRY_DELIVERY');}
   res.status(200).send('EVENT_RECEIVED');
   console.info('Instagram webhook saved',JSON.stringify({events:rows.length,new_messages:(data||[]).filter(p=>p.inserted).length,standby:rows.filter(r=>r.stream==='standby').length}));
   void enrich(data||[],t);
  }catch{console.error('Instagram webhook processing failed');if(!res.headersSent)res.status(503).send('RETRY_DELIVERY');}
 });
 app.get('/api/chat/instagram/config',auth,async(req,res)=>{
  try{
   if(!configReady())throw Error('Graph version missing');
   const t=await token();
   const {error}=await db.from('instagram_send_requests').select('request_id').limit(1);
   if(error)throw Error('Migration/permissions');
   const response=await graph(`${t.account_id}?fields=id,username`,t);
   const b=await response.json();
   if(!response.ok||b.error)return res.status(502).json({success:false,provider_code:b.error?.code??null,provider_subcode:b.error?.error_subcode??null,
     message:'Meta chưa xác nhận được token Unified Login và tài khoản. Kiểm tra đúng token/quyền Instagram, ID và phiên bản Graph.'});
   if(b.id!==t.account_id)return res.status(409).json({success:false,message:'ID tài khoản phản hồi khác với cấu hình. Chưa cho phép gửi.'});
   return res.json({success:true,account_verified:true,account_id:b.id,username:typeof b.username==='string'?b.username:'',graph_version:version,
    webhook_secret_configured:!!env.META_APP_SECRET,message:'Token đọc được đúng tài khoản. Cần thử webhook và gửi thật để kiểm tra quyền nhắn tin.'});
  }catch{return res.status(503).json({success:false,message:'Kiểm tra SQL, khóa Supabase backend, IG_CHAT_ACCESS_TOKEN, IG_CHAT_ACCOUNT_ID và phiên bản Graph.'});}
 });
 app.post('/api/chat/instagram/send',auth,async(req,res)=>{
  let input;try{input=validateInstagramSend(req.body);}catch(e){return res.status(400).json({state:'invalid',message:e.message});}
  const {request_id,conversation_id,text}=input;
  const hash=createHash('sha256').update(JSON.stringify([conversation_id,text])).digest('hex');
  async function remember(fields){const r=await db.from('instagram_send_requests').update(fields).eq('request_id',request_id);return !r.error;}
  async function saveAccepted(job){
   const {data:conv,error}=await db.from('chat_conversations').select('customer_id,instagram_account_id,platform').eq('id',conversation_id).single();
   if(error||conv?.platform!=='instagram'||!numeric(conv.instagram_account_id))return false;
   const r=await db.rpc('binbin_save_instagram_messages',{p_rows:[{account_id:conv.instagram_account_id,customer_id:conv.customer_id,
    mid:job.external_message_id,sender_type:'page',stream:'sendapi',text,attachments:null,created_at:job.sent_at}]});
   return !r.error;
  }
  async function replay(job){
   if(job.payload_hash!==hash||job.conversation_id!==conversation_id)return res.status(409).json({state:'conflict',message:'Mã yêu cầu đã dùng cho nội dung khác.'});
   if(job.status==='accepted')return res.json({success:true,state:'accepted',saved:await saveAccepted(job),message_id:job.external_message_id});
   if(job.status==='rejected')return res.status(422).json({state:'rejected',provider_code:job.provider_code,message:`Instagram từ chối tin (mã ${job.provider_code}). Kiểm tra quyền, token và định tuyến.`});
   return res.status(202).json({state:'unknown',message:'Chưa rõ kết quả yêu cầu này. Kiểm tra Instagram trước khi gửi lại; hệ thống không tự gọi Instagram lần nữa.'});
  }
  let claimed=false;
  try{
   const old=await db.from('instagram_send_requests').select('*').eq('request_id',request_id).maybeSingle();
   if(old.error)return res.status(503).json({state:'not_started',message:'Chưa đọc được sổ gửi tin. Kiểm tra SQL và khóa backend.'});
   if(old.data)return replay(old.data);
   if(!configReady())return res.status(503).json({state:'not_started',message:'Chưa cấu hình IG_CHAT_GRAPH_VERSION/META_GRAPH_VERSION trên backend.'});
   const [cr,t]=await Promise.all([db.from('chat_conversations').select('id,platform,customer_id,instagram_account_id,meta_last_customer_at,meta_last_stream').eq('id',conversation_id).single(),token()]);
   if(cr.error)return res.status(404).json({state:'invalid',message:'Không tìm thấy hội thoại.'});
   const block=instagramSendBlock(cr.data,t.account_id);if(block)return res.status(409).json({state:'invalid',message:block});
   const claim=await db.from('instagram_send_requests').insert({request_id,conversation_id,payload_hash:hash,status:'sending'});
   if(claim.error){
    if(claim.error.code!=='23505')return res.status(503).json({state:'not_started',message:'Chưa ghi được yêu cầu. Chưa gọi Instagram.'});
    const again=await db.from('instagram_send_requests').select('*').eq('request_id',request_id).single();
    if(again.error)throw Error('Cannot read claim');return replay(again.data);
   }
   claimed=true;
   let response,b;
   try{
    response=await graph(`${t.account_id}/messages`,t,{method:'POST',body:JSON.stringify({recipient:{id:cr.data.customer_id},message:{text}})});
    b=await response.json();
   }catch{await remember({status:'unknown'});return res.status(202).json({state:'unknown',message:'Mất kết nối khi gửi. Chưa rõ Instagram đã nhận; kiểm tra Instagram, không tự gửi lại.'});}
   if(response.status>=400&&response.status<500&&Number.isInteger(b.error?.code)){
    const stored=await remember({status:'rejected',provider_code:b.error.code});
    return res.status(stored?422:202).json({state:stored?'rejected':'unknown',provider_code:b.error.code,message:`Instagram từ chối yêu cầu (mã ${b.error.code}). Kiểm tra quyền, định tuyến và cửa sổ trả lời.`});
   }
   if(!response.ok||b.error||typeof b.message_id!=='string'||!b.message_id||b.recipient_id!==cr.data.customer_id){
    await remember({status:'unknown'});return res.status(202).json({state:'unknown',message:'Phản hồi chưa đủ để xác nhận gửi. Kiểm tra Instagram; không tự gửi lại.'});
   }
   const job={status:'accepted',external_message_id:b.message_id,sent_at:new Date().toISOString()};
   const remembered=await remember(job);const saved=await saveAccepted(job);
   return res.json({success:true,state:'accepted',saved:remembered&&saved,message_id:job.external_message_id});
  }catch{return res.status(503).json({state:claimed?'unknown':'not_started',message:claimed?'Chưa xác nhận xong kết quả. Giữ mã yêu cầu và kiểm tra trạng thái.':'Chưa gửi tin. Kiểm tra cấu hình token/Page và kết nối DB.'});}
 });
}
