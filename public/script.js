const API = '/api/images';
const CONFIG_API = '/api/config';
const UPLOAD_API = '/api/upload';
const CHUNK_INIT_API = '/api/upload/init';
const CHUNK_API = '/api/upload/chunk';
const CHUNK_COMPLETE_API = '/api/upload/complete';

const DEFAULTS = {
  maxFileSizeMb: 4096,
  directUploadLimitMb: 80,
  chunkSizeMb: 48
};

const NEEDS_CONVERT = new Set(['.mov', '.avi', '.mkv', '.wmv', '.flv', '.webm', '.mts', '.m2ts', '.ts', '.3gp']);
const VIDEO_EXTS = new Set(['.mp4', '.mov', '.webm', '.avi', '.mkv', '.wmv', '.flv', '.mts', '.m2ts', '.ts', '.3gp']);

const state = {
  selectedFile: null,
  convertedFile: null,
  previewUrl: '',
  uploadId: '',
  config: { ...DEFAULTS },
  ffmpeg: null
};

const refs = {
  gallery: document.getElementById('gallery'),
  fileCount: document.getElementById('fileCount'),
  fileInput: document.getElementById('fileInput'),
  uploadZone: document.getElementById('uploadZone'),
  uploadPreview: document.getElementById('uploadPreview'),
  previewImg: document.getElementById('previewImg'),
  previewVideo: document.getElementById('previewVideo'),
  previewInfo: document.getElementById('previewInfo'),
  previewActions: document.getElementById('previewActions'),
  cancelBtn: document.getElementById('cancelBtn'),
  uploadBtn: document.getElementById('uploadBtn'),
  convertOption: document.getElementById('convertOption'),
  convertCheck: document.getElementById('convertCheck'),
  progress: document.getElementById('convertProgress'),
  progressFill: document.getElementById('convertProgressFill'),
  progressText: document.getElementById('convertProgressText'),
  toast: document.getElementById('toast'),
  lightbox: document.getElementById('lightbox'),
  lightboxContent: document.getElementById('lightboxContent'),
  lightboxClose: document.querySelector('.lightbox-close'),
  maxSizeText: document.getElementById('maxSizeText'),
  uploadLimitText: document.getElementById('uploadLimitText'),
  statusText: document.getElementById('statusText'),
  canvas: document.getElementById('networkCanvas')
};

function getExt(name) {
  const index = name.lastIndexOf('.');
  return index >= 0 ? name.slice(index).toLowerCase() : '';
}

function isVideoFile(file) {
  return file.type.startsWith('video/') || VIDEO_EXTS.has(getExt(file.name));
}

function formatLimit(mb) {
  return mb >= 1024 ? `${Number((mb / 1024).toFixed(1))}GB` : `${mb}MB`;
}
function formatSize(bytes) {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)}GB`;
}

function formatTime(iso) {
  const date = new Date(iso);
  const diff = Date.now() - date.getTime();
  if (!Number.isFinite(diff)) return '刚刚';
  if (diff < 60_000) return '刚刚';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`;
  return date.toLocaleDateString('zh-CN');
}

function showToast(message, type = '') {
  refs.toast.textContent = message;
  refs.toast.className = `toast show ${type}`.trim();
  clearTimeout(refs.toast._timer);
  refs.toast._timer = setTimeout(() => refs.toast.classList.remove('show'), 3400);
}

function setProgress(text, percent, loading = false) {
  refs.progress.hidden = false;
  refs.progress.classList.toggle('loading', loading);
  refs.progressFill.style.width = `${Math.max(0, Math.min(100, percent))}%`;
  refs.progressText.textContent = text;
  refs.previewActions.hidden = true;
  refs.convertOption.hidden = true;
}

function hideProgress() {
  refs.progress.hidden = true;
  refs.progress.classList.remove('loading');
  refs.previewActions.hidden = false;
}

