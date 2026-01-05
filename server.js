const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const url = require('url');
const cloudinary = require('cloudinary').v2;

const PORT = process.env.PORT || 3000;

// Cloudinary config
cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME || 'dbkbvl7o8',
    api_key: process.env.CLOUDINARY_API_KEY || '547825369251547',
    api_secret: process.env.CLOUDINARY_API_SECRET || '8Lpo69j1h3_jZJvMYXFYF2Vp3lc'
});

// JSONBin config
const JSONBIN_ID = process.env.JSONBIN_ID || '695bfa31ae596e708fc6e08e';
const JSONBIN_KEY = process.env.JSONBIN_KEY || '$2a$10$hQGknUInTFydIXjYiOoPS.DS4ySQntwxcqxjYlSfp7aMHyBdYPowa';

// Cache for data
let dataCache = null;

async function getData() {
    if (dataCache) return dataCache;
    
    return new Promise((resolve) => {
        const options = {
            hostname: 'api.jsonbin.io',
            path: `/v3/b/${JSONBIN_ID}/latest`,
            method: 'GET',
            headers: { 'X-Master-Key': JSONBIN_KEY }
        };
        
        const req = https.request(options, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    const parsed = JSON.parse(data);
                    dataCache = parsed.record || { videos: [], users: [], comments: [], subscriptions: [] };
                    resolve(dataCache);
                } catch(e) {
                    console.error('JSONBin read error:', e);
                    resolve({ videos: [], users: [], comments: [], subscriptions: [] });
                }
            });
        });
        req.on('error', (e) => {
            console.error('JSONBin request error:', e);
            resolve({ videos: [], users: [], comments: [], subscriptions: [] });
        });
        req.end();
    });
}

async function saveData(data) {
    dataCache = data;
    
    return new Promise((resolve) => {
        const jsonData = JSON.stringify(data);
        const options = {
            hostname: 'api.jsonbin.io',
            path: `/v3/b/${JSONBIN_ID}`,
            method: 'PUT',
            headers: {
                'Content-Type': 'application/json',
                'X-Master-Key': JSONBIN_KEY
            }
        };
        
        const req = https.request(options, (res) => {
            let responseData = '';
            res.on('data', chunk => responseData += chunk);
            res.on('end', () => resolve(true));
        });
        req.on('error', (e) => {
            console.error('JSONBin save error:', e);
            resolve(false);
        });
        req.write(jsonData);
        req.end();
    });
}

function sendJSON(res, data, status = 200) {
    res.writeHead(status, { 
        'Content-Type': 'application/json; charset=utf-8',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type'
    });
    res.end(JSON.stringify(data));
}

function parseJSON(req) {
    return new Promise((resolve) => {
        let body = '';
        req.on('data', chunk => body += chunk.toString('utf8'));
        req.on('end', () => {
            try { resolve(JSON.parse(body)); } 
            catch { resolve({}); }
        });
    });
}

// Simple multipart parser with UTF-8 support
function parseMultipart(req) {
    return new Promise((resolve) => {
        const chunks = [];
        req.on('data', chunk => chunks.push(chunk));
        req.on('end', () => {
            const buffer = Buffer.concat(chunks);
            const boundary = '--' + req.headers['content-type'].split('boundary=')[1];
            const result = { fields: {}, file: null };
            
            let pos = 0;
            while (pos < buffer.length) {
                const boundaryPos = buffer.indexOf(boundary, pos);
                if (boundaryPos === -1) break;
                
                const nextBoundary = buffer.indexOf(boundary, boundaryPos + boundary.length);
                if (nextBoundary === -1) break;
                
                const part = buffer.slice(boundaryPos + boundary.length, nextBoundary);
                const headerEnd = part.indexOf('\r\n\r\n');
                if (headerEnd === -1) { pos = nextBoundary; continue; }
                
                const headerStr = part.slice(0, headerEnd).toString('utf8');
                const content = part.slice(headerEnd + 4);
                
                // Remove trailing \r\n
                const cleanContent = content.slice(0, content.length - 2);
                
                const nameMatch = headerStr.match(/name="([^"]+)"/);
                if (!nameMatch) { pos = nextBoundary; continue; }
                
                const fieldName = nameMatch[1];
                
                if (headerStr.includes('filename="')) {
                    const filenameMatch = headerStr.match(/filename="([^"]+)"/);
                    result.file = {
                        name: fieldName,
                        filename: filenameMatch ? filenameMatch[1] : 'file',
                        data: cleanContent
                    };
                } else {
                    result.fields[fieldName] = cleanContent.toString('utf8');
                }
                
                pos = nextBoundary;
            }
            resolve(result);
        });
    });
}

