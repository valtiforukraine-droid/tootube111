const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');

const PORT = process.env.PORT || 3000;
const UPLOAD_DIR = path.join(__dirname, 'uploads');
const DATA_FILE = path.join(__dirname, 'data.json');

if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

function initData() {
    if (!fs.existsSync(DATA_FILE)) {
        fs.writeFileSync(DATA_FILE, JSON.stringify({ videos: [], users: [], comments: [], subscriptions: [] }));
    }
}
initData();

function getData() { 
    try {
        initData();
        return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); 
    } catch(e) {
        console.error('Error reading data:', e);
        return { videos: [], users: [], comments: [], subscriptions: [] };
    }
}
function saveData(data) { fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2)); }

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

    // Serve videos
    if (req.method === 'GET' && pathname.startsWith('/uploads/')) {
        const filePath = path.join(__dirname, pathname);
        if (fs.existsSync(filePath)) {
            const stat = fs.statSync(filePath);
            const range = req.headers.range;
            if (range) {
                const parts = range.replace(/bytes=/, '').split('-');
                const start = parseInt(parts[0], 10);
                const end = parts[1] ? parseInt(parts[1], 10) : stat.size - 1;
                res.writeHead(206, {
                    'Content-Range': `bytes ${start}-${end}/${stat.size}`,
                    'Accept-Ranges': 'bytes',
                    'Content-Length': end - start + 1,
                    'Content-Type': 'video/mp4'
                });
                fs.createReadStream(filePath, { start, end }).pipe(res);
            } else {
                res.writeHead(200, { 'Content-Length': stat.size, 'Content-Type': 'video/mp4' });
                fs.createReadStream(filePath).pipe(res);
            }
            return;
        }
        res.writeHead(404);
        return res.end('Not found');
    }

    // API: Get data
    if (req.method === 'GET' && pathname === '/api/data') {
        return sendJSON(res, getData());
    }

    // API: Upload
    if (req.method === 'POST' && pathname === '/api/upload') {
        const { fields, file } = await parseMultipart(req);
        
        if (!file || !fields.title || !fields.userId) {
            return sendJSON(res, { error: 'Missing fields' }, 400);
        }

        const videoId = 'v' + Date.now();
        const ext = path.extname(file.filename) || '.mp4';
        const savedFilename = videoId + ext;
        fs.writeFileSync(path.join(UPLOAD_DIR, savedFilename), file.data);

        const data = getData();
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
            videoUrl: '/uploads/' + savedFilename,
            createdAt: new Date().toISOString()
        });
        saveData(data);
        return sendJSON(res, { success: true });
    }

    // API: Register
    if (req.method === 'POST' && pathname === '/api/register') {
        const body = await parseJSON(req);
        const data = getData();
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
        saveData(data);
        return sendJSON(res, { success: true, user: { id: user.id, nickname: user.nickname } });
    }

    // API: Login
    if (req.method === 'POST' && pathname === '/api/login') {
        const body = await parseJSON(req);
        const data = getData();
        const user = data.users.find(u => u.nickname === body.nickname && u.password === body.password);
        if (!user) return sendJSON(res, { error: 'Невірні дані' }, 401);
        return sendJSON(res, { success: true, user: { id: user.id, nickname: user.nickname } });
    }

    // API: Like (with toggle support)
    if (req.method === 'POST' && pathname === '/api/like') {
        const body = await parseJSON(req);
        const data = getData();
        const video = data.videos.find(v => v.id === body.videoId);
        if (!video) return sendJSON(res, { error: 'Not found' }, 404);

        // Remove existing like/dislike
        video.likes = video.likes.filter(id => id !== body.userId);
        video.dislikes = video.dislikes.filter(id => id !== body.userId);
        
        // Add new one (unless action is 'none')
        if (body.action === 'like') video.likes.push(body.userId);
        else if (body.action === 'dislike') video.dislikes.push(body.userId);

        saveData(data);
        return sendJSON(res, { success: true });
    }

    // API: View
    if (req.method === 'POST' && pathname === '/api/view') {
        const body = await parseJSON(req);
        const data = getData();
        const video = data.videos.find(v => v.id === body.videoId);
        if (video) { video.views++; saveData(data); }
        return sendJSON(res, { success: true });
    }

    // API: Comment
    if (req.method === 'POST' && pathname === '/api/comment') {
        const body = await parseJSON(req);
        const data = getData();
        data.comments.push({
            id: 'c' + Date.now(),
            videoId: body.videoId,
            authorId: body.userId,
            authorName: body.userName,
            text: body.text,
            likes: [],
            createdAt: new Date().toISOString()
        });
        saveData(data);
        return sendJSON(res, { success: true });
    }

    // API: Like comment
    if (req.method === 'POST' && pathname === '/api/comment/like') {
        const body = await parseJSON(req);
        const data = getData();
        const comment = data.comments.find(c => c.id === body.commentId);
        if (comment) {
            const idx = comment.likes.indexOf(body.userId);
            if (idx > -1) comment.likes.splice(idx, 1);
            else comment.likes.push(body.userId);
            saveData(data);
        }
        return sendJSON(res, { success: true });
    }

    // API: Subscribe
    if (req.method === 'POST' && pathname === '/api/subscribe') {
        const body = await parseJSON(req);
        const data = getData();
        const idx = data.subscriptions.findIndex(s => s.subscriberId === body.subscriberId && s.channelId === body.channelId);
        const channel = data.users.find(u => u.id === body.channelId);
        if (idx > -1) {
            data.subscriptions.splice(idx, 1);
            if (channel) channel.subscriberCount = Math.max(0, (channel.subscriberCount || 0) - 1);
        } else {
            data.subscriptions.push({ id: 's' + Date.now(), subscriberId: body.subscriberId, channelId: body.channelId });
            if (channel) channel.subscriberCount = (channel.subscriberCount || 0) + 1;
        }
        saveData(data);
        return sendJSON(res, { success: true });
    }

    // API: Delete video
    if (req.method === 'DELETE' && pathname.startsWith('/api/video/')) {
        const videoId = pathname.split('/').pop();
        const data = getData();
        const video = data.videos.find(v => v.id === videoId);
        if (video && video.videoUrl) {
            const filePath = path.join(__dirname, video.videoUrl);
            if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
        }
        data.videos = data.videos.filter(v => v.id !== videoId);
        data.comments = data.comments.filter(c => c.videoId !== videoId);
        saveData(data);
        return sendJSON(res, { success: true });
    }

    // API: Update user
    if (req.method === 'POST' && pathname === '/api/user/update') {
        const body = await parseJSON(req);
        const data = getData();
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
        saveData(data);
        return sendJSON(res, { success: true, user: { id: user.id, nickname: user.nickname } });
    }

    // API: Delete user
    if (req.method === 'DELETE' && pathname.startsWith('/api/user/')) {
        const userId = pathname.split('/').pop();
        const data = getData();
        data.videos.filter(v => v.authorId === userId).forEach(v => {
            if (v.videoUrl) {
                const fp = path.join(__dirname, v.videoUrl);
                if (fs.existsSync(fp)) fs.unlinkSync(fp);
            }
        });
        data.videos = data.videos.filter(v => v.authorId !== userId);
        data.comments = data.comments.filter(c => c.authorId !== userId);
        data.subscriptions = data.subscriptions.filter(s => s.subscriberId !== userId && s.channelId !== userId);
        data.users = data.users.filter(u => u.id !== userId);
        saveData(data);
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
