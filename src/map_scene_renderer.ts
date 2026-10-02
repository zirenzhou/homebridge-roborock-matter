/**
 * The map camera's picture, drawn the way the Roborock app draws its map, so
 * the camera tile and the app agree at a glance: a flat plan on a pale
 * backdrop, rooms in the app's four colours with neighbours always
 * different, tile and plank texture, the cleaned area washed white under a
 * fine white path, thin grey walls, numbered room badges, white obstacle
 * icons, the green dock and the white robot.
 *
 * Colours were sampled from the app (light mode). By night the same design is
 * drawn dark — same four colours, dimmed — so the tile is not a white
 * rectangle in a dark room.
 *
 * Drawn with Skia (@napi-rs/canvas, prebuilt, no compiler needed) and a
 * bundled CJK subset of Noto Sans SC for room names. Where neither loads,
 * renderSceneJpeg returns null and the camera falls back to the plain
 * pure-JavaScript renderer in map_renderer.ts.
 */

import path from "path";

import { ClassicMap, FLOOR_MATERIAL, MapObstacle } from "./map_renderer";
import {
  deepestPoint,
  Loop,
  simplifyLoop,
  traceMaskContours,
} from "./map_geometry";

const FONT_FAMILY = "RRMap Sans SC";
const MM_PER_PIXEL = 50;

let canvasLibrary: any | null | undefined;

/** Tests only: pretend Skia is (or is not) there. */
export function setCanvasLibraryForTests(
  library: any | null | undefined
): void {
  canvasLibrary = library;
}

/** Skia with the bundled fonts registered, or null where it cannot load. */
export function loadCanvasLibrary(): any | null {
  if (canvasLibrary !== undefined) {
    return canvasLibrary;
  }
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const library = require("@napi-rs/canvas");
    const fonts = path.join(__dirname, "..", "assets", "fonts");
    for (const file of ["RRMapSansSC-Medium.ttf", "RRMapSansSC-Bold.ttf"]) {
      library.GlobalFonts.registerFromPath(path.join(fonts, file), FONT_FAMILY);
    }
    canvasLibrary = library;
  } catch {
    canvasLibrary = null;
  }
  return canvasLibrary;
}

/**
 * 0 at night, 1 by day, easing through dawn (05:30–07:00) and dusk
 * (17:30–19:00) local time.
 */
export function daylightAt(date: Date): number {
  const hour = date.getHours() + date.getMinutes() / 60;
  const ease = (t: number) => t * t * (3 - 2 * t);
  if (hour < 5.5 || hour >= 19) return 0;
  if (hour < 7) return ease((hour - 5.5) / 1.5);
  if (hour < 17.5) return 1;
  return 1 - ease((hour - 17.5) / 1.5);
}

type Rgb = [number, number, number];

const hex = (value: string): Rgb => [
  parseInt(value.slice(1, 3), 16),
  parseInt(value.slice(3, 5), 16),
  parseInt(value.slice(5, 7), 16),
];

function mixRgb(a: Rgb, b: Rgb, t: number): Rgb {
  return [
    Math.round(a[0] + (b[0] - a[0]) * t),
    Math.round(a[1] + (b[1] - a[1]) * t),
    Math.round(a[2] + (b[2] - a[2]) * t),
  ];
}

const rgba = (color: Rgb, alpha = 1) =>
  `rgba(${color[0]},${color[1]},${color[2]},${alpha})`;

/** The app's four room colours, with the ink it uses on each. */
const ROOM_COLORS: { fill: Rgb; ink: Rgb }[] = [
  { fill: hex("#8cb6ec"), ink: hex("#25457a") }, // blue
  { fill: hex("#e9a185"), ink: hex("#7e4c4b") }, // coral
  { fill: hex("#6ce1da"), ink: hex("#255c52") }, // teal
  { fill: hex("#f7dc77"), ink: hex("#735a13") }, // yellow
];

type Palette = {
  backgroundTop: Rgb;
  backgroundBottom: Rgb;
  floor: Rgb;
  wall: Rgb;
  rooms: { fill: Rgb; ink: Rgb; badgeText: Rgb }[];
  cleanedAlpha: number;
  pathAlpha: number;
  textureAlpha: number;
  title: Rgb;
  subtitle: Rgb;
  iconFill: Rgb;
  iconGlyph: Rgb;
  iconRing: Rgb;
};

const LIGHT: Palette = {
  backgroundTop: hex("#e4eaf0"),
  backgroundBottom: hex("#eef0f2"),
  floor: hex("#d5dbe3"),
  wall: hex("#747a82"),
  rooms: ROOM_COLORS.map(({ fill, ink }) => ({
    fill,
    ink,
    badgeText: hex("#ffffff"),
  })),
  cleanedAlpha: 0.6,
  pathAlpha: 0.85,
  textureAlpha: 0.13,
  title: hex("#1c1d1f"),
  subtitle: hex("#5a5d60"),
  iconFill: hex("#ffffff"),
  iconGlyph: hex("#8e99a4"),
  iconRing: hex("#d9dee4"),
};

const DARK: Palette = {
  backgroundTop: hex("#15181d"),
  backgroundBottom: hex("#1c2026"),
  floor: hex("#2c323b"),
  wall: hex("#9aa1ab"),
  rooms: ROOM_COLORS.map(({ fill }) => ({
    fill: mixRgb(fill, hex("#14171c"), 0.45),
    ink: mixRgb(fill, hex("#ffffff"), 0.35),
    badgeText: hex("#14171c"),
  })),
  cleanedAlpha: 0.2,
  pathAlpha: 0.55,
  textureAlpha: 0.18,
  title: hex("#f2f3f5"),
  subtitle: hex("#a3a8b0"),
  iconFill: hex("#e8ebef"),
  iconGlyph: hex("#6b7480"),
  iconRing: hex("#3a414b"),
};

