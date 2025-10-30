import express from 'express';
import http from 'http';
import { WebSocketServer } from 'ws';
import { spawn, exec } from 'child_process';
import path from 'path';
import fs from 'fs';
import { v4 as uuidv4 } from 'uuid';
import { fileURLToPath } from 'url';
import https from 'https';

// Helper function to format duration from seconds
function formatDuration(seconds) {
    if (!seconds || seconds <= 0) return 'N/A';
    const date = new Date(0);
    date.setSeconds(seconds);
    return date.toISOString().substr(11, 8); // HH:MM:SS format
}

// دالة مساعدة للتحقق من رابط الغلاف (HEAD request)
function checkThumbnail(url) {
  return new Promise((resolve, reject) => {
    const request = https.request(new URL(url), { method: 'HEAD' }, (res) => {
      if (res.statusCode === 200) {
        const contentLength = parseInt(res.headers['content-length'], 10);
        if (contentLength > 5000) { // 5KB threshold
          resolve(url); 
        } else {
          reject(new Error('Placeholder image (too small)')); 
        }
      } else {
        reject(new Error(`Status Code: ${res.statusCode}`)); 
      }
    });
    request.on('error', (e) => reject(e)); 
    request.end();
  });
}

// تحديد المسار الحالي
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(express.json());

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

// --- !!! تعديل مهم: تحديد مسار القرص الثابت في Render !!! ---
const downloadsDir = '/var/data/downloads';
// التأكد من أن المجلد موجود عند بدء التشغيل
if (!fs.existsSync(downloadsDir)) {
  fs.mkdirSync(downloadsDir, { recursive: true });
}
// --- !!! نهاية التعديل !!! ---


// استخدام express.static مع setHeaders لضمان 'inline'
app.use('/downloads', express.static(downloadsDir, {
    setHeaders: (res, filePath) => {
        const ext = path.extname(filePath).toLowerCase();
        let contentType = 'application/octet-stream';
        if (ext === '.mp4') contentType = 'video/mp4';
        else if (ext === '.mp3') contentType = 'audio/mpeg';
        res.setHeader('Content-Type', contentType);
        res.setHeader('Content-Disposition', 'inline');
    }
}));

let concurrencyLimit = 3;
const downloadQueue = [];
const activeProcesses = new Map();
const wsConnections = new Map();
const jobDetails = new Map();

// WebSocket
wss.on('connection', (ws) => {
  console.log('✅ Client connected');
  ws.on('message', (message) => {
    try {
      const data = JSON.parse(message);
      if (data.type === 'register' && data.id) {
        ws.jobId = data.id;
        wsConnections.set(data.id, ws);
        const job = jobDetails.get(data.id);
        if (job) ws.send(JSON.stringify(job));
      }
    } catch (e) { console.error('WS message error:', e); }
  });
   ws.on('close', () => { console.log(`Client disconnected (job: ${ws.jobId})`); });
});

// sendStatusUpdate
function sendStatusUpdate(id, status, progress = 0, filePath = null) {
  const job = jobDetails.get(id);
  if (job) {
    job.status = status;
    job.progress = Math.max(job.progress || 0, progress);
    if (filePath) job.filePath = filePath;
  }
  const ws = wsConnections.get(id);
  if (ws && ws.readyState === ws.OPEN)
    ws.send(JSON.stringify({ id, status, progress: job.progress, filePath: job.filePath }));
}

