const API = '/api/images';
const UPLOAD_API = '/api/upload';

let selectedFile = null;
let convertedFile = null; // File after FFmpeg conversion
let ffmpeg = null;

// Video extensions that need conversion
const NEEDS_CONVERT = new Set(['.mov', '.avi', '.mkv', '.wmv', '.flv', '.webm', '.mts', '.m2ts', '.ts', '.3gp']);

// DOM refs
const gallery = document.getElementById('gallery');
const fileCount = document.getElementById('fileCount');
const fileInput = document.getElementById('fileInput');
const uploadZone = document.getElementById('uploadZone');
const uploadPreview = document.getElementById('uploadPreview');
const previewImg = document.getElementById('previewImg');
const previewVideo = document.getElementById('previewVideo');
const previewInfo = document.getElementById('previewInfo');
const previewActions = document.getElementById('previewActions');
const cancelBtn = document.getElementById('cancelBtn');
const uploadBtn = document.getElementById('uploadBtn');
const convertOption = document.getElementById('convertOption');
const convertCheck = document.getElementById('convertCheck');
const convertProgress = document.getElementById('convertProgress');
const convertProgressFill = document.getElementById('convertProgressFill');
const convertProgressText = document.getElementById('convertProgressText');
const toast = document.getElementById('toast');
const lightbox = document.getElementById('lightbox');
const lightboxContent = document.getElementById('lightboxContent');
const lightboxClose = lightbox.querySelector('.lightbox-close');

// --- Toast ---
function showToast(msg, type = '') {
  toast.textContent = msg;
  toast.className = 'toast show ' + type;
  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => toast.classList.remove('show'), 3000);
}

// --- Load files ---
async function loadFiles() {
  try {
    const res = await fetch(API);
    if (!res.ok) throw new Error('加载失败');
    const files = await res.json();

    fileCount.textContent = `${files.length} 个文件`;

    if (files.length === 0) {
      gallery.innerHTML = '<div class="empty">还没有内容，快来发第一个吧！</div>';
      return;
    }

    gallery.innerHTML = files.map(file => {
      const isVideo = file.type?.startsWith('video/');
      return `
        <div class="gallery-item" data-url="${file.url}" data-type="${file.type || ''}">
          ${isVideo
            ? `<video src="${file.url}" preload="metadata" muted></video><div class="play-indicator"></div>`
            : `<img src="${file.url}" alt="" loading="lazy">`
          }
          <div class="meta">
            <span>${formatSize(file.size)}</span>
            <span>${isVideo ? '视频' : formatTime(file.uploadedAt)}</span>
          </div>
        </div>
      `;
    }).join('');

    document.querySelectorAll('.gallery-item').forEach(el => {
      el.addEventListener('click', () => openLightbox(el.dataset.url, el.dataset.type));
    });
  } catch (err) {
    gallery.innerHTML = '<div class="empty">加载失败，请确认服务器是否运行</div>';
    showToast('加载失败', 'error');
  }
}