const server = http.createServer(async (req, res) => {
    try {
        const parsedUrl = url.parse(req.url, true);
        const pathname = parsedUrl.pathname;

        if (req.method === 'OPTIONS') {
            res.writeHead(204, {
                'Access-Control-Allow-Origin': '*',
                'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
                'Access-Control-Allow-Headers': 'Content-Type'
            });
            return res.end();
        }

    // Serve index.html
    if (req.method === 'GET' && (pathname === '/' || pathname === '/index.html')) {
        const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        return res.end(html);
    }

    // API: Get data
    if (req.method === 'GET' && pathname === '/api/data') {
        return sendJSON(res, await getData());
    }

    // API: Upload
    if (req.method === 'POST' && pathname === '/api/upload') {
        const { fields, file } = await parseMultipart(req);
        
        if (!file || !fields.title || !fields.userId) {
            return sendJSON(res, { error: 'Missing fields' }, 400);
        }

        try {
            const videoId = 'v' + Date.now();
            
            // Upload to Cloudinary
            const uploadResult = await new Promise((resolve, reject) => {
                const uploadStream = cloudinary.uploader.upload_stream(
                    { 
                        resource_type: 'video',
                        public_id: videoId,
                        folder: 'tootube'
                    },
                    (error, result) => {
                        if (error) reject(error);
                        else resolve(result);
                    }
                );
                uploadStream.end(file.data);
            });

            const data = await getData();
            data.videos.push({
                id: videoId,
                title: fields.title,
                description: fields.description || '',
                authorId: fields.userId,
                authorName: fields.userName || 'User',
                isShort: fields.isShort === 'true',
                views: 0,
                likes: [],
                dislikes: [],
                videoUrl: uploadResult.secure_url,
                cloudinaryId: uploadResult.public_id,
                createdAt: new Date().toISOString()
            });
            await saveData(data);
            return sendJSON(res, { success: true });
        } catch(err) {
            console.error('Upload error:', err);
            return sendJSON(res, { error: 'Помилка завантаження' }, 500);
        }
    }

    // API: Register
    if (req.method === 'POST' && pathname === '/api/register') {
        const body = await parseJSON(req);
        const data = await getData();
        if (data.users.find(u => u.nickname === body.nickname)) {
            return sendJSON(res, { error: 'Нікнейм зайнятий' }, 400);
        }
        const user = {
            id: 'u' + Date.now(),
            nickname: body.nickname,
            password: body.password,
            subscriberCount: 0,
            avatar: null,
            createdAt: new Date().toISOString()
        };
        data.users.push(user);
        await saveData(data);
        return sendJSON(res, { success: true, user: { id: user.id, nickname: user.nickname } });
    }

    // API: Login
    if (req.method === 'POST' && pathname === '/api/login') {
        const body = await parseJSON(req);
        const data = await getData();
        const user = data.users.find(u => u.nickname === body.nickname && u.password === body.password);
        if (!user) return sendJSON(res, { error: 'Невірні дані' }, 401);
        return sendJSON(res, { success: true, user: { id: user.id, nickname: user.nickname } });
    }

    // API: Like (with toggle support)
    if (req.method === 'POST' && pathname === '/api/like') {
        const body = await parseJSON(req);
        const data = await getData();
        const video = data.videos.find(v => v.id === body.videoId);
        if (!video) return sendJSON(res, { error: 'Not found' }, 404);

        // Remove existing like/dislike
        video.likes = video.likes.filter(id => id !== body.userId);
        video.dislikes = video.dislikes.filter(id => id !== body.userId);
        
        // Add new one (unless action is 'none')
        if (body.action === 'like') video.likes.push(body.userId);
        else if (body.action === 'dislike') video.dislikes.push(body.userId);

        await saveData(data);
        return sendJSON(res, { success: true });
    }

    // API: View
    if (req.method === 'POST' && pathname === '/api/view') {
        const body = await parseJSON(req);
        const data = await getData();
        const video = data.videos.find(v => v.id === body.videoId);
        if (video) { video.views++; await saveData(data); }
        return sendJSON(res, { success: true });
    }

    // API: Comment
    if (req.method === 'POST' && pathname === '/api/comment') {
        const body = await parseJSON(req);
        const data = await getData();
        data.comments.push({
            id: 'c' + Date.now(),
            videoId: body.videoId,
            authorId: body.userId,
            authorName: body.userName,
            text: body.text,
            likes: [],
            createdAt: new Date().toISOString()
        });
        await saveData(data);
        return sendJSON(res, { success: true });
    }

    // API: Like comment
    if (req.method === 'POST' && pathname === '/api/comment/like') {
        const body = await parseJSON(req);
        const data = await getData();
        const comment = data.comments.find(c => c.id === body.commentId);
        if (comment) {
            const idx = comment.likes.indexOf(body.userId);
            if (idx > -1) comment.likes.splice(idx, 1);
            else comment.likes.push(body.userId);
            await saveData(data);
        }
        return sendJSON(res, { success: true });
    }

    // API: Subscribe
    if (req.method === 'POST' && pathname === '/api/subscribe') {
        const body = await parseJSON(req);
        const data = await getData();
        const idx = data.subscriptions.findIndex(s => s.subscriberId === body.subscriberId && s.channelId === body.channelId);
        const channel = data.users.find(u => u.id === body.channelId);
        if (idx > -1) {
            data.subscriptions.splice(idx, 1);
            if (channel) channel.subscriberCount = Math.max(0, (channel.subscriberCount || 0) - 1);
        } else {
            data.subscriptions.push({ id: 's' + Date.now(), subscriberId: body.subscriberId, channelId: body.channelId });
            if (channel) channel.subscriberCount = (channel.subscriberCount || 0) + 1;
        }
        await saveData(data);
        return sendJSON(res, { success: true });
    }

    // API: Delete video
    if (req.method === 'DELETE' && pathname.startsWith('/api/video/')) {
        const videoId = pathname.split('/').pop();
        const data = await getData();
        const video = data.videos.find(v => v.id === videoId);
        if (video && video.cloudinaryId) {
            try {
                await cloudinary.uploader.destroy(video.cloudinaryId, { resource_type: 'video' });
            } catch(e) { console.error('Cloudinary delete error:', e); }
        }
        data.videos = data.videos.filter(v => v.id !== videoId);
        data.comments = data.comments.filter(c => c.videoId !== videoId);
        await saveData(data);
        return sendJSON(res, { success: true });
    }

    // API: Update user
    if (req.method === 'POST' && pathname === '/api/user/update') {
        const body = await parseJSON(req);
        const data = await getData();
        const user = data.users.find(u => u.id === body.userId);
        if (!user) return sendJSON(res, { error: 'Not found' }, 404);
        if (body.nickname) {
            if (data.users.find(u => u.nickname === body.nickname && u.id !== body.userId)) {
                return sendJSON(res, { error: 'Нікнейм зайнятий' }, 400);
            }
            data.videos.forEach(v => { if (v.authorId === body.userId) v.authorName = body.nickname; });
            data.comments.forEach(c => { if (c.authorId === body.userId) c.authorName = body.nickname; });
            user.nickname = body.nickname;
        }
        if (body.password) user.password = body.password;
        if (body.avatar !== undefined) user.avatar = body.avatar;
        await saveData(data);
        return sendJSON(res, { success: true, user: { id: user.id, nickname: user.nickname } });
    }

    // API: Delete user
    if (req.method === 'DELETE' && pathname.startsWith('/api/user/')) {
        const userId = pathname.split('/').pop();
        const data = await getData();
        // Delete user's videos from Cloudinary
        for (const v of data.videos.filter(v => v.authorId === userId)) {
            if (v.cloudinaryId) {
                try {
                    await cloudinary.uploader.destroy(v.cloudinaryId, { resource_type: 'video' });
                } catch(e) { console.error('Cloudinary delete error:', e); }
            }
        }
        data.videos = data.videos.filter(v => v.authorId !== userId);
        data.comments = data.comments.filter(c => c.authorId !== userId);
        data.subscriptions = data.subscriptions.filter(s => s.subscriberId !== userId && s.channelId !== userId);
        data.users = data.users.filter(u => u.id !== userId);
        await saveData(data);
        return sendJSON(res, { success: true });
    }

    res.writeHead(404);
    res.end('Not found');
    } catch(error) {
        console.error('Server error:', error);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Internal server error' }));
    }
});

server.listen(PORT, () => console.log(`\n🎬 TooTube: http://localhost:${PORT}\n`));
