import { ChildProcess, spawn } from "child_process";
import { createHash } from "crypto";
import { createSocket, Socket } from "dgram";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "fs";
import path from "path";
import { gunzipSync, gzipSync } from "zlib";

import type {
  CameraStreamingDelegate,
  PlatformAccessory,
  PrepareStreamCallback,
  PrepareStreamRequest,
  SnapshotRequest,
  SnapshotRequestCallback,
  StreamingRequest,
  StreamRequestCallback,
} from "homebridge";

import type RoborockPlatform from "./platform";
import {
  ClassicMap,
  encodeJpeg,
  parseClassicMap,
  renderClassicMap,
} from "./map_renderer";
import {
  daylightAt,
  renderSceneJpeg,
  SceneRoom,
  SceneStatus,
} from "./map_scene_renderer";

/** What the picture shows besides the map; supplied by the platform. */
export type MapSceneContext = {
  rooms: SceneRoom[];
  status: SceneStatus | null;
  theme: "auto" | "day" | "night";
  rotation: 0 | 90 | 180 | 270;
  furnitureNames: Record<number, string>;
};

/**
 * The marker that keeps the map camera out of the Matter-only cleanup.
 * Same trap as STATE_SENSOR_KIND: a cached HAP accessory the platform does
 * not recognise is unregistered as "legacy" on the next restart.
 */
export const MAP_CAMERA_KIND = "mapCamera" as const;

export type MapCameraContext = {
  kind: typeof MAP_CAMERA_KIND;
  duid: string;
};

export function isMapCameraAccessory(accessory: {
  context?: unknown;
}): boolean {
  const context = accessory?.context as Partial<MapCameraContext> | undefined;
  return Boolean(
    context &&
      typeof context === "object" &&
      context.kind === MAP_CAMERA_KIND &&
      typeof context.duid === "string"
  );
}

export function mapCameraUuidSeed(duid: string): string {
  return `hap:roborock:mapcamera:${duid}`;
}

/**
 * The robot's v1 state codes, worded as the Roborock app words them in its
 * header. Unknown codes read as nothing rather than as a number.
 */
const ROBOT_STATES: Record<number, string> = {
  1: "启动中",
  2: "未连接充电座",
  3: "待机中",
  4: "遥控中",
  5: "清扫中",
  6: "回充中",
  7: "手动模式",
  8: "充电中",
  9: "充电异常",
  10: "已暂停",
  11: "局部清扫中",
  12: "异常",
  13: "关机中",
  14: "升级中",
  15: "对接中",
  16: "前往目标点",
  17: "区域清扫中",
  18: "房间清扫中",
  22: "集尘中",
  23: "洗拖布中",
  25: "洗拖布中",
  26: "回基站洗拖布",
  29: "建图中",
  100: "已充满",
};

export function describeRobotState(state: number): string {
  return ROBOT_STATES[state] ?? "";
}

/** Where the Synology ffmpeg packages put their binary, newest first. */
const KNOWN_FFMPEG_PATHS = [
  "/var/packages/ffmpeg7/target/bin/ffmpeg",
  "/var/packages/ffmpeg6/target/bin/ffmpeg",
  "/var/packages/ffmpeg/target/bin/ffmpeg",
];

/**
 * The ffmpeg binary: the configured path, else ffmpeg-for-homebridge if the
 * user installed it, else a Synology ffmpeg package, else whatever is on PATH.
 */
export function resolveFfmpegPath(
  configured?: unknown,
  exists: (file: string) => boolean = existsSync
): string {
  if (typeof configured === "string" && configured.trim()) {
    return configured.trim();
  }
  try {
    const bundled = require("ffmpeg-for-homebridge");
    if (typeof bundled === "string" && bundled) {
      return bundled;
    }
  } catch {
    // Not installed: it is not a dependency of this plugin.
  }
  return KNOWN_FFMPEG_PATHS.find((file) => exists(file)) ?? "ffmpeg";
}