/** The palette for the time of day: light by day, dark by night. */
export function paletteFor(daylight: number): Palette {
  const t = Math.min(Math.max(daylight, 0), 1);
  if (t >= 0.999) return LIGHT;
  if (t <= 0.001) return DARK;
  const mix = <T>(a: T, b: T): T => {
    if (typeof a === "number") {
      return ((b as number) + ((a as number) - (b as number)) * t) as T;
    }
    if (Array.isArray(a) && typeof a[0] === "number") {
      return mixRgb(b as Rgb, a as Rgb, t) as T;
    }
    if (Array.isArray(a)) {
      return a.map((item, i) => mix(item, (b as unknown[])[i])) as T;
    }
    const out = {} as Record<string, unknown>;
    for (const key of Object.keys(a as object)) {
      out[key] = mix((a as any)[key], (b as any)[key]);
    }
    return out as T;
  };
  return mix(LIGHT, DARK);
}

// ---------------------------------------------------------------------------
// The scene.
// ---------------------------------------------------------------------------

export type SceneRoom = { id: number; name: string };

export type SceneStatus = {
  /** The robot's name. */
  title: string;
  /** What it is doing, e.g. "清扫中". */
  state: string;
  /** Where, e.g. the live room. */
  detail?: string | null;
  battery?: number | null;
  charging?: boolean;
  /** On a run: the rooms of the run are outlined. */
  active?: boolean;
};

export type SceneInput = {
  /** Null before the first map: the header and a note are drawn instead. */
  map: ClassicMap | null;
  rooms?: SceneRoom[];
  status?: SceneStatus | null;
  /** Picks day or night. */
  now?: Date;
  /** When the map was received, for "更新于" in the header. */
  updatedAt?: Date | null;
  /** Force a look instead of following the clock. */
  theme?: "auto" | "day" | "night";
  /**
   * Names for furniture type codes. The robot stores a code per piece and no
   * public source maps codes to names, so names appear only for codes listed
   * here.
   */
  furnitureNames?: Record<number, string>;
};

type RoomGeometry = {
  id: number;
  /** 1-based, by room id: the number on the app's badge. */
  number: number;
  /** Index into the four room colours. */
  color: number;
  loops: Loop[];
  anchor: [number, number];
  area: number;
};

type Geometry = {
  width: number;
  height: number;
  footprint: Loop[];
  floor: Loop[];
  walls: Loop[];
  rooms: RoomGeometry[];
  carpet: Loop[];
  /** Room id under each top-down grid pixel, 0 for none. */
  roomAt: Uint8Array;
};

/**
 * Four-colour the rooms so that neighbours differ, as the app does: rooms
 * that come within a wall's thickness of each other are neighbours, and the
 * most-connected rooms choose first.
 */
export function colourRooms(
  ids: number[],
  roomAt: Uint8Array,
  width: number,
  height: number
): Map<number, number> {
  const neighbours = new Map<number, Set<number>>(
    ids.map((id) => [id, new Set<number>()])
  );
  const reach = 3;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const a = roomAt[y * width + x];
      if (!a) continue;
      for (let d = 1; d <= reach; d++) {
        for (const [nx, ny] of [
          [x + d, y],
          [x, y + d],
        ]) {
          if (nx >= width || ny >= height) continue;
          const b = roomAt[ny * width + nx];
          if (b && b !== a) {
            neighbours.get(a)?.add(b);
            neighbours.get(b)?.add(a);
          }
        }
      }
    }
  }

  const order = [...ids].sort(
    (a, b) =>
      (neighbours.get(b)?.size ?? 0) - (neighbours.get(a)?.size ?? 0) || a - b
  );
  const colours = new Map<number, number>();
  for (const id of order) {
    const taken = new Set(
      [...(neighbours.get(id) ?? [])]
        .map((n) => colours.get(n))
        .filter((c) => c !== undefined)
    );
    let colour = 0;
    while (taken.has(colour) && colour < ROOM_COLORS.length - 1) colour++;
    colours.set(id, colour);
  }
  return colours;
}