function formatSize(bytes) {
  if (bytes < 1024) return bytes + 'B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + 'KB';
  if (bytes < 1024 * 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + 'MB';
  return (bytes / (1024 * 1024 * 1024)).toFixed(2) + 'GB';
}

function formatTime(iso) {
  const d = new Date(iso);
  const now = new Date();
  const diff = now - d;
  if (diff < 60000) return '刚刚';
  if (diff < 3600000) return Math.floor(diff / 60000) + ' 分钟前';
  if (diff < 86400000) return Math.floor(diff / 3600000) + ' 小时前';
  return d.toLocaleDateString();
}

// --- FFmpeg.wasm Video Conversion ---
function getExt(name) {
  const i = name.lastIndexOf('.');
  return i >= 0 ? name.substring(i).toLowerCase() : '';
}

function needsConversion(file) {
  if (!file.type.startsWith('video/')) return false;
  return NEEDS_CONVERT.has(getExt(file.name));
}

async function initFFmpeg() {
  if (ffmpeg) return ffmpeg;

  showConvertProgress('正在加载转码引擎 (约 30MB)...', true);
  convertProgress.classList.add('loading');

  try {
    const { FFmpeg: FFmpegClass } = await import('https://cdn.jsdelivr.net/npm/@ffmpeg/ffmpeg@0.12.10/+esm');
    const { toBlobURL } = await import('https://cdn.jsdelivr.net/npm/@ffmpeg/util@0.12.10/+esm');

    ffmpeg = new FFmpegClass();

    ffmpeg.on('progress', ({ progress }) => {
      const pct = Math.min(Math.round(progress * 100), 99);
      convertProgressFill.style.width = pct + '%';
      convertProgressText.textContent = `转码中... ${pct}%`;
    });

    await ffmpeg.load({
      coreURL: await toBlobURL(
        'https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.6/dist/esm/ffmpeg-core.js',
        'text/javascript'
      ),
      wasmURL: await toBlobURL(
        'https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.6/dist/esm/ffmpeg-core.wasm',
        'application/wasm'
      ),
    });

    convertProgress.classList.remove('loading');
    return ffmpeg;
  } catch (err) {
    convertProgress.classList.remove('loading');
    throw err;
  }
}

async function convertToMp4(file) {
  const f = await initFFmpeg();

  const inputName = 'input' + getExt(file.name);
  const outputName = 'output.mp4';

  // Write input file
  showConvertProgress('读取源文件...');
  await f.writeFile(inputName, new Uint8Array(await file.arrayBuffer()));

  // Convert to H.264 + AAC + faststart
  showConvertProgress('转码中... 0%');
  convertProgressFill.style.width = '0%';

  await f.exec([
    '-i', inputName,
    '-c:v', 'libx264',
    '-preset', 'fast',
    '-crf', '23',
    '-c:a', 'aac',
    '-movflags', '+faststart',
    outputName
  ]);

  showConvertProgress('打包文件...');
  const data = await f.readFile(outputName);

  // Cleanup FFmpeg virtual filesystem
  await f.deleteFile(inputName);
  await f.deleteFile(outputName);

  // Create output File
  const mp4Name = file.name.replace(/\.[^.]+$/, '.mp4');
  return new File([data.buffer], mp4Name, { type: 'video/mp4' });
}

function showConvertProgress(text, loading = false) {
  convertProgressFill.style.width = '';
  convertProgress.hidden = false;
  previewActions.hidden = true;
  convertOption.hidden = true;
  convertProgressText.textContent = text;
  if (loading) {
    convertProgress.classList.add('loading');
  } else {
    convertProgress.classList.remove('loading');
  }
}

function hideConvertProgress() {
  convertProgress.hidden = true;
  convertProgress.classList.remove('loading');
  previewActions.hidden = false;
}

// --- Upload ---
uploadZone.addEventListener('click', () => fileInput.click());

uploadZone.addEventListener('dragover', (e) => {
  e.preventDefault();
  uploadZone.classList.add('dragover');
});

uploadZone.addEventListener('dragleave', () => {
  uploadZone.classList.remove('dragover');
});

uploadZone.addEventListener('drop', (e) => {
  e.preventDefault();
  uploadZone.classList.remove('dragover');
  const file = e.dataTransfer.files[0];
  if (file) handleFileSelect(file);
});

fileInput.addEventListener('change', () => {
  if (fileInput.files[0]) handleFileSelect(fileInput.files[0]);
});

function handleFileSelect(file) {
  const isImage = file.type.startsWith('image/');
  const isVideo = file.type.startsWith('video/');

  if (!isImage && !isVideo) {
    showToast('请选择图片或视频文件', 'error');
    return;
  }
  if (file.size > 100 * 1024 * 1024) {
    showToast('文件太大（最大 100MB）', 'error');
    return;
  }

  selectedFile = file;
  convertedFile = null;
  hideConvertProgress();

  const ext = getExt(file.name);
  const showConvert = isVideo && needsConversion(file);

  // Show/hide conversion toggle
  convertOption.hidden = !showConvert;

  // Preview
  previewImg.hidden = true;
  previewVideo.hidden = true;

  const reader = new FileReader();
  reader.onload = (e) => {
    if (isImage) {
      previewImg.src = e.target.result;
      previewImg.hidden = false;
    } else {
      previewVideo.src = e.target.result;
      previewVideo.hidden = false;
    }

    const type = isImage ? '图片' : '视频';
    let info = `${file.name}  —  ${type}  ${formatSize(file.size)}`;
    if (showConvert) info += '  —  ⚠ 建议转换为 MP4';
    previewInfo.textContent = info;

    uploadZone.hidden = true;
    uploadPreview.hidden = false;
  };
  reader.readAsDataURL(file);
}

cancelBtn.addEventListener('click', resetUpload);

function resetUpload() {
  selectedFile = null;
  convertedFile = null;
  fileInput.value = '';
  previewImg.src = '';
  previewVideo.src = '';
  convertOption.hidden = true;
  hideConvertProgress();
  uploadPreview.hidden = true;
  uploadZone.hidden = false;
}

uploadBtn.addEventListener('click', async () => {
  if (!selectedFile) return;

  let fileToUpload = selectedFile;
  const shouldConvert = needsConversion(selectedFile) && convertCheck.checked;

  // Step 1: Convert video if needed
  if (shouldConvert) {
    try {
      convertedFile = await convertToMp4(selectedFile);
      fileToUpload = convertedFile;
      showToast('转码完成，正在上传...', 'success');
    } catch (err) {
      console.error('Conversion failed:', err);
      showToast('转码失败，将上传原始文件: ' + err.message, 'error');
      fileToUpload = selectedFile;
      hideConvertProgress();
      return;
    }
  }

  // Step 2: Upload
  uploadBtn.disabled = true;
  uploadBtn.textContent = '上传中...';

  try {
    const formData = new FormData();
    formData.append('image', fileToUpload);

    const res = await fetch(UPLOAD_API, { method: 'POST', body: formData });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || '上传失败');
    }

    showToast('上传成功！', 'success');
    resetUpload();
    loadFiles();
  } catch (err) {
    showToast(err.message, 'error');
    uploadBtn.disabled = false;
    uploadBtn.textContent = '上传';
    hideConvertProgress();
  }
});

// --- Lightbox ---
function openLightbox(url, type) {
  const isVideo = type?.startsWith('video/');

  if (isVideo) {
    lightboxContent.innerHTML = `<video src="${url}" controls autoplay></video>`;
  } else {
    lightboxContent.innerHTML = `<img src="${url}" alt="">`;
  }

  lightbox.classList.add('active');
  document.body.style.overflow = 'hidden';
}

function closeLightbox() {
  lightbox.classList.remove('active');
  const video = lightboxContent.querySelector('video');
  if (video) video.pause();
  lightboxContent.innerHTML = '';
  document.body.style.overflow = '';
}

lightboxClose.addEventListener('click', closeLightbox);
lightbox.addEventListener('click', (e) => {
  if (e.target === lightbox) closeLightbox();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeLightbox();
});

// --- Init ---
loadFiles();
