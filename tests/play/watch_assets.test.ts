import { describe, expect, test } from "bun:test";
import { HttpApp, HttpRouter } from "@effect/platform";
import { Layer } from "effect";
import {
  attachWebAssets,
  createLiveAssets,
  withWatchClient,
  type WebAssets,
} from "../../src/surfaces/web/serve.ts";

describe("watch assets", () => {
  test("watch client is injected once", () => {
    const html = "<html><body><div id=\"root\"></div></body></html>";
    const once = withWatchClient(html);
    expect(once).toContain("/__watch");
    expect(withWatchClient(once)).toBe(once);
  });

  test("live /book.css and /__watch serve the current generation", async () => {
    const first: WebAssets = {
      html: "<html><body></body></html>",
      css: "body{color:red}",
      js: "console.log(1)",
    };
    const live = createLiveAssets(first);
    const routes = attachWebAssets(HttpRouter.empty, live.get, live);
    const { handler, dispose } = HttpApp.toWebHandlerLayer(
      routes,
      Layer.empty,
    );
    try {
      const css = await handler(
        new Request("http://127.0.0.1:7737/book.css"),
      );
      expect(await css.text()).toBe("body{color:red}");

      const banner = await handler(
        new Request("http://127.0.0.1:7737/dice/banner.png"),
      );
      expect(banner.status).toBe(200);
      expect(banner.headers.get("content-type")).toContain("image/png");

      const well = await handler(
        new Request("http://127.0.0.1:7737/ink/well.png"),
      );
      expect(well.status).toBe(200);
      expect(well.headers.get("content-type")).toContain("image/png");

      const brush = await handler(
        new Request("http://127.0.0.1:7737/ink/brush.png"),
      );
      expect(brush.status).toBe(200);
      expect(brush.headers.get("content-type")).toContain("image/png");

      const easel = await handler(
        new Request("http://127.0.0.1:7737/ink/easel.png"),
      );
      expect(easel.status).toBe(200);
      expect(easel.headers.get("content-type")).toContain("image/png");

      const studio = await handler(
        new Request("http://127.0.0.1:7737/ink/studio-easel.png"),
      );
      expect(studio.status).toBe(200);
      expect(studio.headers.get("content-type")).toContain("image/png");

      const desk = await handler(
        new Request("http://127.0.0.1:7737/ink/desk.jpg"),
      );
      expect(desk.status).toBe(200);
      expect(desk.headers.get("content-type")).toContain("image/jpeg");

      const page = await handler(new Request("http://127.0.0.1:7737/"));
      expect(await page.text()).toContain("/__watch");

      const before = await handler(
        new Request("http://127.0.0.1:7737/__watch?since=0"),
      );
      const start = (await before.json()) as { gen: number };
      expect(start.gen).toBeGreaterThan(0);
    } finally {
      live.stop();
      await dispose();
    }
  });
});
