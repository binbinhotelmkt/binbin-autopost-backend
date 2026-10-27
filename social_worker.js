import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
import axios from 'axios';

// 1. KẾT NỐI SUPABASE (Bắt buộc phải điền 2 mã này để hệ thống vào DB lấy Token)
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);
const ZALO_APP_ID = process.env.ZALO_APP_ID;
const ZALO_SECRET_KEY = process.env.ZALO_SECRET_KEY;

// ==========================================
// --- HÀM TỰ ĐỘNG LÀM MỚI TOKEN ZALO ---
// ==========================================
async function refreshZaloToken(tokenId, oldRefreshToken) {
    try {
        console.log(`[Zalo] 🔄 Đang mang Refresh Token đi đổi chìa khóa mới...`);
        const response = await axios.post('https://oauth.zaloapp.com/v4/oa/access_token', null, {
            headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'secret_key': ZALO_SECRET_KEY },
            params: { app_id: ZALO_APP_ID, grant_type: 'refresh_token', refresh_token: oldRefreshToken }
        });

        if (response.data.access_token) {
            console.log(`[Zalo] 🎉 Làm mới Token thành công! Đã lưu tự động vào DB.`);
            await supabase.from('social_tokens').update({
                access_token: response.data.access_token,
                refresh_token: response.data.refresh_token 
            }).eq('id', tokenId);
            return response.data.access_token;
        } else {
            console.error(`[Zalo] ❌ Đổi Token thất bại:`, response.data);
            return null;
        }
    } catch (error) {
        console.error("[Zalo] ❌ Lỗi mạng khi đổi Token:", error.message);
        return null;
    }
}

// ==========================================
// --- MODULE ZALO (KHÔI PHỤC BẢN CHUẨN GỐC CỦA USER) ---
// ==========================================
async function publishToZalo(post, zaloTokenRow, isRetry = false) {
    try {
        if (!post.media_urls || post.media_urls.length === 0) {
            console.log(`[Zalo] ⚠️ Bỏ qua: Zalo Article yêu cầu phải có ít nhất 1 ảnh bìa.`);
            return false;
        }

        console.log(`[Zalo] - Đang xuất bản Article bằng link ảnh trực tiếp (Bản gốc)...`);
        const coverUrl = post.media_urls[0];

        // 1. Tách bài viết thành các dòng (tự động bỏ qua các dòng trống)
        const lines = post.content.split('\n').filter(line => line.trim() !== '');
        
        // 2. Bốc tách Tiêu đề (Dòng đầu tiên, bảo vệ tối đa 140 ký tự)
        let titleLine = lines.length > 0 ? lines[0].trim() : "Thông báo từ Bin Bin Hotel";
        if (titleLine.length > 140) titleLine = titleLine.substring(0, 140) + "...";

        // 3. Nội dung Body (Các dòng dưới, nếu chỉ có 1 dòng thì lấy luôn titleLine)
        let bodyContent = lines.length > 1 ? lines.slice(1).join('\n').trim() : titleLine;

        // 4. Đóng gói chuẩn gửi cho Zalo
        const payload = {
            "type": "normal",
            "title": titleLine,
            "author": "Bin Bin Hotel",
            "cover": {
                "cover_type": "photo",
                "photo_url": coverUrl, 
                "status": "show"
            },
            // BẢN VÁ: Đảm bảo mô tả luôn có chữ (từ 1 - 290 ký tự)
            "description": bodyContent.substring(0, 290) || "Cập nhật mới từ Bin Bin Hotel",
            "body": [
                {
                    "type": "text",
                    "content": bodyContent
                }
            ],
            "status": "show"
        };
        
        const publishRes = await axios.post('https://openapi.zalo.me/v2.0/article/create', payload, {
            headers: {
                'access_token': zaloTokenRow.access_token,
                'Content-Type': 'application/json'
            }
        });

        // BẮT LỖI TOKEN VÀ TỰ ĐỘNG LÀM MỚI
        if ((publishRes.data.error === -216 || publishRes.data.error === -124 || publishRes.data.error === -220) && !isRetry) {
            console.log(`[Zalo] 🔄 Token hết hạn (Mã: ${publishRes.data.error}). Đang tự động làm mới...`);
            const newAccessToken = await refreshZaloToken(zaloTokenRow.id, zaloTokenRow.refresh_token);
            if (newAccessToken) {
                zaloTokenRow.access_token = newAccessToken; 
                return await publishToZalo(post, zaloTokenRow, true); 
            }
        }

        if (publishRes.data.error === 0) {
            console.log(`[Zalo] ✅ Đăng thành công! Article ID: ${publishRes.data.data.token}`);
            return publishRes.data.data.token;
        } else {
            console.error(`[Zalo] ❌ Lỗi tạo bài:`, publishRes.data.message);
            return false;
        }

    } catch (error) {
        console.error(`[Zalo] ❌ Lỗi kết nối:`, error.response?.data?.message || error.message);
        return false;
    }
}

