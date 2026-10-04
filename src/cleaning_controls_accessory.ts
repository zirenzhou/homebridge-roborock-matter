import { PlatformAccessory, Service } from "homebridge";
import { applyServiceName } from "./naming";
import { MOP_WATER_LEVEL_MAX, SUCTION_LEVEL_KEYS } from "./cleaning_profiles";
import RoborockPlatform from "./platform";

/**
 * Two sliders for the Home app, because Apple Home's cleaning-mode menu does
 * not offer a change while the robot is running and the Roborock app does:
 * suction (the five levels) and mop water (off, then 1 to 30). Neither
 * Homebridge nor matter.js blocks a mid-run change, and the plugin applies one
 * (see changeCleanMode), so the lock is on the controller's side. These are
 * ordinary HomeKit fans and work at any time.
 */
export const CLEANING_CONTROLS_KIND = "cleaningControls" as const;

export type CleaningControlsContext = {
  duid: string;
  kind: typeof CLEANING_CONTROLS_KIND;
};

export function isCleaningControlsAccessory(accessory: {
  context?: unknown;
}): boolean {
  const context = accessory?.context as
    | Partial<CleaningControlsContext>
    | undefined;
  return Boolean(
    context &&
      typeof context === "object" &&
      context.kind === CLEANING_CONTROLS_KIND &&
      typeof context.duid === "string"
  );
}

export function cleaningControlsUuidSeed(duid: string): string {
  return `hap:roborock:cleaning-controls:${duid}`;
}

/** Suction levels in the order of the slider: 20 %, 40 %, 60 %, 80 %, 100 %. */
export const SUCTION_FAN_POWERS: readonly number[] = Object.keys(
  SUCTION_LEVEL_KEYS
)
  .map(Number)
  .sort((a, b) => a - b);

export function suctionToSpeed(fanPower: number | null): number | null {
  const index = SUCTION_FAN_POWERS.indexOf(fanPower ?? -1);
  return index < 0 ? null : (index + 1) * 20;
}

export function speedToSuction(speed: number): number {
  const index = Math.min(
    SUCTION_FAN_POWERS.length - 1,
    Math.max(0, Math.ceil(speed / 20) - 1)
  );
  return SUCTION_FAN_POWERS[index];
}

/** Water level 0 (off) to 30 on a 0 to 100 slider. */
export function waterToSpeed(level: number | null): number | null {
  return level === null
    ? null
    : Math.round((level * 100) / MOP_WATER_LEVEL_MAX);
}

export function speedToWater(speed: number): number {
  return Math.min(
    MOP_WATER_LEVEL_MAX,
    Math.max(0, Math.round((speed * MOP_WATER_LEVEL_MAX) / 100))
  );
}

/** What the vacuum accessory offers the sliders. */
export interface CleaningControlsRobot {
  getCleaningControlState(): {
    fanPower: number | null;
    waterLevel: number | null;
  };
  setSuctionFanPower(fanPower: number): Promise<void>;
  setMopWaterLevel(level: number): Promise<void>;
}

const SET_DELAY_MS = 600;
/** After a change, a status that has not caught up does not move the slider back. */
const HOLD_MS = 20_000;
const DEFAULT_WATER_LEVEL = 15;

type Slider = {
  subtype: "suction" | "water";
  name: string;
  service?: Service;
  timer?: ReturnType<typeof setTimeout>;
  holdUntil: number;
  speed: number;
};

export default class RoborockCleaningControlsAccessory {
  private readonly sliders: Slider[] = [
    { subtype: "suction", name: "Suction", holdUntil: 0, speed: 40 },
    { subtype: "water", name: "Mop Water", holdUntil: 0, speed: 50 },
  ];
  private lastWaterLevel = DEFAULT_WATER_LEVEL;
  private waterOn = true;

  constructor(
    private readonly platform: RoborockPlatform,
    public readonly accessory: PlatformAccessory,
    private readonly duid: string,
    private readonly robot: () => CleaningControlsRobot | undefined
  ) {
    this.configureAccessory();
  }

