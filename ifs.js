/**
 * ifs.js — Fractal IFS Image Compression (Jacquin 1992, corrected)
 *
 * THE KEY INSIGHT (why naive implementations snap to fixed point in 1 iter):
 *
 *   Domain blocks must be TWICE the size of range blocks, then downsampled 2×.
 *   This spatial contraction by factor 2 guarantees the IFS operator W is
 *   contractive regardless of brightness scale — Banach's theorem then gives
 *   unique convergence from any starting image.
 *
 *   Without the 2× downsampling, scale values can be ~1 and the map is not
 *   contractive: x_{n+1} ≈ x_n for all n, so it "converges" in 1 step to
 *   whatever the starting image already is.
 *
 * Algorithm:
 *  ENCODE:
 *   1. Grayscale target → Float32 [0,255]
 *   2. Build downsampled domain pool: every 2×bs patch, averaged → bs patch
 *   3. For each range block (bs×bs), find best matching downsampled domain
 *      block via least-squares brightness fit (scale s, offset o)
 *   4. Store transform: { rx,ry, dx,dy, s, o, bs }
 *      where (dx,dy) indexes the ORIGINAL 2×bs domain position
 *
 *  ITERATE (decode):
 *   1. Start from ANY image x_0
 *   2. For each step: downsample x_n → pool, apply transforms → x_{n+1}
 *   3. Repeat: x_n → attractor (≈ target) as n → ∞
 */

"use strict";

