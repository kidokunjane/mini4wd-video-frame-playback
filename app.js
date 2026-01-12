// PWA: register service worker
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch(() => {/* no-op */});
  });
}

const $ = (sel) => document.querySelector(sel);
const video = $('#video');
const stage = $('#stage');
const openBtn = $('#openBtn');
const fileInput = $('#fileInput');
const playPauseBtn = $('#playPauseBtn');
const prevFrameBtn = $('#prevFrameBtn');
const nextFrameBtn = $('#nextFrameBtn');
const currentTimeEl = $('#currentTime');
const durationEl = $('#duration');
const seek = $('#seek');
const hud = $('#hud');
const spinner = $('#spinner');
const iconPlay = $('#iconPlay');
const iconPause = $('#iconPause');
const installBtn = $('#installBtn');

let installPromptEvent = null;
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  installPromptEvent = e;
  if (installBtn) installBtn.hidden = false;
});

if (installBtn) {
  installBtn.addEventListener('click', async () => {
    if (!installPromptEvent) return;
    installPromptEvent.prompt();
    await installPromptEvent.userChoice;
    installPromptEvent = null;
    installBtn.hidden = true;
  });
}

window.addEventListener('appinstalled', () => {
  installPromptEvent = null;
  if (installBtn) installBtn.hidden = true;
});

let objectUrl = null;
let rafId = 0;
let isScrubbing = false;
let frameDuration = 1/30; // fallback
let frameEstimateOk = false;

// Transform state for pinch/pan
const transform = {
  s: 1,
  tx: 0,
  ty: 0,
};

function applyTransform() {
  // clamp
  const sw = stage.clientWidth;
  const sh = stage.clientHeight;
  const maxDx = (sw * (transform.s - 1)) / 2;
  const maxDy = (sh * (transform.s - 1)) / 2;
  if (transform.s <= 1) {
    transform.tx = 0;
    transform.ty = 0;
  } else {
    transform.tx = Math.max(-maxDx, Math.min(maxDx, transform.tx));
    transform.ty = Math.max(-maxDy, Math.min(maxDy, transform.ty));
  }
  video.style.setProperty('--sx', String(transform.s));
  video.style.setProperty('--tx', transform.tx + 'px');
  video.style.setProperty('--ty', transform.ty + 'px');
}

function resetTransform() { transform.s = 1; transform.tx = 0; transform.ty = 0; applyTransform(); }

function fmtTime(t) {
  if (!isFinite(t)) return '00:00.00';
  const sign = t < 0 ? '-' : '';
  t = Math.max(0, Math.abs(t));
  const m = Math.floor(t/60);
  const s = Math.floor(t%60);
  const cs = Math.floor((t - Math.floor(t)) * 100);
  return `${sign}${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}.${String(cs).padStart(2,'0')}`;
}

function setHud(text, ms=1200) {
  hud.textContent = text;
  if (ms) {
    const token = Symbol('hud');
    setHud._t = token;
    setTimeout(() => { if (setHud._t === token) hud.textContent = ''; }, ms);
  }
}

function updateUiFromVideo() {
  const t = video.currentTime || 0;
  const d = isFinite(video.duration) ? video.duration : 0;
  currentTimeEl.textContent = fmtTime(t);
  durationEl.textContent = fmtTime(d);
  if (!isScrubbing && d > 0) {
    seek.max = String(d);
    seek.value = String(t);
    const fill = (t / d) * 100;
    seek.style.setProperty('--fill', fill + '%');
  }
}

function rafLoop() {
  updateUiFromVideo();
  rafId = requestAnimationFrame(rafLoop);
}

function togglePlay() {
  if (!video.src) return;
  if (video.paused) {
    video.play().catch(() => {/* ignore */});
  } else {
    video.pause();
  }
}

function updatePlayIcon() {
  const playing = !video.paused && !video.ended;
  iconPlay.style.display = playing ? 'none' : '';
  iconPause.style.display = playing ? '' : 'none';
}

