import {createHash,randomUUID} from 'node:crypto';
import multer from 'multer';
import sharp from 'sharp';
const parentRE=/^accounts\/\d+\/locations\/\d+$/;
const hash=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
const check=r=>{if(r.error)throw Error('DATABASE_ERROR');return r.data;};
export function validateGoogle(input,env){
 const targets=input.googleTargets;
 if(!Array.isArray(targets)||!targets.length||targets.length>100||targets.some(p=>typeof p!=='string'||!parentRE.test(p)))throw Error('Chọn từ 1 đến 100 chi nhánh Google hợp lệ.');
 if(typeof input.content!=='string'||!input.content.trim()||[...input.content].length>1500)throw Error('Nội dung Google phải có từ 1 đến 1.500 ký tự.');
 const urls=input.mediaUrls||[],types=input.mediaTypes||[];
 if(!Array.isArray(urls)||urls.length>10||!Array.isArray(types)||types.length!==urls.length)throw Error('Tối đa 10 tệp và phải có loại tệp hợp lệ.');
 const base=new URL('/storage/v1/object/public/social_media/',env.SUPABASE_URL);
 urls.forEach((value,i)=>{let u;try{u=new URL(value);}catch{throw Error('URL tệp không hợp lệ.');}if(u.origin!==base.origin||!u.pathname.startsWith(base.pathname)||u.username||u.password||u.search||u.hash||!['image/jpeg','image/png','video/mp4'].includes(types[i]))throw Error('Chỉ nhận JPG, PNG hoặc MP4 đã tải lên phần mềm.');});
 let link=input.googleLink||'';if(link){try{const u=new URL(link);if(u.protocol!=='https:'||u.username||u.password)throw 0;link=u.href;}catch{throw Error('Liên kết Xem thêm phải bắt đầu bằng https://');}}
 return {targets:[...new Set(targets)],link,types};
}
export function buildOperations(post){
 const urls=post.media_urls||[],types=post.media_types||[],photo=types.findIndex(t=>t.startsWith('image/'));
 const body={languageCode:'vi',topicType:'STANDARD',summary:post.content};
 if(post.google_link)body.callToAction={actionType:'LEARN_MORE',url:post.google_link};
 if(photo>=0)body.media=[{mediaFormat:'PHOTO',sourceUrl:urls[photo]}];
 return [{key:'post',endpoint:'localPosts',body},...urls.flatMap((url,i)=>i===photo?[]:[{key:'media-'+i,endpoint:'media',body:{mediaFormat:types[i]==='video/mp4'?'VIDEO':'PHOTO',locationAssociation:{category:'ADDITIONAL'},sourceUrl:url}}])];
}
export function createGooglePublisher(app,db,auth,{getClient,listLocations,env=process.env,fetcher=fetch}){
 const upload=multer({storage:multer.memoryStorage(),limits:{files:1,fileSize:75*1024*1024}}).single('file');
 app.post('/api/media-upload',auth,(req,res)=>upload(req,res,async(err)=>{
  if(err)return res.status(400).json({success:false,message:'Mỗi lần tải 1 tệp, tối đa 75 MB.'});
  try{
   const f=req.file;if(!f)throw Error('Chưa chọn tệp.');let bytes=f.buffer,type,ext;
   // Verify content rather than trusting the browser MIME or filename.
   if(bytes.length>=12&&bytes.toString('ascii',4,8)==='ftyp'&&/^(isom|iso[2-9]|mp4[12]|avc1|M4V )$/.test(bytes.toString('ascii',8,12))){type='video/mp4';ext='mp4';}
   else {const meta=await sharp(bytes,{limitInputPixels:40000000}).metadata();if(!['jpeg','png','webp'].includes(meta.format))throw Error('Chỉ nhận JPG, PNG, WEBP hoặc MP4.');bytes=await sharp(bytes).rotate().resize({width:1920,height:1920,fit:'inside',withoutEnlargement:true}).jpeg({quality:90}).toBuffer();type='image/jpeg';ext='jpg';}
   const path=`publisher/${randomUUID()}.${ext}`;check(await db.storage.from('social_media').upload(path,bytes,{contentType:type,upsert:false}));
   const {data}=db.storage.from('social_media').getPublicUrl(path);res.json({success:true,url:data.publicUrl,type});
  }catch{res.status(400).json({success:false,message:'Không tải được tệp. Dùng JPG/PNG/WEBP hoặc MP4 hợp lệ, tối đa 75 MB; kiểm tra bucket social_media.'});}
 }));
 async function validateTargets(targets){const c=await getClient(),ls=await listLocations(c),available=new Map(ls.map(l=>[`${l.account_name}/${l.name}`,l.title]));if(targets.some(p=>!available.has(p)))throw Error('Một chi nhánh không còn thuộc tài khoản Google đã kết nối. Tải lại danh sách.');return targets.map(parent=>({parent,title:available.get(parent)}));}
 async function operation(post,target,op,token){
  const id=hash([post.id,target.parent,op.key]);
  const old=check(await db.from('google_publish_items').select('*').eq('id',id).maybeSingle());if(old)return old;
  const row={id,post_id:String(post.id),parent:target.parent,title:target.title,kind:op.key,state:'sending'};
  const claim=await db.from('google_publish_items').insert(row);if(claim.error){if(claim.error.code==='23505')return check(await db.from('google_publish_items').select('*').eq('id',id).single());throw Error('DATABASE_ERROR');}
  let result={state:'unknown',message:'Chưa xác định; kiểm tra Google trước khi đăng lại.'};
  try{
   const response=await fetcher(`https://mybusiness.googleapis.com/v4/${target.parent}/${op.endpoint}`,{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify(op.body),signal:AbortSignal.timeout(45000)});
   const b=await response.json();
   const prefix=target.parent+'/'+op.endpoint+'/';
   if(response.ok&&typeof b.name==='string'&&b.name.startsWith(prefix)&&!b.name.slice(prefix.length).includes('/'))result={state:'accepted',resource_name:b.name,provider_state:b.state||null,search_url:b.searchUrl||b.googleUrl||null,message:'Google đã nhận; chờ Google xử lý và duyệt.'};
   else if(response.status>=400&&response.status<500&&b.error)result={state:'rejected',message:String(b.error.message||b.error.status||'Google từ chối').slice(0,600)};
  }catch{}
  check(await db.from('google_publish_items').update({...result,updated_at:new Date().toISOString()}).eq('id',id));return {...row,...result};
 }
 let busy=false;
 async function run(){
  if(busy)return;busy=true;
  try{
   // Never replay a request whose outcome was lost during a server restart.
   check(await db.from('social_posts').update({status_google:'unknown'}).eq('status_google','processing').lt('google_started_at',new Date(Date.now()-3600000).toISOString()));
   const posts=check(await db.from('social_posts').select('*').eq('status_google','pending').or(`scheduled_time.is.null,scheduled_time.lte.${new Date().toISOString()}`).limit(10));
   for(const p of posts||[]){
    const claimed=check(await db.from('social_posts').update({status_google:'processing',google_started_at:new Date().toISOString()}).eq('id',p.id).eq('status_google','pending').select('id'));if(!claimed?.length)continue;
    let status='unknown';
    try{
     const c=await getClient(),{token}=await c.getAccessToken();if(!token)throw Error('NO_TOKEN');
     const current=await listLocations(c),allowed=new Set(current.map(l=>`${l.account_name}/${l.name}`));
     const results=[];
     for(const target of p.google_targets||[]){
      if(!allowed.has(target.parent)){const id=hash([p.id,target.parent,'post']);check(await db.from('google_publish_items').upsert({id,post_id:String(p.id),parent:target.parent,title:target.title,kind:'post',state:'rejected',message:'Tài khoản kết nối không còn quyền trên chi nhánh này.'},{onConflict:'id',ignoreDuplicates:true}));results.push({state:'rejected'});continue;}
      for(const op of buildOperations(p))results.push(await operation(p,target,op,token));
     }
     status=results.length&&results.every(x=>x.state==='accepted')?'accepted':results.some(x=>['unknown','sending'].includes(x.state))?'unknown':results.some(x=>x.state==='accepted')?'partial':'failed';
    }catch{status='unknown';}
    check(await db.from('social_posts').update({status_google:status}).eq('id',p.id));
   }
  }catch(e){console.error('[Google publisher]',e.message==='DATABASE_ERROR'?'Kiểm tra migration 04.':'Chưa hoàn tất lượt xử lý.');}finally{busy=false;}
 }
 app.get('/api/google/posts/:id/results',auth,async(req,res)=>{
  try{
   let items=check(await db.from('google_publish_items').select('*').eq('post_id',req.params.id));
   if(req.query.refresh==='1'&&items.some(x=>x.resource_name)){
    const c=await getClient();
    for(const item of items){if(!item.resource_name||!new RegExp('^accounts/\\d+/locations/\\d+/(localPosts|media)/[^/]+$').test(item.resource_name))continue;
     try{const {data:b}=await c.request({url:`https://mybusiness.googleapis.com/v4/${item.resource_name}`,timeout:15000});const fields={provider_state:b.state||null,search_url:b.searchUrl||b.googleUrl||null,updated_at:new Date().toISOString()};check(await db.from('google_publish_items').update(fields).eq('id',item.id));Object.assign(item,fields);}catch{item.refresh_error='Chưa lấy được trạng thái mới từ Google.';}
    }
   }
   const post=check(await db.from('social_posts').select('status_google,google_targets').eq('id',req.params.id).maybeSingle());
   res.json({success:true,items,status:post?.status_google,targets:post?.google_targets||[]});
  }catch{res.status(502).json({success:false,message:'Chưa lấy được kết quả Google.'});}
 });
 return {run,validateTargets};
}
