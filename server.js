import 'dotenv/config';
import { google } from 'googleapis';
import express from 'express';
import cors from 'cors';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { createClient } from '@supabase/supabase-js';
import cron from 'node-cron';
import { processAllSocialPosts } from './social_worker.js';

const app = express();
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
// HỆ THỐNG OMNICHANNEL: WEBHOOK FACEBOOK & INSTAGRAM
// ==========================================
// Mật mã tự tạo để Meta xác nhận đúng là máy chủ của Bin Bin Hotel
const FB_VERIFY_TOKEN = 'BinBinHotel_2026'; 

// 1. CỔNG GET: Dùng để Meta kiểm tra (Verify) máy chủ lúc cài đặt
app.get('/webhook/facebook', (req, res) => {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];

    if (mode && token) {
        if (mode === 'subscribe' && token === FB_VERIFY_TOKEN) {
            console.log('✅ [Meta] Đã xác minh Webhook thành công!');
            res.status(200).send(challenge);
        } else {
            res.sendStatus(403);
        }
    }
});

// 2. CỔNG POST: Nơi nhận tin nhắn thực tế từ khách hàng
app.post('/webhook/facebook', (req, res) => {
    const body = req.body;

    if (body.object === 'page') {
        body.entry.forEach(function(entry) {
            // Trích xuất tin nhắn của khách
            const webhookEvent = entry.messaging[0];
            const senderId = webhookEvent.sender.id;
            
            if (webhookEvent.message && webhookEvent.message.text) {
                console.log(`📬 [Messenger] Khách ID ${senderId} vừa nhắn: "${webhookEvent.message.text}"`);
            }
        });
        
        // Bắt buộc phải trả lời 200 OK ngay lập tức để Meta không gửi lại tin cũ
        res.status(200).send('EVENT_RECEIVED');
    } else {
        res.sendStatus(404);
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🚀 Máy chủ Backend đang chạy tại Port: ${PORT}`);
});