// ==========================================
// --- MODULE INSTAGRAM (ĐÃ NÂNG CẤP ALBUM CAROUSEL) ---
// ==========================================
async function publishToInstagram(post, igAccountId, pageToken) {
    try {
        if (!post.media_urls || post.media_urls.length === 0) return false;
        let creationId;

        if (post.media_urls.length === 1) {
            const mediaUrl = post.media_urls[0];
            const isVideo = mediaUrl.toLowerCase().includes('.mp4') || mediaUrl.toLowerCase().includes('.mov');
            
            console.log(`[Instagram] - Đang tạo vùng chứa 1 ${isVideo ? 'Video' : 'Ảnh'}...`);
            
            let params = { caption: post.content, access_token: pageToken };
            if (isVideo) {
                params.media_type = 'VIDEO';
                params.video_url = mediaUrl; // IG yêu cầu dùng video_url cho file mp4
            } else {
                params.image_url = mediaUrl; // Dùng image_url cho file ảnh
            }

            const containerRes = await axios.post(`https://graph.facebook.com/v19.0/${igAccountId}/media`, null, { params });
            creationId = containerRes.data.id;
            
            // TẠM DỪNG THÔNG MINH: Ảnh chờ 5 giây, Video nặng chờ 30 giây để IG xử lý HD
            const waitTime = isVideo ? 30000 : 5000;
            console.log(`[Instagram] - Chờ Meta đóng gói ${isVideo ? 'Video (30s)' : 'Ảnh (5s)'}...`);
            await new Promise(resolve => setTimeout(resolve, waitTime));
        } else {
            console.log(`[Instagram] - Đang tách lớp tải ngầm ${post.media_urls.length} ảnh (Carousel)...`);
            const childrenIds = [];
            const maxImages = Math.min(post.media_urls.length, 10);
            
            for (let i = 0; i < maxImages; i++) {
                const childRes = await axios.post(`https://graph.facebook.com/v19.0/${igAccountId}/media`, null, {
                    params: { image_url: post.media_urls[i], is_carousel_item: true, access_token: pageToken }
                });
                childrenIds.push(childRes.data.id);
            }

            console.log(`[Instagram] - Đang gom các ảnh lại thành Album...`);
            const carouselRes = await axios.post(`https://graph.facebook.com/v19.0/${igAccountId}/media`, null, {
                params: { media_type: 'CAROUSEL', children: childrenIds.join(','), caption: post.content, access_token: pageToken }
            });
            creationId = carouselRes.data.id;
        }
        
        console.log(`[Instagram] - Chờ Meta đóng gói ảnh (5 giây)...`);
        await new Promise(resolve => setTimeout(resolve, 5000));
        
        console.log(`[Instagram] - Đang xuất bản lên tường...`);
        const publishRes = await axios.post(`https://graph.facebook.com/v19.0/${igAccountId}/media_publish`, null, {
            params: { creation_id: creationId, access_token: pageToken }
        });

        console.log(`[Instagram] ✅ Đăng thành công! IG Post ID: ${publishRes.data.id}`);
        return publishRes.data.id;
    } catch (error) {
        console.error(`[Instagram] ❌ Lỗi:`, error.response?.data?.error?.message || error.message);
        return false;
    }
}