async function loadConfig() {
  try {
    const response = await fetch(CONFIG_API);
    if (!response.ok) throw new Error('配置读取失败');
    const config = await response.json();
    state.config = { ...DEFAULTS, ...config };
  } catch {
    state.config = { ...DEFAULTS };
  }

  const limitLabel = formatLimit(state.config.maxFileSizeMb);
  refs.maxSizeText.textContent = limitLabel;
  refs.uploadLimitText.textContent = limitLabel;

}
function createGalleryCard(file) {
  const video = file.type?.startsWith('video/');
  const card = document.createElement('article');
  card.className = 'gallery-card';
  card.tabIndex = 0;
  card.dataset.url = file.url;
  card.dataset.type = file.type || '';

  const frame = document.createElement('div');
  frame.className = 'media-frame';

  const media = document.createElement(video ? 'video' : 'img');
  media.src = file.url;
  media.loading = 'lazy';
  if (video) {
    media.muted = true;
    media.preload = 'metadata';
  } else {
    media.alt = '上传的图片';
  }
  frame.appendChild(media);

  const badge = document.createElement('span');
  badge.className = 'media-type';
  badge.textContent = video ? 'VIDEO' : 'IMAGE';
  frame.appendChild(badge);

  if (video) {
    const play = document.createElement('span');
    play.className = 'play-indicator';
    play.setAttribute('aria-hidden', 'true');
    frame.appendChild(play);
  }

  const meta = document.createElement('div');
  meta.className = 'media-meta';

  const name = document.createElement('span');
  name.className = 'media-name';
  name.textContent = `${video ? '视频信号' : '图像信号'} ${getExt(file.filename || '').slice(1).toUpperCase() || ''}`.trim();

  const info = document.createElement('span');
  info.className = 'media-size';
  info.textContent = `${formatSize(file.size)} · ${formatTime(file.uploadedAt)}`;

  meta.append(name, info);
  card.append(frame, meta);

  const open = () => openLightbox(file.url, file.type || '');
  card.addEventListener('click', open);
  card.addEventListener('keydown', event => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      open();
    }
  });

  return card;
}

async function loadFiles() {
  try {
    const response = await fetch(API);
    if (!response.ok) throw new Error('加载失败');
    const files = await response.json();
    refs.fileCount.textContent = `${files.length} 个文件`;
    refs.gallery.replaceChildren();

    if (!files.length) {
      const empty = document.createElement('div');
      empty.className = 'empty';
      empty.textContent = '还没有内容，建立第一条信号吧。';
      refs.gallery.appendChild(empty);
      return;
    }

    const fragment = document.createDocumentFragment();
    files.forEach(file => fragment.appendChild(createGalleryCard(file)));
    refs.gallery.appendChild(fragment);
    refs.statusText.textContent = 'NODE ONLINE';
  } catch {
    refs.gallery.replaceChildren();
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.textContent = '信号读取失败，请确认服务器运行状态。';
    refs.gallery.appendChild(empty);
    refs.statusText.textContent = 'NODE DEGRADED';
    showToast('内容加载失败', 'error');
  }
}

function clearPreviewUrl() {
  if (state.previewUrl) URL.revokeObjectURL(state.previewUrl);
  state.previewUrl = '';
}

function handleFileSelect(file) {
  const image = file.type.startsWith('image/');
  const video = isVideoFile(file);

  if (!image && !video) {
    showToast('请选择图片或视频文件', 'error');
    return;
  }

  const maxBytes = state.config.maxFileSizeMb * 1024 * 1024;
  if (file.size > maxBytes) {
    showToast(`文件太大（最大 ${state.config.maxFileSizeMb}MB）`, 'error');
    return;
  }

  clearPreviewUrl();
  state.selectedFile = file;
  state.convertedFile = null;
  hideProgress();

  const needsConversion = video && NEEDS_CONVERT.has(getExt(file.name));
  refs.convertOption.hidden = !needsConversion;

  refs.previewImg.hidden = true;
  refs.previewVideo.hidden = true;
  state.previewUrl = URL.createObjectURL(file);

  if (image) {
    refs.previewImg.src = state.previewUrl;
    refs.previewImg.hidden = false;
  } else {
    refs.previewVideo.src = state.previewUrl;
    refs.previewVideo.hidden = false;
  }

  refs.previewInfo.textContent = `${file.name} · ${image ? '图片' : '视频'} · ${formatSize(file.size)}`;
  refs.uploadZone.hidden = true;
  refs.uploadPreview.hidden = false;
}

function resetUpload() {
  clearPreviewUrl();
  state.selectedFile = null;
  state.convertedFile = null;
  state.uploadId = '';
  refs.fileInput.value = '';
  refs.previewImg.removeAttribute('src');
  refs.previewVideo.removeAttribute('src');
  refs.previewImg.hidden = true;
  refs.previewVideo.hidden = true;
  refs.convertOption.hidden = true;
  refs.uploadBtn.disabled = false;
  refs.uploadBtn.querySelector('span').textContent = '开始上传';
  hideProgress();
  refs.uploadPreview.hidden = true;
  refs.uploadZone.hidden = false;
}