/** Masks and outlines, top-down. Computed once per map. */
function buildGeometry(map: ClassicMap): Geometry {
  const { width, height, pixels } = map;
  const footprint = new Uint8Array(width * height);
  const floor = new Uint8Array(width * height);
  const walls = new Uint8Array(width * height);
  const roomAt = new Uint8Array(width * height);
  const roomCounts = new Map<number, number>();

  for (let rawRow = 0; rawRow < height; rawRow++) {
    const row = height - 1 - rawRow;
    for (let x = 0; x < width; x++) {
      const byte = pixels[rawRow * width + x];
      if (byte === 0) continue;
      const i = row * width + x;
      footprint[i] = 1;
      const low = byte & 0x07;
      if (byte === 0x01 || (byte !== 0xff && byte !== 0x07 && low <= 1)) {
        walls[i] = 1;
      } else {
        floor[i] = 1;
        if (byte !== 0xff && byte !== 0x07 && low === 7) {
          const id = byte >> 3;
          roomAt[i] = id;
          roomCounts.set(id, (roomCounts.get(id) ?? 0) + 1);
        }
      }
    }
  }

  const outline = (mask: Uint8Array, epsilon: number) =>
    traceMaskContours(mask, width, height).map((loop) =>
      simplifyLoop(loop, epsilon)
    );

  let carpet: Loop[] = [];
  if (map.carpet && map.carpet.length >= width * height) {
    const mask = new Uint8Array(width * height);
    for (let rawRow = 0; rawRow < height; rawRow++) {
      const row = height - 1 - rawRow;
      for (let x = 0; x < width; x++) {
        const i = rawRow * width + x;
        if (map.carpet[i] & 0x01 && pixels[i] !== 0) mask[row * width + x] = 1;
      }
    }
    carpet = outline(mask, 0.8);
  }

  // Furniture, rasterised, so a room's label goes on open floor rather than
  // on top of the bed.
  const occupied = new Uint8Array(width * height);
  for (const piece of map.furniture) {
    const corners = furnitureCorners(map, piece.corners);
    const xs = corners.map((c) => c[0]);
    const ys = corners.map((c) => c[1]);
    for (
      let y = Math.max(0, Math.floor(Math.min(...ys)));
      y < Math.min(height, Math.ceil(Math.max(...ys)));
      y++
    ) {
      for (
        let x = Math.max(0, Math.floor(Math.min(...xs)));
        x < Math.min(width, Math.ceil(Math.max(...xs)));
        x++
      ) {
        if (insidePolygon(corners, x + 0.5, y + 0.5))
          occupied[y * width + x] = 1;
      }
    }
  }

  const ids = [...roomCounts.keys()].sort((a, b) => a - b);
  const colours = colourRooms(ids, roomAt, width, height);
  const rooms = ids.map((id, index) => {
    const mask = new Uint8Array(width * height);
    for (let i = 0; i < mask.length; i++) if (roomAt[i] === id) mask[i] = 1;
    // Grow each room into the walls around it so neighbouring fills meet
    // under the wall instead of leaving a hairline of floor colour.
    const grown = new Uint8Array(mask);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        if (!mask[y * width + x]) continue;
        for (const [dx, dy] of [
          [1, 0],
          [-1, 0],
          [0, 1],
          [0, -1],
        ]) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
          const j = ny * width + nx;
          if (walls[j]) grown[j] = 1;
        }
      }
    }
    const open = new Uint8Array(mask);
    for (let i = 0; i < open.length; i++) if (occupied[i]) open[i] = 0;
    return {
      id,
      number: index + 1,
      color: colours.get(id) ?? 0,
      loops: outline(grown, 0.65),
      anchor:
        deepestPoint(open, width, height) ??
        deepestPoint(mask, width, height) ??
        ([0, 0] as [number, number]),
      area: ((roomCounts.get(id) ?? 0) * MM_PER_PIXEL * MM_PER_PIXEL) / 1e6,
    };
  });

  return {
    width,
    height,
    footprint: outline(footprint, 0.65),
    floor: outline(floor, 0.65),
    walls: outline(walls, 0.75),
    rooms,
    carpet,
    roomAt,
  };
}

const geometryCache = new WeakMap<ClassicMap, Geometry>();

function geometryOf(map: ClassicMap): Geometry {
  let geometry = geometryCache.get(map);
  if (!geometry) {
    geometry = buildGeometry(map);
    geometryCache.set(map, geometry);
  }
  return geometry;
}

/** Millimetres → top-down grid units. */
function toGrid(map: ClassicMap, x: number, y: number): [number, number] {
  return [
    x / MM_PER_PIXEL - map.left,
    map.height - (y / MM_PER_PIXEL - map.top),
  ];
}

/** Bounds of everything drawn, in top-down grid units. */
function boundsOf(map: ClassicMap, geometry: Geometry) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const loop of geometry.footprint) {
    for (const [x, y] of loop) {
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    }
  }
  for (const point of [map.robot, map.charger]) {
    if (!point) continue;
    const [x, y] = toGrid(map, point.x, point.y);
    minX = Math.min(minX, x - 5);
    minY = Math.min(minY, y - 5);
    maxX = Math.max(maxX, x + 5);
    maxY = Math.max(maxY, y + 5);
  }
  if (!Number.isFinite(minX)) {
    return { minX: 0, minY: 0, maxX: map.width, maxY: map.height };
  }
  return { minX, minY, maxX, maxY };
}

function tracePath(ctx: any, loops: Loop[]): void {
  ctx.beginPath();
  for (const loop of loops) {
    loop.forEach(([x, y], i) =>
      i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)
    );
    ctx.closePath();
  }
}

/**
 * Draw the map as a JPEG, or return null when Skia is not available (the
 * caller then uses the plain renderer).
 */
