/**
 * A stand-in robot vacuum that does nothing but report what Apple Home asks
 * of it (matterModeProbe in config.json; not on the settings page).
 *
 * Apple Home names clean modes after their tags and decides where each goes in
 * its menus, and none of it is documented. Learning it on the real robot costs
 * its owner a remove-and-re-pair per guess. This accessory announces every
 * primary tag (Vacuum, Mop, both, vacuum-then-mop) with every intensity tag,
 * so one pairing shows all of Apple's names and their order, and each tap is
 * logged with the mode id and tags it chose. Nothing is ever sent to a robot.
 */

const TAG = {
  AUTO: 0,
  QUICK: 1,
  QUIET: 2,
  LOW_NOISE: 3,
  LOW_ENERGY: 4,
  VACATION: 5,
  MIN: 6,
  MAX: 7,
  NIGHT: 8,
  DAY: 9,
  DEEP_CLEAN: 16384,
  VACUUM: 16385,
  MOP: 16386,
  VACUUM_THEN_MOP: 16387,
} as const;

const PRIMARIES: ReadonlyArray<{ key: string; name: string; tags: number[] }> =
  [
    { key: "A", name: "Vacuum", tags: [TAG.VACUUM] },
    { key: "B", name: "Mop", tags: [TAG.MOP] },
    { key: "C", name: "Vac+Mop", tags: [TAG.VACUUM, TAG.MOP] },
    {
      key: "D",
      name: "Vac+Mop+VTM",
      tags: [TAG.VACUUM, TAG.MOP, TAG.VACUUM_THEN_MOP],
    },
    { key: "E", name: "VTM", tags: [TAG.VACUUM_THEN_MOP] },
  ];

const INTENSITIES: ReadonlyArray<{ name: string; tag: number }> = [
  { name: "Auto", tag: TAG.AUTO },
  { name: "Quick", tag: TAG.QUICK },
  { name: "Quiet", tag: TAG.QUIET },
  { name: "LowNoise", tag: TAG.LOW_NOISE },
  { name: "LowEnergy", tag: TAG.LOW_ENERGY },
  { name: "Vacation", tag: TAG.VACATION },
  { name: "Min", tag: TAG.MIN },
  { name: "Max", tag: TAG.MAX },
  { name: "Night", tag: TAG.NIGHT },
  { name: "Day", tag: TAG.DAY },
  { name: "DeepClean", tag: TAG.DEEP_CLEAN },
];

export type ProbeMode = {
  label: string;
  mode: number;
  modeTags: Array<{ value: number }>;
};

/** Mode id = primary index × 12 + (0 plain, 1–11 the intensities in order). */
export function buildProbeModes(): ProbeMode[] {
  const modes: ProbeMode[] = [];
  PRIMARIES.forEach((primary, p) => {
    modes.push({
      label: `${primary.key}0 ${primary.name}`,
      mode: p * 12,
      modeTags: primary.tags.map((value) => ({ value })),
    });
    INTENSITIES.forEach((intensity, i) => {
      modes.push({
        label: `${primary.key}${i + 1} ${primary.name} ${intensity.name}`,
        mode: p * 12 + i + 1,
        modeTags: [...primary.tags, intensity.tag].map((value) => ({ value })),
      });
    });
  });
  return modes;
}

export const MODE_PROBE_UUID_SEED = "homebridge-roborock-matter:mode-probe";

export function isModeProbeAccessory(accessory: any): boolean {
  return accessory?.context?.modeProbe === true;
}

/**
 * The accessory Homebridge publishes. `onUpdate` pushes a new current mode
 * back so the tile shows the tick where it was tapped.
 */
export function buildModeProbeAccessory(options: {
  uuid: string;
  deviceType: unknown;
  log: { info(message: string): void };
  update: (cluster: string, attributes: Record<string, unknown>) => void;
}): any {
  const modes = buildProbeModes();
  const describe = (id: unknown): string => {
    const mode = modes.find((entry) => entry.mode === id);
    return mode
      ? `${mode.mode} = "${mode.label}" (tags ${mode.modeTags.map((tag) => tag.value).join("/")})`
      : `${String(id)} (not announced)`;
  };
  const note = (what: string) => options.log.info(`[Mode probe] ${what}`);

  return {
    UUID: options.uuid,
    displayName: "Mode Probe",
    name: "Mode Probe",
    serialNumber: "MODE-PROBE-1",
    manufacturer: "Homebridge",
    model: "Mode Probe",
    deviceType: options.deviceType,
    context: { modeProbe: true },
    features: { rvcCleanMode: { directModeChange: true } },
    clusters: {
      rvcRunMode: {
        supportedModes: [
          { label: "Idle", mode: 0, modeTags: [{ value: 16384 }] },
          { label: "Cleaning", mode: 1, modeTags: [{ value: 16385 }] },
        ],
        currentMode: 0,
      },
      rvcCleanMode: { supportedModes: modes, currentMode: 0 },
      rvcOperationalState: {
        phaseList: null,
        currentPhase: null,
        operationalStateList: [0, 1, 2, 3].map((operationalStateId) => ({
          operationalStateId,
        })),
        operationalState: 0,
      },
    },
    handlers: {
      identify: { identify: async () => note("identify") },
      rvcCleanMode: {
        changeToMode: async (request?: { newMode?: number }) => {
          note(`Apple Home chose clean mode ${describe(request?.newMode)}`);
          options.update("rvcCleanMode", { currentMode: request?.newMode });
        },
      },
      rvcRunMode: {
        changeToMode: async (request?: { newMode?: number }) => {
          note(`Apple Home chose run mode ${String(request?.newMode)}`);
          options.update("rvcRunMode", { currentMode: request?.newMode });
        },
      },
      rvcOperationalState: {
        pause: async () => note("pause"),
        resume: async () => note("resume"),
        goHome: async () => note("go home"),
      },
    },
  };
}
