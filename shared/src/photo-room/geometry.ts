/** Pure pinhole + line geometry for the photo solver. No DOM, no client. */

export function focalPxOf(focal35mm: number | undefined, w: number, h: number): number {
  const f35 = focal35mm ?? 26;
  return (f35 * Math.hypot(w, h)) / 43.27;
}

export interface LineFit {
  a: number;
  b: number;
  c: number;
  rmse: number;
}

function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/** Least-squares y = m x + b over points (for near-horizontal lines). */
function lsHoriz(pts: Array<[number, number]>): { m: number; b: number; rmse: number } {
  const n = pts.length;
  if (n < 2) return { m: 0, b: pts[0]?.[1] ?? 0, rmse: 0 };
  let sx = 0;
  let sy = 0;
  let sxx = 0;
  let sxy = 0;
  for (const [x, y] of pts) {
    sx += x;
    sy += y;
    sxx += x * x;
    sxy += x * y;
  }
  const denom = n * sxx - sx * sx;
  const m = denom === 0 ? 0 : (n * sxy - sx * sy) / denom;
  const b = (sy - m * sx) / n;
  let se = 0;
  for (const [x, y] of pts) {
    const e = y - (m * x + b);
    se += e * e;
  }
  return { m, b, rmse: Math.sqrt(se / n) };
}

/** Least-squares x = m y + b over points (for near-vertical lines). */
function lsVert(pts: Array<[number, number]>): { m: number; b: number; rmse: number } {
  const n = pts.length;
  if (n < 2) return { m: 0, b: pts[0]?.[0] ?? 0, rmse: 0 };
  let sy = 0;
  let sx = 0;
  let syy = 0;
  let syx = 0;
  for (const [x, y] of pts) {
    sy += y;
    sx += x;
    syy += y * y;
    syx += y * x;
  }
  const denom = n * syy - sy * sy;
  const m = denom === 0 ? 0 : (n * syx - sy * sx) / denom;
  const b = (sx - m * sy) / n;
  let se = 0;
  for (const [x, y] of pts) {
    const e = x - (m * y + b);
    se += e * e;
  }
  return { m, b, rmse: Math.sqrt(se / n) };
}

/**
 * RANSAC + least-squares refit. Horizontal fits y(x), vertical fits x(y).
 * Deterministic via a fixed LCG seed.
 */
export function fitLineRansac(
  pts: Array<[number, number]>,
  orientation: "horizontal" | "vertical",
  threshold = 2.5,
  iterations = 120,
): LineFit {
  if (pts.length < 2) {
    const p = pts[0] ?? [0, 0];
    if (orientation === "horizontal") return { a: 0, b: 1, c: -(p[1] ?? 0), rmse: 0 };
    return { a: 1, b: 0, c: -(p[0] ?? 0), rmse: 0 };
  }
  const rand = lcg(0x9e3779b9 + pts.length * 7919);
  let best: Array<[number, number]> = [];
  const residual = (p: [number, number], m: number, b: number): number =>
    orientation === "horizontal" ? Math.abs(p[1] - (m * p[0] + b)) : Math.abs(p[0] - (m * p[1] + b));
  for (let it = 0; it < iterations; it += 1) {
    const i = Math.floor(rand() * pts.length);
    const j = Math.floor(rand() * pts.length);
    if (i === j) continue;
    const p = pts[i] as [number, number];
    const q = pts[j] as [number, number];
    let m = 0;
    let b = 0;
    if (orientation === "horizontal") {
      if (q[0] === p[0]) continue;
      m = (q[1] - p[1]) / (q[0] - p[0]);
      b = p[1] - m * p[0];
    } else {
      if (q[1] === p[1]) continue;
      m = (q[0] - p[0]) / (q[1] - p[1]);
      b = p[0] - m * p[1];
    }
    const inliers = pts.filter((pt) => residual(pt, m, b) <= threshold);
    if (inliers.length > best.length) best = inliers;
  }
  const set = best.length >= 2 ? best : pts;
  if (orientation === "horizontal") {
    const { m, b, rmse } = lsHoriz(set);
    const n = Math.hypot(m, -1);
    return { a: m / n, b: -1 / n, c: b / n, rmse };
  }
  const { m, b, rmse } = lsVert(set);
  const n = Math.hypot(1, m);
  void n;
  // x - m y - b = 0
  const norm = Math.hypot(1, m);
  return { a: 1 / norm, b: -m / norm, c: -b / norm, rmse };
}

/** Intersection of two lines ax+by+c=0. */
export function intersect(l1: LineFit, l2: LineFit): [number, number] {
  const det = l1.a * l2.b - l2.a * l1.b;
  if (Math.abs(det) < 1e-9) return [NaN, NaN];
  const x = (l1.b * l2.c - l2.b * l1.c) / det;
  const y = (l2.a * l1.c - l1.a * l2.c) / det;
  return [x, y];
}

