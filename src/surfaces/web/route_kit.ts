/**
 * The pieces every state-changing route shares: the same-origin guard, a JSON
 * body read as a plain record, and typed field readers that say "400" by
 * returning undefined. Routes stay a few lines each.
 */
import {
  HttpServerRequest,
  HttpServerResponse,
} from "@effect/platform";
import { Effect } from "effect";
import { sameOriginOk } from "./origin.ts";

export type Body = Record<string, unknown>;

/** 403 unless the request comes from the page this server handed out. */
export const requireOrigin = Effect.gen(function* () {
  const req = yield* HttpServerRequest.HttpServerRequest;
  if (!sameOriginOk(req)) {
    return yield* HttpServerResponse.empty({ status: 403 });
  }
  return null;
});

function asRecord(raw: unknown): Body {
  return raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Body) : {};
}

/** The JSON body as a record; a malformed body fails the request. */
export const jsonBody = Effect.gen(function* () {
  const req = yield* HttpServerRequest.HttpServerRequest;
  return asRecord(yield* req.json);
});

/** The JSON body as a record, or `{}` when there is none (or it is malformed). */
export const optionalJsonBody = Effect.gen(function* () {
  const req = yield* HttpServerRequest.HttpServerRequest;
  return asRecord(yield* req.json.pipe(Effect.orElseSucceed(() => ({}))));
});

/** Sentinel a parser returns for a 400. */
export const BAD = Symbol("bad request");
export type Parsed<A> = A | typeof BAD;

export function str(body: Body, key: string): string | undefined {
  const value = body[key];
  return typeof value === "string" ? value : undefined;
}

/** Absent is fine; present and not a string is a bad request. */
export function optStr(body: Body, key: string): Parsed<string | undefined> {
  const value = body[key];
  if (value === undefined) return undefined;
  return typeof value === "string" ? value : BAD;
}

export function int(body: Body, key: string): number | undefined {
  const value = body[key];
  return typeof value === "number" && Number.isInteger(value) ? value : undefined;
}

export const noContent = HttpServerResponse.empty({ status: 204 });
export const accepted = HttpServerResponse.empty({ status: 202 });
export const badRequest = HttpServerResponse.empty({ status: 400 });
export const conflict = HttpServerResponse.empty({ status: 409 });
