"use strict";

/**
 * Builds a synthetic classic RRMap buffer — the decrypted, gunzipped payload
 * of `get_map_v1` — from a few rectangles, so the map tests never need a
 * map captured from somebody's home. Layout as the robot sends it: a 0x14
 * byte "rr" header, then blocks of [type u16][header length u16][length u32]
 * [rest of header][payload], then a 20-byte SHA1 trailer.
 *
 * Grid rows are given TOP-DOWN here, the way a person draws a floor plan,
 * and stored bottom-up the way the robot stores them.
 */

const crypto = require("crypto");

const PIXEL = {
  OUTSIDE: 0x00,
  WALL: 0x01,
  FLOOR: 0xff,
  room: (id) => ((id << 3) | 0x07) & 0xff,
};

function block(type, headerExtra, payload) {
  const header = Buffer.alloc(8 + headerExtra.length);
  header.writeUInt16LE(type, 0);
  header.writeUInt16LE(header.length, 2);
  header.writeUInt32LE(payload.length, 4);
  headerExtra.copy(header, 8);
  return Buffer.concat([header, payload]);
}

/**
 * @param {object} spec
 * @param {number} spec.width
 * @param {number} spec.height
 * @param {number} [spec.left] grid offset, pixels
 * @param {number} [spec.top]
 * @param {(x: number, rowFromTop: number) => number} spec.pixel
 * @param {{x: number, y: number, angle?: number}} [spec.robot] millimetres
 * @param {{x: number, y: number}} [spec.charger]
 * @param {[number, number][]} [spec.path]
 * @param {[number, number, number, number][]} [spec.virtualWalls]
 * @param {number[][]} [spec.noGoZones] eight numbers per zone
 * @param {number[][]} [spec.doorSills] eight numbers per sill
 * @param {number[]} [spec.cleanedRooms]
 * @param {{x: number, y: number, type: number, confidence?: number, photoId?: string}[]} [spec.obstacles]
 * @param {(x: number, rowFromTop: number) => boolean} [spec.carpet]
 * @param {number[]} [spec.mopFlags] one per path point
 * @param {Record<number, number>} [spec.floorMaterials] room id → material
 * @param {Record<number, number>} [spec.floorDirections] room id → degrees
 * @param {{corners: number[], type: number, subtype?: number, id?: number}[]} [spec.furniture]
 */
