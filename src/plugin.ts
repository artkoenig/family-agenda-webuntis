import { createHmac } from "node:crypto";
import { ProxyAgent } from "undici";
import type { IngestResult, RunContext, SourceRecord } from "@family-agenda/plugin-contract";
import { PluginError, type PluginImplementation } from "@family-agenda/plugin-kit";
import packageJson from "../package.json" with { type: "json" };
import { isObject, localDate, seenIn, text, timetableRequest, type JsonObject } from "./timetable";

/**
 * What `fetch` is given to route a request through a proxy, as the global `fetch` types it. Taken
 * from there rather than from `undici`, whose own declaration is a second, incompatible copy.
 */
export type FetchDispatcher = NonNullable<RequestInit["dispatcher"]>;

export type WebUntisPluginOptions = {
  /** How the plugin reaches WebUntis; recorded responses in tests. */
  fetch?: typeof globalThis.fetch;
  /** How a call's egress proxy becomes a dispatcher; a `ProxyAgent` of `undici` outside tests. */
  dispatcherFor?: (egressProxy: string) => FetchDispatcher;
  /** How long a request may take before the run fails. */
  timeoutMs?: number;
};

/** The plugin's own version: that of package.json, raised with each release. */
export const version: string = packageJson.version;

/** How many days of Timetable each run reads, today included. */
const daysAhead = 14;

/**
 * The sync cursor: the ids of the children declared as Source Attributes, and the day of every
 * Lesson of the days read, by key, to notice those that go. A cursor from before the children were
 * Source Attributes has no `declared`.
 */
type State = { declared: string[] | null; known: Record<string, string> };

type Child = { id: number; name: string };

/** The version of the Untis Mobile API the plugin speaks, as the app sends it. */
const apiVersion = "i2.2";

/** The JSON-RPC id of every request. */
const requestId = "family-agenda";

/**
 * The run as the plugin uses it: the contract's context with its time as a Date, and the egress
 * proxy of the call at hand, whose ticket allows this one Source's server (contract 3.0).
 */
type Run = { config: RunContext["config"]; now: Date; egressProxy: string };

/**
 * Reads the Timetables of the children of a WebUntis parent account through the endpoints of the
 * Untis Mobile app. The account is one Source and each child one Source Attribute, declared under
 * the child's Untis id, which an Admin assigns to a Family Member; every run compares the children
 * with those declared, declaring new ones and archiving those that are gone. Unverified: whether
 * the ids stay the same over the school-year rollover. If they change, the children appear as new
 * Source Attributes to assign, and the old ones are archived.
 * It authenticates each request with a one-time password from the key the account shares with
 * Untis Mobile (`docs/research/webuntis-parent-access.md` of Family Agenda). One login lists the
 * children; each child's Timetable is then read as a STUDENT's. Each run states every Lesson of the
 * days read whole, with how it deviates from the Timetable as the Untis flags tell, keyed by child
 * and the id Untis gives the Lesson; the core skips those that are unchanged.
 */
