/**
 * Classic (v1) Roborock map → picture, for the optional map camera.
 *
 * The map arrives as the same RRMap buffer live-room tracking already fetches
 * (`get_map_v1`, decrypted and gunzipped by the transport). Live-room tracking
 * reads one pixel of it; this reads the whole grid once per picture.
 *
 * Pure JavaScript on purpose: a native canvas would need a compiler toolchain
 * on whatever NAS or Pi Homebridge runs on, and a map is a grid of a few
 * hundred thousand bytes — nearest-neighbour sampling into an RGBA buffer and
 * a pure-JS JPEG encoder are fast enough at camera-snapshot sizes.
 *
 * Pixel and block semantics follow vacuum-map-parser-roborock, the parser
 * Home Assistant's Roborock map uses: row 0 of the grid is the BOTTOM of the
 * map, coordinates are millimetres at 50 mm per grid pixel, and a pixel byte
 * is 0x00 outside, 0x01 wall, 0xFF floor, 0x07 scanned, or otherwise a room
 * pixel when its low three bits are 7 (room id in the high five bits).
 *
 * Block payloads are located by each block's own header length rather than
 * by fixed offsets, so a firmware that grows a header still parses.
 */

import { encode as encodeJpegImage } from "jpeg-js";

const BLOCK = {
  CHARGER_LOCATION: 1,
  IMAGE: 2,
  PATH: 3,
  ROBOT_POSITION: 8,
  FORBIDDEN_ZONES: 9,
  VIRTUAL_WALLS: 10,
  CURRENTLY_CLEANED_BLOCKS: 11,
  NO_MOP_ZONE: 12,
  OBSTACLES: 13,
  OBSTACLES2: 15,
  CARPET_MAP: 17,
  MOP_PATH: 18,
  DOOR_SILLS: 28,
  FLOOR_MAP: 24,
  FURNITURES: 25,
  FLOOR_DIRECTION: 32,
} as const;

const MM_PER_PIXEL = 50;

export type MapPoint = [number, number];

/** Something the robot's camera recognised on the floor. */
export type MapObstacle = {
  x: number;
  y: number;
  type: number;
  /** 0–1, when the robot reports it. */
  confidence: number | null;
  /** Set when the robot kept a photo of it. */
  photoId: string | null;
};

/** A piece of furniture, as the rotated rectangle the robot stores. */
export type MapFurniture = {
  /** Four corners, x0 y0 … x3 y3, millimetres. */
  corners: number[];
  type: number;
  subtype: number;
  id: number;
};

/** Floor material codes in the FLOOR_MAP block. */
export const FLOOR_MATERIAL = { GENERIC: 0, WOOD: 3, TILE: 4 } as const;

export type ClassicMap = {
  /** Grid size in pixels and its offset, in pixels, from the map origin. */
  width: number;
  height: number;
  left: number;
  top: number;
  /** width × height bytes, row 0 at the bottom of the map. */
  pixels: Buffer;
  robot: { x: number; y: number; angle: number | null } | null;
  charger: { x: number; y: number } | null;
  /** Millimetres. */
  path: MapPoint[];
  virtualWalls: [number, number, number, number][];
  /** Four corners each, x0 y0 … x3 y3 in millimetres. */
  noGoZones: number[][];
  noMopZones: number[][];
  /** Thresholds the robot climbs, four corners each (drawn yellow by the app). */
  doorSills: number[][];
  /** Floor material by room id (FLOOR_MATERIAL codes). */
  floorMaterials: Map<number, number>;
  /** Plank direction by room id, degrees: 0 runs left–right, 90 top–bottom. */
  floorDirections: Map<number, number>;
  /** One byte per grid pixel, bit 0 set on carpet; null when not sent. */
  carpet: Buffer | null;
  obstacles: MapObstacle[];
  furniture: MapFurniture[];
  /** Rooms the current run covers. */
  cleanedRooms: number[];
  /** One flag byte per path point; bit 0 set while mopping. */
  mopFlags: Buffer | null;
  mapIndex: number;
  mapSequence: number;
};

export type Raster = { width: number; height: number; data: Buffer };

