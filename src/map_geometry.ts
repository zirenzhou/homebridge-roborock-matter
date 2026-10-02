/**
 * Grid geometry for the map renderer: masks → outlines, and where to put a
 * label. Pure functions over the top-down grid (row 0 at the top), so the
 * renderer can draw clean vector shapes instead of enlarged pixels.
 */

export type Point = [number, number];
export type Loop = Point[];

/**
 * Trace every boundary of a binary mask along pixel edges. Each loop runs
 * with the filled side on its right (screen coordinates, y down), outer
 * boundaries and holes alike, so a non-zero fill of all loops of one mask
 * reproduces the mask exactly. Corners are pixel corners: (x, y) is the
 * top-left corner of pixel (x, y).
 */
export function traceMaskContours(
  mask: Uint8Array,
  width: number,
  height: number
): Loop[] {
  const filled = (x: number, y: number) =>
    x >= 0 && y >= 0 && x < width && y < height && mask[y * width + x] !== 0;

  // Directed edges keyed by their start corner. Directions: 0 right, 1 down,
  // 2 left, 3 up. Walking an edge keeps the filled pixel on the right.
  const stride = width + 1;
  const outgoing = new Map<number, number[]>();
  const add = (x: number, y: number, dir: number) => {
    const key = y * stride + x;
    const list = outgoing.get(key);
    const edge = key * 4 + dir;
    if (list) list.push(edge);
    else outgoing.set(key, [edge]);
  };

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (!filled(x, y)) continue;
      if (!filled(x, y - 1)) add(x, y, 0); // top side, left → right
      if (!filled(x + 1, y)) add(x + 1, y, 1); // right side, top → bottom
      if (!filled(x, y + 1)) add(x + 1, y + 1, 2); // bottom, right → left
      if (!filled(x - 1, y)) add(x, y + 1, 3); // left, bottom → top
    }
  }

  const DX = [1, 0, -1, 0];
  const DY = [0, 1, 0, -1];
  const used = new Set<number>();
  const loops: Loop[] = [];

  for (const [, starts] of outgoing) {
    for (const first of starts) {
      if (used.has(first)) continue;
      const loop: Loop = [];
      let edge = first;
      while (!used.has(edge)) {
        used.add(edge);
        const key = Math.floor(edge / 4);
        const dir = edge % 4;
        const x = key % stride;
        const y = Math.floor(key / stride);
        loop.push([x, y]);
        const nextKey = (y + DY[dir]) * stride + (x + DX[dir]);
        const candidates = (outgoing.get(nextKey) ?? []).filter(
          (candidate) => !used.has(candidate) || candidate === first
        );
        if (candidates.length === 0) break;
        // Where two pixels touch only at a corner, keep them apart: prefer
        // the right turn, then straight on, then the left turn.
        const preference = [(dir + 1) % 4, dir, (dir + 3) % 4];
        edge =
          preference
            .map((want) => candidates.find((c) => c % 4 === want))
            .find((c) => c !== undefined) ?? candidates[0];
      }
      if (loop.length >= 4) loops.push(removeCollinear(loop));
    }
  }
  return loops;
}

function removeCollinear(loop: Loop): Loop {
  const out: Loop = [];
  const n = loop.length;
  for (let i = 0; i < n; i++) {
    const [px, py] = loop[(i - 1 + n) % n];
    const [x, y] = loop[i];
    const [nx, ny] = loop[(i + 1) % n];
    if ((x - px) * (ny - y) - (y - py) * (nx - x) !== 0) out.push(loop[i]);
  }
  return out;
}

/**
 * Douglas–Peucker on a closed loop. Turns the staircase a diagonal wall makes
 * on the grid into one straight edge while keeping real corners, which sit
 * further than `epsilon` from any shortcut.
 */
export function simplifyLoop(loop: Loop, epsilon: number): Loop {
  if (loop.length <= 4) return loop;
  // Split at the two points furthest apart so the recursion has endpoints.
  let a = 0;
  let b = 0;
  let best = -1;
  for (let i = 0; i < loop.length; i++) {
    const d = dist2(loop[0], loop[i]);
    if (d > best) {
      best = d;
      b = i;
    }
  }
  best = -1;
  for (let i = 0; i < loop.length; i++) {
    const d = dist2(loop[b], loop[i]);
    if (d > best) {
      best = d;
      a = i;
    }
  }
  const [lo, hi] = a < b ? [a, b] : [b, a];
  const first = simplifyChain(loop.slice(lo, hi + 1), epsilon);
  const second = simplifyChain(
    [...loop.slice(hi), ...loop.slice(0, lo + 1)],
    epsilon
  );
  const result = [...first.slice(0, -1), ...second.slice(0, -1)];
  return result.length >= 3 ? result : loop;
}

function simplifyChain(points: Loop, epsilon: number): Loop {
  if (points.length <= 2) return points;
  const [ax, ay] = points[0];
  const [bx, by] = points[points.length - 1];
  const length = Math.hypot(bx - ax, by - ay) || 1;
  let index = -1;
  let furthest = 0;
  for (let i = 1; i < points.length - 1; i++) {
    const [px, py] = points[i];
    const d = Math.abs((bx - ax) * (ay - py) - (ax - px) * (by - ay)) / length;
    if (d > furthest) {
      furthest = d;
      index = i;
    }
  }
  if (furthest <= epsilon) return [points[0], points[points.length - 1]];
  const left = simplifyChain(points.slice(0, index + 1), epsilon);
  const right = simplifyChain(points.slice(index), epsilon);
  return [...left.slice(0, -1), ...right];
}

function dist2(a: Point, b: Point): number {
  return (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2;
}

/**
 * The pixel deepest inside a mask (largest distance to its edge), as the
 * centre of that pixel. A label placed there stays inside an L-shaped room,
 * where the centroid can fall in the neighbouring one.
 */
export function deepestPoint(
  mask: Uint8Array,
  width: number,
  height: number
): Point | null {
  const INF = 1 << 20;
  const d = new Int32Array(width * height);
  for (let i = 0; i < d.length; i++) d[i] = mask[i] ? INF : 0;

  // Two-pass chamfer (3-4) distance transform.
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      if (!d[i]) continue;
      let v = d[i];
      if (x > 0) v = Math.min(v, d[i - 1] + 3);
      else v = Math.min(v, 3);
      if (y > 0) {
        v = Math.min(v, d[i - width] + 3);
        if (x > 0) v = Math.min(v, d[i - width - 1] + 4);
        if (x < width - 1) v = Math.min(v, d[i - width + 1] + 4);
      } else v = Math.min(v, 3);
      d[i] = v;
    }
  }
  let best = -1;
  let bestIndex = -1;
  for (let y = height - 1; y >= 0; y--) {
    for (let x = width - 1; x >= 0; x--) {
      const i = y * width + x;
      if (!d[i]) continue;
      let v = d[i];
      if (x < width - 1) v = Math.min(v, d[i + 1] + 3);
      else v = Math.min(v, 3);
      if (y < height - 1) {
        v = Math.min(v, d[i + width] + 3);
        if (x < width - 1) v = Math.min(v, d[i + width + 1] + 4);
        if (x > 0) v = Math.min(v, d[i + width - 1] + 4);
      } else v = Math.min(v, 3);
      d[i] = v;
      if (v >= best) {
        best = v;
        bestIndex = i;
      }
    }
  }
  if (bestIndex < 0) return null;
  return [(bestIndex % width) + 0.5, Math.floor(bestIndex / width) + 0.5];
}