export function createWebUntisPlugin(options: WebUntisPluginOptions = {}): PluginImplementation {
  const fetch = options.fetch ?? globalThis.fetch;
  const dispatcherFor = options.dispatcherFor ?? ((egressProxy: string) => new ProxyAgent(egressProxy) as unknown as FetchDispatcher);
  const timeoutMs = options.timeoutMs ?? 30_000;

  /** Calls a method of the mobile API with a fresh one-time password, and returns its result. */
  async function call(run: Run, method: string, params: JsonObject): Promise<JsonObject> {
    const { server, school, user } = connectionOf(run.config);
    const url = new URL(`https://${server}/WebUntis/jsonrpc_intern.do`);
    url.searchParams.set("m", method);
    url.searchParams.set("school", school);
    url.searchParams.set("v", apiVersion);
    const auth = { user, otp: oneTimePassword(keyOf(run.config), run.now), clientTime: run.now.getTime() };
    let response: Response;
    try {
      response = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: requestId, method, params: [{ ...params, auth }], jsonrpc: "2.0" }),
        signal: AbortSignal.timeout(timeoutMs),
        dispatcher: dispatcherFor(run.egressProxy),
      });
    } catch (error) {
      throw new PluginError("temporary", `WebUntis could not be reached${reasonOf(error)}.`);
    }
    if (!response.ok) {
      const message = `WebUntis answered with HTTP ${response.status}.`;
      throw new PluginError(response.status === 404 ? "definite" : "temporary", message);
    }
    return parseAnswer(await readJson(response), method);
  }

  /** The children of the account, or the account itself if it is a student's. */
  async function childrenOf(run: Run): Promise<Child[]> {
    const userData = (await call(run, "getUserData2017", {})).userData;
    if (!isObject(userData)) throw new PluginError("temporary", "WebUntis answered without the account's data.");
    const children = (Array.isArray(userData.children) ? userData.children : []).filter(isObject).flatMap(childOf);
    if (children.length > 0) return children;
    if (userData.elemType === "STUDENT" && typeof userData.elemId === "number") {
      return [{ id: userData.elemId, name: text(userData.displayName) ?? String(userData.elemId) }];
    }
    throw new PluginError("definite", "The WebUntis account lists no children.");
  }

  async function poll(context: RunContext): Promise<IngestResult> {
    const run: Run = { config: context.config, now: new Date(context.now), egressProxy: context.egressProxy };
    const previous = parseState(context.syncCursor);
    const children = await childrenOf(run);
    const today = localDate(run.now, context.timeZone);

    const sourceRecords: SourceRecord[] = [];
    const known: Record<string, string> = {};
    for (const child of children) {
      const result = await call(run, "getTimetable2017", timetableRequest(child.id, today, daysAhead));
      for (const [lessonId, seen] of seenIn(result, context.timeZone)) {
        const key = `${child.id}/${lessonId}`;
        known[key] = seen.day;
        sourceRecords.push({ externalId: key, attributes: [String(child.id)], content: { kind: "stated", stated: seen.lesson } });
      }
    }
    const state: State = { declared: children.map((child) => String(child.id)).toSorted(), known };
    return {
      sourceRecords,
      syncCursor: JSON.stringify(state),
      withdrawn: goneFrom(previous.known, known, today),
      attributes: attributesOf(children, previous),
    };
  }

  /** The children as Source Attributes, apart from a run: one login, no Timetable read. */
  async function sourceAttributes(context: RunContext) {
    const children = await childrenOf({ config: context.config, now: new Date(context.now), egressProxy: context.egressProxy });
    return attributesOf(children, parseState(context.syncCursor));
  }

  return {
    description: {
      sourceTypeId: "webuntis",
      kind: "stateless",
      displayName: { en: "WebUntis", de: "WebUntis" },
      version,
      description: {
        en: "Reads the children's Timetables and Timetable Changes from WebUntis, with the key of a parent account's access through Untis Mobile.",
        de: "Liest die Stundenpläne und Stundenplanänderungen der Kinder aus WebUntis, mit dem Schlüssel für den Zugriff über Untis Mobile eines Elternkontos.",
      },
      needsLlm: false,
      configuration: {
        version: 1,
        fields: [
          {
            key: "server",
            label: { en: "Server", de: "Server" },
            secret: false,
            required: true,
            hasChoices: false,
            host: true,
            description: {
              en: "The school's WebUntis server, such as park.webuntis.com, as the address bar shows it when signed in.",
              de: "Der WebUntis-Server der Schule, etwa park.webuntis.com, wie ihn die Adresszeile nach der Anmeldung zeigt.",
            },
          },
          {
            key: "school",
            label: { en: "School", de: "Schule" },
            secret: false,
            required: true,
            hasChoices: false,
            description: {
              en: 'The school\'s name in WebUntis, as "Access through Untis Mobile" in the profile shows it.',
              de: "Der Name der Schule in WebUntis, wie ihn „Zugriff über Untis Mobile“ im Profil zeigt.",
            },
          },
          {
            key: "user",
            label: { en: "User", de: "Benutzer" },
            secret: false,
            required: true,
            hasChoices: false,
            description: { en: "The parent account's user name.", de: "Der Benutzername des Elternkontos." },
          },
          {
            key: "secret",
            label: { en: "Key", de: "Schlüssel" },
            secret: true,
            required: true,
            hasChoices: false,
            description: {
              en: 'The key under the QR code of "Access through Untis Mobile" in the WebUntis profile. Anyone with it can read the account; generating a new one there revokes it.',
              de: "Der Schlüssel unter dem QR-Code von „Zugriff über Untis Mobile“ im WebUntis-Profil. Wer ihn kennt, kann das Konto lesen; ein dort neu erzeugter Schlüssel widerruft ihn.",
            },
          },
        ],
      },
      setupSteps: [],
      // Gently, as the research advises: the endpoints are undocumented.
      ingestion: { mode: "polling", suggestedIntervalSeconds: 30 * 60 },
      // Holidays bring no new Lessons for weeks.
      silentApplies: false,
    },
    poll,
    sourceAttributes,
  };
}

/**
 * The children declared, and archived those declared before that are gone, as is the one Source
 * Attribute a Source from before the children were Source Attributes declared for the account.
 */
function attributesOf(children: Child[], previous: State): NonNullable<IngestResult["attributes"]> {
  const current = children.map((child) => String(child.id));
  return {
    declared: children.map((child) => ({ externalId: String(child.id), name: child.name })),
    archived: (previous.declared ?? [legacyAttribute]).filter((id) => !current.includes(id)),
  };
}

/**
 * The coming Lessons that were known and are not any more: the school no longer plans them, or
 * their child has gone from the account, which is not a cancellation. One of a day that has passed
 * is forgotten and stays as it was.
 */
function goneFrom(before: Record<string, string>, now: Record<string, string>, today: string): string[] {
  return Object.entries(before).flatMap(([key, day]) => (!(key in now) && day >= today ? [key] : []));
}

/** The one Source Attribute a Source declared for its account before the children were Source Attributes. */
const legacyAttribute = "account";