window.IFS = (() => {

  /* ─────────────────────────────────────────────────────
     HELPERS
  ───────────────────────────────────────────────────── */

  /** Convert ImageData → Float32 grayscale [0,255] */
  function toGray(imgData) {
    const { width: W, height: H, data: d } = imgData;
    const g = new Float32Array(W * H);
    for (let i = 0, j = 0; i < d.length; i += 4, j++)
      g[j] = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
    return { g, W, H };
  }

  /** Float32 grayscale → ImageData (clamped) */
  function grayToImageData(g, W, H, ctx) {
    const out = ctx.createImageData(W, H);
    for (let i = 0, j = 0; i < out.data.length; i += 4, j++) {
      const v = Math.max(0, Math.min(255, Math.round(g[j])));
      out.data[i] = out.data[i + 1] = out.data[i + 2] = v;
      out.data[i + 3] = 255;
    }
    return out;
  }

  /**
   * Build a pool of downsampled domain blocks from a grayscale image.
   * Each domain block is a 2×bs patch averaged (box filter) down to bs×bs.
   * Stride controls how densely we sample domain positions.
   *
   * Returns: { pool, positions }
   *   pool[i]      — Float32Array of length bs*bs (the downsampled block)
   *   positions[i] — { dx, dy } original top-left of the 2×bs patch
   */
  function buildDomainPool(g, W, H, bs, stride) {
    const dbs = bs * 2;          // domain block size (twice range block size)
    const pool = [];
    const positions = [];

    for (let dy = 0; dy + dbs <= H; dy += stride) {
      for (let dx = 0; dx + dbs <= W; dx += stride) {
        const block = new Float32Array(bs * bs);
        // 2×2 average downsample: each output pixel = avg of 2×2 input pixels
        for (let by = 0; by < bs; by++) {
          for (let bx = 0; bx < bs; bx++) {
            const sy = dy + by * 2;
            const sx = dx + bx * 2;
            block[by * bs + bx] = (
              g[sy * W + sx] +
              g[sy * W + sx + 1] +
              g[(sy + 1) * W + sx] +
              g[(sy + 1) * W + sx + 1]
            ) * 0.25;
          }
        }
        pool.push(block);
        positions.push({ dx, dy });
      }
    }
    return { pool, positions };
  }

  /**
   * Least-squares brightness affine fit:
   *   minimise Σ (range[i] - (s * domain[i] + o))²
   * Closed-form solution; scale clamped to [-0.95, 0.95] to ensure contractivity.
   */
  function fitBrightness(rangeBlock, domainBlock, n, mode) {
    if (mode === 'offset') {
      let sr = 0, sd = 0;
      for (let i = 0; i < n; i++) { sr += rangeBlock[i]; sd += domainBlock[i]; }
      return { scale: 1, offset: (sr - sd) / n };
    }
    let sr = 0, sd = 0, srd = 0, sd2 = 0;
    for (let i = 0; i < n; i++) {
      const r = rangeBlock[i], d = domainBlock[i];
      sr += r; sd += d; srd += r * d; sd2 += d * d;
    }
    const den = n * sd2 - sd * sd;
    let scale = den > 1e-6 ? (n * srd - sr * sd) / den : 0;
    // Clamp strictly below 1 — contractivity requirement
    scale = Math.max(-0.95, Math.min(0.95, scale));
    const offset = (sr - scale * sd) / n;
    return { scale, offset };
  }

  /** Sum of squared differences between range block and transformed domain block */
  function computeSSD(rangeBlock, domainBlock, n, scale, offset) {
    let ssd = 0;
    for (let i = 0; i < n; i++) {
      const diff = rangeBlock[i] - (scale * domainBlock[i] + offset);
      ssd += diff * diff;
    }
    return ssd;
  }

  /** Extract a bs×bs block from grayscale array as Float32Array */
  function extractBlock(g, W, bx, by, bs) {
    const block = new Float32Array(bs * bs);
    for (let y = 0; y < bs; y++)
      for (let x = 0; x < bs; x++)
        block[y * bs + x] = g[(by + y) * W + (bx + x)];
    return block;
  }

  /* ─────────────────────────────────────────────────────
     ENCODE
  ───────────────────────────────────────────────────── */

  /**
   * Build IFS transforms from target image.
   *
   * @param {ImageData} tgtImgData
   * @param {object}    opts
   *   blockSize   {number}  — range block size (bs); domain blocks are 2×bs
   *   stride      {number}  — domain sampling stride (applied to 2×bs grid)
   *   brightMode  {string}  — 'full' | 'offset'
   *   onProgress  {fn}      — (fraction, message) => void
   * @returns Promise<{ transforms, W, H, blockSize, encodeTime }>
   */
  async function encode(tgtImgData, opts = {}) {
    const bs     = opts.blockSize  ?? 4;
    const stride = opts.stride     ?? 4;   // default stride larger since pool is dense
    const mode   = opts.brightMode ?? 'full';
    const onProg = opts.onProgress ?? (() => {});

    const { g, W, H } = toGray(tgtImgData);
    const n = bs * bs;
    const t0 = performance.now();

    // Build downsampled domain pool from target
    const { pool, positions } = buildDomainPool(g, W, H, bs, stride);

    const nRangeX = Math.floor(W / bs);
    const nRangeY = Math.floor(H / bs);
    const total   = nRangeX * nRangeY;
    const transforms = [];
    let done = 0;

    for (let ry = 0; ry + bs <= H; ry += bs) {
      for (let rx = 0; rx + bs <= W; rx += bs) {
        const rangeBlock = extractBlock(g, W, rx, ry, bs);

        let bestSSD = Infinity, bestIdx = 0, bestScale = 0, bestOffset = 128;

        for (let i = 0; i < pool.length; i++) {
          const { scale, offset } = fitBrightness(rangeBlock, pool[i], n, mode);
          const ssd = computeSSD(rangeBlock, pool[i], n, scale, offset);
          if (ssd < bestSSD) {
            bestSSD = ssd; bestIdx = i; bestScale = scale; bestOffset = offset;
          }
        }

        transforms.push({
          rx, ry,
          dx: positions[bestIdx].dx,
          dy: positions[bestIdx].dy,
          s:  bestScale,
          o:  bestOffset,
          bs
        });

        done++;
        if (done % 16 === 0) {
          onProg(done / total, `Encoding block ${done} / ${total}`);
          await yieldToUI();
        }
      }
    }

    onProg(1, `Encoded ${transforms.length} transforms in ${((performance.now()-t0)/1000).toFixed(1)}s`);
    return { transforms, W, H, blockSize: bs, encodeTime: (performance.now()-t0)/1000 };
  }

  /* ─────────────────────────────────────────────────────
     ITERATE (DECODE)
  ───────────────────────────────────────────────────── */

  /**
   * Apply one IFS iteration.
   *
   * CRITICAL: we downsample `current` first (same 2× box filter as encode),
   * then each transform reads from that downsampled pool — NOT from current directly.
   * This is what makes the operator genuinely contractive.
   */
  function iterateOnce(current, W, H, transforms) {
    const bs = transforms[0]?.bs ?? 4;

    // Build downsampled pool from current image (same stride=1 to cover all positions)
    // We need every possible domain position, so stride=2 (pixel-perfect coverage)
    const dbs = bs * 2;
    const next = new Float32Array(W * H);

    for (const t of transforms) {
      // Downsample the 2×bs domain patch from current on-the-fly
      for (let by = 0; by < t.bs; by++) {
        for (let bx = 0; bx < t.bs; bx++) {
          const sy = t.dy + by * 2;
          const sx = t.dx + bx * 2;

          // Clamp to image bounds (edge safety)
          const sy1 = Math.min(sy,   H - 1);
          const sy2 = Math.min(sy+1, H - 1);
          const sx1 = Math.min(sx,   W - 1);
          const sx2 = Math.min(sx+1, W - 1);

          const dv = (
            current[sy1 * W + sx1] +
            current[sy1 * W + sx2] +
            current[sy2 * W + sx1] +
            current[sy2 * W + sx2]
          ) * 0.25;

          const dstIdx = (t.ry + by) * W + (t.rx + bx);
          next[dstIdx] = Math.max(0, Math.min(255, t.s * dv + t.o));
        }
      }
    }
    return next;
  }

  /** PSNR between two Float32 grayscale arrays */
  function psnr(a, b) {
    let mse = 0;
    for (let i = 0; i < a.length; i++) { const d = a[i]-b[i]; mse += d*d; }
    mse /= a.length;
    return mse < 1e-10 ? 99 : 10 * Math.log10(255*255/mse);
  }

  /**
   * Run iterations from srcImgData toward the IFS attractor.
   *
   * @param {ImageData} srcImgData   — starting image (any image)
   * @param {ImageData} tgtImgData   — target (for PSNR measurement only)
   * @param {object}    ifsResult    — from encode()
   * @param {object}    opts
   *   maxIter     {number}  — hard cap on iterations
   *   convThresh  {number}  — stop if ΔPSNR < this (0 = off)
   *   onProgress  {fn}      — (iter, psnr, converged) => void
   * @returns Promise<{ frames, psnrs, convergedAt }>
   */
  async function iterate(srcImgData, tgtImgData, ifsResult, opts = {}) {
    const maxIter    = opts.maxIter    ?? 20;
    const convThresh = opts.convThresh ?? 0;
    const onProg     = opts.onProgress ?? (() => {});

    const { transforms, W, H } = ifsResult;
    const { g: tgtGray } = toGray(tgtImgData);
    const { g: srcGray } = toGray(srcImgData);

    const offscreen = document.createElement('canvas');
    offscreen.width = W; offscreen.height = H;
    const octx = offscreen.getContext('2d', { willReadFrequently: true });

    const frames = [grayToImageData(srcGray, W, H, octx)];
    const psnrs  = [psnr(srcGray, tgtGray)];
    let convergedAt = null;
    let cur = srcGray;
    let prevP = psnrs[0];

    for (let it = 1; it <= maxIter; it++) {
      cur = iterateOnce(cur, W, H, transforms);
      const p = psnr(cur, tgtGray);
      frames.push(grayToImageData(cur, W, H, octx));
      psnrs.push(p);

      const delta = Math.abs(p - prevP);
      const converged = convThresh > 0 && delta < convThresh && it > 3;
      onProg(it, p, converged);
      if (converged && convergedAt === null) convergedAt = it;
      prevP = p;

      await yieldToUI();
      if (converged && convThresh > 0) break;
    }

    return { frames, psnrs, convergedAt };
  }

  /* ─────────────────────────────────────────────────────
     IMAGE LOADING UTIL
  ───────────────────────────────────────────────────── */

  /** Load File → grayscale ImageData at (W, H) */
  function loadFileAsGray(file, W, H) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = e => {
        const img = new Image();
        img.onload = () => {
          const cv = document.createElement('canvas');
          cv.width = W; cv.height = H;
          const ctx = cv.getContext('2d', { willReadFrequently: true });
          ctx.drawImage(img, 0, 0, W, H);
          const raw = ctx.getImageData(0, 0, W, H);
          const { g } = toGray(raw);
          resolve(grayToImageData(g, W, H, ctx));
        };
        img.onerror = reject;
        img.src = e.target.result;
      };
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
  }

  /** Yield control to the browser's render/event loop */
  function yieldToUI() { return new Promise(r => setTimeout(r, 0)); }

  /* ─────────────────────────────────────────────────────
     PUBLIC API
  ───────────────────────────────────────────────────── */
  return { encode, iterate, loadFileAsGray, psnr, toGray };

})();