async function analyzeFrameRate() {
  if (!('requestVideoFrameCallback' in HTMLVideoElement.prototype)) {
    frameEstimateOk = false;
    return;
  }
  spinner.style.display = 'grid';
  try {
    const deltas = [];
    let last = null;
    let count = 0;
    const maxSamples = 8;
    const timeoutMs = 600;
    const t0 = performance.now();
    const wasPaused = video.paused;
    const wasMuted = video.muted;
    const savedTime = video.currentTime;
    video.muted = true;
    await video.play().catch(()=>{});

    const onFrame = (now, meta) => {
      if (last != null) {
        const dt = meta.mediaTime - last;
        if (dt > 0 && dt < 0.2) deltas.push(dt);
      }
      last = meta.mediaTime;
      count++;
      if (deltas.length >= maxSamples || (performance.now() - t0) > timeoutMs) {
        video.pause();
      } else {
        video.requestVideoFrameCallback(onFrame);
      }
    };
    video.requestVideoFrameCallback(onFrame);

    await new Promise((res) => {
      const done = () => res();
      const chk = () => (video.paused || (performance.now() - t0) > timeoutMs + 100) ? done() : setTimeout(chk, 30);
      chk();
    });

    if (deltas.length) {
      deltas.sort((a,b)=>a-b);
      const mid = deltas[Math.floor(deltas.length/2)];
      if (mid && isFinite(mid)) { frameDuration = mid; frameEstimateOk = true; setHud(`${(1/mid).toFixed(1)} fps`); }
    }

    // restore
    video.muted = wasMuted;
    if (wasPaused) video.currentTime = savedTime;
  } finally {
    spinner.style.display = 'none';
  }
}

function clamp(v, min, max) { return Math.max(min, Math.min(max, v)); }

async function stepFrame(dir) {
  if (!video.src) return;
  video.pause();
  const d = isFinite(video.duration) ? video.duration : 0;
  if (d <= 0) return;
  const epsilon = 1e-4;
  const dt = (frameDuration || 1/30) * dir;
  let target = clamp((video.currentTime || 0) + dt, 0, d - (dir>0?epsilon:0));
  if (dir < 0 && target < epsilon) target = 0;
  await seekTo(target);
}

function seekTo(t) {
  return new Promise((resolve) => {
    const onSeeked = () => { video.removeEventListener('seeked', onSeeked); resolve(); };
    video.addEventListener('seeked', onSeeked, { once: true });
    video.currentTime = t;
  });
}

openBtn.addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', async (e) => {
  const file = e.target.files && e.target.files[0];
  if (!file) return;
  if (objectUrl) URL.revokeObjectURL(objectUrl);
  objectUrl = URL.createObjectURL(file);
  resetTransform();
  video.src = objectUrl;
  video.load();
});

playPauseBtn.addEventListener('click', togglePlay);
prevFrameBtn.addEventListener('click', () => stepFrame(-1));
nextFrameBtn.addEventListener('click', () => stepFrame(1));

seek.addEventListener('input', () => {
  if (!isFinite(video.duration)) return;
  isScrubbing = true;
  const t = Number(seek.value);
  const d = Number(seek.max) || 0;
  const fill = d ? (t/d)*100 : 0;
  seek.style.setProperty('--fill', fill + '%');
  video.currentTime = t;
  updateUiFromVideo();
});
seek.addEventListener('change', () => { isScrubbing = false; updateUiFromVideo(); });

video.addEventListener('loadedmetadata', () => {
  updateUiFromVideo();
  analyzeFrameRate();
});
video.addEventListener('durationchange', updateUiFromVideo);
video.addEventListener('timeupdate', updateUiFromVideo);
video.addEventListener('play', updatePlayIcon);
video.addEventListener('pause', updatePlayIcon);
video.addEventListener('ended', updatePlayIcon);

// Start UI update loop
rafId = requestAnimationFrame(rafLoop);
window.addEventListener('beforeunload', () => cancelAnimationFrame(rafId));

// Pinch / Pan / Double-tap via Pointer Events (with center-origin math)
const pointers = new Map();
let gesture = null; // { s0, t0:{x,y}, p0:{x,y}, d0 }
let lastTap = { t: 0, x: 0, y: 0 };

function getCenterAndDistance() {
  const pts = Array.from(pointers.values());
  const p1 = pts[0], p2 = pts[1];
  const cx = (p1.x + p2.x) / 2;
  const cy = (p1.y + p2.y) / 2;
  const dx = p2.x - p1.x, dy = p2.y - p1.y;
  const dist = Math.hypot(dx, dy);
  return { cx, cy, dist };
}

