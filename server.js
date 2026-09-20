const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { once } = require('events');

const app = express();
const PORT = process.env.PORT || 3000;

const MB = 1024 * 1024;
const MAX_UPLOAD_MB = Math.min(4096, Math.max(1, Number.parseInt(process.env.MAX_UPLOAD_MB || '4096', 10)));
const MAX_UPLOAD_BYTES = MAX_UPLOAD_MB * MB;
const CHUNK_SIZE_MB = Math.min(90, Math.max(1, Number.parseInt(process.env.CHUNK_SIZE_MB || '48', 10)));
const CHUNK_SIZE_BYTES = CHUNK_SIZE_MB * MB;
const DIRECT_UPLOAD_LIMIT_BYTES = Math.min(80 * MB, MAX_UPLOAD_BYTES);
const CHUNK_UPLOAD_LIMIT_BYTES = Math.min(95 * MB, CHUNK_SIZE_BYTES + MB);

const PUBLIC_DIR = path.join(__dirname, 'public');
const UPLOAD_DIR = path.join(PUBLIC_DIR, 'uploads');
const TEMP_DIR = path.join(__dirname, '.upload-tmp');

fs.mkdirSync(UPLOAD_DIR, { recursive: true });
fs.mkdirSync(TEMP_DIR, { recursive: true });

const ALLOWED_EXTS = [
  '.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp',
  '.mp4', '.mov', '.webm', '.avi', '.mkv', '.wmv', '.flv'
];

const MIME_MAP = {
  '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm',
  '.avi': 'video/x-msvideo', '.mkv': 'video/x-matroska', '.wmv': 'video/x-ms-wmv', '.flv': 'video/x-flv',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
  '.gif': 'image/gif', '.webp': 'image/webp', '.bmp': 'image/bmp'
};

function guessType(filename) {
  return MIME_MAP[path.extname(filename).toLowerCase()] || 'application/octet-stream';
}

function safeExtension(filename) {
  const ext = path.extname(path.basename(String(filename || ''))).toLowerCase();
  return ALLOWED_EXTS.includes(ext) ? ext : '';
}

function validUploadId(id) {
  return /^[a-f0-9]{32}$/.test(String(id || ''));
}

function metaPath(uploadId) {
  return path.join(TEMP_DIR, uploadId, 'meta.json');
}

function readMeta(uploadId) {
  if (!validUploadId(uploadId)) throw new Error('无效的上传任务');
  const raw = fs.readFileSync(metaPath(uploadId), 'utf8');
  return JSON.parse(raw);
}

app.use(express.json({ limit: '64kb' }));
app.use(express.static(PUBLIC_DIR));

app.get('/api/config', (req, res) => {
  res.json({
    maxFileSizeMb: MAX_UPLOAD_MB,
    maxFileSizeBytes: MAX_UPLOAD_BYTES,
    directUploadLimitMb: Math.floor(DIRECT_UPLOAD_LIMIT_BYTES / MB),
    chunkSizeMb: CHUNK_SIZE_MB
  });
});

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    const ext = safeExtension(file.originalname);
    cb(null, `${crypto.randomBytes(16).toString('hex')}${ext}`);
  }
});

const fileFilter = (req, file, cb) => {
  if (safeExtension(file.originalname)) return cb(null, true);
  return cb(new Error('不支持的文件格式，请上传图片或视频'));
};

const upload = multer({
  storage,
  limits: { fileSize: DIRECT_UPLOAD_LIMIT_BYTES, files: 1 },
  fileFilter
});

const chunkStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    try {
      if (!validUploadId(req.body.uploadId)) throw new Error('无效的上传任务');
      const dir = path.join(TEMP_DIR, req.body.uploadId);
      fs.mkdirSync(dir, { recursive: true });
      cb(null, dir);
    } catch (err) {
      cb(err);
    }
  },
  filename: (req, file, cb) => {
    const index = Number.parseInt(req.body.index, 10);
    if (!Number.isInteger(index) || index < 0) return cb(new Error('无效的分片编号'));
    cb(null, `${String(index).padStart(6, '0')}.part`);
  }
});

const chunkUpload = multer({
  storage: chunkStorage,
  limits: { fileSize: CHUNK_UPLOAD_LIMIT_BYTES, files: 1 }
});

// Start a chunked upload. Each request stays below Cloudflare's request-body limit.
app.post('/api/upload/init', (req, res) => {
  try {
    const name = path.basename(String(req.body.name || ''));
    const size = Number.parseInt(req.body.size, 10);
    const ext = safeExtension(name);

    if (!ext) return res.status(400).json({ error: '不支持的文件格式，请上传图片或视频' });
    if (!Number.isInteger(size) || size <= 0) return res.status(400).json({ error: '文件大小无效' });
    if (size > MAX_UPLOAD_BYTES) return res.status(413).json({ error: `文件太大，最大 ${MAX_UPLOAD_MB}MB` });

    const uploadId = crypto.randomBytes(16).toString('hex');
    const dir = path.join(TEMP_DIR, uploadId);
    fs.mkdirSync(dir, { recursive: true });

    const meta = {
      uploadId,
      originalName: name,
      ext,
      size,
      chunkSize: CHUNK_SIZE_BYTES,
      totalChunks: Math.ceil(size / CHUNK_SIZE_BYTES),
      createdAt: new Date().toISOString()
    };
    fs.writeFileSync(metaPath(uploadId), JSON.stringify(meta), 'utf8');

    res.status(201).json({
      uploadId,
      chunkSize: CHUNK_SIZE_BYTES,
      totalChunks: meta.totalChunks
    });
  } catch (err) {
    res.status(400).json({ error: err.message || '无法创建上传任务' });
  }
});