// startDownloadJob
function startDownloadJob(job) {
  const { id, url, format_id, title } = job;
  console.log(`🎬 بدء تحميل: ${title}`);
  if (!jobDetails.has(id)) { processQueue(); return; }

  const safeTitle = title.replace(/[^a-zA-Z0-9_\- ]/g, '_');
  const extension = format_id.includes('audio') ? 'mp3' : 'mp4';
  const finalFilename = `${safeTitle}.${extension}`;
  const outputPath = path.join(downloadsDir, finalFilename);
  job.filePath = `/downloads/${encodeURIComponent(finalFilename)}`;

  const args = [
    '-f',
    format_id.includes('audio') ? format_id : `${format_id}+bestaudio/best`,
    '--merge-output-format',
    extension,
    '--newline',
    '--progress',
    '--no-warnings',
    '--ignore-errors',
    '-o',
    outputPath,
    url,
  ];

  const ytProcess = spawn('yt-dlp', args);
  activeProcesses.set(id, ytProcess);
  sendStatusUpdate(id, 'downloading', 0);

  let lastProgress = 0;

  ytProcess.stdout.on('data', (data) => {
    const text = data.toString().trim();
    const lines = text.split('\n');
    const lastProgressLine = lines.filter(line => line.includes('%')).pop();

    if (lastProgressLine) {
        const match = lastProgressLine.match(/(\d{1,3}(?:\.\d{1,2})?)%/);
        if (match) {
            const progress = parseFloat(match[1]);
            if (progress > lastProgress || progress === 0) {
                 lastProgress = progress;
                 sendStatusUpdate(id, 'downloading', progress);
            }
        }
    }
  });
   ytProcess.stderr.on('data', (data) => console.error(`[${id}] stderr: ${data}`));
   ytProcess.on('close', (code) => {
    const currentJob = jobDetails.get(id);
    if (!currentJob) { console.log(`Job ${id} was cancelled, skipping close.`); return; }
    if (currentJob.status === 'paused') { console.log(`Job ${id} is paused, not closing.`); return; }
    const finalProgress = code === 0 ? 100 : currentJob.progress;
    const finalStatus = code === 0 ? 'completed' : 'error';
    sendStatusUpdate(id, finalStatus, finalProgress, code === 0 ? currentJob.filePath : null);
    activeProcesses.delete(id);
    processQueue();
  });
}

// processQueue
function processQueue() {
  if (activeProcesses.size >= concurrencyLimit || downloadQueue.length === 0) return;
  startDownloadJob(downloadQueue.shift());
}

// جلب المعلومات
app.post('/api/get-info', (req, res) => {
  const videoURL = req.body.url;
  if (!videoURL) return res.status(400).json({ error: 'لم يتم إرسال رابط' });
  
  const cmd = `yt-dlp -J --ignore-errors --no-warnings "${videoURL}"`; 
  
  exec(cmd, { maxBuffer: 1024 * 1024 * 10 }, (error, stdout, stderr) => {
    if (error && !stdout) {
        console.error(`exec error: ${error.message}`);
        return res.status(500).json({ error: 'فشل أمر yt-dlp', details: stderr });
    }
    if (!stdout || stdout.trim() === '') {
      console.error('YT-DLP لم يُرجع بيانات');
      return res.status(500).json({ error: 'لم يتم استلام بيانات من yt-dlp.' });
    }
    try {
      const firstValidLine = stdout.split('\n').find(line => line.startsWith('{'));
      if (!firstValidLine) throw new Error('لم يتم العثور على JSON صالح في المخرجات');
      const info = JSON.parse(firstValidLine);

      if (info.entries && Array.isArray(info.entries)) {
        const videos = info.entries
          .filter((v) => v && v.title && !v.title.includes('Private'))
          .map((v) => ({
            title: v.title,
            url: v.url,
            thumbnail: v.thumbnail || v.thumbnails?.[0]?.url || null,
            channel: v.channel || info.channel || 'غير معروف',
            duration_string: v.duration ? formatDuration(v.duration) : 'N/A',
          }));
        return res.json({
          type: 'playlist',
          title: info.title || 'قائمة تشغيل',
          uploader: info.uploader || info.channel || 'غير معروف',
          videoCount: videos.length,
          videos,
          thumbnail: info.thumbnail || videos[0]?.thumbnail || null
        });
      }

      return res.json({
        type: 'single',
        title: info.title,
        channel: info.channel,
        thumbnail: info.thumbnail,
        duration: info.duration,
        duration_string: info.duration_string || formatDuration(info.duration),
        formats: info.formats?.map((f) => ({
          format_id: f.format_id,
          ext: f.ext,
          resolution: f.resolution || (f.vcodec !== 'none' && f.height ? f.height + 'p' : (f.vcodec === 'none' ? 'Audio' : 'Unknown')),
          size_string: f.filesize ? (f.filesize / 1024 / 1024).toFixed(2) + ' MB' : f.filesize_approx ? (f.filesize_approx / 1024 / 1024).toFixed(2) + ' MB' : 'N/A',
          isAudio: f.vcodec === 'none' && f.acodec !== 'none',
          isVideo: f.vcodec !== 'none',
        })) || [],
      });
    } catch (err) {
      console.error('JSON Parse Error:', err, 'Stdout:', stdout);
      res.status(500).json({ error: 'فشل في تحليل بيانات الفيديو أو القائمة' });
    }
  });
});

