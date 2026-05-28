# Fractal IFS Image Compression

A browser-only demo of Jacquin/Barnsley-style **Iterated Function System (IFS)** image compression.

Upload a target image (e.g. an actress photo) — the encoder builds a set of self-similar contractive maps.  
Start from **any** image (e.g. your own photo) and watch it iterate toward the attractor.

---

## Quick start

```bash
git clone <this-repo>
cd fractal-ifs
# Open index.html in any modern browser — no server needed
open index.html          # macOS
xdg-open index.html      # Linux
start index.html         # Windows
```

No build step, no dependencies, no npm install. Pure HTML/CSS/JS.

---

## Files

```
fractal-ifs/
├── index.html   — app shell & layout
├── style.css    — full dark/light theme
├── ifs.js       — IFS encode + iterate engine (pure math)
└── ui.js        — DOM wiring, animation loop, export
```

---

## How it works

### Encoding (IFS construction)

1. Convert target image to grayscale Float32.
2. Partition into non-overlapping range blocks of size `blockSize × blockSize`.
3. For each range block, search all domain blocks (with stride step) across the image.
4. Fit brightness affine transform `g(v) = scale·v + offset` by least-squares.
5. Keep the domain block with lowest SSD. Store `{ rx, ry, dx, dy, scale, offset }`.

### Decoding / iteration

By Banach's contraction mapping theorem — repeated application from ANY starting image converges to the unique fixed point (attractor ≈ target):

```
x_{n+1} = W(x_n)
x_n → x*  as n → ∞  (regardless of x_0)
```

Typically converges in 8–15 iterations.

---

## Dashboard parameters

### Encoding
| Parameter | Values | Effect |
|-----------|--------|--------|
| Block size | 2 / 4 / 8 / 16 px | Smaller = finer quality, quadratically slower |
| Domain stride | 1 / 2 / 4 | 1 = exhaustive search, 4 = fast/rough |
| Brightness transform | Full / Offset-only | Full fits scale+offset; offset-only fixes scale=1 |

### Iteration
| Parameter | Values | Effect |
|-----------|--------|--------|
| Max iterations | 1–100 (slider) | Set high and watch convergence manually |
| Convergence threshold | Off / 0.01 / 0.1 / 0.5 dB | Auto-stop when ΔPSNR < threshold |
| Canvas size | 128 / 256 / 512 px | Resize on upload |

### Animation
| Parameter | Values | Effect |
|-----------|--------|--------|
| Mode | Forward / Bounce / Ping-pong | Forward plays once; bounce loops; ping-pong plays ↔ once |
| Frame delay | 30–800 ms | Animation speed |
| Overlay blend | Off / 20% / 40% | Ghost target over current iteration |

---

## Performance notes

- Block size 2 is very slow — use stride ≥ 2.
- Block size 4, stride 2 is the sweet-spot at 256 px.
- 512 px + block size 2 + stride 1 = research quality, expect minutes.

---

## JS API

```js
IFS.encode(tgtImgData, { blockSize, stride, brightMode, onProgress })
  → Promise<{ transforms, W, H, blockSize, encodeTime }>

IFS.iterate(srcImgData, tgtImgData, ifsResult, { maxIter, convThresh, onProgress })
  → Promise<{ frames, psnrs, convergedAt }>

IFS.loadFileAsGray(file, W, H)
  → Promise<ImageData>
```

---

## References

- Barnsley (1988). *Fractals Everywhere*.
- Jacquin (1992). Image coding based on fractal IFS. *IEEE Trans. Image Processing*.
- Fisher (1995). *Fractal Image Compression*. Springer.
