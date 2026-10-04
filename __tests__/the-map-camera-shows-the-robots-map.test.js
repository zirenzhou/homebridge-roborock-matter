"use strict";

/**
 * The map camera end to end, without HomeKit or a robot: the accessory
 * answers snapshots from the last map (and a placeholder before one), keeps
 * that map on the Homebridge machine across restarts, asks for one map at
 * the end of each run, survives the Matter-only sweep, and the API layer
 * hands it the buffer live-room tracking already fetched. Maps are synthetic.
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const { decode } = require("jpeg-js");

const RoborockMapCameraAccessory =
  require("../src/map_camera_accessory.ts").default;
const {
  MAP_CAMERA_KIND,
  buildFfmpegArgs,
  isMapCameraAccessory,
  mapCameraUuidSeed,
  resolveFfmpegPath,
} = require("../src/map_camera_accessory.ts");
const RoborockPlatform = require("../src/platform").default;
const { Roborock } = require("../roborockLib/roborockAPI");
const { buildRRMap, PIXEL } = require("../test-support/rrmap-builder");

function mapBuffer() {
  return buildRRMap({
    width: 20,
    height: 12,
    pixel: (x, row) =>
      x === 0 || x === 19 || row === 0 || row === 11
        ? PIXEL.WALL
        : PIXEL.room(16),
  });
}

function fakeHap() {
  class CameraController {
    constructor(options) {
      this.options = options;
    }
    static generateSynchronisationSource() {
      return 0x1234;
    }
  }
  return {
    CameraController,
    SRTPCryptoSuites: { AES_CM_128_HMAC_SHA1_80: 0 },
    H264Profile: { BASELINE: 0, MAIN: 1, HIGH: 2 },
    H264Level: { LEVEL3_1: 0, LEVEL3_2: 1, LEVEL4_0: 2 },
    Categories: { IP_CAMERA: 17 },
    uuid: { generate: (seed) => `uuid:${seed}` },
  };
}

function fakeAccessory(displayName, UUID = `uuid:${displayName}`) {
  const information = {
    values: {},
    setCharacteristic(type, value) {
      this.values[type] = value;
      return this;
    },
  };
  return {
    UUID,
    displayName,
    context: {},
    controllers: [],
    getService: () => information,
    configureController(controller) {
      this.controllers.push(controller);
    },
  };
}

function fakePlatform() {
  return {
    Service: { AccessoryInformation: { UUID: "info" } },
    Characteristic: {
      Manufacturer: "Manufacturer",
      Model: "Model",
      SerialNumber: "SerialNumber",
    },
    api: { hap: fakeHap() },
    log: {
      debug: jest.fn(),
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    },
    getVacuumModel: () => "P20 Ultra Plus",
    getVacuumSerialNumber: () => "SN-TEST",
  };
}

function tempStorage() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "map-camera-"));
}

function makeCamera(storagePath = tempStorage()) {
  const platform = fakePlatform();
  const accessory = fakeAccessory("Map");
  const camera = new RoborockMapCameraAccessory(platform, accessory, "duid-1", {
    storagePath,
    ffmpegPath: "ffmpeg",
  });
  return { camera, accessory, platform, storagePath };
}

describe("the camera accessory", () => {
  test("is a HomeKit camera with H.264 profiles HomeKit can ask for", () => {
    const { accessory } = makeCamera();
    expect(accessory.controllers).toHaveLength(1);
    const { streamingOptions } = accessory.controllers[0].options;
    expect(streamingOptions.video.resolutions).toContainEqual([1280, 720, 30]);
    expect(streamingOptions.video.codec.profiles).toEqual([0, 1, 2]);
  });

  test("answers a snapshot before any map with the placeholder, at the size asked", () => {
    const { camera } = makeCamera();
    const callback = jest.fn();
    camera.handleSnapshotRequest({ width: 640, height: 360 }, callback);

    const [error, jpeg] = callback.mock.calls[0];
    expect(error).toBeUndefined();
    const decoded = decode(jpeg);
    expect([decoded.width, decoded.height]).toEqual([640, 360]);
  });

  test("a new map changes the picture; anything else is ignored", () => {
    const { camera } = makeCamera();
    const before = camera.snapshot(640, 360);

    expect(camera.updateMap("retry")).toBe(false);
    expect(camera.snapshot(640, 360)).toBe(before);

    expect(camera.updateMap(mapBuffer())).toBe(true);
    expect(camera.hasMap).toBe(true);
    expect(camera.snapshot(640, 360).equals(before)).toBe(false);
  });

  test("keeps the last map on the Homebridge machine, under a name that is not the robot id", () => {
    const storagePath = tempStorage();
    const first = makeCamera(storagePath).camera;
    first.updateMap(mapBuffer());

    const dir = path.join(storagePath, "roborock-matter", "maps");
    const files = fs.readdirSync(dir);
    expect(files).toHaveLength(1);
    expect(files[0]).not.toContain("duid-1");

    const second = makeCamera(storagePath).camera;
    expect(second.hasMap).toBe(true);
    expect(second.snapshot(640, 360).equals(first.snapshot(640, 360))).toBe(
      true
    );
  });

  test("asks for one map when a run ends, and at startup only when it has none", () => {
    const { camera } = makeCamera();
    expect(camera.noteCleaning(null)).toBe(false);
    expect(camera.noteCleaning(false)).toBe(true); // startup, no map kept
    expect(camera.noteCleaning(false)).toBe(false);
    expect(camera.noteCleaning(true)).toBe(false);
    expect(camera.noteCleaning(true)).toBe(false);
    expect(camera.noteCleaning(false)).toBe(true); // the run ended

    const kept = makeCamera();
    kept.camera.updateMap(mapBuffer());
    expect(kept.camera.noteCleaning(false)).toBe(false); // startup, map kept
  });

  test("a stream session gets a return port and echoes the controller's keys", async () => {
    const { camera } = makeCamera();
    const key = Buffer.alloc(16, 1);
    const salt = Buffer.alloc(14, 2);
    const response = await new Promise((resolve, reject) =>
      camera.prepareStream(
        {
          sessionID: "s1",
          sourceAddress: "127.0.0.1",
          targetAddress: "127.0.0.1",
          addressVersion: "ipv4",
          audio: { port: 0, srtp_key: key, srtp_salt: salt },
          video: { port: 50000, srtp_key: key, srtp_salt: salt },
        },
        (error, value) => (error ? reject(error) : resolve(value))
      )
    );

    expect(response.video.port).toBeGreaterThan(0);
    expect(response.video.ssrc).toBe(0x1234);
    expect(response.video.srtp_key).toBe(key);

    const stopped = jest.fn();
    camera.handleStreamRequest({ sessionID: "s1", type: "stop" }, stopped);
    expect(stopped).toHaveBeenCalledWith();
    camera.dispose();
  });
});

describe("the ffmpeg command", () => {
  const session = {
    address: "192.168.1.20",
    ipv6: false,
    videoPort: 51000,
    ssrc: 99,
    srtpParams: "a2V5c2FsdA==",
  };
  const video = {
    profile: 2,
    level: 2,
    fps: 30,
    pt: 99,
    max_bit_rate: 299,
    mtu: 1378,
  };

  test("reads JPEG frames from stdin and sends H.264 over SRTP to the controller", () => {
    const args = buildFfmpegArgs(session, video);
    const after = (flag) => args[args.indexOf(flag) + 1];

    expect(after("-f")).toBe("image2pipe");
    expect(after("-i")).toBe("pipe:0");
    expect(after("-c:v")).toBe("libx264");
    expect(after("-profile:v")).toBe("high");
    expect(after("-level:v")).toBe("4.0");
    expect(after("-r")).toBe("15"); // a still is not worth 30 fps
    expect(after("-payload_type")).toBe("99");
    expect(after("-ssrc")).toBe("99");
    expect(after("-srtp_out_params")).toBe("a2V5c2FsdA==");
    expect(args[args.length - 1]).toBe(
      "srtp://192.168.1.20:51000?rtcpport=51000&pkt_size=1378"
    );
  });

  test("the binary is the configured one, else a Synology ffmpeg package, else PATH", () => {
    expect(resolveFfmpegPath(" /opt/ffmpeg ", () => false)).toBe("/opt/ffmpeg");
    expect(
      resolveFfmpegPath(
        "",
        (file) => file === "/var/packages/ffmpeg/target/bin/ffmpeg"
      )
    ).toBe("/var/packages/ffmpeg/target/bin/ffmpeg");
    expect(resolveFfmpegPath(undefined, () => false)).toBe("ffmpeg");
  });

  test("brackets an IPv6 controller address", () => {
    const args = buildFfmpegArgs(
      { ...session, ipv6: true, address: "fd00::20" },
      video
    );
    expect(args[args.length - 1]).toMatch(/^srtp:\/\/\[fd00::20\]:51000\?/);
  });
});

describe("the platform", () => {
  function createPlatform({ enabled = true, cached = [], pv = "1.0" } = {}) {
    const platform = Object.create(RoborockPlatform.prototype);
    const hap = fakeHap();
    platform.Service = { AccessoryInformation: { UUID: "info" } };
    platform.Characteristic = {
      Manufacturer: "Manufacturer",
      Model: "Model",
      SerialNumber: "SerialNumber",
    };
    platform.platformConfig = { enableMapCamera: enabled };
    platform.accessories = [...cached];
    platform.mapCameras = new Map();
    platform.matterVacuums = new Map();
    platform.log = {
      debug: jest.fn(),
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    };
    platform.registered = [];
    platform.unregistered = [];
    const storagePath = tempStorage();
    platform.api = {
      hap,
      user: { storagePath: () => storagePath },
      platformAccessory: function (name, uuid) {
        return fakeAccessory(name, uuid);
      },
      registerPlatformAccessories: jest.fn((_p, _n, list) =>
        platform.registered.push(...list.map((a) => a.UUID))
      ),
      unregisterPlatformAccessories: jest.fn((_p, _n, list) =>
        platform.unregistered.push(...list.map((a) => a.UUID))
      ),
    };
    platform.roborockAPI = {
      getVacuumDeviceInfo: (duid, key) =>
        key === "pv" ? pv : key === "name" ? "Rocky" : "",
      getProductAttribute: () => "roborock.vacuum.a225",
      refreshLiveRoomForDevice: jest.fn(async () => null),
      fetchMapForCamera: jest.fn(async () => true),
    };
    return platform;
  }

  test("registers one camera per classic robot, marked as its own kind", () => {
    const platform = createPlatform();
    platform.syncMapCameras([{ duid: "duid-1" }]);

    const uuid = `uuid:${mapCameraUuidSeed("duid-1")}`;
    expect(platform.registered).toEqual([uuid]);
    const accessory = platform.accessories.find((a) => a.UUID === uuid);
    expect(accessory.displayName).toBe("Map");
    expect(accessory.context).toEqual({
      kind: MAP_CAMERA_KIND,
      duid: "duid-1",
    });
    expect(isMapCameraAccessory(accessory)).toBe(true);
  });

  test("a B01/Q7 robot gets no camera, and says why", () => {
    const platform = createPlatform({ pv: "B01" });
    platform.syncMapCameras([{ duid: "duid-1" }]);
    expect(platform.registered).toEqual([]);
    expect(platform.log.info).toHaveBeenCalledWith(
      expect.stringContaining("B01/Q7")
    );
  });

  test("turning the setting off removes the camera", () => {
    const cached = fakeAccessory("Map", "uuid:cam");
    cached.context = { kind: MAP_CAMERA_KIND, duid: "duid-1" };
    const platform = createPlatform({ enabled: false, cached: [cached] });

    platform.syncMapCameras([{ duid: "duid-1" }]);

    expect(platform.unregistered).toEqual(["uuid:cam"]);
    expect(platform.accessories).toHaveLength(0);
  });

  test("the Matter-only sweep leaves a cached camera alone", () => {
    const cached = fakeAccessory("Map", "uuid:cam");
    cached.context = { kind: MAP_CAMERA_KIND, duid: "duid-1" };
    const legacy = { UUID: "uuid:legacy", displayName: "Rocky", context: {} };
    const platform = createPlatform({ cached: [cached, legacy] });

    platform.removeLegacyHomeKitAccessories();

    expect(platform.unregistered).toEqual(["uuid:legacy"]);
  });

  test("follows the live map while cleaning and fetches the finished map after the run", () => {
    jest.useFakeTimers();
    try {
      const platform = createPlatform();
      platform.syncMapCameras([{ duid: "duid-1" }]);
      let cleaning = true;
      platform.matterVacuums.set("duid-1", {
        getHomeKitStateSensorValue: () => cleaning,
      });

      platform.refreshMapCameraForRobot("duid-1");
      expect(
        platform.roborockAPI.refreshLiveRoomForDevice
      ).toHaveBeenCalledWith("duid-1", {});

      cleaning = false;
      platform.refreshMapCameraForRobot("duid-1");
      expect(platform.roborockAPI.fetchMapForCamera).not.toHaveBeenCalled();
      jest.advanceTimersByTime(20_000);
      expect(platform.roborockAPI.fetchMapForCamera).toHaveBeenCalledWith(
        "duid-1",
        { cleaning: true }
      );
    } finally {
      jest.useRealTimers();
    }
  });
});

describe("the API layer", () => {
  function createApi(options = {}) {
    const api = new Roborock({
      log: {
        debug: jest.fn(),
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
      },
      storagePath: tempStorage(),
      ...options,
    });
    api.vacuums["duid-1"] = {};
    api.getVacuumDeviceInfo = jest.fn(() => "");
    api.getRoomMappingsForDevice = jest.fn(() => []);
    api.messageQueueHandler = {
      sendRequest: jest.fn(async () => mapBuffer()),
    };
    return api;
  }

  test("live-room tracking's fetch is handed to the camera", async () => {
    const api = createApi({ enableMapCamera: true });
    const listener = jest.fn();
    api.mapBufferListener = listener;

    await api.refreshLiveRoomForDevice("duid-1", { v1State: 5 });

    expect(listener).toHaveBeenCalledWith("duid-1", expect.any(Buffer));
  });

  test("with room tracking off the camera still gets its map, and no room is resolved", async () => {
    const api = createApi({
      enableMapCamera: true,
      enableLiveRoomTracking: false,
    });
    const listener = jest.fn();
    api.mapBufferListener = listener;

    const room = await api.refreshLiveRoomForDevice("duid-1", { v1State: 5 });

    expect(room).toBeNull();
    expect(listener).toHaveBeenCalledTimes(1);
    expect(api.getRoomMappingsForDevice).not.toHaveBeenCalled();
  });

  test("with both off nothing is fetched", async () => {
    const api = createApi({ enableLiveRoomTracking: false });
    await api.refreshLiveRoomForDevice("duid-1", { v1State: 5 });
    expect(api.messageQueueHandler.sendRequest).not.toHaveBeenCalled();
  });

  test("the one-off fetch is camera-only, classic-only and single-flight", async () => {
    const off = createApi();
    expect(await off.fetchMapForCamera("duid-1")).toBe(false);
    expect(off.messageQueueHandler.sendRequest).not.toHaveBeenCalled();

    const b01 = createApi({ enableMapCamera: true });
    b01.getVacuumDeviceInfo = jest.fn((duid, key) =>
      key === "pv" ? "B01" : ""
    );
    expect(await b01.fetchMapForCamera("duid-1")).toBe(false);

    const api = createApi({ enableMapCamera: true });
    const listener = jest.fn();
    api.mapBufferListener = listener;
    const [a, b] = await Promise.all([
      api.fetchMapForCamera("duid-1"),
      api.fetchMapForCamera("duid-1"),
    ]);
    expect([a, b]).toEqual([true, true]);
    expect(api.messageQueueHandler.sendRequest).toHaveBeenCalledTimes(1);
    expect(api.messageQueueHandler.sendRequest).toHaveBeenCalledWith(
      "duid-1",
      "get_map_v1",
      [],
      true
    );
    expect(listener).toHaveBeenCalledTimes(1);
  });

  test("a listener that throws does not cost live-room tracking its room", async () => {
    const api = createApi({ enableMapCamera: true });
    api.getRoomMappingsForDevice = jest.fn(() => [
      { segmentId: 16, mapId: 0, name: "Kitchen" },
    ]);
    api.mapBufferListener = () => {
      throw new Error("draw failed");
    };
    await expect(
      api.refreshLiveRoomForDevice("duid-1", { v1State: 5 })
    ).resolves.not.toThrow();
  });
});

describe("the clean sequence", () => {
  function api(answer) {
    const roborock = new Roborock({
      log: {
        debug: jest.fn(),
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
      },
      storagePath: tempStorage(),
    });
    roborock.messageQueueHandler = { sendRequest: jest.fn(async () => answer) };
    return roborock;
  }

  test("is read however the robot wraps it, and cached", async () => {
    for (const answer of [[3, 1, 2], [[3, 1, 2]], { sequence: [3, 1, 2] }]) {
      const roborock = api(answer);
      expect(await roborock.refreshCleanSequence("duid-1")).toEqual([3, 1, 2]);
      expect(roborock.getCachedCleanSequence("duid-1")).toEqual([3, 1, 2]);
      await roborock.refreshCleanSequence("duid-1");
      expect(roborock.messageQueueHandler.sendRequest).toHaveBeenCalledTimes(1);
    }
  });

  test("an answer without one leaves the badges on room ids", async () => {
    const roborock = api(["ok"]);
    expect(await roborock.refreshCleanSequence("duid-1")).toBeNull();
    expect(roborock.getCachedCleanSequence("duid-1")).toBeNull();
  });
});

describe("keeping the picture current", () => {
  test("a tile on screen asks for a fresh map at most once a minute", () => {
    jest.useFakeTimers();
    try {
      const requestMap = jest.fn();
      const camera = new RoborockMapCameraAccessory(
        fakePlatform(),
        fakeAccessory("Map"),
        "duid-1",
        { storagePath: tempStorage(), ffmpegPath: "ffmpeg", requestMap }
      );
      const done = jest.fn();
      camera.handleSnapshotRequest({ width: 320, height: 180 }, done);
      camera.handleSnapshotRequest({ width: 320, height: 180 }, done);
      expect(requestMap).toHaveBeenCalledTimes(1);
      jest.advanceTimersByTime(61_000);
      camera.handleSnapshotRequest({ width: 320, height: 180 }, done);
      expect(requestMap).toHaveBeenCalledTimes(2);
      expect(done).toHaveBeenCalledTimes(3);
    } finally {
      jest.useRealTimers();
    }
  });
});