// بدء التحميل
app.post('/api/start-download', (req, res) => {
  const { url, format_id, title, channel, thumbnail } = req.body;
  if (!url || !format_id) return res.status(400).json({ error: 'Missing URL or Format ID' });
  const id = uuidv4();
   const job = {
    id, url, format_id, title, channel, thumbnail,
    status: 'queued', progress: 0, filePath: null
  };
  jobDetails.set(id, job);
  downloadQueue.push(job);
  sendStatusUpdate(id, 'queued', 0);
  res.status(201).json({ downloadId: id });
  processQueue();
});

// إعداد الحد
app.post('/api/set-limit', (req, res) => {
  const { limit } = req.body;
  if (limit && parseInt(limit) > 0) {
    concurrencyLimit = parseInt(limit);
    res.sendStatus(200);
    processQueue();
  } else res.status(400).send('Invalid limit');
});

// الإيقاف المؤقت
app.post('/api/pause/:id', (req, res) => {
    const { id } = req.params;
    const process = activeProcesses.get(id);
    if (process) {
        try {
            process.kill('SIGSTOP');
            sendStatusUpdate(id, 'paused', jobDetails.get(id)?.progress || 0);
            console.log(`⏸️ Paused job ${id}`);
            res.sendStatus(200);
        } catch (e) {
            console.error(`Failed to pause job ${id}:`, e);
            res.status(500).send('Failed to pause');
        }
    } else {
        res.status(404).send('Process not found');
    }
});

// الاستئناف
app.post('/api/resume/:id', (req, res) => {
    const { id } = req.params;
    const process = activeProcesses.get(id);
    if (process) {
        try {
            process.kill('SIGCONT');
            sendStatusUpdate(id, 'downloading', jobDetails.get(id)?.progress || 0);
            console.log(`▶️ Resumed job ${id}`);
            res.sendStatus(200);
        } catch (e) {
            console.error(`Failed to resume job ${id}:`, e);
            res.status(500).send('Failed to resume');
        }
    } else {
        res.status(404).send('Process not found');
    }
});

// مسار جلب الغلاف
app.get('/api/get-thumbnail/:videoId', async (req, res) => {
  const { videoId } = req.params;
  if (!videoId) {
    return res.status(400).json({ error: 'No videoId provided' });
  }

  const tryUrls = [
    `https://i.ytimg.com/vi/${videoId}/maxresdefault.jpg`,
    `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
    `https://i.ytimg.com/vi/${videoId}/mqdefault.jpg`
  ];

  for (const url of tryUrls) {
    try {
      const validUrl = await checkThumbnail(url);
      console.log(`✅ Found valid thumbnail for ${videoId}: ${validUrl}`);
      return res.json({ success: true, url: validUrl });
    } catch (error) {
      console.log(`Thumbnail check failed for ${url}: ${error.message}`);
    }
  }

  console.error(`❌ Could not find any valid thumbnail for ${videoId}`);
  res.status(404).json({ success: false, error: 'Could not find a valid thumbnail.' });
});

// مسار بروكسي تحميل الغلاف
app.get('/api/download-thumbnail', (req, res) => {
  const { url, id } = req.query; 
  if (!url || !id) {
    return res.status(400).send('Missing URL or ID');
  }

  try {
    res.setHeader('Content-Disposition', `attachment; filename="${id}.jpg"`);
    https.get(url, (imageStream) => {
      imageStream.pipe(res);
    }).on('error', (e) => {
      console.error('Failed to pipe image:', e);
      res.status(500).send('Failed to download image');
    });

  } catch (error) {
    console.error('Proxy download error:', error);
    res.status(500).send('Error');
  }
});

// خدمة الواجهة
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// تشغيل الخادم
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🚀 الخادم يعمل على http://localhost:${PORT}`));