async function initFFmpeg() {
  if (state.ffmpeg) return state.ffmpeg;

  setProgress('正在加载转码引擎...', 2, true);
  const { FFmpeg: FFmpegClass } = await import('https://cdn.jsdelivr.net/npm/@ffmpeg/ffmpeg@0.12.10/+esm');
  const { toBlobURL } = await import('https://cdn.jsdelivr.net/npm/@ffmpeg/util@0.12.10/+esm');

  const ffmpeg = new FFmpegClass();
  ffmpeg.on('progress', ({ progress }) => {
    setProgress(`转码中... ${Math.min(99, Math.round(progress * 100))}%`, progress * 100);
  });

  await ffmpeg.load({
    coreURL: await toBlobURL('https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.6/dist/esm/ffmpeg-core.js', 'text/javascript'),
    wasmURL: await toBlobURL('https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.6/dist/esm/ffmpeg-core.wasm', 'application/wasm')
  });

  state.ffmpeg = ffmpeg;
  return ffmpeg;
}

async function convertToMp4(file) {
  const ffmpeg = await initFFmpeg();
  const inputName = `input${getExt(file.name)}`;
  const outputName = 'output.mp4';

  setProgress('读取源文件...', 4);
  await ffmpeg.writeFile(inputName, new Uint8Array(await file.arrayBuffer()));

  setProgress('转码中... 0%', 5);
  await ffmpeg.exec([
    '-i', inputName,
    '-c:v', 'libx264',
    '-preset', 'fast',
    '-crf', '23',
    '-c:a', 'aac',
    '-movflags', '+faststart',
    outputName
  ]);

  setProgress('打包文件...', 99);
  const data = await ffmpeg.readFile(outputName);
  await ffmpeg.deleteFile(inputName);
  await ffmpeg.deleteFile(outputName);

  return new File([data.buffer], file.name.replace(/\.[^.]+$/, '.mp4'), { type: 'video/mp4' });
}

function uploadDirect(file) {
  return new Promise((resolve, reject) => {
    const formData = new FormData();
    formData.append('image', file);

    const xhr = new XMLHttpRequest();
    xhr.open('POST', UPLOAD_API);
    xhr.responseType = 'json';

    xhr.upload.addEventListener('progress', event => {
      if (!event.lengthComputable) return;
      const percent = (event.loaded / event.total) * 100;
      setProgress(`正在上传... ${Math.round(percent)}%`, percent);
    });

    xhr.addEventListener('load', () => {
      const payload = xhr.response || {};
      if (xhr.status >= 200 && xhr.status < 300) resolve(payload);
      else reject(new Error(payload.error || '上传失败'));
    });
    xhr.addEventListener('error', () => reject(new Error('网络连接失败')));
    xhr.send(formData);
  });
}

async function readJson(response) {
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || '请求失败');
  return payload;
}

async function uploadChunked(file, onProgress) {
  const init = await readJson(await fetch(CHUNK_INIT_API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: file.name, size: file.size, type: file.type })
  }));

  state.uploadId = init.uploadId;
  const chunkSize = init.chunkSize;
  const total = init.totalChunks;

  for (let index = 0; index < total; index += 1) {
    const start = index * chunkSize;
    const end = Math.min(file.size, start + chunkSize);
    const blob = file.slice(start, end, file.type || 'application/octet-stream');
    const formData = new FormData();
    formData.append('uploadId', state.uploadId);
    formData.append('index', String(index));
    formData.append('chunk', blob, `chunk-${index}.part`);

    await readJson(await fetch(CHUNK_API, { method: 'POST', body: formData }));
    onProgress(index + 1, total);
  }

  const result = await readJson(await fetch(CHUNK_COMPLETE_API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ uploadId: state.uploadId })
  }));
  state.uploadId = '';
  return result;
}

refs.uploadZone.addEventListener('click', () => refs.fileInput.click());
refs.uploadZone.addEventListener('keydown', event => {
  if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault();
    refs.fileInput.click();
  }
});

refs.uploadZone.addEventListener('dragover', event => {
  event.preventDefault();
  refs.uploadZone.classList.add('dragover');
});

refs.uploadZone.addEventListener('dragleave', () => refs.uploadZone.classList.remove('dragover'));

refs.uploadZone.addEventListener('drop', event => {
  event.preventDefault();
  refs.uploadZone.classList.remove('dragover');
  const file = event.dataTransfer.files[0];
  if (file) handleFileSelect(file);
});

refs.fileInput.addEventListener('change', () => {
  if (refs.fileInput.files[0]) handleFileSelect(refs.fileInput.files[0]);
});

refs.cancelBtn.addEventListener('click', async () => {
  if (state.uploadId) {
    fetch(`/api/upload/${state.uploadId}`, { method: 'DELETE' }).catch(() => {});
  }
  resetUpload();
});

