import { useRef, useState } from "preact/hooks";
import { dieTypeForN } from "../../../play/dice.ts";
import type { DiceCast } from "./dice_overlay.tsx";

/** Rolls play one at a time on the dice overlay; later ones queue behind. */
export function useDiceCasts() {
  const [cast, setCast] = useState<DiceCast | null>(null);
  const queue = useRef<Array<{ n: number; value: number; reason?: string }>>([]);
  const key = useRef(0);
  const casting = useRef(false);

  function show(n: number, value: number, reason?: string) {
    if (!dieTypeForN(n)) return;
    if (casting.current) {
      queue.current.push({ n, value, reason });
      return;
    }
    casting.current = true;
    setCast({ n, value, reason, key: ++key.current });
  }

  function done() {
    const next = queue.current.shift();
    if (!next) {
      casting.current = false;
      setCast(null);
      return;
    }
    setCast({ ...next, key: ++key.current });
  }

  return { cast, show, done };
}