function buildRRMap(spec) {
  const { width, height, left = 100, top = 100 } = spec;

  const grid = Buffer.alloc(width * height);
  for (let rowFromTop = 0; rowFromTop < height; rowFromTop++) {
    const rawRow = height - 1 - rowFromTop;
    for (let x = 0; x < width; x++) {
      grid[rawRow * width + x] = spec.pixel(x, rowFromTop);
    }
  }

  const imageHeader = Buffer.alloc(20);
  imageHeader.writeUInt32LE(0, 0); // segment count, unused by the renderer
  imageHeader.writeInt32LE(top, 4);
  imageHeader.writeInt32LE(left, 8);
  imageHeader.writeInt32LE(height, 12);
  imageHeader.writeInt32LE(width, 16);

  const blocks = [block(2, imageHeader, grid)];

  const position = (type, point, withAngle) => {
    const payload = Buffer.alloc(withAngle ? 12 : 8);
    payload.writeInt32LE(point.x, 0);
    payload.writeInt32LE(point.y, 4);
    if (withAngle) payload.writeInt32LE(point.angle ?? 0, 8);
    blocks.push(block(type, Buffer.alloc(0), payload));
  };
  if (spec.charger) position(1, spec.charger, false);
  if (spec.robot) position(8, spec.robot, true);

  if (spec.path) {
    const payload = Buffer.alloc(spec.path.length * 4);
    spec.path.forEach(([x, y], i) => {
      payload.writeUInt16LE(x, i * 4);
      payload.writeUInt16LE(y, i * 4 + 2);
    });
    const header = Buffer.alloc(12);
    header.writeUInt32LE(spec.path.length, 0);
    blocks.push(block(3, header, payload));
  }

  const counted = (type, items, size) => {
    const payload = Buffer.alloc(items.length * size * 2);
    items.forEach((values, i) =>
      values.forEach((v, j) => payload.writeUInt16LE(v, (i * size + j) * 2))
    );
    const header = Buffer.alloc(4);
    header.writeUInt32LE(items.length, 0);
    blocks.push(block(type, header, payload));
  };
  if (spec.virtualWalls) counted(10, spec.virtualWalls, 4);
  if (spec.noGoZones) counted(9, spec.noGoZones, 8);
  if (spec.doorSills) counted(28, spec.doorSills, 8);

  if (spec.cleanedRooms) {
    const header = Buffer.alloc(4);
    header.writeUInt32LE(spec.cleanedRooms.length, 0);
    blocks.push(block(11, header, Buffer.from(spec.cleanedRooms)));
  }
  if (spec.obstacles) {
    // OBSTACLES2: x, y, type, confidence ×100, two unknowns, 16-byte photo id.
    const payload = Buffer.alloc(spec.obstacles.length * 28);
    spec.obstacles.forEach((o, i) => {
      const at = i * 28;
      payload.writeUInt16LE(o.x, at);
      payload.writeUInt16LE(o.y, at + 2);
      payload.writeUInt16LE(o.type, at + 4);
      payload.writeUInt16LE(Math.round((o.confidence ?? 0.9) * 10000), at + 6);
      if (o.photoId) payload.write(o.photoId, at + 12, 16, "latin1");
    });
    const header = Buffer.alloc(4);
    header.writeUInt32LE(spec.obstacles.length, 0);
    blocks.push(block(15, header, payload));
  }
  if (spec.carpet) {
    // One byte per grid pixel, stored bottom-up like the image.
    const payload = Buffer.alloc(width * height);
    for (let rowFromTop = 0; rowFromTop < height; rowFromTop++) {
      for (let x = 0; x < width; x++) {
        if (spec.carpet(x, rowFromTop)) {
          payload[(height - 1 - rowFromTop) * width + x] = 1;
        }
      }
    }
    blocks.push(block(17, Buffer.alloc(0), payload));
  }
  if (spec.mopFlags) {
    blocks.push(block(18, Buffer.alloc(0), Buffer.from(spec.mopFlags)));
  }
  if (spec.floorMaterials) {
    const payload = Buffer.alloc(32);
    for (const [room, material] of Object.entries(spec.floorMaterials)) {
      payload[Number(room)] = material;
    }
    blocks.push(block(24, Buffer.alloc(0), payload));
  }
  if (spec.furniture) {
    const payload = Buffer.alloc(spec.furniture.length * 23);
    spec.furniture.forEach((f, i) => {
      const at = i * 23;
      f.corners.forEach((v, j) => payload.writeUInt16LE(v, at + j * 2));
      payload.writeUInt8(f.type, at + 18);
      payload.writeUInt8(f.subtype ?? 0, at + 19);
      payload.writeUInt8(f.id ?? i + 1, at + 21);
      payload.writeUInt8(1, at + 22);
    });
    const header = Buffer.alloc(4);
    header.writeUInt32LE(spec.furniture.length, 0);
    blocks.push(block(25, header, payload));
  }
  if (spec.floorDirections) {
    const entries = Object.entries(spec.floorDirections);
    const payload = Buffer.alloc(entries.length * 3);
    entries.forEach(([room, degrees], i) => {
      payload.writeUInt8(Number(room), i * 3);
      payload.writeUInt16LE(degrees, i * 3 + 1);
    });
    blocks.push(block(32, Buffer.alloc(0), payload));
  }

  const body = Buffer.concat(blocks);
  const header = Buffer.alloc(0x14);
  header.write("rr", 0, "ascii");
  header.writeUInt16LE(0x14, 2);
  header.writeUInt32LE(0x14 + body.length, 4);
  header.writeUInt16LE(1, 8);
  header.writeUInt16LE(1, 10);
  header.writeUInt32LE(7, 0x0c); // map index
  header.writeUInt32LE(42, 0x10); // map sequence

  const unsigned = Buffer.concat([header, body]);
  const sha1 = crypto.createHash("sha1").update(unsigned).digest();
  return Buffer.concat([unsigned, sha1]);
}

/** Grid pixel (column, row from top) → the millimetre coordinates of its centre. */
function millimetresAt(spec, column, rowFromTop) {
  const { height, left = 100, top = 100 } = spec;
  const rawRow = height - 1 - rowFromTop;
  return {
    x: (left + column) * 50 + 25,
    y: (top + rawRow) * 50 + 25,
  };
}

module.exports = { buildRRMap, millimetresAt, PIXEL };