export function renderSceneJpeg(
  input: SceneInput,
  width: number,
  height: number,
  quality = 88
): Buffer | null {
  const library = loadCanvasLibrary();
  if (!library) {
    return null;
  }

  const { map } = input;
  const now = input.now ?? new Date();
  const daylight =
    input.theme === "day" ? 1 : input.theme === "night" ? 0 : daylightAt(now);
  const palette = paletteFor(daylight);

  const canvas = library.createCanvas(width, height);
  const ctx = canvas.getContext("2d");
  const unit = Math.min(width, height) / 100;
  const compact = width < 900;

  const background = ctx.createLinearGradient(0, 0, 0, height);
  background.addColorStop(0, rgba(palette.backgroundTop));
  background.addColorStop(1, rgba(palette.backgroundBottom));
  ctx.fillStyle = background;
  ctx.fillRect(0, 0, width, height);

  if (!map) {
    if (input.status) {
      drawHeader(ctx, input.status, palette, width, unit, null, compact);
    }
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillStyle = rgba(palette.subtitle);
    ctx.font = `500 ${Math.max(13, unit * (compact ? 4.6 : 3.4))}px "${FONT_FAMILY}"`;
    ctx.fillText("扫地机下次清扫后显示地图", width / 2, height * 0.56);
    return canvas.toBuffer("image/jpeg", quality);
  }
  const geometry = geometryOf(map);

  // Fit the plan below the header.
  const headerHeight = input.status ? unit * (compact ? 15 : 13) : 0;
  const padding = unit * 5;
  const bounds = boundsOf(map, geometry);
  const spanX = bounds.maxX - bounds.minX;
  const spanY = bounds.maxY - bounds.minY;
  const availableW = width - padding * 2;
  const availableH = height - padding * 2 - headerHeight;
  const scale = Math.max(
    Math.min(availableW / spanX, availableH / spanY),
    0.05
  );
  const offsetX = (width - spanX * scale) / 2 - bounds.minX * scale;
  const offsetY =
    headerHeight +
    padding +
    (availableH - spanY * scale) / 2 -
    bounds.minY * scale;

  const project = (gx: number, gy: number): [number, number] => [
    offsetX + gx * scale,
    offsetY + gy * scale,
  ];
  const onPlan = () => ctx.setTransform(scale, 0, 0, scale, offsetX, offsetY);
  const flat = () => ctx.setTransform(1, 0, 0, 1, 0, 0);
  const px = (screen: number) => screen / scale;

  // Floor, then rooms in their colours with their floor texture.
  onPlan();
  ctx.fillStyle = rgba(palette.floor);
  tracePath(ctx, geometry.floor);
  ctx.fill("nonzero");
  for (const room of geometry.rooms) {
    const colour = palette.rooms[room.color];
    ctx.fillStyle = rgba(colour.fill);
    tracePath(ctx, room.loops);
    ctx.fill("nonzero");
    drawFloorTexture(ctx, map, room, colour.ink, palette.textureAlpha, px);
  }
  drawCarpet(ctx, geometry, palette, px);
  drawFurniture(ctx, map, geometry, palette, px);

  // The cleaned area: the path widened to the robot's width and washed white,
  // with the path itself as a fine white line on top.
  drawPath(ctx, map, palette, px);
  drawZones(ctx, map, px);

  // Walls on top of everything on the floor.
  ctx.fillStyle = rgba(palette.wall);
  tracePath(ctx, geometry.walls);
  ctx.fill("nonzero");

  if (input.status?.active && map.cleanedRooms.length > 0) {
    drawRunScope(ctx, geometry, map.cleanedRooms, palette, px);
  }

  flat();
  drawVirtualWalls(ctx, map, project, unit);
  drawObstacles(ctx, map, palette, project, unit);
  drawDock(ctx, map, project, scale, unit);
  drawRobot(ctx, map, project, scale, unit);
  drawRoomLabels(
    ctx,
    geometry,
    input.rooms ?? [],
    palette,
    project,
    unit,
    compact
  );
  drawFurnitureLabels(
    ctx,
    map,
    geometry,
    palette,
    project,
    unit,
    compact,
    input.furnitureNames
  );
  if (input.status) {
    drawHeader(
      ctx,
      input.status,
      palette,
      width,
      unit,
      input.updatedAt ?? null,
      compact
    );
  }

  return canvas.toBuffer("image/jpeg", quality);
}

/** Wood planks along the room's direction, or a tile grid, inside the room. */
function drawFloorTexture(
  ctx: any,
  map: ClassicMap,
  room: RoomGeometry,
  ink: Rgb,
  alpha: number,
  px: (screen: number) => number
): void {
  const material = map.floorMaterials.get(room.id);
  if (material !== FLOOR_MATERIAL.WOOD && material !== FLOOR_MATERIAL.TILE) {
    return;
  }
  const xs = room.loops.flatMap((loop) => loop.map((p) => p[0]));
  const ys = room.loops.flatMap((loop) => loop.map((p) => p[1]));
  const x0 = Math.min(...xs);
  const x1 = Math.max(...xs);
  const y0 = Math.min(...ys);
  const y1 = Math.max(...ys);

  ctx.save();
  tracePath(ctx, room.loops);
  ctx.clip("nonzero");
  ctx.strokeStyle = rgba(ink, alpha);
  ctx.lineWidth = px(1);

  if (material === FLOOR_MATERIAL.TILE) {
    // 30 cm tiles.
    const step = 6;
    ctx.beginPath();
    for (let x = Math.ceil(x0 / step) * step; x < x1; x += step) {
      ctx.moveTo(x, y0);
      ctx.lineTo(x, y1);
    }
    for (let y = Math.ceil(y0 / step) * step; y < y1; y += step) {
      ctx.moveTo(x0, y);
      ctx.lineTo(x1, y);
    }
    ctx.stroke();
    ctx.restore();
    return;
  }

  // Planks 25 cm wide along the stored direction, joints staggered.
  const degrees = map.floorDirections.get(room.id) ?? 0;
  const vertical = Math.round(degrees / 90) % 2 === 1;
  const plank = 5;
  const length = 30;
  ctx.beginPath();
  if (vertical) {
    for (
      let x = Math.ceil(x0 / plank) * plank, n = 0;
      x < x1;
      x += plank, n++
    ) {
      ctx.moveTo(x, y0);
      ctx.lineTo(x, y1);
      for (let y = y0 + ((n * 11) % length); y < y1; y += length) {
        ctx.moveTo(x, y);
        ctx.lineTo(x + plank, y);
      }
    }
  } else {
    for (
      let y = Math.ceil(y0 / plank) * plank, n = 0;
      y < y1;
      y += plank, n++
    ) {
      ctx.moveTo(x0, y);
      ctx.lineTo(x1, y);
      for (let x = x0 + ((n * 11) % length); x < x1; x += length) {
        ctx.moveTo(x, y);
        ctx.lineTo(x, y + plank);
      }
    }
  }
  ctx.stroke();
  ctx.restore();
}