// ==========================================
// --- MODULE FACEBOOK (TỐI ƯU HÓA HIỂN THỊ) ---
// ==========================================
async function publishToFacebook(post, pageId, pageToken) {
    try {
        let payload = { message: post.content, access_token: pageToken };
        if (post.attached_link) payload.link = post.attached_link;

        if (post.media_urls && post.media_urls.length > 0) {
            if (post.media_urls.length === 1) {
                const mediaUrl = post.media_urls[0];
                const isVideo = mediaUrl.toLowerCase().includes('.mp4') || mediaUrl.toLowerCase().includes('.mov');
                
                // Nếu là Video thì đẩy qua cổng /videos, nếu là Ảnh thì đẩy qua cổng /photos
                const endpoint = isVideo ? 'videos' : 'photos';
                let fbPayload = { access_token: pageToken, published: true };

                if (isVideo) {
                    fbPayload.file_url = mediaUrl; // Meta yêu cầu dùng chữ file_url cho video
                    fbPayload.description = post.content;
                } else {
                    fbPayload.url = mediaUrl;
                    fbPayload.message = post.content;
                    if (post.attached_link) fbPayload.link = post.attached_link;
                }

                console.log(`[Facebook] - Đang xuất bản 1 ${isVideo ? 'Video' : 'Ảnh'} thẳng ra tường...`);
                const res = await axios.post(`https://graph.facebook.com/v19.0/${pageId}/${endpoint}`, fbPayload);
                
                console.log(`[Facebook] ✅ Đăng thành công! Post ID: ${res.data.post_id || res.data.id}`);
                return res.data.post_id || res.data.id;
            } else {
                // CHIẾN THUẬT 2: Nếu có nhiều ảnh, tải ngầm rồi gom thành Album
                console.log(`[Facebook] - Đang tải ngầm ${post.media_urls.length} ảnh...`);
                let attached_media = [];
                for (const url of post.media_urls) {
                    const resPhoto = await axios.post(`https://graph.facebook.com/v19.0/${pageId}/photos`, null, {
                        params: { url: url, published: false, access_token: pageToken }
                    });
                    if (resPhoto.data.id) attached_media.push({ media_fbid: resPhoto.data.id });
                }
                if (attached_media.length > 0) payload.attached_media = attached_media;
            }
        }
        
        // Lệnh này sẽ chạy cho bài viết nhiều ảnh, hoặc bài chỉ có chữ (không có ảnh)
        if (!post.media_urls || post.media_urls.length !== 1) {
            const res = await axios.post(`https://graph.facebook.com/v19.0/${pageId}/feed`, payload);
            console.log(`[Facebook] ✅ Đăng feed thành công! Post ID: ${res.data.id}`);
            return res.data.id;
        }
    } catch (error) {
        console.error(`[Facebook] ❌ Lỗi:`, error.response?.data?.error?.message || error.message);
        return false;
    }
}

