import 'dotenv/config';
import { registerGoogleConnect } from './google-connect.js';
import express from 'express';
import cors from 'cors';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { createClient } from '@supabase/supabase-js';
import cron from 'node-cron';
import { processAllSocialPosts } from './social_worker.js';
import axios from 'axios';
import { registerZaloHistory, saveZaloWebhook, zaloWebhookLabel } from './zalo-history.js';
import { registerFacebookChat } from './facebook-chat.js';
import { registerInstagramChat } from './instagram-chat.js';

const app = express();
app.use(express.json({verify:(req,res,buf)=>{
    if (['/webhook/facebook','/webhook/instagram'].includes(req.originalUrl.split('?')[0])) req.rawBody = Buffer.from(buf);
}}));
app.use(cors()); 

// CẤU HÌNH MỞ RỘNG BĂNG THÔNG
app.use(express.json({ limit: '500mb' }));
app.use(express.urlencoded({ limit: '500mb', extended: true }));

// ==========================================
// 1. CẤU HÌNH API KEYS
// ==========================================
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

// ==========================================
// 1. HỆ THỐNG BẢO MẬT & ĐĂNG NHẬP
// ==========================================
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
const AUTH_TOKEN = process.env.AUTH_TOKEN;

// "Cửa an ninh": Kiểm tra xem trình duyệt có trình ra đúng thẻ Token không
const requireAuth = (req, res, next) => {
    const token = req.headers['authorization'];
    if (AUTH_TOKEN && token === `Bearer ${AUTH_TOKEN}`) {
        next(); // Cho phép đi tiếp vào trong API
    } else {
        res.status(401).json({ success: false, message: 'Từ chối truy cập. Vui lòng đăng nhập lại!' });
    }
};
// ==========================================
// CỬA PHỤ: GIỮ MÁY CHỦ THỨC 24/7 (KEEP-ALIVE)
// ==========================================
app.get('/api/keep-alive', (req, res) => {
    res.status(200).send('Máy chủ đang thức để canh lịch đăng bài!');
});

// API Đăng nhập: Cấp Token nếu nhập đúng mật khẩu
app.post('/api/login', (req, res) => {
    if (req.body.password === ADMIN_PASSWORD) {
        res.json({ success: true, token: AUTH_TOKEN });
    } else {
        res.status(401).json({ success: false, message: 'Mật khẩu không chính xác!' });
    }
});

// ==========================================
// API 1: TRỢ LÝ AI SOẠN KỊCH BẢN 
// ==========================================
app.post('/api/generate-content', requireAuth, async (req, res) => {
    try {
        const { prompt } = req.body;
        const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" }); 
        const systemInstruction = `Bạn là chuyên gia Content Marketing của hệ thống Bin Bin Hotel (chuỗi 16 khách sạn). Hãy viết 1 bài đăng mạng xã hội dựa trên yêu cầu. Giọng điệu: Chuyên nghiệp, thu hút. Tách đoạn rõ ràng. Luôn dùng hashtag: #BinBinHotel`;

        const result = await model.generateContent(`${systemInstruction}\n\nYêu cầu: ${prompt}`);
        res.json({ success: true, content: result.response.text() });
    } catch (error) {
        console.error("[AI] ❌ Lỗi:", error);
        res.status(500).json({ success: false, message: "Lỗi kết nối AI" });
    }
});