function drawCarpet(
  ctx: any,
  geometry: Geometry,
  palette: Palette,
  px: (screen: number) => number
): void {
  if (geometry.carpet.length === 0) return;
  ctx.save();
  tracePath(ctx, geometry.carpet);
  ctx.clip("nonzero");
  // Cross-hatching, as the app marks a rug.
  const xs = geometry.carpet.flatMap((loop) => loop.map((p) => p[0]));
  const ys = geometry.carpet.flatMap((loop) => loop.map((p) => p[1]));
  const x0 = Math.min(...xs);
  const x1 = Math.max(...xs);
  const y0 = Math.min(...ys);
  const y1 = Math.max(...ys);
  ctx.strokeStyle = rgba(palette.rooms[0].ink, palette.textureAlpha * 1.6);
  ctx.lineWidth = px(1);
  ctx.beginPath();
  const span = y1 - y0;
  for (let k = x0 - span; k < x1 + span; k += 2) {
    ctx.moveTo(k, y0);
    ctx.lineTo(k + span, y1);
    ctx.moveTo(k, y1);
    ctx.lineTo(k + span, y0);
  }
  ctx.stroke();
  ctx.restore();
}

/** Furniture as a darker, rounded patch of the room it stands in. */
function drawFurniture(
  ctx: any,
  map: ClassicMap,
  geometry: Geometry,
  palette: Palette,
  px: (screen: number) => number
): void {
  for (const piece of map.furniture) {
    const corners = furnitureCorners(map, piece.corners);
    const ink = inkUnder(geometry, palette, corners);
    ctx.save();
    roundedPolygon(ctx, corners, 1.2);
    ctx.fillStyle = rgba(ink, 0.18);
    ctx.fill();
    ctx.strokeStyle = rgba(ink, 0.28);
    ctx.lineWidth = px(1.2);
    ctx.stroke();
    ctx.restore();
  }
}

function furnitureCorners(
  map: ClassicMap,
  corners: number[]
): [number, number][] {
  const points: [number, number][] = [];
  for (let i = 0; i + 1 < corners.length; i += 2) {
    points.push(toGrid(map, corners[i], corners[i + 1]));
  }
  return points;
}