function connectionOf(config: RunContext["config"]): { server: string; school: string; user: string } {
  const plain = (key: string) => {
    const value = config.plain[key];
    return typeof value === "string" ? value.trim() : "";
  };
  const server = hostOf(plain("server"));
  const school = plain("school");
  const user = plain("user");
  if (server === null) throw new PluginError("definite", "The WebUntis server is no host name, such as park.webuntis.com.");
  if (school === "" || user === "") throw new PluginError("definite", "The WebUntis school and user must be given.");
  return { server, school, user };
}

/**
 * The host of the `server` field, by the rule the core's egress allowlist applies to a host field:
 * without `http://` or `https://`, without everything from the first `/`, in lower case. An Admin
 * may paste the address the browser shows rather than the server's name. Null if no bare host is left.
 */
export function hostOf(value: string): string | null {
  const host = value.trim().replace(/^https?:\/\//i, "").split("/")[0]!.toLowerCase();
  return /^[a-z0-9-]+(\.[a-z0-9-]+)*$/.test(host) ? host : null;
}

/** The key of the account's access through Untis Mobile. */
function keyOf(config: RunContext["config"]): string {
  const key = config.secrets.secret?.trim() ?? "";
  if (key === "") throw new PluginError("definite", "The WebUntis key is missing.");
  return key;
}

async function readJson(response: Response): Promise<JsonObject> {
  try {
    return (await response.json()) as JsonObject;
  } catch {
    throw new PluginError("temporary", "WebUntis answered with no JSON.");
  }
}

/** Untis's JSON-RPC error codes for a login it refuses: bad credentials, and not authenticated. */
const badCredentials = -8504;
const notAuthenticated = -8520;
const refusedLogin = new Set([badCredentials, notAuthenticated]);

/**
 * The result of a JSON-RPC answer. A refusal is told by its numeric code only: the message Untis
 * gives is not passed on, as no one has checked what it may repeat of the request.
 */
function parseAnswer(answer: JsonObject, method: string): JsonObject {
  if (isObject(answer.error)) {
    const code = typeof answer.error.code === "number" ? answer.error.code : null;
    if (code !== null && refusedLogin.has(code)) throw new PluginError("definite", "WebUntis refused the user or key.");
    throw new PluginError("definite", `WebUntis refused ${method}${code === null ? "" : ` (error ${code})`}.`);
  }
  if (!isObject(answer.result)) throw new PluginError("temporary", `WebUntis answered ${method} without a result.`);
  return answer.result;
}

/** A child of the account, if it has an id. */
function childOf(child: JsonObject): Child[] {
  if (typeof child.id !== "number") return [];
  const name = [child.firstName, child.lastName].filter((part) => typeof part === "string" && part !== "").join(" ");
  return [{ id: child.id, name: name || (text(child.displayName) ?? String(child.id)) }];
}

function parseState(state: string | null): State {
  if (state === null) return { declared: [], known: {} };
  try {
    const parsed = JSON.parse(state) as Partial<State>;
    const declared = Array.isArray(parsed.declared) ? parsed.declared.filter((id) => typeof id === "string") : null;
    const known = isObject(parsed.known)
      ? Object.fromEntries(Object.entries(parsed.known).filter((entry): entry is [string, string] => typeof entry[1] === "string"))
      : {};
    return { declared, known };
  } catch {
    return { declared: [], known: {} };
  }
}

/**
 * The TOTP of RFC 6238 that Untis Mobile sends: six digits from HMAC-SHA1 over 30-second steps of
 * the key in Base32, as a number, as Untis takes it.
 */
function oneTimePassword(key: string, at: Date): number {
  const secret = base32(key);
  if (secret.length === 0) throw new PluginError("definite", "The WebUntis key is no key in Base32.");
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(at.getTime() / 30_000)));
  const hash = createHmac("sha1", secret).update(counter).digest();
  const offset = hash.readUInt8(hash.length - 1) & 0x0f;
  return (hash.readUInt32BE(offset) & 0x7fffffff) % 1_000_000;
}

function base32(key: string): Buffer {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  const clean = key.toUpperCase().replace(/[\s=-]/g, "");
  if (!/^[A-Z2-7]*$/.test(clean)) return Buffer.alloc(0);
  let bits = "";
  for (const char of clean) bits += alphabet.indexOf(char).toString(2).padStart(5, "0");
  const bytes = bits.match(/.{8}/g) ?? [];
  return Buffer.from(bytes.map((byte) => parseInt(byte, 2)));
}

/**
 * Why a request failed, as far as it is safe to tell: a timeout, or a system error code such as
 * ETIMEDOUT. The error's message is not passed on, as it may name the address it failed on.
 */
function reasonOf(error: unknown): string {
  if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) return " (timeout)";
  const codeOf = (value: unknown) => (isObject(value) && typeof value.code === "string" && /^[A-Z][A-Z_]*$/.test(value.code) ? value.code : null);
  const code = codeOf(error) ?? (error instanceof Error ? codeOf(error.cause) : null);
  return code ? ` (${code})` : "";
}
