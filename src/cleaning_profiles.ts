/**
 * What the Roborock app calls its cleaning settings, as the robot reports and
 * accepts them. Measured on a P20 Ultra Plus (roborock.vacuum.a225) by
 * changing each setting in the Roborock app and reading the status that came
 * back (4 Oct 2026); the codes are the same family python-roborock lists.
 *
 *   fan_power        101 quiet · 102 standard · 103 strong · 104 max · 108 max+
 *   water_box_mode   200 off · 221…250 = mop water level 1…30 (220 + level)
 *   mop_mode         300 standard · 303 fine · 304 fast  (清洁效率)
 *   seq_type         0 vacuum and mop together · 1 vacuum first, then mop
 *   repeat           1 or 2 passes (清洁次数)
 *
 * Max+ is vacuum-only in the Roborock app: choosing it there sets the water
 * to 200 and the sequence to 0.
 */

export type MopEfficiency = "follow" | "standard" | "fine" | "fast";

/** 清洁效率: 标准 / 精细 / 高效动态. */
export const MOP_MODE_CODES: Record<
  Exclude<MopEfficiency, "follow">,
  number
> = {
  standard: 300,
  fine: 303,
  fast: 304,
};

/** 拖地水量 level 1…30 is sent as 220 + level. */
export const MOP_WATER_LEVEL_BASE = 220;
export const MOP_WATER_LEVEL_MIN = 1;
export const MOP_WATER_LEVEL_MAX = 30;

/** The five suction levels, by the code the robot uses, and the key the settings page uses. */
export const SUCTION_LEVEL_KEYS: Record<number, SuctionLevelKey> = {
  101: "quiet",
  102: "standard",
  103: "strong",
  104: "max",
  108: "maxPlus",
};

export type SuctionLevelKey =
  | "quiet"
  | "standard"
  | "strong"
  | "max"
  | "maxPlus";

export type CleaningProfileConfig = {
  efficiency?: MopEfficiency;
  /** "follow" or 1 / 2. */
  repeat?: "follow" | number | string;
  /** "follow" or 1…30. */
  mopWater?: "follow" | number | string;
};

export type CleaningProfiles = Partial<
  Record<SuctionLevelKey, CleaningProfileConfig>
>;

export type ResolvedCleaningProfile = {
  /** Value for set_mop_mode. */
  mopMode?: number;
  /** Value for set_clean_repeat_times. */
  repeatTimes?: number;
  /** Value for water_box_mode (220 + level). */
  waterBoxMode?: number;
};

function asInteger(value: unknown): number | null {
  if (value === "follow" || value === undefined || value === null) {
    return null;
  }
  const n = typeof value === "number" ? value : Number(value);
  return Number.isInteger(n) ? n : null;
}

/**
 * The settings a clean at this suction level should carry, or nothing for the
 * parts left on "follow the Roborock app". Max+ never gets a water level: it
 * only vacuums.
 */
export function resolveCleaningProfile(
  profiles: CleaningProfiles | undefined,
  fanPower: number | undefined
): ResolvedCleaningProfile {
  if (!profiles || typeof fanPower !== "number") {
    return {};
  }
  const key = SUCTION_LEVEL_KEYS[fanPower];
  const profile = key ? profiles[key] : undefined;
  if (!profile || typeof profile !== "object") {
    return {};
  }

  const resolved: ResolvedCleaningProfile = {};

  const efficiency = profile.efficiency;
  if (efficiency && efficiency !== "follow" && efficiency in MOP_MODE_CODES) {
    resolved.mopMode = MOP_MODE_CODES[efficiency];
  }

  const repeat = asInteger(profile.repeat);
  if (repeat === 1 || repeat === 2) {
    resolved.repeatTimes = repeat;
  }

  const water = asInteger(profile.mopWater);
  if (
    water !== null &&
    water >= MOP_WATER_LEVEL_MIN &&
    water <= MOP_WATER_LEVEL_MAX &&
    key !== "maxPlus"
  ) {
    resolved.waterBoxMode = MOP_WATER_LEVEL_BASE + water;
  }

  return resolved;
}
