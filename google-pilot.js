import {createHash} from 'node:crypto';
export const PILOT_KEY='hotel18-intro-20261105';
export const PILOT_POST={languageCode:'vi',topicType:'STANDARD',summary:`🏨 BIN BIN HOTEL 18 – GÓC NGHỈ NGƠI DỄ CHỊU GIỮA LÒNG CÁT LÁI! ✨

Bạn đang tìm một nơi lưu trú thoải mái tại TP. Thủ Đức? 💙

📍 Tọa lạc tại khu vực Cát Lái, Bin Bin Hotel 18 mang đến không gian nghỉ ngơi ấm cúng, tiện nghi, phù hợp cho cả chuyến công tác lẫn những ngày nghỉ thư giãn.

✨ Đa dạng hạng phòng: Superior, Deluxe, Suite và Twin.
🛏️ Phòng nghỉ gọn gàng, đầy đủ tiện nghi.
🌙 Lễ tân hỗ trợ 24/7, Wi-Fi miễn phí và chỗ đỗ xe thuận tiện.

💙 BIN BIN HOTEL – YOUR SECOND HOME
📍 9 Đường Số 63A-TML, P. Cát Lái, TP. Thủ Đức, TP.HCM`,callToAction:{actionType:'LEARN_MORE',url:'https://binbinhotel.com/'}};
export function hotel18(title){return typeof title==='string'&&/^bin bin hotel\s+18(?:\s|[-–—]|$)/i.test(title.trim());}
export function registerGooglePilot(app,db,auth,{getClient,listLocations,fetcher=fetch}){
 const table='google_pilot_posts';
 const hash=parent=>createHash('sha256').update(JSON.stringify([parent,PILOT_POST])).digest('hex');
 async function record(){const r=await db.from(table).select('*').eq('id',PILOT_KEY).maybeSingle();if(r.error)throw Error('DATABASE');return r.data;}
 function result(row){return {success:row.state==='accepted',state:row.state==='sending'?'unknown':row.state,parent:row.parent,provider_state:row.provider_state||null,post_name:row.post_name||null,search_url:row.search_url||null,provider_code:row.provider_code||null,message:row.state==='accepted'?'Google đã nhận bài. Trạng thái hiển thị còn phụ thuộc Google.':row.state==='rejected'?'Yêu cầu bị từ chối; chưa gửi lại tự động.':'Chưa xác định kết quả. Kiểm tra bài trên Maps trước khi xử lý tiếp; hệ thống không tự gửi lại.'};}
 function secure(res){res.set('Cache-Control','no-store');}
 app.get('/api/google/pilot',auth,async(req,res)=>{secure(res);try{const row=await record();res.json({success:true,draft:PILOT_POST,result:row?result(row):null});}catch{res.status(503).json({success:false,message:'Chạy 03-google-pilot.sql trước.'});}});
 app.post('/api/google/pilot',auth,async(req,res)=>{secure(res);const parent=req.body?.parent;
  if(typeof parent!=='string'||!/^accounts\/\d+\/locations\/\d+$/.test(parent))return res.status(400).json({success:false,message:'Chi nhánh không hợp lệ.'});
  let claimed=false,attempted=false;
  try{
   const old=await record();if(old){if(old.payload_hash!==hash(parent))return res.status(409).json({success:false,message:'Bài thử đã gắn với một địa điểm khác.'});return res.json(result(old));}
   const c=await getClient(),locations=await listLocations(c),location=locations.find(l=>`${l.account_name}/${l.name}`===parent);
   if(!location||!hotel18(location.title))return res.status(400).json({success:false,message:'Chỉ cho đăng thử Bin Bin Hotel 18. Hãy tải lại chi nhánh.'});
   // Refresh credentials before reserving the single publishing attempt.
   const token=await c.getAccessToken();if(!token.token)throw Error('NO_TOKEN');
   const ins=await db.from(table).insert({id:PILOT_KEY,parent,payload_hash:hash(parent),state:'sending'});
   if(ins.error){if(ins.error.code==='23505'){const existing=await record();if(existing?.payload_hash===hash(parent))return res.json(result(existing));return res.status(409).json({success:false,message:'Đã có yêu cầu khác cho bài thử.'});}throw Error('SAVE');}
   claimed=true;attempted=true;
   const response=await fetcher(`https://mybusiness.googleapis.com/v4/${parent}/localPosts`,{method:'POST',headers:{Authorization:`Bearer ${token.token}`,'Content-Type':'application/json'},body:JSON.stringify(PILOT_POST),signal:AbortSignal.timeout(30000)});
   const body=await response.json();let row;
   if(response.ok&&typeof body.name==='string'&&body.name.startsWith(parent+'/localPosts/')){
    let url=null;try{const u=new URL(body.searchUrl);if(u.protocol==='https:'&&(u.hostname==='google.com'||u.hostname.endsWith('.google.com')))url=u.href;}catch{}
    row={state:'accepted',post_name:body.name,provider_state:body.state||null,search_url:url};
   }else if(response.status>=400&&response.status<500&&body.error){row={state:'rejected',provider_code:String(body.error.status||body.error.code||response.status)};}
   else row={state:'unknown'};
   const saved=await db.from(table).update({...row,updated_at:new Date().toISOString()}).eq('id',PILOT_KEY);
   if(saved.error)return res.status(503).json({success:false,state:'unknown',message:'Chưa lưu được kết quả. Không đăng lại; kiểm tra Maps và trạng thái bài thử.'});
   res.json(result({...row,parent}));
  }catch{if(claimed){await db.from(table).update({state:attempted?'unknown':'rejected',updated_at:new Date().toISOString()}).eq('id',PILOT_KEY);return res.status(502).json({success:false,state:'unknown',message:'Chưa xác định kết quả. Không tự gửi lại; kiểm tra Maps trước.'});}res.status(503).json({success:false,message:'Chưa gửi bài. Kiểm tra kết nối Google, quyền API và SQL.'});}
 });
}
