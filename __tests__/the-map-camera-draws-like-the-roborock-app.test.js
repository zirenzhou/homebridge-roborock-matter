"use strict";

/**
 * The map camera's picture follows the Roborock app's own map: four room
 * colours with neighbours always different, numbered badges, tile and plank
 * texture, the app's icons — light by day, the same design dark by night.
 * These pin the geometry that makes it look drawn rather than enlarged, the
 * blocks it reads beyond the floor plan, and the fallback when Skia is not
 * there. All maps are synthetic (test-support/rrmap-builder.js).
 */

const { decode } = require("jpeg-js");
const {
  traceMaskContours,
  simplifyLoop,
  deepestPoint,
} = require("../src/map_geometry.ts");
const { parseClassicMap } = require("../src/map_renderer.ts");
const scene = require("../src/map_scene_renderer.ts");
const {
  buildRRMap,
  millimetresAt,
  PIXEL,
} = require("../test-support/rrmap-builder");

function maskOf(rows) {
  const height = rows.length;
  const width = rows[0].length;
  const mask = new Uint8Array(width * height);
  rows.forEach((row, y) =>
    [...row].forEach((c, x) => (mask[y * width + x] = c === "#" ? 1 : 0))
  );
  return { mask, width, height };
}

function area(loop) {
  let sum = 0;
  for (let i = 0; i < loop.length; i++) {
    const [x0, y0] = loop[i];
    const [x1, y1] = loop[(i + 1) % loop.length];
    sum += x0 * y1 - x1 * y0;
  }
  return sum / 2;
}

describe("outlines from the grid", () => {
  test("a square is four corners on pixel edges", () => {
    const { mask, width, height } = maskOf(["....", ".##.", ".##.", "...."]);
    const loops = traceMaskContours(mask, width, height);
    expect(loops).toHaveLength(1);
    expect(loops[0]).toHaveLength(4);
    expect(Math.abs(area(loops[0]))).toBe(4);
  });

  test("an L keeps its six corners and a hole runs the other way round", () => {
    const l = maskOf(["##..", "##..", "####", "####"]);
    const [outline] = traceMaskContours(l.mask, l.width, l.height);
    expect(outline).toHaveLength(6);

    const ring = maskOf(["###", "#.#", "###"]);
    const loops = traceMaskContours(ring.mask, ring.width, ring.height);
    expect(loops).toHaveLength(2);
    expect(Math.sign(area(loops[0]))).toBe(-Math.sign(area(loops[1])));
  });

  test("pixels touching only at a corner stay two shapes", () => {
    const { mask, width, height } = maskOf(["#.", ".#"]);
    expect(traceMaskContours(mask, width, height)).toHaveLength(2);
  });

  test("a staircase simplifies to a straight diagonal", () => {
    const rows = [];
    for (let y = 0; y < 12; y++) {
      rows.push([...Array(12)].map((_, x) => (x <= y ? "#" : ".")).join(""));
    }
    const { mask, width, height } = maskOf(rows);
    const [loop] = traceMaskContours(mask, width, height);
    expect(loop.length).toBeGreaterThan(20);
    expect(simplifyLoop(loop, 0.75).length).toBeLessThanOrEqual(4);
  });

  test("a label point stays inside an L-shaped room", () => {
    const rows = [];
    for (let y = 0; y < 20; y++) {
      rows.push(
        [...Array(20)].map((_, x) => (x < 6 || y >= 14 ? "#" : ".")).join("")
      );
    }
    const { mask, width, height } = maskOf(rows);
    const [x, y] = deepestPoint(mask, width, height);
    expect(mask[Math.floor(y) * width + Math.floor(x)]).toBe(1);
  });
});