app.post('/api/upload/chunk', chunkUpload.single('chunk'), (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: '缺少文件分片' });
    const meta = readMeta(req.body.uploadId);
    const index = Number.parseInt(req.body.index, 10);
    if (!Number.isInteger(index) || index < 0 || index >= meta.totalChunks) {
      fs.rmSync(path.join(TEMP_DIR, req.body.uploadId), { recursive: true, force: true });
      return res.status(400).json({ error: '无效的分片编号' });
    }
    res.json({ ok: true, index, received: req.file.size });
  } catch (err) {
    res.status(400).json({ error: err.message || '分片上传失败' });
  }
});

async function appendChunk(source, target) {
  const input = fs.createReadStream(source);
  for await (const chunk of input) {
    if (!target.write(chunk)) await once(target, 'drain');
  }
}

app.post('/api/upload/complete', async (req, res) => {
  const uploadId = req.body.uploadId;
  try {
    const meta = readMeta(uploadId);
    const chunkDir = path.join(TEMP_DIR, uploadId);
    const finalName = `${crypto.randomBytes(16).toString('hex')}${meta.ext}`;
    const finalPath = path.join(UPLOAD_DIR, finalName);
    const output = fs.createWriteStream(finalPath);

    let written = 0;
    for (let i = 0; i < meta.totalChunks; i += 1) {
      const part = path.join(chunkDir, `${String(i).padStart(6, '0')}.part`);
      const stat = fs.statSync(part);
      written += stat.size;
      await appendChunk(part, output);
    }

    await new Promise((resolve, reject) => {
      output.end(resolve);
      output.on('error', reject);
    });

    if (written !== meta.size) {
      fs.rmSync(finalPath, { force: true });
      throw new Error(`文件大小校验失败，预期 ${meta.size} 字节，实际 ${written} 字节`);
    }

    fs.rmSync(chunkDir, { recursive: true, force: true });
    res.json({
      message: '上传成功',
      filename: finalName,
      url: `/uploads/${finalName}`,
      type: guessType(finalName),
      size: written
    });
  } catch (err) {
    if (validUploadId(uploadId)) {
      fs.rmSync(path.join(TEMP_DIR, uploadId), { recursive: true, force: true });
    }
    res.status(400).json({ error: err.message || '文件合并失败' });
  }
});

app.delete('/api/upload/:uploadId', (req, res) => {
  const uploadId = req.params.uploadId;
  if (!validUploadId(uploadId)) return res.status(400).json({ error: '无效的上传任务' });
  fs.rmSync(path.join(TEMP_DIR, uploadId), { recursive: true, force: true });
  res.json({ ok: true });
});

app.get('/api/images', (req, res) => {
  fs.readdir(UPLOAD_DIR, (err, files) => {
    if (err) return res.status(500).json({ error: '读取文件列表失败' });

    const images = files
      .filter(f => ALLOWED_EXTS.includes(path.extname(f).toLowerCase()))
      .map(f => {
        const stats = fs.statSync(path.join(UPLOAD_DIR, f));
        return {
          filename: f,
          url: `/uploads/${f}`,
          size: stats.size,
          type: guessType(f),
          uploadedAt: stats.mtime.toISOString()
        };
      })
      .sort((a, b) => new Date(b.uploadedAt) - new Date(a.uploadedAt));

    res.json(images);
  });
});

app.post('/api/upload', upload.single('image'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: '请提供要上传的文件' });
  res.json({
    message: '上传成功',
    filename: req.file.filename,
    url: `/uploads/${req.file.filename}`,
    type: guessType(req.file.filename),
    size: req.file.size
  });
});

app.get('/uploads/:filename', (req, res) => {
  const safeName = path.basename(req.params.filename);
  const filePath = path.join(UPLOAD_DIR, safeName);
  if (!fs.existsSync(filePath)) return res.status(404).send('文件不存在');

  const stat = fs.statSync(filePath);
  const fileSize = stat.size;
  const contentType = guessType(safeName);
  const range = req.headers.range;

  if (range) {
    const parts = range.replace(/bytes=/, '').split('-');
    const start = Number.parseInt(parts[0], 10);
    const end = parts[1] ? Number.parseInt(parts[1], 10) : fileSize - 1;
    if (!Number.isInteger(start) || start < 0 || start >= fileSize || end < start) {
      return res.status(416).set('Content-Range', `bytes */${fileSize}`).end();
    }
    const chunkSize = end - start + 1;
    res.writeHead(206, {
      'Content-Range': `bytes ${start}-${end}/${fileSize}`,
      'Accept-Ranges': 'bytes',
      'Content-Length': chunkSize,
      'Content-Type': contentType,
      'Cache-Control': 'public, max-age=31536000, immutable'
    });
    fs.createReadStream(filePath, { start, end }).pipe(res);
  } else {
    res.writeHead(200, {
      'Content-Length': fileSize,
      'Content-Type': contentType,
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'public, max-age=31536000, immutable'
    });
    fs.createReadStream(filePath).pipe(res);
  }
});

app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(413).json({ error: `文件太大，最大 ${MAX_UPLOAD_MB}MB` });
    }
    return res.status(400).json({ error: err.message });
  }
  if (err) return res.status(400).json({ error: err.message });
  next();
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Image Board running at http://0.0.0.0:${PORT}`);
  console.log(`Max upload: ${MAX_UPLOAD_MB}MB, chunk size: ${CHUNK_SIZE_MB}MB`);
});