const PROFILE_NAMES = ["baseline", "main", "high"];
const LEVEL_NAMES = ["3.1", "3.2", "4.0"];

/** A frame a second is plenty for a picture that changes every ~10 s. */
const FRAME_INTERVAL_MS = 1000;
/** Encoding a still at more than this is CPU spent on identical frames. */
const MAX_STREAM_FPS = 15;
/**
 * The controller reports over RTCP while it is watching. When it goes quiet
 * — the phone locked, the app closed without a STOP — the stream ends here
 * rather than encoding to nobody until the next restart.
 */
const RTCP_SILENCE_TIMEOUT_MS = 30_000;
/** At most one persisted map per minute while a clean is in progress. */
const PERSIST_INTERVAL_MS = 60_000;

export type StreamSession = {
  address: string;
  ipv6: boolean;
  videoPort: number;
  ssrc: number;
  srtpParams: string;
  returnSocket: Socket;
  process?: ChildProcess;
  frameTimer?: ReturnType<typeof setInterval>;
  watchdog?: ReturnType<typeof setInterval>;
  lastRtcpAt: number;
};

/**
 * The ffmpeg arguments for one HomeKit stream: JPEG frames on stdin, H.264 to
 * the controller over SRTP. Exported so the shape is tested without ffmpeg.
 */
export function buildFfmpegArgs(
  session: Pick<
    StreamSession,
    "address" | "ipv6" | "videoPort" | "ssrc" | "srtpParams"
  >,
  video: {
    profile: number;
    level: number;
    fps: number;
    pt: number;
    max_bit_rate: number;
    mtu: number;
  }
): string[] {
  const fps = Math.max(1, Math.min(video.fps, MAX_STREAM_FPS));
  const bitrate = Math.max(64, video.max_bit_rate);
  const host = session.ipv6 ? `[${session.address}]` : session.address;
  return [
    "-hide_banner",
    "-loglevel",
    "error",
    "-f",
    "image2pipe",
    "-framerate",
    String(1000 / FRAME_INTERVAL_MS),
    "-i",
    "pipe:0",
    "-an",
    "-sn",
    "-dn",
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    "-r",
    String(fps),
    "-preset",
    "ultrafast",
    "-tune",
    "zerolatency",
    "-profile:v",
    PROFILE_NAMES[video.profile] ?? "main",
    "-level:v",
    LEVEL_NAMES[video.level] ?? "3.1",
    "-g",
    String(fps * 2),
    "-bf",
    "0",
    "-b:v",
    `${bitrate}k`,
    "-maxrate",
    `${bitrate}k`,
    "-bufsize",
    `${bitrate * 2}k`,
    "-payload_type",
    String(video.pt),
    "-ssrc",
    String(session.ssrc),
    "-f",
    "rtp",
    "-srtp_out_suite",
    "AES_CM_128_HMAC_SHA1_80",
    "-srtp_out_params",
    session.srtpParams,
    `srtp://${host}:${session.videoPort}?rtcpport=${session.videoPort}&pkt_size=${video.mtu}`,
  ];
}

/**
 * The robot's map as a HomeKit camera.
 *
 * The picture is whatever map the plugin last received: while the robot
 * cleans, live-room tracking fetches one every ~10 s and hands it here; when
 * a clean ends one more is fetched so the finished map stays up; otherwise
 * nothing is fetched. The last map is kept on disk next to config.json so the
 * camera has a picture straight after a restart — it never leaves the
 * Homebridge machine.
 *
 * A snapshot is drawn at the size HomeKit asks for. Live view is ffmpeg
 * turning the same picture, re-sent once a second, into an H.264 stream.
 */