function toCenterCoords(x, y) {
  const rect = stage.getBoundingClientRect();
  return { x: x - (rect.left + rect.width/2), y: y - (rect.top + rect.height/2) };
}

function clampTranslateForScale(s, tx, ty) {
  const sw = stage.clientWidth;
  const sh = stage.clientHeight;
  if (s <= 1) return { tx: 0, ty: 0 };
  const maxDx = (sw * (s - 1)) / 2;
  const maxDy = (sh * (s - 1)) / 2;
  return { tx: clamp(tx, -maxDx, maxDx), ty: clamp(ty, -maxDy, maxDy) };
}

stage.addEventListener('pointerdown', (e) => {
  // Ignore if interacting with overlay UI controls
  const el = e.target;
  if (el.closest && (el.closest('.btn') || el.closest('.controls') || el.closest('.seek'))) return;
  if (e.button !== 0) return;
  stage.setPointerCapture(e.pointerId);
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

  // double-tap detection for quick zoom toggle (single pointer only)
  const now = performance.now();
  if (pointers.size === 1 && (now - lastTap.t) < 300 && Math.hypot(e.clientX - lastTap.x, e.clientY - lastTap.y) < 24) {
    // toggle zoom around tap
    const rect = stage.getBoundingClientRect();
    const pScreen = { x: e.clientX, y: e.clientY };
    const pc = toCenterCoords(pScreen.x, pScreen.y);
    const s0 = transform.s;
    const t0 = { x: transform.tx, y: transform.ty };
    const s1 = s0 < 1.5 ? 2 : 1;
    // t1 = p - c - s1*(p - c - t0)/s0, but pc is (p-c)
    const t1x = pc.x - s1 * (pc.x - t0.x) / s0;
    const t1y = pc.y - s1 * (pc.y - t0.y) / s0;
    transform.s = s1;
    const cl = clampTranslateForScale(s1, t1x, t1y);
    transform.tx = cl.tx; transform.ty = cl.ty;
    applyTransform();
  }
  lastTap = { t: now, x: e.clientX, y: e.clientY };

  if (pointers.size === 2) {
    const { cx, cy, dist } = getCenterAndDistance();
    gesture = { s0: transform.s, t0: { x: transform.tx, y: transform.ty }, p0: { x: cx, y: cy }, d0: dist };
  }
});

stage.addEventListener('pointermove', (e) => {
  if (!pointers.has(e.pointerId)) return;
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

  if (pointers.size === 2 && gesture) {
    const { cx, cy, dist } = getCenterAndDistance();
    const s1 = clamp(gesture.s0 * (dist / (gesture.d0 || 1)), 1, 8);
    // anchored at midpoint
    const pc = toCenterCoords(cx, cy);
    const t0 = gesture.t0;
    const s0 = gesture.s0;
    const t1x = pc.x - s1 * (pc.x - t0.x) / s0;
    const t1y = pc.y - s1 * (pc.y - t0.y) / s0;
    transform.s = s1;
    const cl = clampTranslateForScale(s1, t1x, t1y);
    transform.tx = cl.tx; transform.ty = cl.ty;
    applyTransform();
  } else if (pointers.size === 1) {
    // pan when zoomed
    if (transform.s > 1) {
      const p = Array.from(pointers.values())[0];
      if (!stage._lastPan) stage._lastPan = { x: p.x, y: p.y };
      const dx = p.x - stage._lastPan.x;
      const dy = p.y - stage._lastPan.y;
      stage._lastPan = { x: p.x, y: p.y };
      transform.tx += dx;
      transform.ty += dy;
      applyTransform();
    }
  }
});

function endPointer(e) {
  if (stage.hasPointerCapture?.(e.pointerId)) stage.releasePointerCapture(e.pointerId);
  pointers.delete(e.pointerId);
  if (pointers.size < 2) gesture = null;
  if (pointers.size === 0) stage._lastPan = null;
}
stage.addEventListener('pointerup', endPointer);
stage.addEventListener('pointercancel', endPointer);

window.addEventListener('resize', applyTransform);