describe("the blocks beyond the floor plan", () => {
  const spec = {
    width: 30,
    height: 20,
    pixel: (x, row) =>
      x === 0 || x === 29 || row === 0 || row === 19
        ? PIXEL.WALL
        : PIXEL.room(x < 15 ? 16 : 17),
  };

  test("floor material and direction, carpet, obstacles, furniture and the run", () => {
    const shoe = millimetresAt(spec, 5, 5);
    const map = parseClassicMap(
      buildRRMap({
        ...spec,
        floorMaterials: { 16: 3, 17: 4 },
        floorDirections: { 16: 90 },
        carpet: (x, row) => x > 20 && row > 10,
        obstacles: [
          { ...shoe, type: 2, confidence: 0.94, photoId: "0017Q80vVl5VD5Gf" },
          { x: 6000, y: 6000, type: 0 },
        ],
        furniture: [
          {
            corners: [5100, 5100, 5300, 5100, 5300, 5200, 5100, 5200],
            type: 44,
          },
          {
            corners: [5400, 5400, 5600, 5400, 5600, 5500, 5400, 5500],
            type: 44,
          },
        ],
        doorSills: [[5000, 5500, 5040, 5500, 5040, 5600, 5000, 5600]],
        cleanedRooms: [16],
        path: [
          [5100, 5100],
          [5200, 5100],
        ],
        mopFlags: [1, 0],
      })
    );

    expect([...map.floorMaterials]).toEqual([
      [16, 3],
      [17, 4],
    ]);
    expect([...map.floorDirections]).toEqual([[16, 90]]);
    expect(map.carpet.reduce((sum, byte) => sum + (byte & 1), 0)).toBe(9 * 9);
    expect(map.obstacles[0]).toEqual({
      x: shoe.x,
      y: shoe.y,
      type: 2,
      confidence: 0.94,
      photoId: "0017Q80vVl5VD5Gf",
    });
    expect(map.obstacles[1].photoId).toBeNull();
    // Laid out as measured on an a225: two pieces of one type, ids 1 and 2.
    expect(map.furniture.map(({ type, id }) => ({ type, id }))).toEqual([
      { type: 44, id: 1 },
      { type: 44, id: 2 },
    ]);
    expect(map.doorSills).toEqual([
      [5000, 5500, 5040, 5500, 5040, 5600, 5000, 5600],
    ]);
    expect(map.cleanedRooms).toEqual([16]);
    expect([...map.mopFlags]).toEqual([1, 0]);
    expect(scene.obstacleName(map.obstacles[0])).toBe("鞋子");
  });
});

describe("the picture", () => {
  afterEach(() => scene.setCanvasLibraryForTests(undefined));

  /** Three rooms in a row and one under all of them. */
  function plan() {
    return parseClassicMap(
      buildRRMap({
        width: 60,
        height: 40,
        pixel: (x, row) => {
          if (x === 0 || x === 59 || row === 0 || row === 39) return PIXEL.WALL;
          if (row === 20 || x === 20 || x === 40) return PIXEL.WALL;
          if (row > 20) return PIXEL.room(19);
          return PIXEL.room(x < 20 ? 16 : x < 40 ? 17 : 18);
        },
      })
    );
  }

  test("neighbouring rooms never share a colour", () => {
    const ids = [16, 17, 18, 19];
    const width = 60;
    const height = 40;
    const roomAt = new Uint8Array(width * height);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        roomAt[y * width + x] =
          y > 20
            ? 19
            : y < 20 && x !== 20 && x !== 40
              ? x < 20
                ? 16
                : x < 40
                  ? 17
                  : 18
              : 0;
      }
    }
    const colours = scene.colourRooms(ids, roomAt, width, height);
    for (const [a, b] of [
      [16, 17],
      [17, 18],
      [16, 19],
      [17, 19],
      [18, 19],
    ]) {
      expect(colours.get(a)).not.toBe(colours.get(b));
    }
  });

  test("draws a JPEG of the asked size, light by day and dark by night", () => {
    const map = plan();
    const day = decode(scene.renderSceneJpeg({ map, theme: "day" }, 640, 360));
    const night = decode(
      scene.renderSceneJpeg({ map, theme: "night" }, 640, 360)
    );
    expect([day.width, day.height]).toEqual([640, 360]);
    const brightness = (img) => img.data[0] + img.data[1] + img.data[2];
    expect(brightness(day)).toBeGreaterThan(600);
    expect(brightness(night)).toBeLessThan(150);
  });

  test("follows the clock when not told otherwise", () => {
    expect(scene.daylightAt(new Date(2026, 0, 1, 13, 0))).toBe(1);
    expect(scene.daylightAt(new Date(2026, 0, 1, 23, 0))).toBe(0);
    const dusk = scene.daylightAt(new Date(2026, 0, 1, 18, 15));
    expect(dusk).toBeGreaterThan(0);
    expect(dusk).toBeLessThan(1);
  });

  test("before any map it still draws the header and a note", () => {
    const jpeg = scene.renderSceneJpeg(
      {
        map: null,
        status: {
          title: "Rocky",
          state: "充电中",
          battery: 91,
          charging: true,
        },
      },
      640,
      360
    );
    expect(decode(jpeg).width).toBe(640);
  });

  test("without Skia it says so, and the caller falls back", () => {
    scene.setCanvasLibraryForTests(null);
    expect(scene.renderSceneJpeg({ map: plan() }, 640, 360)).toBeNull();
  });
});
