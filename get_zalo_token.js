import express from 'express';
import axios from 'axios';

const app = express();
const port = 3000;

// 🔴 ĐIỀN THÔNG TIN APP ZALO CỦA BẠN VÀO ĐÂY:
const ZALO_APP_ID = '1993896583983966448'; 
const ZALO_SECRET = 'eH9bHO1eXIMlTJ2TaEt3';
const REDIRECT_URI = `http://localhost:${port}/callback`;

app.get('/', (req, res) => {
    // Chuyển hướng người dùng sang trang ủy quyền của Zalo
    const authUrl = `https://oauth.zaloapp.com/v4/oa/permission?app_id=${ZALO_APP_ID}&redirect_uri=${REDIRECT_URI}`;
    res.redirect(authUrl);
});

app.get('/callback', async (req, res) => {
    // Lấy mã xác thực (oauthcode) từ URL trả về
    const code = req.query.oauthcode || req.query.code;
    
    if (!code) {
        return res.send('❌ Lỗi: Không tìm thấy authorization code từ Zalo!');
    }

    try {
        console.log('⏳ Đang dùng Auth Code để đổi lấy bộ Token...');
        
        // Gọi API cấp Token của Zalo
        const response = await axios.post('https://oauth.zaloapp.com/v4/oa/access_token',
            `app_id=${ZALO_APP_ID}&grant_type=authorization_code&code=${code}`,
            {
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded',
                    'secret_key': ZALO_SECRET
                }
            }
        );

        const data = response.data;

        if (data.access_token) {
            console.log('\n=============================================');
            console.log('✅ LẤY TOKEN ZALO THÀNH CÔNG!');
            console.log('\n🔑 ACCESS TOKEN (Sống 25 tiếng):');
            console.log(data.access_token);
            console.log('\n🗝️ REFRESH TOKEN (Sống 3 tháng - RẤT QUAN TRỌNG):');
            console.log(data.refresh_token);
            console.log('=============================================\n');
            
            res.send('<h1>✅ Ủy quyền Zalo thành công! Hãy xem cửa sổ Terminal để lấy Token.</h1>');
        } else {
            console.error('❌ Zalo từ chối cấp Token:', data);
            res.send('❌ Lỗi: Zalo từ chối cấp Token. Xem Terminal.');
        }

    } catch (error) {
        console.error('❌ Lỗi hệ thống:', error.response?.data || error.message);
        res.send('❌ Lỗi hệ thống. Xem Terminal.');
    }
});

app.listen(port, () => {
    console.log(`🚀 Trạm lấy Token Zalo đã khởi động!`);
    console.log(`👉 Hãy mở trình duyệt và truy cập: http://localhost:${port}`);
});