// ==========================================
// --- HÀM ĐỊNH TUYẾN CHÍNH (ĐÃ TÁCH ĐỘC LẬP 3 KÊNH) ---
// ==========================================
async function processAllSocialPosts() {
    const { data: tokenList } = await supabase.from('social_tokens').select('*');
    const tokens = {};
    if (tokenList) tokenList.forEach(t => tokens[t.platform] = t);

    // 1. TÌM BÀI ĐANG CHỜ (Đã bổ sung quét thêm cột status_instagram)
    const { data: posts, error: fetchError } = await supabase
        .from('social_posts')
        .select('*')
        .or('status_facebook.eq.pending,status_zalo.eq.pending,status_instagram.eq.pending'); 

    if (fetchError) return console.error("❌ Lỗi truy vấn DB:", fetchError.message);
    if (!posts || posts.length === 0) return;

    // 2. KHÓA BÀI (Chống đăng trùng cho cả 3 kênh)
    for (const post of posts) {
        await supabase.from('social_posts').update({
            status_facebook: post.status_facebook === 'pending' ? 'processing' : post.status_facebook,
            status_zalo: post.status_zalo === 'pending' ? 'processing' : post.status_zalo,
            status_instagram: post.status_instagram === 'pending' ? 'processing' : post.status_instagram
        }).eq('id', post.id);
    }

    // 3. XỬ LÝ ĐĂNG BÀI ĐỘC LẬP TỪNG KÊNH VÀ THU THẬP ID
    for (const post of posts) {
        console.log(`\n📦 Đang xử lý bài viết ID: ${post.id}`);
        let updateData = {}; 

        // KÊNH FACEBOOK
        if (post.status_facebook === 'pending' && tokens['facebook']) {
            const fbPostId = await publishToFacebook(post, tokens['facebook'].page_id, tokens['facebook'].access_token);
            if (fbPostId) {
                updateData.status_facebook = 'published';
                updateData.fb_post_id = fbPostId; // Lưu mã biên lai Facebook
            } else {
                updateData.status_facebook = 'failed';
            }
        }

        // KÊNH INSTAGRAM
        if (post.status_instagram === 'pending' && tokens['instagram']) {
            const igPostId = await publishToInstagram(post, tokens['instagram'].page_id, tokens['instagram'].access_token);
            if (igPostId) {
                updateData.status_instagram = 'published';
                updateData.ig_post_id = igPostId; // Lưu mã biên lai Instagram
            } else {
                updateData.status_instagram = 'failed';
            }
        }

        // KÊNH ZALO
        if (post.status_zalo === 'pending' && tokens['zalo']) {
            const zaloArticleId = await publishToZalo(post, tokens['zalo']);
            if (zaloArticleId) {
                updateData.status_zalo = 'published';
                updateData.zalo_article_id = zaloArticleId; // Lưu mã biên lai Zalo
            } else {
                updateData.status_zalo = 'failed';
            }
        }

        // 4. CHỐT KẾT QUẢ VÀ BÓP CÒ DỌN RÁC SUPABASE
        if (Object.keys(updateData).length > 0) {
            
            // 4a. Cập nhật các ID và trạng thái vào Database trước
            await supabase.from('social_posts').update(updateData).eq('id', post.id);
            console.log(`✅ Đã chốt mã biên lai vào Database:`, updateData);

            // 4b. THUẬT TOÁN DỌN RÁC HOÀN CHỈNH
            const isAllChannelsFinished = 
                (post.status_facebook !== 'pending' || updateData.status_facebook === 'published') &&
                (post.status_instagram !== 'pending' || updateData.status_instagram === 'published') &&
                (post.status_zalo !== 'pending' || updateData.status_zalo === 'published');

            if (isAllChannelsFinished && post.media_urls && post.media_urls.length > 0) {
                console.log(`⏳ Đang cho Facebook/Zalo 60 giây để tải ảnh trước khi dọn rác...`);
                
                setTimeout(async () => {
                    try {
                        const filePaths = post.media_urls.map(url => {
                            const parts = url.split('/social_media/'); 
                            return parts[1];
                        });

                        const { error: removeError } = await supabase.storage
                            .from('social_media')
                            .remove(filePaths);

                        if (!removeError) {
                            await supabase.from('social_posts').update({ media_urls: null }).eq('id', post.id);
                            console.log(`🧹 Dọn rác thành công: Đã xóa ${filePaths.length} file!`);
                        }
                    } catch (err) {
                        console.error('Lỗi dọn rác:', err);
                    }
                }, 3600000); // Đổi 15000 thành 60000 tại đây
            }
        }
    }
}
    export { processAllSocialPosts };