refs.uploadBtn.addEventListener('click', async () => {
  if (!state.selectedFile) return;

  let fileToUpload = state.selectedFile;
  const shouldConvert = isVideoFile(fileToUpload) && NEEDS_CONVERT.has(getExt(fileToUpload.name)) && refs.convertCheck.checked;

  refs.uploadBtn.disabled = true;
  refs.uploadBtn.querySelector('span').textContent = '传输中...';

  try {
    if (shouldConvert && fileToUpload.size <= 1024 * 1024 * 1024) {
      state.convertedFile = await convertToMp4(fileToUpload);
      fileToUpload = state.convertedFile;
    } else if (shouldConvert) {
      showToast('文件超过 1GB，浏览器无法稳定转码，将上传原文件', 'error');
    }

    const directLimitBytes = state.config.directUploadLimitMb * 1024 * 1024;
    if (fileToUpload.size <= directLimitBytes) {
      setProgress('正在连接上传节点...', 1);
      await uploadDirect(fileToUpload);
    } else {
      await uploadChunked(fileToUpload, (done, total) => {
        const percent = (done / total) * 100;
        setProgress(`分片传输中... ${done}/${total} · ${Math.round(percent)}%`, percent);
      });
    }

    showToast('上传成功，信号已进入档案库', 'success');
    resetUpload();
    await loadFiles();
  } catch (error) {
    console.error(error);
    showToast(error.message || '上传失败', 'error');
    refs.uploadBtn.disabled = false;
    refs.uploadBtn.querySelector('span').textContent = '开始上传';
    hideProgress();
  }
});

function openLightbox(url, type) {
  refs.lightboxContent.replaceChildren();
  const video = type?.startsWith('video/');
  const media = document.createElement(video ? 'video' : 'img');
  media.src = url;
  if (video) {
    media.controls = true;
    media.autoplay = true;
  } else {
    media.alt = '媒体预览';
  }
  refs.lightboxContent.appendChild(media);
  refs.lightbox.classList.add('active');
  document.body.style.overflow = 'hidden';
}

function closeLightbox() {
  const video = refs.lightboxContent.querySelector('video');
  if (video) video.pause();
  refs.lightboxContent.replaceChildren();
  refs.lightbox.classList.remove('active');
  document.body.style.overflow = '';
}

refs.lightboxClose.addEventListener('click', closeLightbox);
refs.lightbox.addEventListener('click', event => {
  if (event.target === refs.lightbox) closeLightbox();
});
document.addEventListener('keydown', event => {
  if (event.key === 'Escape') closeLightbox();
});

function initNetworkCanvas() {
  const canvas = refs.canvas;
  if (!canvas || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const context = canvas.getContext('2d');
  if (!context) return;

  let width = 0;
  let height = 0;
  let nodes = [];
  let frame = 0;

  function resize() {
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    width = window.innerWidth;
    height = window.innerHeight;
    canvas.width = Math.floor(width * ratio);
    canvas.height = Math.floor(height * ratio);
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
    context.setTransform(ratio, 0, 0, ratio, 0, 0);

    const count = Math.max(24, Math.min(70, Math.floor(width / 24)));
    nodes = Array.from({ length: count }, () => ({
      x: Math.random() * width,
      y: Math.random() * height,
      vx: (Math.random() - 0.5) * 0.18,
      vy: (Math.random() - 0.5) * 0.18,
      r: Math.random() * 1.2 + 0.4
    }));
  }

  function draw() {
    context.clearRect(0, 0, width, height);

    for (const node of nodes) {
      node.x += node.vx;
      node.y += node.vy;
      if (node.x < 0 || node.x > width) node.vx *= -1;
      if (node.y < 0 || node.y > height) node.vy *= -1;
    }

    for (let i = 0; i < nodes.length; i += 1) {
      for (let j = i + 1; j < nodes.length; j += 1) {
        const dx = nodes[i].x - nodes[j].x;
        const dy = nodes[i].y - nodes[j].y;
        const distance = Math.hypot(dx, dy);
        if (distance < 130) {
          context.strokeStyle = `rgba(89, 238, 255, ${(1 - distance / 130) * 0.14})`;
          context.lineWidth = 0.7;
          context.beginPath();
          context.moveTo(nodes[i].x, nodes[i].y);
          context.lineTo(nodes[j].x, nodes[j].y);
          context.stroke();
        }
      }
    }

    context.fillStyle = 'rgba(159, 248, 255, 0.62)';
    for (const node of nodes) {
      context.beginPath();
      context.arc(node.x, node.y, node.r, 0, Math.PI * 2);
      context.fill();
    }

    frame = requestAnimationFrame(draw);
  }

  window.addEventListener('resize', resize, { passive: true });
  resize();
  draw();
  window.addEventListener('pagehide', () => cancelAnimationFrame(frame), { once: true });
}

async function bootstrap() {
  initNetworkCanvas();
  await loadConfig();
  await loadFiles();
}

bootstrap();