export default class RoborockMapCameraAccessory
  implements CameraStreamingDelegate
{
  private map: ClassicMap | null = null;
  private mapReceivedAt = 0;
  private mapVersion = 0;
  private lastPersistAt = 0;
  private readonly frameCache = new Map<string, Buffer>();
  private readonly sessions = new Map<string, StreamSession>();
  private cleaning: boolean | null = null;
  private ffmpegMissingLogged = false;
  private furnitureLogged = "";

  constructor(
    private readonly platform: RoborockPlatform,
    public readonly accessory: PlatformAccessory,
    private readonly duid: string,
    private readonly options: { storagePath: string; ffmpegPath: string }
  ) {
    this.configureAccessory();
    this.loadPersistedMap();
  }

  get hasMap(): boolean {
    return this.map !== null;
  }

  private configureAccessory(): void {
    const { Service, Characteristic } = this.platform;
    const hap = this.platform.api.hap;

    this.accessory
      .getService(Service.AccessoryInformation)!
      .setCharacteristic(Characteristic.Manufacturer, "Roborock")
      .setCharacteristic(
        Characteristic.Model,
        `${this.platform.getVacuumModel(this.duid)} Map`
      )
      .setCharacteristic(
        Characteristic.SerialNumber,
        `${this.platform.getVacuumSerialNumber(this.duid)}-map`
      );

    const resolutions: [number, number, number][] = [
      [1920, 1080, 30],
      [1280, 720, 30],
      [640, 360, 30],
      [480, 270, 30],
      [320, 180, 30],
      [1280, 960, 30],
      [1024, 768, 30],
      [640, 480, 30],
      [480, 360, 30],
      [320, 240, 15],
    ];

    const controller = new hap.CameraController({
      cameraStreamCount: 2,
      delegate: this,
      streamingOptions: {
        supportedCryptoSuites: [hap.SRTPCryptoSuites.AES_CM_128_HMAC_SHA1_80],
        video: {
          resolutions,
          codec: {
            profiles: [
              hap.H264Profile.BASELINE,
              hap.H264Profile.MAIN,
              hap.H264Profile.HIGH,
            ],
            levels: [
              hap.H264Level.LEVEL3_1,
              hap.H264Level.LEVEL3_2,
              hap.H264Level.LEVEL4_0,
            ],
          },
        },
      },
    });
    this.accessory.configureController(controller);
  }

  /** Follow a rename in the Roborock app through to Apple Home. */
  updateIdentity(vacuumName: string): void {
    this.accessory.displayName = `${vacuumName} Map`;
  }

  /** A new map from the robot. Anything that is not a classic map is ignored. */
  updateMap(buffer: unknown): boolean {
    const map = parseClassicMap(buffer);
    if (!map) {
      return false;
    }
    this.map = map;
    this.mapReceivedAt = Date.now();
    this.mapVersion++;
    this.frameCache.clear();
    this.logFurniture(map);

    if (
      this.cleaning !== true ||
      this.mapReceivedAt - this.lastPersistAt >= PERSIST_INTERVAL_MS
    ) {
      this.persistMap(buffer as Buffer);
    }
    return true;
  }

  /**
   * Called after every publish with whether the robot is on a cleaning run.
   * Returns true when the caller should fetch one map now: at the end of a
   * run, so the finished map stays up, and at startup when there is none.
   */
  noteCleaning(cleaning: boolean | null): boolean {
    if (cleaning === null) {
      return false;
    }
    const previous = this.cleaning;
    this.cleaning = cleaning;
    if (previous === true && cleaning === false) {
      return true;
    }
    return previous === null && !this.map;
  }

  /**
   * The JPEG for one size. Drawn again only when something on it changed —
   * the map, the robot's status line, or day turning to night — because
   * HomeKit asks for a snapshot every few seconds while the Home app is open.
   */
  snapshot(width: number, height: number): Buffer {
    const w = Math.max(160, Math.min(Math.round(width), 1920));
    const h = Math.max(90, Math.min(Math.round(height), 1080));
    const context = this.sceneContext();
    const now = new Date();
    const key = [
      `${w}x${h}`,
      this.mapVersion,
      JSON.stringify(context?.status ?? null),
      context?.theme ?? "auto",
      context?.rotation ?? 0,
      JSON.stringify(context?.rooms ?? []),
      Math.round(daylightAt(now) * 20),
    ].join("|");
    let frame = this.frameCache.get(key);
    if (!frame) {
      frame =
        renderSceneJpeg(
          {
            map: this.map,
            rooms: context?.rooms,
            status: context?.status,
            theme: context?.theme,
            rotation: context?.rotation,
            furnitureNames: context?.furnitureNames,
            now,
            updatedAt: this.mapReceivedAt ? new Date(this.mapReceivedAt) : null,
          },
          w,
          h
        ) ?? encodeJpeg(renderClassicMap(this.map, w, h), 82);
      if (this.frameCache.size > 16) this.frameCache.clear();
      this.frameCache.set(key, frame);
    }
    return frame;
  }

  /**
   * Name the furniture codes on the map once, with sizes, so they can be
   * given names in the settings: no public source maps codes to names.
   */
  private logFurniture(map: ClassicMap): void {
    const pieces = map.furniture.map((piece) => {
      const [x0, y0, x1, y1, x2, y2] = piece.corners;
      const a = Math.hypot(x1 - x0, y1 - y0) / 1000;
      const b = Math.hypot(x2 - x1, y2 - y1) / 1000;
      const [w, l] = [a, b].sort((p, q) => p - q);
      return `code ${piece.type} (${w.toFixed(1)} × ${l.toFixed(1)} m)`;
    });
    const summary = pieces.sort().join(", ");
    if (!summary || summary === this.furnitureLogged) return;
    this.furnitureLogged = summary;
    this.platform.log.info(
      `Map camera: furniture on ${this.accessory.displayName}'s map: ${summary}. Name a code with "mapFurnitureNames" in config.json to label it.`
    );
  }

  private sceneContext(): MapSceneContext | null {
    try {
      return this.platform.getMapSceneContext?.(this.duid) ?? null;
    } catch {
      return null;
    }
  }

  handleSnapshotRequest(
    request: SnapshotRequest,
    callback: SnapshotRequestCallback
  ): void {
    try {
      callback(undefined, this.snapshot(request.width, request.height));
    } catch (error) {
      this.platform.log.warn(
        `Map camera snapshot for ${this.accessory.displayName} failed: ${(error as Error)?.message ?? error}`
      );
      callback(error as Error);
    }
  }

  prepareStream(
    request: PrepareStreamRequest,
    callback: PrepareStreamCallback
  ): void {
    const ipv6 = request.addressVersion === "ipv6";
    const returnSocket = createSocket(ipv6 ? "udp6" : "udp4");
    returnSocket.on("error", (error) => {
      this.platform.log.debug(
        `Map camera return socket error: ${error.message}`
      );
      this.stopSession(request.sessionID);
    });

    returnSocket.bind(0, () => {
      const ssrc =
        this.platform.api.hap.CameraController.generateSynchronisationSource();
      const session: StreamSession = {
        address: request.targetAddress,
        ipv6,
        videoPort: request.video.port,
        ssrc,
        srtpParams: Buffer.concat([
          request.video.srtp_key,
          request.video.srtp_salt,
        ]).toString("base64"),
        returnSocket,
        lastRtcpAt: Date.now(),
      };
      this.sessions.set(request.sessionID, session);

      callback(undefined, {
        video: {
          port: returnSocket.address().port,
          ssrc,
          srtp_key: request.video.srtp_key,
          srtp_salt: request.video.srtp_salt,
        },
      });
    });
  }

  handleStreamRequest(
    request: StreamingRequest,
    callback: StreamRequestCallback
  ): void {
    switch (request.type) {
      case "start": {
        const session = this.sessions.get(request.sessionID);
        if (!session) {
          callback(new Error("Unknown stream session"));
          return;
        }
        this.startStream(request.sessionID, session, request.video, callback);
        return;
      }
      case "reconfigure":
        // The picture is a still: a new bitrate or size changes nothing worth
        // restarting the encoder for.
        callback();
        return;
      case "stop":
        this.stopSession(request.sessionID);
        callback();
        return;
    }
  }

  private startStream(
    sessionID: string,
    session: StreamSession,
    video: {
      width: number;
      height: number;
      profile: number;
      level: number;
      fps: number;
      pt: number;
      max_bit_rate: number;
      mtu: number;
    },
    callback: StreamRequestCallback
  ): void {
    const args = buildFfmpegArgs(session, video);
    let answered = false;
    const answer = (error?: Error) => {
      if (!answered) {
        answered = true;
        callback(error);
      }
    };

    const child = spawn(this.options.ffmpegPath, args, {
      stdio: ["pipe", "ignore", "pipe"],
    });
    session.process = child;

    child.on("spawn", () => answer());
    child.on("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT" && !this.ffmpegMissingLogged) {
        this.ffmpegMissingLogged = true;
        this.platform.log.warn(
          `Map camera live view needs ffmpeg, and '${this.options.ffmpegPath}' was not found. Snapshots still work. Set "ffmpegPath" in the plugin settings or install ffmpeg on the Homebridge machine.`
        );
      }
      answer(error);
      this.stopSession(sessionID);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      this.platform.log.debug(`Map camera ffmpeg: ${chunk.toString().trim()}`);
    });
    child.on("exit", () => this.stopSession(sessionID));
    child.stdin?.on("error", () => undefined);

    const sendFrame = () => {
      if (child.stdin?.writable) {
        child.stdin.write(this.snapshot(video.width, video.height));
      }
    };
    sendFrame();
    session.frameTimer = setInterval(sendFrame, FRAME_INTERVAL_MS);

    session.returnSocket.on("message", () => {
      session.lastRtcpAt = Date.now();
    });
    session.watchdog = setInterval(() => {
      if (Date.now() - session.lastRtcpAt > RTCP_SILENCE_TIMEOUT_MS) {
        this.platform.log.debug(
          `Map camera stream for ${this.accessory.displayName} ended: the viewer stopped reporting.`
        );
        this.stopSession(sessionID);
      }
    }, RTCP_SILENCE_TIMEOUT_MS / 3);
  }

  stopSession(sessionID: string): void {
    const session = this.sessions.get(sessionID);
    if (!session) {
      return;
    }
    this.sessions.delete(sessionID);
    if (session.frameTimer) clearInterval(session.frameTimer);
    if (session.watchdog) clearInterval(session.watchdog);
    try {
      session.process?.stdin?.end();
      session.process?.kill("SIGKILL");
    } catch {
      // Already gone.
    }
    try {
      session.returnSocket.close();
    } catch {
      // Already closed.
    }
  }

  dispose(): void {
    for (const sessionID of [...this.sessions.keys()]) {
      this.stopSession(sessionID);
    }
  }

  private mapFilePath(): string {
    const name = createHash("sha1")
      .update(this.duid)
      .digest("hex")
      .slice(0, 16);
    return path.join(
      this.options.storagePath,
      "roborock-matter",
      "maps",
      `${name}.rrmap.gz`
    );
  }

  private loadPersistedMap(): void {
    try {
      const map = parseClassicMap(gunzipSync(readFileSync(this.mapFilePath())));
      if (map) {
        this.map = map;
      }
    } catch {
      // No map yet: the camera shows its placeholder until one arrives.
    }
  }

  private persistMap(buffer: Buffer): void {
    const file = this.mapFilePath();
    try {
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(`${file}.tmp`, gzipSync(buffer));
      renameSync(`${file}.tmp`, file);
      this.lastPersistAt = Date.now();
    } catch (error) {
      this.platform.log.debug(
        `Could not keep the map for ${this.accessory.displayName}: ${(error as Error)?.message ?? error}`
      );
    }
  }
}
