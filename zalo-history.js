// Shared by webhook and history import. No token refresh or scheduled work.
export function zaloTime(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 1e12 || n > 9e12) throw new Error('Thời gian Zalo không hợp lệ.');
  return new Date(n).toISOString();
}
export function normalizeZaloMessage(m, conversationId) {
  if (typeof m.message_id !== 'string' || !m.message_id || ![0, 1].includes(m.src))
    throw new Error('Tin Zalo thiếu mã hoặc chiều gửi/nhận.');
  const labels = {sticker:'[Sticker]', photo:'[Hình ảnh]', GIF:'[GIF]', voice:'[Tin nhắn thoại]', location:'[Vị trí]', link:'[Liên kết]', links:'[Liên kết]'};
  return {conversation_id:conversationId, external_message_id:m.message_id,
    sender_type:m.src === 1 ? 'customer' : 'page',
    message_text:m.type === 'text' ? String(m.message || '') : (labels[m.type] || '[Đính kèm]'),
    created_at:zaloTime(m.time), attachments:{zalo:{type:m.type, url:m.url, thumb:m.thumb, links:m.links, description:m.description, location:m.location}}};
}
export function legacyOverlap(old, row) {
  return old.sender_type === row.sender_type && old.message_text === row.message_text &&
    Math.abs(Date.parse(old.created_at) - Date.parse(row.created_at)) <= 120000;
}
export async function saveZaloWebhook(db, row, body) {
  const externalId = body.message?.msg_id || body.message?.message_id;
  if (typeof externalId === 'string' && externalId) row.external_message_id = externalId;
  if (body.timestamp) { try { row.created_at = zaloTime(body.timestamp); } catch {} }
  const result = row.external_message_id
    ? await db.from('chat_messages').upsert(row, {onConflict:'conversation_id,external_message_id', ignoreDuplicates:true})
    : await db.from('chat_messages').insert(row);
  if (result.error) throw new Error('Không lưu được tin Zalo: ' + result.error.message);
}
export function registerZaloHistory(app, db, requireAuth) {
  const busy = new Set();
  app.post('/api/chat/zalo/history', requireAuth, async (req, res) => {
    const id = req.body.conversation_id, offset = req.body.offset ?? 0;
    if (typeof id !== 'string' || !/^[0-9a-f-]{36}$/i.test(id) || !Number.isSafeInteger(offset) || offset < 0 || offset > 100000)
      return res.status(400).json({message:'Hội thoại hoặc vị trí lịch sử không hợp lệ.'});
    if (busy.has(id)) return res.status(409).json({message:'Hội thoại đang đồng bộ, thử lại sau.'});
    busy.add(id);
    try {
      const {data:conv,error:ce} = await db.from('chat_conversations').select('id,customer_id,platform').eq('id',id).single();
      if (ce || conv?.platform !== 'zalo') return res.status(404).json({message:'Không tìm thấy hội thoại Zalo.'});
      const {data:token,error:te} = await db.from('social_tokens').select('access_token').eq('platform','zalo').single();
      if (te || !token?.access_token) throw new Error('Không đọc được một token OA duy nhất.');
      const query = encodeURIComponent(JSON.stringify({user_id:conv.customer_id, offset, count:10}));
      const response = await fetch(`https://openapi.zalo.me/v2.0/oa/conversation?data=${query}`, {
        headers:{access_token:token.access_token}, signal:AbortSignal.timeout(20000)});
      const body = await response.json();
      if (!response.ok || body.error !== 0) return res.status(502).json({message:`Zalo chưa trả lịch sử (HTTP ${response.status}, mã ${body.error ?? 'không rõ'}).`, provider_code:body.error});
      if (!Array.isArray(body.data)) throw new Error('Zalo trả cấu trúc lịch sử không hợp lệ.');
      const rows = body.data.map(m => normalizeZaloMessage(m,id));
      let held = 0, inserted = 0;
      // Preserve legacy rows without provider IDs. Possible matches require review;
      // never delete/merge repeated customer messages based only on their text.
      for (const row of rows) {
        const t = Date.parse(row.created_at);
        const {data:old,error:oe} = await db.from('chat_messages').select('sender_type,message_text,created_at')
          .eq('conversation_id',id).is('external_message_id',null)
          .gte('created_at',new Date(t-120000).toISOString()).lte('created_at',new Date(t+120000).toISOString());
        if (oe) throw new Error('Chưa đọc được dữ liệu lịch sử. Kiểm tra migration SQL.');
        if ((old || []).some(x => legacyOverlap(x,row))) {held++; continue;}
        const {data:saved,error:se} = await db.from('chat_messages').upsert(row,
          {onConflict:'conversation_id,external_message_id',ignoreDuplicates:true}).select('id');
        if (se) throw new Error('Không lưu được lịch sử. Kiểm tra migration SQL.');
        inserted += saved?.length || 0;
      }
      // Import must not change conversation preview/order or trigger outgoing sends.
      res.json({success:true, fetched:rows.length, inserted, held_for_review:held,
        next_offset:offset+rows.length, has_more:rows.length === 10});
    } catch (error) {
      console.error('Zalo history:', error.message);
      res.status(500).json({message:'Đồng bộ chưa hoàn tất. Có thể thử lại; kiểm tra log backend nếu lỗi tiếp diễn.'});
    } finally {busy.delete(id);}
  });
}