/**
 * Parse the blocks the picture needs. Returns null for anything that is not a
 * classic RRMap with an image block — a B01/Q7 SCMap, a truncated payload, or
 * an error string a robot answered instead of a map.
 */
export function parseClassicMap(buf: unknown): ClassicMap | null {
  if (
    !Buffer.isBuffer(buf) ||
    buf.length < 0x14 ||
    buf[0] !== 0x72 ||
    buf[1] !== 0x72
  ) {
    return null;
  }

  const headerLength = buf.readUInt16LE(0x02);
  const end = Math.min(buf.readUInt32LE(0x04), buf.length);

  const map: Omit<ClassicMap, "width" | "height" | "left" | "top" | "pixels"> =
    {
      robot: null,
      charger: null,
      path: [],
      virtualWalls: [],
      noGoZones: [],
      noMopZones: [],
      doorSills: [],
      floorMaterials: new Map(),
      floorDirections: new Map(),
      carpet: null,
      obstacles: [],
      furniture: [],
      cleanedRooms: [],
      mopFlags: null,
      mapIndex: buf.readUInt32LE(0x0c),
      mapSequence: buf.readUInt32LE(0x10),
    };
  let image: Pick<
    ClassicMap,
    "width" | "height" | "left" | "top" | "pixels"
  > | null = null;

  let position = headerLength;
  while (position + 8 <= end) {
    const type = buf.readUInt16LE(position);
    const blockHeaderLength = buf.readUInt16LE(position + 2);
    const length = buf.readUInt32LE(position + 4);
    const data = position + blockHeaderLength;
    if (blockHeaderLength < 8 || data + length > buf.length) {
      break;
    }

    switch (type) {
      case BLOCK.IMAGE: {
        if (blockHeaderLength < 24) break;
        const top = buf.readInt32LE(data - 0x10);
        const left = buf.readInt32LE(data - 0x0c);
        const height = buf.readInt32LE(data - 0x08);
        const width = buf.readInt32LE(data - 0x04);
        if (width > 0 && height > 0 && width * height <= length) {
          image = {
            width,
            height,
            left,
            top,
            pixels: buf.subarray(data, data + width * height),
          };
        }
        break;
      }
      case BLOCK.ROBOT_POSITION:
      case BLOCK.CHARGER_LOCATION: {
        if (length < 8) break;
        const x = buf.readInt32LE(data);
        const y = buf.readInt32LE(data + 4);
        if (type === BLOCK.ROBOT_POSITION) {
          map.robot = {
            x,
            y,
            angle: length >= 12 ? buf.readInt32LE(data + 8) : null,
          };
        } else {
          map.charger = { x, y };
        }
        break;
      }
      case BLOCK.PATH: {
        for (let i = 0; i + 4 <= length; i += 4) {
          map.path.push([
            buf.readUInt16LE(data + i),
            buf.readUInt16LE(data + i + 2),
          ]);
        }
        break;
      }
      case BLOCK.VIRTUAL_WALLS: {
        const count = buf.readUInt32LE(position + 8);
        for (let i = 0; i < count && (i + 1) * 8 <= length; i++) {
          const at = data + i * 8;
          map.virtualWalls.push([
            buf.readUInt16LE(at),
            buf.readUInt16LE(at + 2),
            buf.readUInt16LE(at + 4),
            buf.readUInt16LE(at + 6),
          ]);
        }
        break;
      }
      case BLOCK.FORBIDDEN_ZONES:
      case BLOCK.NO_MOP_ZONE:
      case BLOCK.DOOR_SILLS: {
        const count = buf.readUInt32LE(position + 8);
        const target =
          type === BLOCK.FORBIDDEN_ZONES
            ? map.noGoZones
            : type === BLOCK.NO_MOP_ZONE
              ? map.noMopZones
              : map.doorSills;
        for (let i = 0; i < count && (i + 1) * 16 <= length; i++) {
          const zone: number[] = [];
          for (let j = 0; j < 8; j++) {
            zone.push(buf.readUInt16LE(data + i * 16 + j * 2));
          }
          target.push(zone);
        }
        break;
      }
      case BLOCK.CURRENTLY_CLEANED_BLOCKS: {
        const count = Math.min(buf.readUInt32LE(position + 8), length);
        for (let i = 0; i < count; i++) {
          map.cleanedRooms.push(buf.readUInt8(data + i));
        }
        break;
      }
      case BLOCK.OBSTACLES:
      case BLOCK.OBSTACLES2: {
        // Item size differs between firmwares; derive it from the block.
        const count = buf.readUInt32LE(position + 8);
        if (count === 0) break;
        const stride = Math.floor(length / count);
        const minimum = type === BLOCK.OBSTACLES ? 5 : 6;
        if (stride < minimum) break;
        for (let i = 0; i < count; i++) {
          const at = data + i * stride;
          const obstacle: MapObstacle = {
            x: buf.readUInt16LE(at),
            y: buf.readUInt16LE(at + 2),
            type:
              type === BLOCK.OBSTACLES
                ? buf.readUInt8(at + 4)
                : buf.readUInt16LE(at + 4),
            confidence: null,
            photoId: null,
          };
          if (type === BLOCK.OBSTACLES2 && stride >= 8) {
            obstacle.confidence = buf.readUInt16LE(at + 6) / 10000;
          }
          if (type === BLOCK.OBSTACLES2 && stride >= 28) {
            const id = buf
              .toString("latin1", at + 12, at + 28)
              .replace(/\0+$/, "");
            obstacle.photoId = /^[0-9A-Za-z]+$/.test(id) ? id : null;
          }
          map.obstacles.push(obstacle);
        }
        break;
      }
      case BLOCK.CARPET_MAP:
        map.carpet = buf.subarray(data, data + length);
        break;
      case BLOCK.MOP_PATH:
        map.mopFlags = buf.subarray(data, data + length);
        break;
      case BLOCK.FLOOR_MAP:
        // One byte per room id: byte i is the material of room i.
        for (let i = 0; i < length; i++) {
          const material = buf.readUInt8(data + i);
          if (material !== 0) map.floorMaterials.set(i, material);
        }
        break;
      case BLOCK.FLOOR_DIRECTION:
        for (let i = 0; i + 3 <= length; i += 3) {
          map.floorDirections.set(
            buf.readUInt8(data + i),
            buf.readUInt16LE(data + i + 1)
          );
        }
        break;
      case BLOCK.FURNITURES: {
        const count = buf.readUInt32LE(position + 8);
        if (count === 0) break;
        const stride = Math.floor(length / count);
        if (stride < 23) break;
        for (let i = 0; i < count; i++) {
          const at = data + i * stride;
          const corners: number[] = [];
          for (let j = 0; j < 8; j++)
            corners.push(buf.readUInt16LE(at + j * 2));
          // Measured on a 2025 robot (a225): after the corners, a u16, then
          // type, subtype, one more byte, the piece's id, and a flag. The
          // ids run 1, 2, …; read one byte later they would all be 1.
          map.furniture.push({
            corners,
            type: buf.readUInt8(at + 18),
            subtype: buf.readUInt8(at + 19),
            id: buf.readUInt8(at + 21),
          });
        }
        break;
      }
    }

    position = data + length;
  }

  return image ? { ...image, ...map } : null;
}

