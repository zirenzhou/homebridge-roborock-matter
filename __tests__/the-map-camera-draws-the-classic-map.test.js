"use strict";

/**
 * The map camera draws the same RRMap buffer live-room tracking fetches.
 * These pin the parts of the picture that are easy to get silently wrong:
 * the grid is stored bottom-up, coordinates are millimetres at 50 mm per
 * pixel, and block payloads sit after each block's own header. Every map
 * here is synthetic (test-support/rrmap-builder.js).
 */

const { decode } = require("jpeg-js");
const {
  parseClassicMap,
  renderClassicMap,
  encodeJpeg,
  pixelColor,
} = require("../src/map_renderer.ts");
const RRMapParser = require("../roborockLib/lib/RRMapParser");
const {
  buildRRMap,
  millimetresAt,
  PIXEL,
} = require("../test-support/rrmap-builder");

/** 40 × 30 grid: a wall ring, room 16 in the top half, room 17 below. */
function twoRoomSpec(extra = {}) {
  return {
    width: 40,
    height: 30,
    pixel: (x, row) => {
      if (x === 0 || x === 39 || row === 0 || row === 29) return PIXEL.WALL;
      return row < 15 ? PIXEL.room(16) : PIXEL.room(17);
    },
    ...extra,
  };
}

function rgbAt(raster, x, y) {
  const i = (y * raster.width + x) * 4;
  return [raster.data[i], raster.data[i + 1], raster.data[i + 2]];
}

describe("parsing a classic map", () => {
  test("reads the grid, positions, path, walls and zones from their blocks", () => {
    const spec = twoRoomSpec();
    const robot = { ...millimetresAt(spec, 10, 20), angle: 90 };
    const charger = millimetresAt(spec, 30, 25);
    const buffer = buildRRMap({
      ...spec,
      robot,
      charger,
      path: [
        [5200, 5300],
        [5400, 5300],
      ],
      virtualWalls: [[5100, 5100, 5100, 5900]],
      noGoZones: [[5600, 5600, 5800, 5600, 5800, 5800, 5600, 5800]],
    });

    const map = parseClassicMap(buffer);

    expect(map).toMatchObject({
      width: 40,
      height: 30,
      left: 100,
      top: 100,
      mapIndex: 7,
      mapSequence: 42,
      robot: { x: robot.x, y: robot.y, angle: 90 },
      charger,
      path: [
        [5200, 5300],
        [5400, 5300],
      ],
      virtualWalls: [[5100, 5100, 5100, 5900]],
      noGoZones: [[5600, 5600, 5800, 5600, 5800, 5800, 5600, 5800]],
    });
    expect(map.pixels.length).toBe(40 * 30);
  });

  test("agrees with live-room tracking about which room the robot is in", () => {
    const spec = twoRoomSpec();
    for (const [row, room] of [
      [5, 16],
      [25, 17],
    ]) {
      const robot = millimetresAt(spec, 12, row);
      const buffer = buildRRMap({ ...spec, robot });
      const map = parseClassicMap(buffer);

      const column = Math.floor(robot.x / 50) - map.left;
      const rawRow = Math.floor(robot.y / 50) - map.top;
      const byte = map.pixels[rawRow * map.width + column];

      expect(byte >> 3).toBe(room);
      expect(RRMapParser.resolveLiveSegmentFromMapBuffer(buffer)).toBe(room);
    }
  });

  test("anything that is not a classic map is not a map", () => {
    expect(parseClassicMap(undefined)).toBeNull();
    expect(parseClassicMap("retry")).toBeNull();
    expect(
      parseClassicMap(Buffer.from("not a map at all, honestly"))
    ).toBeNull();
    // A truncated buffer keeps the header but loses the image block.
    const whole = buildRRMap(twoRoomSpec());
    expect(parseClassicMap(whole.subarray(0, 40))).toBeNull();
  });
});

describe("drawing it", () => {
  test("the top of the floor plan is the top of the picture", () => {
    const raster = renderClassicMap(
      parseClassicMap(buildRRMap(twoRoomSpec())),
      400,
      300
    );

    // The grid fills the frame apart from padding, so a quarter in from the
    // top is room 16 and a quarter up from the bottom is room 17.
    expect(rgbAt(raster, 200, 90)).toEqual([...pixelColor(PIXEL.room(16))]);
    expect(rgbAt(raster, 200, 210)).toEqual([...pixelColor(PIXEL.room(17))]);
  });

  test("a map is centred in a frame of another shape, with background around it", () => {
    const raster = renderClassicMap(
      parseClassicMap(buildRRMap(twoRoomSpec())),
      1280,
      720
    );

    const background = rgbAt(raster, 2, 2);
    expect(rgbAt(raster, 40, 360)).toEqual(background);
    expect(rgbAt(raster, 1240, 360)).toEqual(background);
    expect(rgbAt(raster, 640, 360)).not.toEqual(background);
  });

  test("the cleaning path is drawn over the rooms", () => {
    const spec = twoRoomSpec();
    const from = millimetresAt(spec, 5, 22);
    const to = millimetresAt(spec, 35, 22);
    const withPath = renderClassicMap(
      parseClassicMap(
        buildRRMap({
          ...spec,
          path: [
            [from.x, from.y],
            [to.x, to.y],
          ],
        })
      ),
      400,
      300
    );
    const without = renderClassicMap(
      parseClassicMap(buildRRMap(spec)),
      400,
      300
    );

    // Row 22 of 30, inside a 2-pixel margin and 4 % padding.
    const y = Math.round(12 + ((22 + 2 + 0.5) / 34) * 276);
    const lit = rgbAt(withPath, 200, y);
    const plain = rgbAt(without, 200, y);
    expect(lit[0] + lit[1] + lit[2]).toBeGreaterThan(
      plain[0] + plain[1] + plain[2]
    );
  });

  test("before any map has arrived the camera shows a placeholder, not an error", () => {
    const raster = renderClassicMap(null, 640, 360);
    expect(raster.data.length).toBe(640 * 360 * 4);
    // The ring of the placeholder glyph sits between 0.72 and 1 × 12 % of the
    // short side from the centre.
    expect(rgbAt(raster, 2, 2)).not.toEqual(rgbAt(raster, 320, 180 - 38));
  });

  test("the picture encodes as a JPEG of the requested size", () => {
    const jpegBytes = encodeJpeg(
      renderClassicMap(parseClassicMap(buildRRMap(twoRoomSpec())), 640, 360)
    );

    expect(jpegBytes.subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8]));
    const decoded = decode(jpegBytes);
    expect([decoded.width, decoded.height]).toEqual([640, 360]);
  });
});