function insidePolygon(
  points: [number, number][],
  px: number,
  py: number
): boolean {
  let inside = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const [xi, yi] = points[i];
    const [xj, yj] = points[j];
    if (yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

/** The ink of the room a shape stands in. */
function inkUnder(
  geometry: Geometry,
  palette: Palette,
  points: [number, number][]
): Rgb {
  const cx = points.reduce((s, p) => s + p[0], 0) / points.length;
  const cy = points.reduce((s, p) => s + p[1], 0) / points.length;
  const x = Math.floor(cx);
  const y = Math.floor(cy);
  const id =
    x >= 0 && y >= 0 && x < geometry.width && y < geometry.height
      ? geometry.roomAt[y * geometry.width + x]
      : 0;
  const room = geometry.rooms.find((r) => r.id === id);
  return room ? palette.rooms[room.color].ink : palette.subtitle;
}

function roundedPolygon(ctx: any, points: [number, number][], r: number): void {
  ctx.beginPath();
  const n = points.length;
  for (let i = 0; i < n; i++) {
    const prev = points[(i - 1 + n) % n];
    const curr = points[i];
    const next = points[(i + 1) % n];
    if (i === 0) ctx.moveTo((prev[0] + curr[0]) / 2, (prev[1] + curr[1]) / 2);
    ctx.arcTo(curr[0], curr[1], next[0], next[1], r);
  }
  ctx.closePath();
}

function drawPath(
  ctx: any,
  map: ClassicMap,
  palette: Palette,
  px: (screen: number) => number
): void {
  if (map.path.length < 2) return;
  const points = map.path.map(([x, y]) => toGrid(map, x, y));
  const line = () => {
    ctx.beginPath();
    points.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
  };
  ctx.save();
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  // The cleaned area, 35 cm wide — the robot's own width. One stroke of one
  // path, so overlapping passes do not stack up to opaque white.
  ctx.strokeStyle = `rgba(255,255,255,${palette.cleanedAlpha})`;
  ctx.lineWidth = 7;
  line();
  ctx.stroke();
  ctx.strokeStyle = `rgba(255,255,255,${palette.pathAlpha})`;
  ctx.lineWidth = px(1.1);
  line();
  ctx.stroke();
  ctx.restore();
}

function drawZones(
  ctx: any,
  map: ClassicMap,
  px: (screen: number) => number
): void {
  const zones: [number[][], Rgb][] = [
    [map.noMopZones, hex("#3b8cff")],
    [map.noGoZones, hex("#ea6a51")],
  ];
  ctx.save();
  for (const [list, color] of zones) {
    for (const zone of list) {
      ctx.beginPath();
      for (let i = 0; i + 1 < zone.length; i += 2) {
        const [x, y] = toGrid(map, zone[i], zone[i + 1]);
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.closePath();
      ctx.fillStyle = rgba(color, 0.22);
      ctx.fill();
      ctx.strokeStyle = rgba(color, 0.95);
      ctx.lineWidth = px(1.5);
      ctx.stroke();
    }
  }
  ctx.restore();
}

/** Virtual walls: a red line with the app's round "no entry" ends. */
function drawVirtualWalls(
  ctx: any,
  map: ClassicMap,
  project: (gx: number, gy: number) => [number, number],
  unit: number
): void {
  const red = hex("#ea6a51");
  for (const [x0, y0, x1, y1] of map.virtualWalls) {
    const a = project(...toGrid(map, x0, y0));
    const b = project(...toGrid(map, x1, y1));
    ctx.strokeStyle = rgba(red);
    ctx.lineWidth = Math.max(2, unit * 0.5);
    ctx.lineCap = "butt";
    ctx.beginPath();
    ctx.moveTo(a[0], a[1]);
    ctx.lineTo(b[0], b[1]);
    ctx.stroke();
    const r = Math.max(4, unit * 1.05);
    for (const [x, y] of [a, b]) {
      ctx.fillStyle = rgba(red);
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = "rgba(255,255,255,1)";
      ctx.lineWidth = Math.max(1.2, r * 0.3);
      ctx.beginPath();
      ctx.moveTo(x - r * 0.5, y);
      ctx.lineTo(x + r * 0.5, y);
      ctx.stroke();
    }
  }
}

/** The rooms of the current run, outlined in their own ink. */
function drawRunScope(
  ctx: any,
  geometry: Geometry,
  roomIds: number[],
  palette: Palette,
  px: (screen: number) => number
): void {
  const scope = new Set(roomIds);
  for (const room of geometry.rooms) {
    if (!scope.has(room.id)) continue;
    ctx.save();
    tracePath(ctx, room.loops);
    ctx.clip("nonzero");
    ctx.strokeStyle = rgba(palette.rooms[room.color].ink, 0.55);
    ctx.lineWidth = px(5);
    tracePath(ctx, room.loops);
    ctx.stroke();
    ctx.restore();
  }
}

/** The dock: the app's green rounded square with a house. */
function drawDock(
  ctx: any,
  map: ClassicMap,
  project: (gx: number, gy: number) => [number, number],
  scale: number,
  unit: number
): void {
  if (!map.charger) return;
  const [cx, cy] = project(...toGrid(map, map.charger.x, map.charger.y));
  const s = Math.max(unit * 2.6, scale * 6);
  ctx.save();
  ctx.fillStyle = "rgba(76,195,138,1)";
  roundRect(ctx, cx - s / 2, cy - s / 2, s, s, s * 0.22);
  ctx.fill();
  ctx.strokeStyle = "rgba(255,255,255,0.9)";
  ctx.lineWidth = Math.max(1, s * 0.06);
  ctx.stroke();
  const g = s * 0.28;
  ctx.fillStyle = "rgba(255,255,255,1)";
  ctx.beginPath();
  ctx.moveTo(cx, cy - g);
  ctx.lineTo(cx + g, cy - g * 0.1);
  ctx.lineTo(cx + g * 0.72, cy - g * 0.1);
  ctx.lineTo(cx + g * 0.72, cy + g * 0.85);
  ctx.lineTo(cx - g * 0.72, cy + g * 0.85);
  ctx.lineTo(cx - g * 0.72, cy - g * 0.1);
  ctx.lineTo(cx - g, cy - g * 0.1);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

/** The robot from above: a white disc, a grey rim, the LiDAR cap. */
function drawRobot(
  ctx: any,
  map: ClassicMap,
  project: (gx: number, gy: number) => [number, number],
  scale: number,
  unit: number
): void {
  if (!map.robot) return;
  const [cx, cy] = project(...toGrid(map, map.robot.x, map.robot.y));
  const r = Math.max(unit * 1.5, scale * 3.5);
  const rim = hex("#c3c8ce");
  ctx.save();
  ctx.shadowColor = "rgba(0,0,0,0.18)";
  ctx.shadowBlur = r * 0.5;
  ctx.shadowOffsetY = r * 0.12;
  ctx.fillStyle = "rgba(255,255,255,1)";
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fill();
  ctx.shadowColor = "rgba(0,0,0,0)";
  ctx.strokeStyle = rgba(rim);
  ctx.lineWidth = Math.max(1, r * 0.1);
  ctx.stroke();
  const angle = ((map.robot.angle ?? 90) * Math.PI) / 180;
  const fx = Math.cos(angle);
  const fy = -Math.sin(angle);
  ctx.fillStyle = rgba(hex("#d7dbe0"));
  ctx.beginPath();
  ctx.arc(cx - fx * r * 0.18, cy - fy * r * 0.18, r * 0.36, 0, Math.PI * 2);
  ctx.fill();
  // The bumper: the robot's front.
  ctx.strokeStyle = rgba(rim);
  ctx.lineWidth = Math.max(1, r * 0.12);
  const heading = Math.atan2(fy, fx);
  ctx.beginPath();
  ctx.arc(cx, cy, r * 0.78, heading - 0.9, heading + 0.9);
  ctx.stroke();
  ctx.restore();
}

type ObstacleGlyph = "shoe" | "cable" | "pet" | "poop" | "dot";

/**
 * What the robot's obstacle recognition calls things. Codes from
 * vacuum-map-parser-roborock and Valetudo, names as the Roborock app uses
 * them; anything else is a generic obstacle.
 */
export const OBSTACLE_TYPES: Record<
  number,
  { name: string; glyph: ObstacleGlyph }
> = {
  0: { name: "线类", glyph: "cable" },
  48: { name: "线团", glyph: "cable" },
  1: { name: "宠物便便", glyph: "poop" },
  2: { name: "鞋子", glyph: "shoe" },
  3: { name: "底座", glyph: "dot" },
  4: { name: "底座", glyph: "dot" },
  5: { name: "插线板", glyph: "cable" },
  9: { name: "体重秤", glyph: "dot" },
  10: { name: "织物", glyph: "dot" },
  34: { name: "织物", glyph: "dot" },
  25: { name: "簸箕", glyph: "dot" },
  26: { name: "易卡家具", glyph: "dot" },
  27: { name: "易卡家具", glyph: "dot" },
  49: { name: "猫", glyph: "pet" },
  50: { name: "狗", glyph: "pet" },
  51: { name: "纸团", glyph: "dot" },
};

export function obstacleName(obstacle: Pick<MapObstacle, "type">): string {
  return OBSTACLE_TYPES[obstacle.type]?.name ?? "障碍物";
}

/** Obstacles as the app shows them: a white disc with a grey glyph. */
function drawObstacles(
  ctx: any,
  map: ClassicMap,
  palette: Palette,
  project: (gx: number, gy: number) => [number, number],
  unit: number
): void {
  const r = Math.max(6, unit * 1.45);
  for (const obstacle of map.obstacles) {
    const [x, y] = project(...toGrid(map, obstacle.x, obstacle.y));
    ctx.save();
    ctx.shadowColor = "rgba(0,0,0,0.12)";
    ctx.shadowBlur = r * 0.4;
    ctx.fillStyle = rgba(palette.iconFill);
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.shadowColor = "rgba(0,0,0,0)";
    ctx.strokeStyle = rgba(palette.iconRing);
    ctx.lineWidth = Math.max(0.8, r * 0.08);
    ctx.stroke();
    drawGlyph(
      ctx,
      OBSTACLE_TYPES[obstacle.type]?.glyph ?? "dot",
      x,
      y,
      r * 0.6,
      palette.iconGlyph
    );
    ctx.restore();
  }
}

function drawGlyph(
  ctx: any,
  glyph: ObstacleGlyph,
  x: number,
  y: number,
  s: number,
  color: Rgb
): void {
  ctx.save();
  ctx.fillStyle = rgba(color);
  ctx.strokeStyle = rgba(color);
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  switch (glyph) {
    case "shoe":
      // A slipper in profile: sole, toe cap, heel.
      ctx.beginPath();
      ctx.moveTo(x - s * 0.95, y + s * 0.45);
      ctx.lineTo(x + s * 0.75, y + s * 0.45);
      ctx.quadraticCurveTo(
        x + s * 1.05,
        y + s * 0.4,
        x + s * 0.95,
        y + s * 0.1
      );
      ctx.quadraticCurveTo(
        x + s * 0.55,
        y - s * 0.05,
        x + s * 0.1,
        y - s * 0.35
      );
      ctx.lineTo(x - s * 0.55, y - s * 0.45);
      ctx.quadraticCurveTo(
        x - s * 0.95,
        y - s * 0.3,
        x - s * 0.95,
        y + s * 0.45
      );
      ctx.closePath();
      ctx.fill();
      break;
    case "cable":
      ctx.lineWidth = s * 0.26;
      ctx.beginPath();
      ctx.moveTo(x - s * 0.9, y + s * 0.2);
      ctx.bezierCurveTo(
        x - s * 0.5,
        y - s * 0.8,
        x,
        y + s * 0.8,
        x + s * 0.4,
        y - s * 0.1
      );
      ctx.quadraticCurveTo(
        x + s * 0.65,
        y - s * 0.55,
        x + s * 0.9,
        y - s * 0.2
      );
      ctx.stroke();
      break;
    case "poop":
      ctx.beginPath();
      ctx.ellipse(x, y + s * 0.45, s * 0.75, s * 0.28, 0, 0, Math.PI * 2);
      ctx.ellipse(x, y + s * 0.05, s * 0.52, s * 0.24, 0, 0, Math.PI * 2);
      ctx.ellipse(x, y - s * 0.32, s * 0.3, s * 0.2, 0, 0, Math.PI * 2);
      ctx.fill();
      break;
    case "pet":
      ctx.beginPath();
      ctx.ellipse(x, y + s * 0.3, s * 0.42, s * 0.34, 0, 0, Math.PI * 2);
      ctx.fill();
      for (const [dx, dy] of [
        [-0.55, -0.15],
        [-0.2, -0.5],
        [0.2, -0.5],
        [0.55, -0.15],
      ]) {
        ctx.beginPath();
        ctx.arc(x + dx * s, y + dy * s, s * 0.17, 0, Math.PI * 2);
        ctx.fill();
      }
      break;
    default:
      ctx.beginPath();
      ctx.arc(x, y, s * 0.3, 0, Math.PI * 2);
      ctx.fill();
  }
  ctx.restore();
}

/** Room labels as the app sets them: a numbered badge, then the name. */
function drawRoomLabels(
  ctx: any,
  geometry: Geometry,
  rooms: SceneRoom[],
  palette: Palette,
  project: (gx: number, gy: number) => [number, number],
  unit: number,
  compact: boolean
): void {
  const names = new Map(rooms.map((room) => [room.id, room.name]));
  const size = compact ? Math.max(12, unit * 4) : Math.max(12, unit * 2.9);
  const badge = size * 0.62;
  for (const room of geometry.rooms) {
    const name = names.get(room.id) ?? "";
    const { ink, badgeText } = palette.rooms[room.color];
    const [ax, ay] = project(room.anchor[0], room.anchor[1]);

    ctx.font = `500 ${size}px "${FONT_FAMILY}"`;
    const nameWidth = name ? ctx.measureText(name).width : 0;
    const gap = name ? size * 0.28 : 0;
    const left = ax - (badge * 2 + gap + nameWidth) / 2;

    ctx.fillStyle = rgba(ink);
    ctx.beginPath();
    ctx.arc(left + badge, ay, badge, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = rgba(badgeText);
    ctx.font = `700 ${badge * 1.15}px "${FONT_FAMILY}"`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(String(room.number), left + badge, ay + badge * 0.06);

    if (name) {
      ctx.fillStyle = rgba(ink);
      ctx.font = `500 ${size}px "${FONT_FAMILY}"`;
      ctx.textAlign = "left";
      ctx.fillText(name, left + badge * 2 + gap, ay + size * 0.04);
    }
  }
}

function drawFurnitureLabels(
  ctx: any,
  map: ClassicMap,
  geometry: Geometry,
  palette: Palette,
  project: (gx: number, gy: number) => [number, number],
  unit: number,
  compact: boolean,
  names?: Record<number, string>
): void {
  if (!names || compact) return;
  const size = Math.max(10, unit * 2.1);
  for (const piece of map.furniture) {
    const name = names[piece.type];
    if (!name) continue;
    const corners = furnitureCorners(map, piece.corners);
    const ink = inkUnder(geometry, palette, corners);
    const [x, y] = project(
      corners.reduce((s, p) => s + p[0], 0) / corners.length,
      corners.reduce((s, p) => s + p[1], 0) / corners.length
    );
    ctx.font = `500 ${size}px "${FONT_FAMILY}"`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillStyle = rgba(ink, 0.75);
    ctx.fillText(name, x, y);
  }
}

/** The app's header: the robot's name, then battery and state. */
function drawHeader(
  ctx: any,
  status: SceneStatus,
  palette: Palette,
  width: number,
  unit: number,
  updatedAt: Date | null,
  compact: boolean
): void {
  const size = compact ? Math.max(14, unit * 5.2) : Math.max(14, unit * 4.4);
  const x = unit * 4.5;
  const top = unit * 4;

  ctx.textAlign = "left";
  ctx.textBaseline = "alphabetic";
  ctx.fillStyle = rgba(palette.title);
  ctx.font = `700 ${size}px "${FONT_FAMILY}"`;
  ctx.fillText(status.title, x, top + size * 0.95);

  const line = top + size * 2.05;
  const small = size * 0.6;
  let cursor = x;
  if (typeof status.battery === "number") {
    if (status.charging) {
      const b = small * 0.62;
      ctx.fillStyle = "rgba(95,197,101,1)";
      ctx.beginPath();
      ctx.moveTo(cursor + b * 0.6, line - small * 0.95);
      ctx.lineTo(cursor, line - small * 0.25);
      ctx.lineTo(cursor + b * 0.5, line - small * 0.25);
      ctx.lineTo(cursor + b * 0.3, line + small * 0.18);
      ctx.lineTo(cursor + b * 1.0, line - small * 0.5);
      ctx.lineTo(cursor + b * 0.5, line - small * 0.5);
      ctx.closePath();
      ctx.fill();
      cursor += b * 1.5;
    }
    ctx.fillStyle = rgba(palette.subtitle);
    ctx.font = `500 ${small}px "${FONT_FAMILY}"`;
    const battery = `${Math.round(status.battery)}%`;
    ctx.fillText(battery, cursor, line);
    cursor += ctx.measureText(battery).width + small * 1.4;
  }
  ctx.fillStyle = rgba(palette.subtitle);
  ctx.font = `500 ${small}px "${FONT_FAMILY}"`;
  const state = status.detail
    ? `${status.state} · ${status.detail}`
    : status.state;
  ctx.fillText(state, cursor, line);

  if (!compact && updatedAt) {
    const clock = `${String(updatedAt.getHours()).padStart(2, "0")}:${String(
      updatedAt.getMinutes()
    ).padStart(2, "0")}`;
    ctx.textAlign = "right";
    ctx.fillStyle = rgba(palette.subtitle);
    ctx.font = `500 ${small * 0.9}px "${FONT_FAMILY}"`;
    ctx.fillText(`更新于 ${clock}`, width - x, top + size * 0.95);
  }
}

function roundRect(
  ctx: any,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number
): void {
  const radius = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.arcTo(x + w, y, x + w, y + h, radius);
  ctx.arcTo(x + w, y + h, x, y + h, radius);
  ctx.arcTo(x, y + h, x, y, radius);
  ctx.arcTo(x, y, x + w, y, radius);
  ctx.closePath();
}