type Rgb = readonly [number, number, number];

const BACKGROUND: Rgb = [0x1c, 0x1c, 0x1e];
const FLOOR: Rgb = [0x48, 0x48, 0x4a];
const SCANNED: Rgb = [0x3a, 0x3a, 0x3c];
const WALL: Rgb = [0xd1, 0xd1, 0xd6];
const PATH: Rgb = [0xff, 0xff, 0xff];
const NO_GO: Rgb = [0xff, 0x45, 0x3a];
const NO_MOP: Rgb = [0x64, 0xd2, 0xff];
const CHARGER: Rgb = [0x30, 0xd1, 0x58];
const ROBOT_RING: Rgb = [0x0a, 0x84, 0xff];
const ROOM_COLORS: readonly Rgb[] = [
  [0x6e, 0xa8, 0xfe],
  [0xf6, 0xb2, 0x6b],
  [0x7e, 0xd3, 0x9a],
  [0xf2, 0x8b, 0x9b],
  [0xb3, 0x9d, 0xf5],
  [0x6f, 0xd0, 0xd6],
  [0xe8, 0xd0, 0x6b],
  [0xc9, 0x9e, 0x86],
  [0x9f, 0xc3, 0x6b],
  [0xe0, 0x9f, 0xd6],
  [0x8a, 0xb4, 0xd8],
  [0xf0, 0xa0, 0x7a],
];

