import { DiceRoller, type Die } from "@gnuton/css-dice-roller";
import type { CssDieType } from "../../../play/dice.ts";

const PERCENTILE_TENS: Record<number, string> = {
  1: "10",
  2: "20",
  3: "30",
  4: "40",
  5: "50",
  6: "60",
  7: "70",
  8: "80",
  9: "90",
  10: "00",
};

const PERCENTILE_ONES: Record<number, string> = {
  1: "1",
  2: "2",
  3: "3",
  4: "4",
  5: "5",
  6: "6",
  7: "7",
  8: "8",
  9: "9",
  10: "0",
};

export async function castDie(
  container: HTMLElement,
  type: CssDieType,
  value: number,
  signal?: AbortSignal,
): Promise<() => void> {
  const roller = createRoller(container, 148);
  const [die] = roller.addDie(type);
  if (!die) {
    roller.clear();
    return () => {};
  }

  const dispose = bindDisposal(roller, signal);
  if (signal?.aborted) return dispose;
  if (reducedMotion()) {
    die.setResult(value);
    return dispose;
  }

  await rollDieTo(die, value, Number(type.slice(1)));
  if (!signal?.aborted) die.setResult(value);
  return dispose;
}

export async function castPercentile(
  container: HTMLElement,
  value: number,
  signal?: AbortSignal,
): Promise<() => void> {
  const roller = createRoller(container, 96);
  const [tensDie, onesDie] = roller.addDie("d10", 2);
  if (!tensDie || !onesDie) {
    roller.clear();
    return () => {};
  }
  tensDie.updateSettings({ faceLabels: PERCENTILE_TENS });
  onesDie.updateSettings({ faceLabels: PERCENTILE_ONES });

  const dispose = bindDisposal(roller, signal);
  if (signal?.aborted) return dispose;
  const [tens, ones] = percentileFaces(value);
  if (reducedMotion()) {
    tensDie.setResult(tens);
    onesDie.setResult(ones);
    return dispose;
  }

  await Promise.all([
    rollDieTo(tensDie, tens, 10),
    rollDieTo(onesDie, ones, 10),
  ]);
  if (!signal?.aborted) {
    tensDie.setResult(tens);
    onesDie.setResult(ones);
  }
  return dispose;
}

function createRoller(container: HTMLElement, scale: number): DiceRoller {
  const roller = new DiceRoller(container, scale);
  roller.updateSettings({
    theme: "theme-solid",
    baseColor: "#f4ead3",
    textColor: "#12100c",
    secondaryColor: "#7a2e14",
    animation: "standard",
    speed: 1.7,
    dragEnabled: false,
    scale,
  });
  return roller;
}

function bindDisposal(
  roller: DiceRoller,
  signal?: AbortSignal,
): () => void {
  const dispose = () => roller.clear();
  signal?.addEventListener("abort", dispose, { once: true });
  return dispose;
}

function reducedMotion(): boolean {
  return (
    typeof matchMedia === "function" &&
    matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

function percentileFaces(value: number): [tens: number, ones: number] {
  const normalized = value === 100 ? 0 : value;
  const tens = Math.floor(normalized / 10);
  const ones = normalized % 10;
  return [tens === 0 ? 10 : tens, ones === 0 ? 10 : ones];
}

function rollDieTo(die: Die, value: number, faces: number): Promise<number> {
  const restore = Math.random;
  try {
    Math.random = () => (value - 0.5) / faces;
    return die.roll();
  } finally {
    Math.random = restore;
  }
}
