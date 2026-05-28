/**
 * ui.js — UI controller for Fractal IFS demo
 * Wires DOM elements to IFS engine; manages animation loop.
 */

"use strict";

(() => {

  /* ── state ──────────────────────────────────────── */
  const state = {
    srcData:      null,   // ImageData (grayscale)
    tgtData:      null,   // ImageData (grayscale)
    ifsResult:    null,   // output of IFS.encode()
    frames:       [],     // ImageData[] — one per iteration
    psnrs:        [],     // number[]
    convergedAt:  null,
    currentFrame: 0,
    animTimer:    null,
    animDir:      1,      // +1 forward / -1 backward (for bounce)
    canvasSize:   256,
  };

  /* ── DOM refs ───────────────────────────────────── */
  const $ = id => document.getElementById(id);
  const srcCanvas    = $('srcCanvas');
  const tgtCanvas    = $('tgtCanvas');
  const iterCanvas   = $('iterCanvas');
  const srcZone      = $('srcZone');
  const tgtZone      = $('tgtZone');
  const srcFile      = $('srcFile');
  const tgtFile      = $('tgtFile');
  const encodeBtn    = $('encodeBtn');
  const animBtn      = $('animBtn');
  const stepFwdBtn   = $('stepFwdBtn');
  const stepBwdBtn   = $('stepBwdBtn');
  const exportBtn    = $('exportBtn');
  const resetBtn     = $('resetBtn');
  const maxIterSlide = $('maxIter');
  const maxIterNum   = $('maxIterNum');
  const animSpeedSlide = $('animSpeed');
  const speedDisp    = $('speedDisp');
  const iterSlider   = $('iterSlider');
  const iterTag      = $('iterTag');
  const progressSection = $('progressSection');
  const progressFill = $('progressFill');
  const progressLabel = $('progressLabel');
  const metricsRow   = $('metricsRow');
  const thumbStrip   = $('thumbStrip');
  const prevBtn      = $('prevBtn');
  const nextBtn      = $('nextBtn');

  /* ── helpers ────────────────────────────────────── */

  function getCanvasSize() {
    const el = document.querySelector('input[name="canvSize"]:checked');
    return el ? parseInt(el.value) : 256;
  }
  function getBlockSize() {
    const el = document.querySelector('input[name="bs"]:checked');
    return el ? parseInt(el.value) : 4;
  }
  function getStride() {
    const el = document.querySelector('input[name="stride"]:checked');
    return el ? parseInt(el.value) : 2;
  }
  function getBrightMode() {
    const el = document.querySelector('input[name="bright"]:checked');
    return el ? el.value : 'full';
  }
  function getMaxIter() { return Math.max(1, parseInt(maxIterNum.value) || 20); }
  function getConvThresh() {
    const el = document.querySelector('input[name="conv"]:checked');
    return el ? parseFloat(el.value) : 0.01;
  }
  function getAnimMode() {
    const el = document.querySelector('input[name="animMode"]:checked');
    return el ? el.value : 'forward';
  }
  function getBlendAlpha() {
    const el = document.querySelector('input[name="blend"]:checked');
    return el ? parseFloat(el.value) : 0;
  }
  function getAnimSpeed() { return parseInt(animSpeedSlide.value); }

  function drawFrameToCanvas(idx) {
    if (!state.frames[idx]) return;
    const ctx = iterCanvas.getContext('2d');
    ctx.clearRect(0, 0, iterCanvas.width, iterCanvas.height);
    ctx.putImageData(state.frames[idx], 0, 0);

    // Optional ghost overlay of target
    const alpha = getBlendAlpha();
    if (alpha > 0 && state.tgtData) {
      // draw tgt to offscreen then blit with alpha
      const off = document.createElement('canvas');
      off.width = iterCanvas.width; off.height = iterCanvas.height;
      off.getContext('2d').putImageData(state.tgtData, 0, 0);
      ctx.globalAlpha = alpha;
      ctx.drawImage(off, 0, 0);
      ctx.globalAlpha = 1;
    }

    // update tag & slider
    iterTag.textContent = `it. ${idx}`;
    iterSlider.value = idx;
    state.currentFrame = idx;
    highlightThumb(idx);
  }

  function setProgress(frac, msg) {
    progressSection.style.display = 'flex';
    progressFill.style.width = Math.round(frac * 100) + '%';
    progressLabel.textContent = msg;
  }

  function hideProgress() {
    progressSection.style.display = 'none';
    progressFill.style.width = '0%';
  }

  function setBtnsEncoding(busy) {
    encodeBtn.disabled    = busy;
    animBtn.disabled      = busy || !state.frames.length;
    stepFwdBtn.disabled   = busy || !state.frames.length;
    stepBwdBtn.disabled   = busy || !state.frames.length;
    exportBtn.disabled    = busy || !state.frames.length;
  }

  function checkReady() {
    encodeBtn.disabled = !(state.srcData && state.tgtData);
  }

  /* ── image upload ───────────────────────────────── */

  async function handleUpload(file, role) {
    const sz = getCanvasSize();
    const imgData = await IFS.loadFileAsGray(file, sz, sz);

    // draw to preview canvas
    const cv = role === 'src' ? srcCanvas : tgtCanvas;
    const zone = role === 'src' ? srcZone : tgtZone;
    cv.width = sz; cv.height = sz;
    cv.getContext('2d').putImageData(imgData, 0, 0);
    zone.style.display = 'none';
    cv.classList.add('visible');

    if (role === 'src') state.srcData = imgData;
    else                state.tgtData = imgData;

    // also clear stale results
    clearResults();
    checkReady();
  }

  srcZone.addEventListener('click', () => srcFile.click());
  srcFile.addEventListener('change', e => { if (e.target.files[0]) handleUpload(e.target.files[0], 'src'); });
  tgtZone.addEventListener('click', () => tgtFile.click());
  tgtFile.addEventListener('change', e => { if (e.target.files[0]) handleUpload(e.target.files[0], 'tgt'); });

  // Drag-and-drop support
  [srcZone, tgtZone].forEach((zone, i) => {
    zone.addEventListener('dragover', e => { e.preventDefault(); zone.style.borderColor = '#378add'; });
    zone.addEventListener('dragleave', () => { zone.style.borderColor = ''; });
    zone.addEventListener('drop', e => {
      e.preventDefault();
      zone.style.borderColor = '';
      const f = e.dataTransfer.files[0];
      if (f && f.type.startsWith('image/')) handleUpload(f, i === 0 ? 'src' : 'tgt');
    });
  });

  /* ── encode ─────────────────────────────────────── */

  encodeBtn.addEventListener('click', async () => {
    if (!state.srcData || !state.tgtData) return;
    stopAnim();
    setBtnsEncoding(true);
    clearResults();
    setProgress(0, 'Starting encoder...');

    try {
      // 1. Encode IFS from target
      state.ifsResult = await IFS.encode(state.tgtData, {
        blockSize:  getBlockSize(),
        stride:     getStride(),
        brightMode: getBrightMode(),
        onProgress: (frac, msg) => setProgress(frac * 0.6, msg),
      });

      // 2. Iterate from source
      setProgress(0.6, 'Running iterations...');
      const result = await IFS.iterate(state.srcData, state.tgtData, state.ifsResult, {
        maxIter:    getMaxIter(),
        convThresh: getConvThresh(),
        onProgress: (it, p, converged) => {
          setProgress(0.6 + 0.4 * it / getMaxIter(),
            `Iteration ${it} — PSNR ${p.toFixed(2)} dB${converged ? ' ✓ converged' : ''}`);
        },
      });

      state.frames      = result.frames;
      state.psnrs       = result.psnrs;
      state.convergedAt = result.convergedAt;

      // Update iter canvas & controls
      iterCanvas.width  = state.canvasSize;
      iterCanvas.height = state.canvasSize;
      iterSlider.max    = state.frames.length - 1;
      iterSlider.value  = 0;
      iterSlider.disabled = false;
      prevBtn.disabled = false;
      nextBtn.disabled = false;
      drawFrameToCanvas(0);

      showMetrics();
      buildThumbs();
      hideProgress();
      setBtnsEncoding(false);

    } catch (err) {
      console.error(err);
      setProgress(1, `Error: ${err.message}`);
      setBtnsEncoding(false);
    }
  });

  /* ── metrics ─────────────────────────────────────── */

  function showMetrics() {
    const t = state.ifsResult;
    const finalPSNR = state.psnrs[state.psnrs.length - 1];
    const W = t.W, H = t.H, bs = t.blockSize;
    const origBytes = W * H * 3;
    const encBytes  = t.transforms.length * (4 * 2 + 2 * 4 + 1); // 2 ints, 2 floats, blockSize

    $('mBlocks').textContent   = t.transforms.length;
    $('mIter').textContent     = state.frames.length - 1;
    $('mPSNR').textContent     = finalPSNR.toFixed(1) + ' dB';
    $('mRatio').textContent    = (origBytes / encBytes).toFixed(1) + '×';
    $('mConv').textContent     = state.convergedAt !== null ? state.convergedAt : '—';
    $('mEncTime').textContent  = t.encodeTime.toFixed(1);
    metricsRow.style.display   = 'flex';
  }

  /* ── thumbnail strip ─────────────────────────────── */

  function buildThumbs() {
    thumbStrip.innerHTML = '';
    const n = state.frames.length;
    // Show at most 24 thumbs, evenly spaced
    const step = Math.max(1, Math.floor(n / 24));
    for (let i = 0; i < n; i += step) {
      const wrap = document.createElement('div');
      wrap.className = 'thumb-item';

      const cv = document.createElement('canvas');
      cv.width  = 60;
      cv.height = 60;
      cv.dataset.frameIdx = i;
      const ctx = cv.getContext('2d');
      // Scale down from full-res frame
      const off = document.createElement('canvas');
      off.width  = state.ifsResult.W;
      off.height = state.ifsResult.H;
      off.getContext('2d').putImageData(state.frames[i], 0, 0);
      ctx.drawImage(off, 0, 0, 60, 60);

      const lbl = document.createElement('span');
      lbl.textContent = `it.${i}`;
      lbl.dataset.frameIdx = i;

      cv.addEventListener('click', () => { stopAnim(); drawFrameToCanvas(i); });
      wrap.appendChild(cv); wrap.appendChild(lbl);
      thumbStrip.appendChild(wrap);
    }
  }

  function highlightThumb(activeIdx) {
    thumbStrip.querySelectorAll('canvas').forEach(cv => {
      cv.classList.toggle('active', parseInt(cv.dataset.frameIdx) === activeIdx);
    });
  }

  /* ── animation ───────────────────────────────────── */

  function stopAnim() {
    if (state.animTimer) { clearInterval(state.animTimer); state.animTimer = null; }
    animBtn.textContent = '▶ Animate';
  }

  animBtn.addEventListener('click', () => {
    if (state.animTimer) { stopAnim(); return; }
    if (!state.frames.length) return;

    const mode  = getAnimMode();
    const delay = getAnimSpeed();
    state.animDir = 1;
    state.currentFrame = 0;
    animBtn.textContent = '⏹ Stop';

    state.animTimer = setInterval(() => {
      let next = state.currentFrame + state.animDir;

      if (mode === 'forward') {
        if (next >= state.frames.length) { stopAnim(); return; }
      } else if (mode === 'bounce') {
        if (next >= state.frames.length) { state.animDir = -1; next = state.frames.length - 2; }
        else if (next < 0)              { state.animDir =  1; next = 1; }
      } else if (mode === 'pingpong') {
        if (next >= state.frames.length) { state.animDir = -1; next = state.frames.length - 2; }
        else if (next < 0)              { stopAnim(); return; }
      }

      drawFrameToCanvas(next);
    }, delay);
  });

  /* ── step buttons ────────────────────────────────── */

  stepFwdBtn.addEventListener('click', () => {
    stopAnim();
    const n = Math.min(state.currentFrame + 1, state.frames.length - 1);
    drawFrameToCanvas(n);
  });

  stepBwdBtn.addEventListener('click', () => {
    stopAnim();
    const n = Math.max(state.currentFrame - 1, 0);
    drawFrameToCanvas(n);
  });

  iterSlider.addEventListener('input', () => {
    stopAnim();
    drawFrameToCanvas(parseInt(iterSlider.value));
  });

  prevBtn.addEventListener('click', () => {
    stopAnim();
    drawFrameToCanvas(Math.max(state.currentFrame - 1, 0));
  });
  nextBtn.addEventListener('click', () => {
    stopAnim();
    drawFrameToCanvas(Math.min(state.currentFrame + 1, state.frames.length - 1));
  });

  /* ── export ──────────────────────────────────────── */

  exportBtn.addEventListener('click', () => {
    if (!state.frames[state.currentFrame]) return;
    const off = document.createElement('canvas');
    off.width  = state.ifsResult.W;
    off.height = state.ifsResult.H;
    off.getContext('2d').putImageData(state.frames[state.currentFrame], 0, 0);
    const link = document.createElement('a');
    link.download = `ifs_iter_${state.currentFrame}.png`;
    link.href = off.toDataURL('image/png');
    link.click();
  });

  /* ── reset ───────────────────────────────────────── */

  resetBtn.addEventListener('click', () => {
    stopAnim();
    state.srcData = null; state.tgtData = null;
    state.ifsResult = null; state.frames = []; state.psnrs = [];
    state.currentFrame = 0; state.convergedAt = null;

    [srcCanvas, tgtCanvas, iterCanvas].forEach(cv => {
      cv.getContext('2d').clearRect(0, 0, cv.width, cv.height);
      cv.classList.remove('visible');
    });
    [srcZone, tgtZone].forEach(z => z.style.display = '');
    srcFile.value = ''; tgtFile.value = '';

    thumbStrip.innerHTML = '';
    metricsRow.style.display = 'none';
    hideProgress();
    iterTag.textContent = 'it. 0';
    iterSlider.value = 0; iterSlider.max = 0; iterSlider.disabled = true;
    prevBtn.disabled = true; nextBtn.disabled = true;
    encodeBtn.disabled = true;
    animBtn.disabled = true; stepFwdBtn.disabled = true;
    stepBwdBtn.disabled = true; exportBtn.disabled = true;
  });

  function clearResults() {
    stopAnim();
    state.frames = []; state.psnrs = []; state.ifsResult = null;
    state.currentFrame = 0; state.convergedAt = null;
    thumbStrip.innerHTML = '';
    metricsRow.style.display = 'none';
    iterCanvas.getContext('2d').clearRect(0, 0, iterCanvas.width, iterCanvas.height);
    iterTag.textContent = 'it. 0';
    iterSlider.value = 0; iterSlider.max = 0; iterSlider.disabled = true;
    prevBtn.disabled = true; nextBtn.disabled = true;
    animBtn.disabled = true; stepFwdBtn.disabled = true;
    stepBwdBtn.disabled = true; exportBtn.disabled = true;
  }

  /* ── live slider displays ────────────────────────── */

  // Slider → number box (slider caps at 500)
  maxIterSlide.addEventListener('input', () => {
    maxIterNum.value = maxIterSlide.value;
  });
  // Number box → slider (clamp display to 500 max)
  maxIterNum.addEventListener('input', () => {
    const v = parseInt(maxIterNum.value) || 1;
    maxIterSlide.value = Math.min(v, 500);
  });

  animSpeedSlide.addEventListener('input', () => {
    speedDisp.textContent = animSpeedSlide.value;
    if (state.animTimer) {
      stopAnim();
      animBtn.click(); // restart with new speed
    }
  });

  // Init iter canvas with placeholder
  iterCanvas.classList.add('visible');
  (() => {
    const ctx = iterCanvas.getContext('2d');
    ctx.fillStyle = '#e8e7e2';
    ctx.fillRect(0, 0, iterCanvas.width, iterCanvas.height);
    ctx.fillStyle = '#999993';
    ctx.font = '13px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('output appears here', 128, 135);
  })();

})();