/** The colour of one grid byte, or null for "outside the map". */
export function pixelColor(byte: number): Rgb | null {
  if (byte === 0x00) return null;
  if (byte === 0x01) return WALL;
  if (byte === 0xff) return FLOOR;
  if (byte === 0x07) return SCANNED;
  const low = byte & 0x07;
  if (low === 0 || low === 1) return WALL;
  if (low === 7) return ROOM_COLORS[(byte >> 3) % ROOM_COLORS.length];
  return FLOOR;
}

/** Where the map lands in the picture: grid pixel → output pixel. */
type Placement = {
  scale: number;
  offsetX: number;
  offsetY: number;
  /** Grid bounds, in flipped (top-down) rows. */
  minX: number;
  maxX: number;
  minRow: number;
  maxRow: number;
};

function placeMap(map: ClassicMap, width: number, height: number): Placement {
  let minX = Infinity;
  let maxX = -Infinity;
  let minRow = Infinity;
  let maxRow = -Infinity;
  for (let rawRow = 0; rawRow < map.height; rawRow++) {
    const rowStart = rawRow * map.width;
    for (let x = 0; x < map.width; x++) {
      if (map.pixels[rowStart + x] === 0) continue;
      const row = map.height - 1 - rawRow;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (row < minRow) minRow = row;
      if (row > maxRow) maxRow = row;
    }
  }

  // The robot and dock can sit on a pixel the robot has not drawn yet.
  for (const point of [map.robot, map.charger]) {
    if (!point) continue;
    const x = Math.floor(point.x / MM_PER_PIXEL) - map.left;
    const row = map.height - 1 - (Math.floor(point.y / MM_PER_PIXEL) - map.top);
    minX = Math.min(minX, x);
    maxX = Math.max(maxX, x);
    minRow = Math.min(minRow, row);
    maxRow = Math.max(maxRow, row);
  }

  if (!Number.isFinite(minX)) {
    minX = 0;
    maxX = map.width - 1;
    minRow = 0;
    maxRow = map.height - 1;
  }

  const margin = 2;
  minX -= margin;
  maxX += margin;
  minRow -= margin;
  maxRow += margin;

  const padding = Math.round(Math.min(width, height) * 0.04);
  const spanX = maxX - minX + 1;
  const spanY = maxRow - minRow + 1;
  const scale = Math.max(
    Math.min((width - 2 * padding) / spanX, (height - 2 * padding) / spanY),
    0.01
  );

  return {
    scale,
    offsetX: (width - spanX * scale) / 2,
    offsetY: (height - spanY * scale) / 2,
    minX,
    maxX,
    minRow,
    maxRow,
  };
}

/** Millimetres → output pixel coordinates (continuous). */
function project(
  map: ClassicMap,
  placement: Placement,
  x: number,
  y: number
): MapPoint {
  const gridX = x / MM_PER_PIXEL - map.left;
  const gridRow = map.height - (y / MM_PER_PIXEL - map.top);
  return [
    placement.offsetX + (gridX - placement.minX) * placement.scale,
    placement.offsetY + (gridRow - placement.minRow) * placement.scale,
  ];
}

class Canvas {
  readonly data: Buffer;

  constructor(
    readonly width: number,
    readonly height: number
  ) {
    this.data = Buffer.alloc(width * height * 4);
  }

  fill(color: Rgb): void {
    for (let i = 0; i < this.data.length; i += 4) {
      this.data[i] = color[0];
      this.data[i + 1] = color[1];
      this.data[i + 2] = color[2];
      this.data[i + 3] = 0xff;
    }
  }

