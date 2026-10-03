import { localPainter } from "@nq/local-inference/painter.ts";
import { describe, expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { HttpApp } from "@effect/platform";
import {
  CampaignError,
  listTrackedFiles,
  readTranscript,
} from "../../src/campaign/index.ts";
import { playSessionLayer } from "../../src/play/index.ts";
import { serveHttpApp } from "../../src/surfaces/web/http.ts";
import {
  ILLUSTRATION_BTW_PREFIX,
  illustrationCandidateAbs,
  illustrationRel,
} from "../../src/play/illustration.ts";
import { birthCampaign } from "../helpers/campaign.ts";
import { makeTempDir, rmTempDir } from "../helpers/fs.ts";
import {
  scriptedGameMaster,
  type ScriptedGameMaster,
} from "../helpers/game_master.ts";
import { NativeRequest } from "./native_request.ts";

const ORIGIN = "http://127.0.0.1:7737";
const HOST = { Origin: ORIGIN, Host: "127.0.0.1:7737" };

const PNG_1x1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

/** The looker's reply; the Play Loop normalises `_` to spaces. */
const LOOKER_REPLY =
  "masterpiece, best quality, safe, pov, pov hands, full_body, 1girl, elf, waterfall, rocks";
const LOOKER_PROMPT =
  "masterpiece, best quality, safe, pov, pov hands, full body, 1girl, elf, waterfall, rocks";

/** The real Game Master over a scripted model that answers the illustration lookup. */
async function illustratingGm(): Promise<ScriptedGameMaster> {
  return scriptedGameMaster({
    fallback: (c) =>
      c.say(
        c.instruction.startsWith(ILLUSTRATION_BTW_PREFIX) ? LOOKER_REPLY : "ok",
      ),
  });
}

describe("illustration HTTP", () => {
  test("GET status is not ready without a runner; missing PNG is 404", async () => {
    const root = await makeTempDir();
    try {
      const campaign = await birthCampaign(root);
      const layer = playSessionLayer({
        path: campaign,
        factory: (await illustratingGm()).factory,
        illustrator: localPainter({ animaDir: `${root}/missing-tools` }),
      });
      const { handler, dispose } = HttpApp.toWebHandlerLayer(
        serveHttpApp,
        layer,
      );
      try {
        const status = await handler(
          new NativeRequest("http://127.0.0.1:7737/api/illustration"),
        );
        expect(status.status).toBe(200);
        const body = (await status.json()) as { ready: boolean };
        expect(body.ready).toBe(false);

        const missing = await handler(
          new NativeRequest(
            "http://127.0.0.1:7737/api/illustrations/2026-08-18T12:00:00.000Z",
          ),
        );
        expect(missing.status).toBe(404);

        const traversal = await handler(
          new NativeRequest(
            "http://127.0.0.1:7737/api/illustrations/..%2Fplayer_sheet.md",
          ),
        );
        expect(traversal.status).toBe(404);
      } finally {
        await dispose();
      }
    } finally {
      await rmTempDir(root);
    }
  });

  test("POST illustrate writes a PNG and does not track it", async () => {
    const root = await makeTempDir();
    try {
      const campaign = await birthCampaign(root, {
        seed: "# Seed\n\n## Opening message\n\nWater hits the rocks.\n",
      });
      const gmModel = await illustratingGm();
      const layer = playSessionLayer({
        path: campaign,
        factory: gmModel.factory,
        illustrator: { paintOne: async ({ outPath }) => {
          await mkdir(path.dirname(outPath), { recursive: true });
          await writeFile(outPath, PNG_1x1);
        } },
      });
      const { handler, dispose } = await HttpApp.toWebHandlerLayer(
        serveHttpApp,
        layer,
      );
      try {
        const created = await handler(
          new NativeRequest("http://127.0.0.1:7737/api/illustration", {
            method: "POST",
            headers: HOST,
          }),
        );
        expect(created.status).toBe(200);
        const body = (await created.json()) as { ts: string; prompt: string };
        expect(body.prompt).toBe(LOOKER_PROMPT);
        // the looker was asked about the opening scene
        const lookup = gmModel.calls.find((c) =>
          c.instruction.startsWith(ILLUSTRATION_BTW_PREFIX),
        );
        expect(lookup!.instruction).toContain(
          "Current scene:\nWater hits the rocks.",
        );

        const rows = await readTranscript(campaign);
        const gm = [...rows].reverse().find((row) => row.role === "gm");
        expect(gm?.ts).toBe(body.ts);
        expect(gm?.illustration).toBeUndefined();

        const missingOfficial = await handler(
          new NativeRequest(
            `http://127.0.0.1:7737/api/illustrations/${encodeURIComponent(body.ts)}`,
          ),
        );
        expect(missingOfficial.status).toBe(404);

        const candidate = await handler(
          new NativeRequest(
            `http://127.0.0.1:7737/api/illustrations/${encodeURIComponent(body.ts)}?slot=0`,
          ),
        );
        expect(candidate.status).toBe(200);
        expect(candidate.headers.get("content-type")).toContain("image/png");
        expect(Buffer.from(await candidate.arrayBuffer()).equals(PNG_1x1)).toBe(
          true,
        );
        expect(
          await Bun.file(illustrationCandidateAbs(campaign, body.ts, 0)).exists(),
        ).toBe(true);

        const picked = await handler(
          new NativeRequest("http://127.0.0.1:7737/api/illustration/pick", {
            method: "POST",
            headers: { ...HOST, "content-type": "application/json" },
            body: JSON.stringify({ slot: 0 }),
          }),
        );
        expect(picked.status).toBe(200);

        const stamped = await readTranscript(campaign);
        const stampedGm = stamped.find((row) => row.ts === body.ts);
        expect(stampedGm?.illustration).toBe(body.ts);
        expect(stampedGm?.illustrationPrompt).toBe(body.prompt);

        const png = await handler(
          new NativeRequest(
            `http://127.0.0.1:7737/api/illustrations/${encodeURIComponent(body.ts)}`,
          ),
        );
        expect(png.status).toBe(200);
        expect(png.headers.get("content-type")).toContain("image/png");
        expect(Buffer.from(await png.arrayBuffer()).equals(PNG_1x1)).toBe(true);
        expect(
          await Bun.file(path.join(campaign, illustrationRel(body.ts))).exists(),
        ).toBe(true);

        const tracked = await listTrackedFiles(campaign);
        expect(tracked.some((f) => f.startsWith("illustrations/"))).toBe(false);
      } finally {
        await dispose();
      }
    } finally {
      await rmTempDir(root);
    }
  });

  test("POST illustrate with prompt skips the rewrite", async () => {
    const root = await makeTempDir();
    try {
      const campaign = await birthCampaign(root, {
        seed: "# Seed\n\n## Opening message\n\nWater hits the rocks.\n",
      });
      const seen: string[] = [];
      const gmModel = await illustratingGm();
      const layer = playSessionLayer({
        path: campaign,
        factory: gmModel.factory,
        illustrator: { paintOne: async ({ prompt, outPath }) => {
          seen.push(prompt);
          await mkdir(path.dirname(outPath), { recursive: true });
          await writeFile(outPath, PNG_1x1);
        } },
      });
      const { handler, dispose } = await HttpApp.toWebHandlerLayer(
        serveHttpApp,
        layer,
      );
      try {
        const given =
          "pov, pov hands, cowboy_shot, 1girl, elf, lake, night";
        const parsed =
          "pov, pov hands, cowboy shot, 1girl, elf, lake, night";
        const created = await handler(
          new NativeRequest("http://127.0.0.1:7737/api/illustration", {
            method: "POST",
            headers: { ...HOST, "content-type": "application/json" },
            body: JSON.stringify({ prompt: given }),
          }),
        );
        expect(created.status).toBe(200);
        const body = (await created.json()) as { ts: string; prompt: string };
        expect(body.prompt).toBe(parsed);
        expect(seen).toEqual([parsed, parsed, parsed, parsed]);
        // no lookup pass reached the model
        expect(gmModel.calls).toHaveLength(0);
        const picked = await handler(
          new NativeRequest("http://127.0.0.1:7737/api/illustration/pick", {
            method: "POST",
            headers: { ...HOST, "content-type": "application/json" },
            body: JSON.stringify({ slot: 2 }),
          }),
        );
        expect(picked.status).toBe(200);
        const rows = await readTranscript(campaign);
        const gm = [...rows].reverse().find((row) => row.role === "gm");
        expect(gm?.illustrationPrompt).toBe(parsed);
      } finally {
        await dispose();
      }
    } finally {
      await rmTempDir(root);
    }
  });

  test("overlapping POST illustrate is 409", async () => {
    const root = await makeTempDir();
    try {
      const campaign = await birthCampaign(root, {
        seed: "# Seed\n\n## Opening message\n\nWater hits the rocks.\n",
      });
      const started = Promise.withResolvers<void>();
      const gate = Promise.withResolvers<void>();
      const layer = playSessionLayer({
        path: campaign,
        factory: (await illustratingGm()).factory,
        illustrator: { paintOne: async ({ outPath }) => {
          started.resolve();
          await gate.promise;
          await mkdir(path.dirname(outPath), { recursive: true });
          await writeFile(outPath, PNG_1x1);
        } },
      });
      const { handler, dispose } = await HttpApp.toWebHandlerLayer(
        serveHttpApp,
        layer,
      );
      try {
        const firstP = handler(
          new NativeRequest("http://127.0.0.1:7737/api/illustration", {
            method: "POST",
            headers: HOST,
          }),
        );
        const overlapP = started.promise.then(() =>
          handler(
            new NativeRequest("http://127.0.0.1:7737/api/illustration", {
              method: "POST",
              headers: HOST,
            }),
          ),
        );
        const overlap = await overlapP;
        expect(overlap.status).toBe(409);
        gate.resolve();
        const created = await firstP;
        expect(created.status).toBe(200);
      } finally {
        gate.resolve();
        await dispose();
      }
    } finally {
      await rmTempDir(root);
    }
  });

  test("POST without a runner is 503; generate_failed is 500 with error", async () => {
    const root = await makeTempDir();
    try {
      const campaign = await birthCampaign(root, {
        seed: "# Seed\n\n## Opening message\n\nWater hits the rocks.\n",
      });
      const missing = playSessionLayer({
        path: campaign,
        factory: (await illustratingGm()).factory,
        illustrator: localPainter({ animaDir: `${root}/missing-tools` }),
      });
      const { handler: missingHandler, dispose: disposeMissing } =
        await HttpApp.toWebHandlerLayer(serveHttpApp, missing);
      try {
        const unavailable = await missingHandler(
          new NativeRequest("http://127.0.0.1:7737/api/illustration", {
            method: "POST",
            headers: HOST,
          }),
        );
        expect(unavailable.status).toBe(503);
        const unavailableBody = (await unavailable.json()) as { error?: string };
        expect(unavailableBody.error).toMatch(/sd-cli|GGUF|runner/i);
      } finally {
        await disposeMissing();
      }

      const failing = playSessionLayer({
        path: campaign,
        factory: (await illustratingGm()).factory,
        illustrator: { paintOne: async () => {
          throw new CampaignError("generate_failed", "sd-cli exploded");
        } },
      });
      const { handler, dispose } = await HttpApp.toWebHandlerLayer(
        serveHttpApp,
        failing,
      );
      try {
        const failed = await handler(
          new NativeRequest("http://127.0.0.1:7737/api/illustration", {
            method: "POST",
            headers: HOST,
          }),
        );
        expect(failed.status).toBe(500);
        const body = (await failed.json()) as { error?: string };
        expect(body.error).toBe("sd-cli exploded");
      } finally {
        await dispose();
      }
    } finally {
      await rmTempDir(root);
    }
  });
});