// ==========================================
// API 3: TẠO BÀI VIẾT HOẶC LƯU NHÁP
// ==========================================
app.post('/api/publish', requireAuth, async (req, res) => {
    try {
        const { content, mediaUrls, platforms, isPostNow, scheduledTime, isDraft } = req.body;
        
        // Xác định trạng thái: Nếu là nháp thì gán 'draft', xuất bản thì gán 'pending'
        const status = isDraft ? 'draft' : 'pending';

        const postData = {
            content: content,
            media_urls: mediaUrls || [],
            scheduled_time: (isPostNow || isDraft) ? null : scheduledTime,
            status_facebook: platforms.includes('facebook') ? status : null,
            status_instagram: platforms.includes('instagram') ? status : null,
            status_zalo: platforms.includes('zalo') ? status : null,
        };

        const { data, error } = await supabase.from('social_posts').insert([postData]).select();
        if (error) throw error;

        res.json({ success: true, message: isDraft ? 'Đã lưu nháp thành công!' : 'Đã đưa vào hàng đợi xuất bản!', data });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// ==========================================
// API MỚI: CẤP CHÌA KHÓA SUPABASE CHO FRONTEND
// ==========================================
app.get('/api/config', requireAuth, (req, res) => {
    res.json({
        success: true,
        supabaseUrl: process.env.SUPABASE_URL,
        supabaseKey: process.env.SUPABASE_KEY
    });
});

// ==========================================
// API 4: LẤY DANH SÁCH BÀI VIẾT (Cho Bảng quản lý)
// ==========================================
app.get('/api/posts', requireAuth, async (req, res) => {
    try {
        const { data, error } = await supabase
            .from('social_posts')
            .select('*')
            .order('created_at', { ascending: false }); // Lấy bài mới nhất lên đầu
        
        if (error) throw error;
        res.json({ success: true, posts: data });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// ==========================================
// API 5: XÓA BÀI VIẾT TỪ BẢNG QUẢN LÝ
// ==========================================
app.delete('/api/posts/:id', requireAuth, async (req, res) => {
    try {
        const { error } = await supabase.from('social_posts').delete().eq('id', req.params.id);
        if (error) throw error;
        res.json({ success: true, message: 'Đã xóa bài viết!' });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// ==========================================
// API 6: CHUYỂN BÀI NHÁP THÀNH CHỜ ĐĂNG
// ==========================================
app.put('/api/posts/:id/publish', requireAuth, async (req, res) => {
    try {
        // 1. Lấy thông tin bài viết hiện tại
        const { data: post, error: fetchErr } = await supabase.from('social_posts').select('*').eq('id', req.params.id).single();
        if (fetchErr) throw fetchErr;

        // 2. Chuyển các nền tảng đang 'draft' thành 'pending'
        let updateData = {};
        if (post.status_facebook === 'draft') updateData.status_facebook = 'pending';
        if (post.status_instagram === 'draft') updateData.status_instagram = 'pending';
        if (post.status_zalo === 'draft') updateData.status_zalo = 'pending';

        const { error: updateErr } = await supabase.from('social_posts').update(updateData).eq('id', req.params.id);
        if (updateErr) throw updateErr;

        res.json({ success: true, message: 'Đã đẩy bài nháp lên hàng đợi!' });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});
// ==========================================
// BỘ ĐẾM THỜI GIAN (CRON JOB)
// ==========================================
cron.schedule('* * * * *', () => {
    console.log("⏰ [Cron] Đang rà soát bài viết theo lịch hẹn...");
    processAllSocialPosts();
});

// ==========================================
// KẾT NỐI GOOGLE BUSINESS PROFILE (OAUTH 2.0)
// ==========================================
registerGoogleConnect(app, supabase, requireAuth);

// ==========================================
// HỆ THỐNG OMNICHANNEL: WEBHOOK & DATABASE
// ==========================================
// Verified Messenger webhooks and authenticated sends; separate from Zalo.
registerFacebookChat(app, supabase, requireAuth);
registerInstagramChat(app, supabase, requireAuth);

// ==========================================
// CỔNG GET: TRANG CHỦ & XÁC THỰC ZALO DOMAIN
// ==========================================
app.get('/', (req, res) => {
    res.send(`
        <!DOCTYPE html>
        <html lang="en">
        <head>
            <meta property="zalo-platform-site-verification" content="Rlg74OVOCmPzsOO6ZUS694_LYNgZer8dC3Ss" />
            <title>Bin Bin Hotel - Webhook Server</title>
        </head>
        <body>
            <h1>Máy chủ Webhook đa kênh Bin Bin Hotel đang hoạt động!</h1>
        </body>
        </html>
    `);
});

// ==========================================
// CỔNG POST: Nhận tin nhắn thực tế từ ZALO OA (BẢN BẮT MỌI PAYLOAD)
// ==========================================
function binbinZaloProfileFields(response) {
    const fields = {};
    if (!response || response.error !== 0 || !response.data) return fields;
    for (const [source, target] of [['display_name', 'customer_name'], ['avatar', 'customer_avatar']]) {
        const value = response.data[source];
        if (typeof value === 'string' && value.trim()) fields[target] = value.trim();
    }
    return fields;
}

app.post('/webhook/zalo', async (req, res) => {
    // 1. Phản hồi Zalo ngay lập tức
    res.status(200).send("OK");

    try {
        const body = req.body;
        const event = body?.event_name;
        
        // ==========================================
        // A. LUỒNG KHÁCH HÀNG GỬI ĐẾN
        // ==========================================
        if (event && event.startsWith('user_send_')) {
            const senderId = body.sender?.id;
            let text = body.message?.text || '';

            if (!text && event !== 'user_send_text') text = zaloWebhookLabel(event);

            if (senderId && text) {
                console.log(`\n💬 [ZALO] Bắt đầu xử lý tin từ khách ${senderId}...`);
                
                let customerName = `Khách ${senderId.substring(0, 4)}`;
                let customerAvatar = null;
                let verifiedProfile = {};

                console.log(`🔍 [Bước 1 & 2] Lấy Profile Zalo...`);
                // Lấy CẢ access_token VÀ refresh_token
                const { data: zaloToken } = await supabase.from('social_tokens').select('access_token, refresh_token').eq('platform', 'zalo').single();

                if (zaloToken && zaloToken.access_token) {
                    try {
                        let accessToken = zaloToken.access_token;
                        
                        // Lần gọi 1
                        let profileRes = await fetch(`https://openapi.zalo.me/v3.0/oa/user/detail?data=${encodeURIComponent(JSON.stringify({ user_id: senderId }))}`, {
                            headers: { 'access_token': accessToken }
                        });
                        let profileData = await profileRes.json();

                        // NẾU TOKEN HẾT HẠN (Lỗi -216 hoặc -124) -> TỰ ĐỘNG LÀM MỚI
                        if (profileData.error === -216 || profileData.error === -124) {
                            console.log("🔄 Token Zalo hết hạn! Đang dùng Refresh Token để đổi khóa mới...");
                            
                            const refreshRes = await fetch('https://oauth.zaloapp.com/v4/oa/access_token', {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'secret_key': process.env.ZALO_SECRET_KEY },
                                body: new URLSearchParams({
                                    app_id: process.env.ZALO_APP_ID,
                                    grant_type: 'refresh_token',
                                    refresh_token: zaloToken.refresh_token
                                })
                            });
                            
                            const refreshData = await refreshRes.json();
                            
                            if (refreshData.access_token) {
                                accessToken = refreshData.access_token;
                                // Lưu khóa mới vào DB
                                await supabase.from('social_tokens').update({
                                    access_token: accessToken,
                                    refresh_token: refreshData.refresh_token
                                }).eq('platform', 'zalo');
                                
                                console.log("✅ Đã làm mới Token! Đang gọi lại API Profile...");
                                // Lần gọi 2 (Với khóa mới)
                                profileRes = await fetch(`https://openapi.zalo.me/v3.0/oa/user/detail?data=${encodeURIComponent(JSON.stringify({ user_id: senderId }))}`, {
                                    headers: { 'access_token': accessToken }
                                });
                                profileData = await profileRes.json();
                            } else {
                                console.log("❌ Lỗi Refresh Token Zalo:", refreshData);
                            }
                        }

                        // Cập nhật tên và avatar nếu gọi thành công
                        verifiedProfile = binbinZaloProfileFields(profileData);
                        if (Object.keys(verifiedProfile).length) {
                            customerName = verifiedProfile.customer_name || customerName;
                            customerAvatar = verifiedProfile.customer_avatar || customerAvatar;
                            console.log(`✅ Lấy thành công Profile: ${customerName}`);
                        } else {
                            console.log(`⚠️ Zalo từ chối trả Profile:`, profileData);
                        }

                    } catch (e) { console.log("⚠️ Lỗi mạng khi lấy Profile:", e.message); }
                }

                console.log(`🔍 [Bước 3] Xử lý UUID cho bảng chat_conversations...`);
                let validConversationId;

                // KIỂM TRA KHÁCH CŨ HAY MỚI
                const { data: existConv, error: findErr } = await supabase
                    .from('chat_conversations')
                    .select('id')
                    .eq('customer_id', senderId)
                    .eq('platform', 'zalo')
                    .maybeSingle();

                if (findErr) throw new Error("Lỗi tìm hội thoại: " + findErr.message);

                if (existConv) {
                    // Khách cũ -> Dùng UUID cũ và cập nhật tin nhắn mới nhất
                    validConversationId = existConv.id;
                    await supabase.from('chat_conversations').update({
                        ...verifiedProfile,
                        last_message: text,
                        updated_at: new Date().toISOString()
                    }).eq('id', validConversationId);
                } else {
                    // Khách mới -> Insert và để Supabase tự sinh UUID (select('id').single() để lấy lại UUID đó)
                    const { data: newConv, error: insertConvErr } = await supabase.from('chat_conversations').insert({
                        customer_id: senderId,
                        platform: 'zalo',
                        customer_name: customerName,
                        customer_avatar: customerAvatar,
                        last_message: text,
                        updated_at: new Date().toISOString()
                    }).select('id').single(); 

                    if (insertConvErr) throw new Error("Lỗi Insert hội thoại: " + insertConvErr.message);
                    validConversationId = newConv.id;
                }

                console.log(`🔍 [Bước 4] Lưu tin nhắn với UUID chuẩn: ${validConversationId}`);
                await saveZaloWebhook(supabase, {
                    conversation_id: validConversationId,
                    sender_type: 'customer',
                    message_text: text,
                    created_at: new Date().toISOString()
                }, body);
                console.log("✅ ĐÃ LƯU THÀNH CÔNG VÀO SUPABASE!");
            }
        }

        // ==========================================
        // B. LUỒNG ĐỒNG BỘ PANCAKE (Cũng đã sửa dùng UUID)
        // ==========================================
        if (['oa_send_text','oa_send_image','oa_send_gif','oa_send_video','oa_send_audio','oa_send_sticker','oa_send_file','oa_send_link','oa_send_location','oa_send_business_card'].includes(event)) {
            const customerId = body.recipient?.id;
            let text = body.message?.text || (event === 'oa_send_text' ? '' : zaloWebhookLabel(event));

            if (customerId && text) {
                console.log(`🔄 [PANCAKE] Đang đồng bộ tin nhắn gửi cho khách ${customerId}...`);
                
                // Lấy UUID của khách từ CSDL
                const { data: existConv } = await supabase
                    .from('chat_conversations')
                    .select('id')
                    .eq('customer_id', customerId)
                    .eq('platform', 'zalo')
                    .maybeSingle();
                    
                if (existConv) {
                    await saveZaloWebhook(supabase, {
                        conversation_id: existConv.id,
                        sender_type: 'page',
                        message_text: text,
                        created_at: new Date().toISOString()
                    }, body);
                    
                    await supabase.from('chat_conversations').update({
                        last_message: text,
                        updated_at: new Date().toISOString()
                    }).eq('id', existConv.id);
                    
                    console.log(`✅ Đồng bộ xong tin nhắn Pancake!`);
                } else {
                    console.log("⚠️ Không tìm thấy hội thoại để đồng bộ.");
                }
            }
        }

    } catch (error) {
        console.error("❌ LỖI NGHIÊM TRỌNG TRONG WEBHOOK ZALO:", error);
    }
});

// ==========================================
// API: LỄ TÂN GỬI TIN NHẮN TỪ GIAO DIỆN PMS
// ==========================================
// Retire the old placeholder route which reported success without sending.
app.post('/api/chat/send', requireAuth, (req,res) => {
    res.status(410).json({success:false,message:'Dùng endpoint gửi riêng của Facebook hoặc Zalo. Endpoint cũ đã dừng.'});
});

registerZaloHistory(app, supabase, requireAuth);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🚀 Máy chủ Backend đang chạy tại Port: ${PORT}`);
});