  set(x: number, y: number, color: Rgb): void {
    const i = (y * this.width + x) * 4;
    this.data[i] = color[0];
    this.data[i + 1] = color[1];
    this.data[i + 2] = color[2];
  }

  blend(x: number, y: number, color: Rgb, alpha: number): void {
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) return;
    const i = (y * this.width + x) * 4;
    this.data[i] += (color[0] - this.data[i]) * alpha;
    this.data[i + 1] += (color[1] - this.data[i + 1]) * alpha;
    this.data[i + 2] += (color[2] - this.data[i + 2]) * alpha;
  }

  /** Composite a coverage mask once, so overlapping strokes do not darken. */
  composite(mask: Uint8Array, color: Rgb, alpha: number): void {
    for (let i = 0; i < mask.length; i++) {
      if (mask[i] === 0) continue;
      this.blend(i % this.width, Math.floor(i / this.width), color, alpha);
    }
  }

  disc(cx: number, cy: number, radius: number, color: Rgb, alpha = 1): void {
    const r2 = radius * radius;
    for (let y = Math.floor(cy - radius); y <= Math.ceil(cy + radius); y++) {
      for (let x = Math.floor(cx - radius); x <= Math.ceil(cx + radius); x++) {
        const dx = x + 0.5 - cx;
        const dy = y + 0.5 - cy;
        if (dx * dx + dy * dy <= r2) this.blend(x, y, color, alpha);
      }
    }
  }
}

function stampDisc(
  mask: Uint8Array,
  width: number,
  height: number,
  cx: number,
  cy: number,
  radius: number
): void {
  const r2 = radius * radius;
  const x0 = Math.max(0, Math.floor(cx - radius));
  const x1 = Math.min(width - 1, Math.ceil(cx + radius));
  const y0 = Math.max(0, Math.floor(cy - radius));
  const y1 = Math.min(height - 1, Math.ceil(cy + radius));
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const dx = x + 0.5 - cx;
      const dy = y + 0.5 - cy;
      if (dx * dx + dy * dy <= r2) mask[y * width + x] = 1;
    }
  }
}

function strokeLine(
  mask: Uint8Array,
  width: number,
  height: number,
  from: MapPoint,
  to: MapPoint,
  radius: number
): void {
  const dx = to[0] - from[0];
  const dy = to[1] - from[1];
  const distance = Math.hypot(dx, dy);
  const steps = Math.max(1, Math.ceil(distance / Math.max(radius * 0.5, 0.5)));
  for (let s = 0; s <= steps; s++) {
    stampDisc(
      mask,
      width,
      height,
      from[0] + (dx * s) / steps,
      from[1] + (dy * s) / steps,
      radius
    );
  }
}

/** Even-odd fill of a polygon into a mask, bounded by its own box. */
function fillPolygon(
  mask: Uint8Array,
  width: number,
  height: number,
  points: MapPoint[]
): void {
  const xs = points.map((p) => p[0]);
  const ys = points.map((p) => p[1]);
  const x0 = Math.max(0, Math.floor(Math.min(...xs)));
  const x1 = Math.min(width - 1, Math.ceil(Math.max(...xs)));
  const y0 = Math.max(0, Math.floor(Math.min(...ys)));
  const y1 = Math.min(height - 1, Math.ceil(Math.max(...ys)));
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const px = x + 0.5;
      const py = y + 0.5;
      let inside = false;
      for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
        const [xi, yi] = points[i];
        const [xj, yj] = points[j];
        if (
          yi > py !== yj > py &&
          px < ((xj - xi) * (py - yi)) / (yj - yi) + xi
        ) {
          inside = !inside;
        }
      }
      if (inside) mask[y * width + x] = 1;
    }
  }
}

/**
 * Draw the map fitted and centred into width × height. A null map draws the
 * placeholder the camera shows before the first map has arrived.
 */