  configureAccessory(): void {
    const { Service: Svc, Characteristic } = this.platform;

    const information =
      this.accessory.getService(Svc.AccessoryInformation) ||
      this.accessory.addService(Svc.AccessoryInformation);
    information
      .setCharacteristic(Characteristic.Manufacturer, "Roborock")
      .setCharacteristic(
        Characteristic.Model,
        `${this.platform.getVacuumModel(this.duid)} Cleaning`
      )
      .setCharacteristic(
        Characteristic.SerialNumber,
        `${this.platform.getVacuumSerialNumber(this.duid)}-cleaning`
      );

    for (const slider of this.sliders) {
      const service =
        this.accessory.getServiceById(Svc.Fanv2, slider.subtype) ||
        this.accessory.addService(Svc.Fanv2, slider.name, slider.subtype);
      slider.service = service;
      applyServiceName(this.accessory, service, Characteristic, slider.name);
      this.accessory.displayName = "Cleaning";

      const active = service.getCharacteristic(Characteristic.Active);
      active.removeAllListeners("get");
      active.removeAllListeners("set");
      const speed = service.getCharacteristic(Characteristic.RotationSpeed);
      speed.removeAllListeners("get");
      speed.removeAllListeners("set");

      if (slider.subtype === "suction") {
        speed.setProps({ minValue: 0, maxValue: 100, minStep: 20 });
        active.onGet(() => 1);
        // Suction is never "off": put the switch back where it belongs.
        active.onSet(() => {
          setTimeout(() => {
            service.updateCharacteristic(Characteristic.Active, 1);
          }, 500).unref?.();
        });
      } else {
        speed.setProps({ minValue: 0, maxValue: 100, minStep: 1 });
        active.onGet(() => (this.waterOn ? 1 : 0));
        active.onSet((value) => {
          const on = Number(value) === 1;
          if (on === this.waterOn) return;
          this.waterOn = on;
          this.queue(slider, on ? this.lastWaterLevel : 0);
        });
      }

      speed.onGet(() => slider.speed);
      speed.onSet((value) => {
        const requested = Number(value);
        if (slider.subtype === "suction") {
          this.queue(slider, speedToSuction(requested));
        } else {
          const level = speedToWater(requested);
          if (level > 0) {
            this.lastWaterLevel = level;
            this.waterOn = true;
          }
          this.queue(slider, level);
        }
      });
    }
  }

  updateIdentity(_vacuumName: string): void {
    this.accessory.displayName = "Cleaning";
    for (const slider of this.sliders) {
      applyServiceName(
        this.accessory,
        slider.service,
        this.platform.Characteristic,
        slider.name
      );
    }
  }

  /** Adopt what the robot reports, unless a change is still on its way. */
  refresh(): void {
    const robot = this.robot();
    if (!robot) return;
    const { fanPower, waterLevel } = robot.getCleaningControlState();
    const now = Date.now();
    const { Characteristic } = this.platform;

    const suction = this.sliders[0];
    const suctionSpeed = suctionToSpeed(fanPower);
    if (suctionSpeed !== null && now >= suction.holdUntil) {
      suction.speed = suctionSpeed;
      suction.service?.updateCharacteristic(
        Characteristic.RotationSpeed,
        suctionSpeed
      );
    }

    const water = this.sliders[1];
    if (waterLevel !== null && now >= water.holdUntil) {
      if (waterLevel > 0) this.lastWaterLevel = waterLevel;
      this.waterOn = waterLevel > 0;
      water.speed = waterToSpeed(waterLevel) ?? water.speed;
      water.service?.updateCharacteristic(
        Characteristic.RotationSpeed,
        water.speed
      );
      water.service?.updateCharacteristic(
        Characteristic.Active,
        this.waterOn ? 1 : 0
      );
    }
  }

  /** The slider settles for a moment, then one command goes to the robot. */
  private queue(slider: Slider, value: number): void {
    if (slider.timer) clearTimeout(slider.timer);
    slider.holdUntil = Date.now() + HOLD_MS;
    if (slider.subtype === "suction") {
      slider.speed = suctionToSpeed(value) ?? slider.speed;
    } else {
      slider.speed = waterToSpeed(value) ?? slider.speed;
    }
    slider.timer = setTimeout(() => {
      slider.timer = undefined;
      const robot = this.robot();
      if (!robot) return;
      const apply =
        slider.subtype === "suction"
          ? robot.setSuctionFanPower(value)
          : robot.setMopWaterLevel(value);
      void apply.catch((error: unknown) => {
        slider.holdUntil = 0;
        this.platform.log.warn(
          `Could not change the ${slider.name.toLowerCase()} of the robot: ${
            error instanceof Error ? error.message : String(error)
          }`
        );
        this.refresh();
      });
    }, SET_DELAY_MS);
    slider.timer.unref?.();
  }

  dispose(): void {
    for (const slider of this.sliders) {
      if (slider.timer) clearTimeout(slider.timer);
      slider.timer = undefined;
    }
  }
}
