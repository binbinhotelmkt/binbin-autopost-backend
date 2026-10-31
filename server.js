import 'dotenv/config';
import { google } from 'googleapis';
import express from 'express';
import cors from 'cors';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { createClient } from '@supabase/supabase-js';
import cron from 'node-cron';
import { processAllSocialPosts } from './social_worker.js';
import axios from 'axios';

const app = express();
app.use(express.json());
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
    if (token === `Bearer ${AUTH_TOKEN}`) {
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
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const GOOGLE_REDIRECT_URI = 'http://localhost:3000/auth/google/callback';

const oauth2Client = new google.auth.OAuth2(
    GOOGLE_CLIENT_ID,
    GOOGLE_CLIENT_SECRET,
    GOOGLE_REDIRECT_URI
);

// 1. NẠP CHÌA KHÓA VĨNH VIỄN VÀO BỘ NHỚ
oauth2Client.setCredentials({
    // Dán mã anh vừa lấy được vào trong cặp dấu nháy đơn dưới đây:
    refresh_token: process.env.GOOGLE_REFRESH_TOKEN 
});

// 2. API QUÉT ĐỊA BÀN: LẤY DANH SÁCH CHI NHÁNH BIN BIN HOTEL
app.get('/api/google-locations', requireAuth, async (req, res) => {
    try {
        console.log("🔍 Đang kết nối Google lấy danh sách chi nhánh...");
        const tokenResponse = await oauth2Client.getAccessToken();
        const accessToken = tokenResponse.token;

        const accRes = await fetch('https://mybusinessaccountmanagement.googleapis.com/v1/accounts', {
            headers: { 'Authorization': `Bearer ${accessToken}` }
        });
        const accData = await accRes.json();
        
        // In thẳng phản hồi gốc từ Google ra Terminal để bắt bệnh
        console.log("=========================================");
        console.log("🚨 PHẢN HỒI GỐC TỪ GOOGLE:");
        console.log(accData);
        console.log("=========================================");
        
        // Nếu Google báo lỗi (VD: Chưa bật API)
        if (accData.error) {
            return res.json({ success: false, message: `Lỗi từ Google: ${accData.error.message}` });
        }
        
        // Nếu Google không báo lỗi nhưng danh sách trống
        if (!accData.accounts || accData.accounts.length === 0) {
            return res.json({ success: false, message: "Email anh vừa xác thực KHÔNG quản lý bất kỳ cơ sở nào trên Google Maps." });
        }
        
        const accountName = accData.accounts[0].name; 
        
        const locRes = await fetch(`https://mybusinessbusinessinformation.googleapis.com/v1/${accountName}/locations?readMask=name,title`, {
            headers: { 'Authorization': `Bearer ${accessToken}` }
        });
        const locData = await locRes.json();

        console.log("🏢 DANH SÁCH CHI NHÁNH TRÊN GOOGLE MAPS:");
        console.log(locData.locations);

        res.json({ success: true, message: "Quét thành công! Hãy xem danh sách chi nhánh in ra ở cửa sổ Terminal Node.js!" });
    } catch (error) {
        console.error("[Google Maps] ❌ Lỗi:", error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// ==========================================
// HỆ THỐNG OMNICHANNEL: WEBHOOK & DATABASE
// ==========================================
const FB_VERIFY_TOKEN = 'BinBinHotel_2026'; 

// HÀM XỬ LÝ: Tự động phân loại, lấy Tên/Ảnh Meta và lưu vào Supabase
async function saveMessageToSupabase(senderId, text, platform = 'facebook') {
    try {
        let conversationId;

        // 1. Tìm xem khách này đã từng chat chưa
        const { data: existingConv } = await supabase
            .from('chat_conversations')
            .select('id, customer_name')
            .eq('customer_id', senderId)
            .eq('platform', platform)
            .single();

        if (!existingConv) {
            // KHÁCH MỚI: Khởi tạo dữ liệu mặc định
            let customerName = "Khách hàng " + senderId.substring(0, 4);
            let customerAvatar = "";

            // Gọi API Meta để xin Tên thật và Ảnh đại diện
            if (platform === 'facebook') {
                const { data: tokenData } = await supabase
                    .from('social_tokens')
                    .select('access_token')
                    .eq('platform', 'facebook')
                    .single();

                if (tokenData && tokenData.access_token) {
                    try {
                        const profileRes = await axios.get(`https://graph.facebook.com/v19.0/${senderId}`, {
                            params: {
                                fields: 'name,profile_pic',
                                access_token: tokenData.access_token
                            }
                        });
                        if (profileRes.data) {
                            customerName = profileRes.data.name;
                            customerAvatar = profileRes.data.profile_pic;
                            console.log(`👤 [Meta] Đã nhận diện được khách: ${customerName}`);
                        }
                    } catch (metaErr) {
                        console.error("❌ [Meta] Lỗi lấy thông tin:", metaErr.response?.data || metaErr.message);
                    }
                }
            }

            // [CODE MỚI] BỔ SUNG: Gọi API Zalo để xin Tên thật và Ảnh đại diện
            if (platform === 'zalo') {
                const { data: tokenData } = await supabase
                    .from('social_tokens')
                    .select('access_token')
                    .eq('platform', 'zalo')
                    .single();

                if (tokenData && tokenData.access_token) {
                    try {
                        const profileRes = await axios.get('https://openapi.zalo.me/v2.0/oa/getprofile', {
                            params: { data: JSON.stringify({ user_id: senderId }) },
                            headers: { 'access_token': tokenData.access_token }
                        });
                        
                        if (profileRes.data && profileRes.data.data) {
                            customerName = profileRes.data.data.display_name;
                            customerAvatar = profileRes.data.data.avatar;
                            console.log(`👤 [Zalo] Đã nhận diện được khách: ${customerName}`);
                        }
                    } catch (zaloErr) {
                        console.error("❌ [Zalo] Lỗi lấy thông tin:", zaloErr.message);
                    }
                }
            }

            // Ghi khách mới vào Database kèm Tên và Ảnh
            const { data: newConv, error: insertError } = await supabase
                .from('chat_conversations')
                .insert([{ 
                    customer_id: senderId, 
                    platform: platform,
                    customer_name: customerName,
                    customer_avatar: customerAvatar,
                    last_message: text,
                    is_read: false
                }])
                .select('id')
                .single();
            
            if (insertError) throw insertError;
            conversationId = newConv.id;
        } else {
            // KHÁCH CŨ: Cập nhật lại câu chat cuối cùng và đẩy lên đầu danh sách
            conversationId = existingConv.id;
            await supabase
                .from('chat_conversations')
                .update({ 
                    last_message: text, 
                    is_read: false,
                    updated_at: new Date()
                })
                .eq('id', conversationId);
        }

        // 2. Lưu chi tiết câu chat vào khung bên phải
        await supabase
            .from('chat_messages')
            .insert([{
                conversation_id: conversationId,
                sender_type: 'customer',
                message_text: text
            }]);

        console.log(`💾 Đã lưu thành công tin nhắn vào Database!`);
    } catch (err) {
        console.error("❌ Lỗi lưu tin nhắn vào DB:", err.message);
    }
}

// CỔNG GET: Meta kiểm tra máy chủ
app.get('/webhook/facebook', (req, res) => {
    if (req.query['hub.mode'] === 'subscribe' && req.query['hub.verify_token'] === FB_VERIFY_TOKEN) {
        res.status(200).send(req.query['hub.challenge']);
    } else {
        res.sendStatus(403);
    }
});

// CỔNG POST: Nhận tin nhắn thực tế
app.post('/webhook/facebook', (req, res) => {
    const body = req.body;

    if (body && body.object === 'page') {
        body.entry.forEach(function(entry) {
            // LUỒNG 1: Nhận chính (Sau này dùng)
            if (entry.messaging) {
                const webhookEvent = entry.messaging[0];
                const senderId = webhookEvent.sender?.id;
                const text = webhookEvent.message?.text;
                if (text) {
                    console.log(`📬 [CHÍNH THỨC] Khách ${senderId} nhắn: "${text}"`);
                    saveMessageToSupabase(senderId, text, 'facebook');
                }
            }

            // LUỒNG 2: Nghe lén (Pancake đang nhận chính)
            if (entry.standby) {
                const standbyEvent = entry.standby[0];
                const senderId = standbyEvent.sender?.id;
                const text = standbyEvent.message?.text;
                if (text) {
                    console.log(`🕵️ [ĐỌC TRỘM - STANDBY] Khách ${senderId} nhắn: "${text}"`);
                    saveMessageToSupabase(senderId, text, 'facebook');
                }
            }
        });
        
        res.status(200).send('EVENT_RECEIVED');
    } else {
        res.sendStatus(404);
    }
});

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

            if (event === 'user_send_image') text = '[Hình ảnh]';
            else if (event === 'user_send_sticker') text = '[Sticker]';
            else if (event === 'user_send_audio') text = '[Tin nhắn thoại]';
            else if (event === 'user_send_location') text = '[Vị trí]';
            else if (event === 'user_send_link') text = '[Liên kết]';

            if (senderId && text) {
                console.log(`\n💬 [ZALO] Bắt đầu xử lý tin từ khách ${senderId}...`);
                
                let customerName = `Khách ${senderId.substring(0, 4)}`;
                let customerAvatar = null;

                console.log(`🔍 [Bước 1 & 2] Lấy Profile Zalo...`);
                // Lấy CẢ access_token VÀ refresh_token
                const { data: zaloToken } = await supabase.from('social_tokens').select('access_token, refresh_token').eq('platform', 'zalo').single();

                if (zaloToken && zaloToken.access_token) {
                    try {
                        let accessToken = zaloToken.access_token;
                        
                        // Lần gọi 1
                        let profileRes = await fetch(`https://openapi.zalo.me/v2.0/oa/getprofile?data=${encodeURIComponent(JSON.stringify({ user_id: senderId }))}`, {
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
                                profileRes = await fetch(`https://openapi.zalo.me/v2.0/oa/getprofile?data=${encodeURIComponent(JSON.stringify({ user_id: senderId }))}`, {
                                    headers: { 'access_token': accessToken }
                                });
                                profileData = await profileRes.json();
                            } else {
                                console.log("❌ Lỗi Refresh Token Zalo:", refreshData);
                            }
                        }

                        // Cập nhật tên và avatar nếu gọi thành công
                        if (profileData && profileData.data) {
                            customerName = profileData.data.display_name || customerName;
                            customerAvatar = profileData.data.avatar || null;
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
                        customer_name: customerName,
                        customer_avatar: customerAvatar,
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
                const { error: insertErr } = await supabase.from('chat_messages').insert({
                    conversation_id: validConversationId, 
                    sender_type: 'customer', 
                    message_text: text, 
                    created_at: new Date().toISOString()
                });

                if (insertErr) throw new Error("Lỗi Insert tin nhắn: " + insertErr.message);
                console.log("✅ ĐÃ LƯU THÀNH CÔNG VÀO SUPABASE!");
            }
        }

        // ==========================================
        // B. LUỒNG ĐỒNG BỘ PANCAKE (Cũng đã sửa dùng UUID)
        // ==========================================
        if (event === 'oa_send_text' || event === 'oa_send_image') {
            const customerId = body.recipient?.id;
            let text = body.message?.text || (event === 'oa_send_image' ? '[Hình ảnh Lễ tân gửi]' : '');

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
                    await supabase.from('chat_messages').insert({
                        conversation_id: existConv.id,
                        sender_type: 'page', 
                        message_text: text,
                        created_at: new Date().toISOString()
                    });
                    
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
app.post('/api/chat/send', async (req, res) => {
    try {
        // req.user được lấy từ middleware xác thực token (nếu anh có)
        const { conversation_id, platform, customer_id, text, media_urls } = req.body;

        if (!conversation_id || !platform || !customer_id) {
            return res.status(400).json({ success: false, message: "Thiếu thông tin người nhận!" });
        }

        // 1. LƯU LỊCH SỬ VÀO DATABASE TRƯỚC
        // Lưu vào bảng chat_messages với sender_type là 'page' hoặc 'admin'
        const { error: dbError } = await supabase.from('chat_messages').insert([{
            conversation_id: conversation_id,
            sender_type: 'page', // Xác định đây là tin do Lễ tân gửi
            message_text: text || '',
            attachments: media_urls && media_urls.length > 0 ? JSON.stringify(media_urls) : null,
            created_at: new Date().toISOString()
        }]);

        if (dbError) throw new Error("Không thể lưu tin nhắn vào CSDL: " + dbError.message);

        // 2. PHÂN LUỒNG BẮN API SANG FACEBOOK HOẶC ZALO
        if (platform === 'facebook') {
            // Logic lấy Page Token từ bảng social_tokens và gọi Axios sang Facebook Graph API
            // (Chúng ta sẽ viết chi tiết luồng Facebook sau khi anh test UI xong)
            console.log(`[FB] Đang bắn tin nhắn "${text}" tới ID: ${customer_id}`);
            
        } else if (platform === 'zalo') {
            // Logic lấy Zalo Token từ bảng social_tokens và gọi Zalo OpenAPI
            // (Chúng ta sẽ viết chi tiết luồng Zalo sau khi anh test UI xong)
            console.log(`[ZALO] Đang bắn tin nhắn "${text}" tới ID: ${customer_id}`);
        }

        // 3. TRẢ KẾT QUẢ VỀ CHO TRÌNH DUYỆT CẬP NHẬT 2 DẤU TICK
        res.json({ success: true, message: "Đã gửi thành công!" });

    } catch (error) {
        console.error("❌ Lỗi gửi tin nhắn chat:", error);
        res.status(500).json({ success: false, message: error.message });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🚀 Máy chủ Backend đang chạy tại Port: ${PORT}`);
});