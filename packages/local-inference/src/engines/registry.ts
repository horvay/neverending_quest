/**
 * The engines NQ can run, and which one serves a model: the model's format
 * decides (an EXL3 folder runs on exl3xpu, a GGUF on Atomic), and a running
 * engine is known by its run record's `engine` field.
 */
import type { InstalledLocalModel } from "../installation.ts";
import { atomicEngine } from "./atomic.ts";
import type { Engine, EngineName } from "./engine.ts";
import { exl3xpuEngine } from "./exl3xpu.ts";

/** Every engine; each serves its own model format. */
export const ENGINES: readonly Engine[] = [atomicEngine, exl3xpuEngine];

/** The engine for a model; Atomic when none other claims it (or there is none). */
export function engineForModel(model: InstalledLocalModel | undefined): Engine {
  if (!model) return atomicEngine;
  return ENGINES.find((engine) => engine.serves(model)) ?? atomicEngine;
}

/**
 * The engine a record names. Records leave Atomic unnamed, because older NQ
 * versions read any other value as a broken record.
 */
export function engineNamed(name: EngineName | undefined): Engine {
  return ENGINES.find((engine) => engine.name === name) ?? atomicEngine;
}

/** How a record names an engine: Atomic not at all, see `engineNamed`. */
export function recordedEngineName(
  engine: Engine,
): Exclude<EngineName, "atomic"> | undefined {
  return engine.name === "atomic" ? undefined : engine.name;
}
