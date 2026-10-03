import { useEffect, useMemo, useState } from "preact/hooks";
import type { AlmanacEntry } from "@nq/local-inference/almanac.ts";
import type { AlmanacModel } from "../../../../home/almanac_pages.ts";
import { api } from "../api_client.ts";

export type AlmanacData = {
  entries: AlmanacEntry[];
  models: AlmanacModel[];
};

/** The Almanac as the Home page sees it, with the player's writes. */
export function useAlmanac() {
  const [data, setData] = useState<AlmanacData | null>(null);
  const [error, setError] = useState<string | undefined>();
  const reload = async () => {
    const reply = await api.almanac();
    if (reply.ok) setData(reply.body);
    else setError("Could not read the Almanac.");
  };
  useEffect(() => {
    void reload();
  }, []);
  const save = async (entry: Partial<AlmanacEntry>): Promise<AlmanacEntry | undefined> => {
    setError(undefined);
    const reply = await api.saveAlmanacEntry(entry);
    if (!reply.ok) {
      setError(reply.error ?? "Could not write to the Almanac.");
      return undefined;
    }
    setData(reply.body.almanac);
    return reply.body.entry;
  };
  const remove = async (id: string): Promise<boolean> => {
    setError(undefined);
    const reply = await api.deleteAlmanacEntry(id);
    if (!reply.ok) {
      setError(
        reply.status === 0
          ? "Could not tear out that entry."
          : (reply.error ?? "Could not write to the Almanac."),
      );
      return false;
    }
    setData(reply.body);
    return true;
  };
  const yours = useMemo(
    () => (data?.entries ?? []).filter((entry) => entry.source === "yours"),
    [data],
  );
  // the server's whole Almanac: a page left open across an update still
  // reads the running server's book, not the one it was built with
  const all = data?.entries ?? [];
  return { data, yours, all, error, reload, save, remove };
}

export type AlmanacApi = ReturnType<typeof useAlmanac>;
