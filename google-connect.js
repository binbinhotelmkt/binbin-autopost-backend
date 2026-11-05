import {randomBytes,createHash,createCipheriv,createDecipheriv} from 'node:crypto';
import {google} from 'googleapis';
export const digest=s=>createHash('sha256').update(s).digest('hex');
export function seal(text,key){const iv=randomBytes(12),c=createCipheriv('aes-256-gcm',Buffer.from(key,'hex'),iv);const b=Buffer.concat([c.update(text,'utf8'),c.final()]);return Buffer.concat([iv,c.getAuthTag(),b]).toString('base64');}
export function unseal(text,key){const b=Buffer.from(text,'base64'),c=createDecipheriv('aes-256-gcm',Buffer.from(key,'hex'),b.subarray(0,12));c.setAuthTag(b.subarray(12,28));return Buffer.concat([c.update(b.subarray(28)),c.final()]).toString('utf8');}
export function registerGoogleConnect(app,db,auth,{env=process.env}={}){
 const scope='https://www.googleapis.com/auth/business.manage';
 function ready(){if(!env.GOOGLE_CLIENT_ID||!env.GOOGLE_CLIENT_SECRET||!/^https:\/\//.test(env.GOOGLE_REDIRECT_URI||'')||!/^\w{64}$/.test(env.GOOGLE_TOKEN_ENCRYPTION_KEY||'')||!/^[a-f0-9]+$/i.test(env.GOOGLE_TOKEN_ENCRYPTION_KEY))throw Error('CONFIG_REQUIRED');}
 function client(){ready();return new google.auth.OAuth2(env.GOOGLE_CLIENT_ID,env.GOOGLE_CLIENT_SECRET,env.GOOGLE_REDIRECT_URI);}
 function secure(res){res.set('Cache-Control','no-store');res.set('Referrer-Policy','no-referrer');}
 async function saved(){const r=await db.from('google_connections').select('*').eq('id','primary').maybeSingle();if(r.error)throw Error('DATABASE_REQUIRED');return r.data?.client_id===env.GOOGLE_CLIENT_ID?r.data:null;}
 async function connected(){const row=await saved();if(!row)throw Error('NOT_CONNECTED');const c=client();c.setCredentials({refresh_token:unseal(row.refresh_token_encrypted,env.GOOGLE_TOKEN_ENCRYPTION_KEY)});return c;}
 app.get('/api/google/status',auth,async(req,res)=>{secure(res);try{ready();const r=await saved();res.json({success:true,connected:!!r,connected_at:r?.updated_at||null});}catch{res.status(503).json({success:false,message:'Kiểm tra SQL và các biến GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REDIRECT_URI, GOOGLE_TOKEN_ENCRYPTION_KEY.'});}});
 app.get('/api/google/connect',auth,async(req,res)=>{secure(res);try{
  const c=client(),state=randomBytes(32).toString('hex'),nonce=randomBytes(32).toString('hex');
  await db.from('google_oauth_states').delete().lt('expires_at',new Date().toISOString());
  const r=await db.from('google_oauth_states').insert({state_hash:digest(state),browser_hash:digest(nonce),expires_at:new Date(Date.now()+600000).toISOString()});if(r.error)throw Error('STATE_SAVE');
  const launch=new URL('/auth/google/start',env.GOOGLE_REDIRECT_URI);launch.searchParams.set('state',state);launch.searchParams.set('browser',nonce);
  res.json({success:true,url:launch.href});
 }catch{res.status(503).json({success:false,message:'Chưa tạo được phiên Google. Kiểm tra cấu hình và SQL.'});}});
 app.get('/auth/google/start',async(req,res)=>{secure(res);res.type('text/plain');try{
  const c=client(),state=req.query.state,nonce=req.query.browser;
  if(typeof state!=='string'||typeof nonce!=='string'||!/^[a-f0-9]{64}$/.test(state)||!/^[a-f0-9]{64}$/.test(nonce))return res.status(400).send('Phiên không hợp lệ. Bấm Kết nối Google từ phần mềm.');
  const r=await db.from('google_oauth_states').update({launched:true}).eq('state_hash',digest(state)).eq('browser_hash',digest(nonce)).eq('launched',false).gt('expires_at',new Date().toISOString()).select('state_hash');
  if(r.error||r.data?.length!==1)return res.status(400).send('Liên kết đã dùng hoặc hết hạn. Bấm Kết nối Google lại.');
  res.set('Set-Cookie',`bb_google_oauth=${nonce}; HttpOnly; Secure; SameSite=Lax; Path=/auth/google/callback; Max-Age=600`);
  res.redirect(303,c.generateAuthUrl({access_type:'offline',scope:[scope],prompt:'consent',state}));
 }catch{res.status(503).send('Không khởi tạo được phiên. Kiểm tra cấu hình và SQL mới.');}});
 app.get('/auth/google/callback',async(req,res)=>{secure(res);res.type('text/plain');try{
  ready();const state=req.query.state,nonce=(req.headers.cookie||'').split(';').map(x=>x.trim()).find(x=>x.startsWith('bb_google_oauth='))?.slice(16);
  if(typeof state!=='string'||!/^[a-f0-9]{64}$/.test(state)||!nonce||!/^[a-f0-9]{64}$/.test(nonce))return res.status(400).send('Phiên Google không hợp lệ. Quay lại phần mềm để kết nối lại.');
  const r=await db.from('google_oauth_states').delete().eq('launched',true).eq('state_hash',digest(state)).eq('browser_hash',digest(nonce)).gt('expires_at',new Date().toISOString()).select('state_hash');
  if(r.error||r.data?.length!==1)return res.status(400).send('Phiên đã hết hạn hoặc đã được sử dụng. Hãy kết nối lại.');
  res.set('Set-Cookie','bb_google_oauth=; HttpOnly; Secure; SameSite=Lax; Path=/auth/google/callback; Max-Age=0');
  if(req.query.error)return res.status(400).send('Bạn chưa cấp quyền Google. Kết nối cũ được giữ nguyên.');
  if(typeof req.query.code!=='string')return res.status(400).send('Thiếu mã cấp quyền.');
  const c=client(),{tokens}=await c.getToken(req.query.code);
  if(!tokens.refresh_token||!tokens.scope?.split(' ').includes(scope))return res.status(400).send('Chưa nhận được quyền hoặc refresh token cần thiết. Hãy kết nối lại và cấp quyền quản lý doanh nghiệp.');
  const save=await db.from('google_connections').upsert({id:'primary',client_id:env.GOOGLE_CLIENT_ID,refresh_token_encrypted:seal(tokens.refresh_token,env.GOOGLE_TOKEN_ENCRYPTION_KEY),updated_at:new Date().toISOString()});if(save.error)throw Error('SAVE_FAILED');
  res.send('Đã lưu kết nối Google thành công. Quay lại social.binbinhotel.com và bấm Tải chi nhánh để kiểm tra quyền thực tế.');
 }catch{res.status(502).send('Chưa lưu được kết nối Google. Kiểm tra cấu hình client, callback và cơ sở dữ liệu rồi kết nối lại.');}});
 app.get('/api/google-locations',auth,async(req,res)=>{secure(res);try{
  const c=await connected();let pageToken,accounts=[],locations=[];
  do{const u=new URL('https://mybusinessaccountmanagement.googleapis.com/v1/accounts');if(pageToken)u.searchParams.set('pageToken',pageToken);const {data}=await c.request({url:u.href,timeout:15000});accounts.push(...(data.accounts||[]));pageToken=data.nextPageToken;}while(pageToken);
  for(const a of accounts){pageToken=undefined;do{const u=new URL(`https://mybusinessbusinessinformation.googleapis.com/v1/${a.name}/locations`);u.searchParams.set('readMask','name,title');u.searchParams.set('pageSize','100');if(pageToken)u.searchParams.set('pageToken',pageToken);const {data}=await c.request({url:u.href,timeout:15000});locations.push(...(data.locations||[]).map(l=>({...l,account_name:a.name})));pageToken=data.nextPageToken;}while(pageToken);}
  res.json({success:true,locations,message:locations.length?'Đã tải danh sách chi nhánh.':'Tài khoản vừa kết nối chưa có chi nhánh khả dụng.'});
 }catch(e){const code=e.response?.data?.error?.status;res.status(502).json({success:false,message:code==='PERMISSION_DENIED'?'Google từ chối quyền. Kiểm tra tài khoản quản lý địa điểm, API đã bật và quota.':'Chưa tải được chi nhánh. Kiểm tra kết nối Google và thử lại.',provider_status:typeof code==='string'?code:null});}});
}