export function renderClassicMap(
  map: ClassicMap | null,
  width: number,
  height: number
): Raster {
  const canvas = new Canvas(width, height);
  canvas.fill(BACKGROUND);

  if (!map) {
    const r = Math.min(width, height) * 0.12;
    canvas.disc(width / 2, height / 2, r, FLOOR);
    canvas.disc(width / 2, height / 2, r * 0.72, BACKGROUND);
    canvas.disc(width / 2, height / 2, r * 0.22, FLOOR);
    return { width, height, data: canvas.data };
  }

  const placement = placeMap(map, width, height);
  const { scale, offsetX, offsetY, minX, minRow } = placement;

  // Nearest-neighbour: one grid lookup per output pixel, with the column and
  // row mapping computed once per axis rather than once per pixel.
  const columnFor = new Int32Array(width);
  for (let x = 0; x < width; x++) {
    columnFor[x] = Math.floor((x + 0.5 - offsetX) / scale) + minX;
  }
  for (let y = 0; y < height; y++) {
    const row = Math.floor((y + 0.5 - offsetY) / scale) + minRow;
    if (row < 0 || row >= map.height) continue;
    const rowStart = (map.height - 1 - row) * map.width;
    for (let x = 0; x < width; x++) {
      const column = columnFor[x];
      if (column < 0 || column >= map.width) continue;
      const color = pixelColor(map.pixels[rowStart + column]);
      if (color) canvas.set(x, y, color);
    }
  }

  const toScreen = (x: number, y: number) => project(map, placement, x, y);

  for (const [zones, color] of [
    [map.noMopZones, NO_MOP],
    [map.noGoZones, NO_GO],
  ] as const) {
    if (zones.length === 0) continue;
    const fill = new Uint8Array(width * height);
    const outline = new Uint8Array(width * height);
    for (const zone of zones) {
      const corners: MapPoint[] = [];
      for (let i = 0; i + 1 < zone.length; i += 2) {
        corners.push(toScreen(zone[i], zone[i + 1]));
      }
      fillPolygon(fill, width, height, corners);
      for (let i = 0; i < corners.length; i++) {
        strokeLine(
          outline,
          width,
          height,
          corners[i],
          corners[(i + 1) % corners.length],
          Math.max(0.8, scale * 0.15)
        );
      }
    }
    canvas.composite(fill, color, 0.22);
    canvas.composite(outline, color, 0.9);
  }

  if (map.virtualWalls.length > 0) {
    const walls = new Uint8Array(width * height);
    for (const [x0, y0, x1, y1] of map.virtualWalls) {
      strokeLine(
        walls,
        width,
        height,
        toScreen(x0, y0),
        toScreen(x1, y1),
        Math.max(1, scale * 0.3)
      );
    }
    canvas.composite(walls, NO_GO, 0.95);
  }

  if (map.path.length > 1) {
    const trail = new Uint8Array(width * height);
    const radius = Math.max(0.6, scale * 0.18);
    let previous = toScreen(map.path[0][0], map.path[0][1]);
    for (let i = 1; i < map.path.length; i++) {
      const next = toScreen(map.path[i][0], map.path[i][1]);
      strokeLine(trail, width, height, previous, next, radius);
      previous = next;
    }
    canvas.composite(trail, PATH, 0.55);
  }

  const marker = Math.max(5, scale * 2);

  if (map.charger) {
    const [cx, cy] = toScreen(map.charger.x, map.charger.y);
    canvas.disc(cx, cy, marker * 0.8, WALL);
    canvas.disc(cx, cy, marker * 0.62, CHARGER);
  }

  if (map.robot) {
    const [cx, cy] = toScreen(map.robot.x, map.robot.y);
    canvas.disc(cx, cy, marker * 1.15, ROBOT_RING);
    canvas.disc(cx, cy, marker * 0.85, [0xff, 0xff, 0xff]);
    if (map.robot.angle !== null) {
      // Map angles turn counter-clockwise from +x; screen y points down.
      const radians = (map.robot.angle * Math.PI) / 180;
      canvas.disc(
        cx + Math.cos(radians) * marker * 0.5,
        cy - Math.sin(radians) * marker * 0.5,
        marker * 0.28,
        ROBOT_RING
      );
    }
  }

  return { width, height, data: canvas.data };
}

export function encodeJpeg(raster: Raster, quality = 80): Buffer {
  return encodeJpegImage(raster, quality).data;
}