function cross(a: [number, number, number], b: [number, number, number]): [number, number, number] {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}

function dot(a: [number, number, number], b: [number, number, number]): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

/**
 * True width-to-height ratio from Zhang & He 2007, eq. 20.
 * m1 top-left, m2 top-right, m3 bottom-left, m4 bottom-right (pixels).
 */
export function widthHeightRatio(
  m1: [number, number],
  m2: [number, number],
  m3: [number, number],
  m4: [number, number],
  w: number,
  h: number,
  fPx: number,
): number {
  const u0 = w / 2;
  const v0 = h / 2;
  const t1: [number, number, number] = [m1[0], m1[1], 1];
  const t2: [number, number, number] = [m2[0], m2[1], 1];
  const t3: [number, number, number] = [m3[0], m3[1], 1];
  const t4: [number, number, number] = [m4[0], m4[1], 1];
  const c14 = cross(t1, t4);
  const c24 = cross(t2, t4);
  const c34 = cross(t3, t4);
  const k2 = dot(c14, t3) / dot(c24, t3);
  const k3 = dot(c14, t2) / dot(c34, t2);
  const n2: [number, number, number] = [
    k2 * t2[0] - t1[0],
    k2 * t2[1] - t1[1],
    k2 * t2[2] - t1[2],
  ];
  const n3: [number, number, number] = [
    k3 * t3[0] - t1[0],
    k3 * t3[1] - t1[1],
    k3 * t3[2] - t1[2],
  ];
  const num =
    (n2[0] - u0 * n2[2]) ** 2 + (n2[1] - v0 * n2[2]) ** 2 + fPx * fPx * n2[2] * n2[2];
  const den =
    (n3[0] - u0 * n3[2]) ** 2 + (n3[1] - v0 * n3[2]) ** 2 + fPx * fPx * n3[2] * n3[2];
  if (!(den > 0) || !(num >= 0)) return NaN;
  return Math.sqrt(num / den);
}

/** Solve 8x8 linear system via Gaussian elimination. */
function solve8(A: number[][], b: number[]): number[] {
  const n = 8;
  const M = A.map((row, i) => [...row, b[i] as number]);
  for (let col = 0; col < n; col += 1) {
    let piv = col;
    for (let r = col + 1; r < n; r += 1) {
      if (Math.abs(M[r]?.[col] as number) > Math.abs(M[piv]?.[col] as number)) piv = r;
    }
    const tmp = M[col] as number[];
    M[col] = M[piv] as number[];
    M[piv] = tmp;
    const diag = M[col]?.[col] as number;
    if (Math.abs(diag) < 1e-12) continue;
    for (let r = 0; r < n; r += 1) {
      if (r === col) continue;
      const factor = (M[r]?.[col] as number) / diag;
      for (let c = col; c <= n; c += 1) {
        M[r]![c] = (M[r]?.[c] as number) - factor * (M[col]?.[c] as number);
      }
    }
  }
  const x: number[] = [];
  for (let i = 0; i < n; i += 1) {
    const diag = M[i]?.[i] as number;
    x.push(Math.abs(diag) < 1e-12 ? 0 : ((M[i]?.[n] as number) / diag));
  }
  return x;
}

/**
 * Image -> wall homography. Image corners m1..m4 map to wall rectangle
 * (0,H),(W,H),(0,0),(W,0) where W is wall length cm and H wall height cm.
 * Returns 3x3 row-major; apply with perspective divide.
 */
export function wallHomography(
  m1: [number, number],
  m2: [number, number],
  m3: [number, number],
  m4: [number, number],
  wallLenCm: number,
  wallHeightCm: number,
): number[] {
  const src = [m1, m2, m3, m4];
  const dst: Array<[number, number]> = [
    [0, wallHeightCm],
    [wallLenCm, wallHeightCm],
    [0, 0],
    [wallLenCm, 0],
  ];
  const A: number[][] = [];
  const b: number[] = [];
  for (let i = 0; i < 4; i += 1) {
    const [x, y] = src[i] as [number, number];
    const [X, Y] = dst[i] as [number, number];
    A.push([x, y, 1, 0, 0, 0, -X * x, -X * y]);
    b.push(X);
    A.push([0, 0, 0, x, y, 1, -Y * x, -Y * y]);
    b.push(Y);
  }
  const h = solve8(A, b);
  return [h[0] as number, h[1] as number, h[2] as number, h[3] as number, h[4] as number, h[5] as number, h[6] as number, h[7] as number, 1];
}

/** Apply homography to an image point -> wall cm point. */
export function applyHomography(H: number[], x: number, y: number): [number, number] {
  const w = (H[6] as number) * x + (H[7] as number) * y + (H[8] as number);
  const X = ((H[0] as number) * x + (H[1] as number) * y + (H[2] as number)) / w;
  const Y = ((H[3] as number) * x + (H[4] as number) * y + (H[5] as number)) / w;
  return [X, Y];
}
