import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createPluginHandler } from "@family-agenda/plugin-kit/server";
import { pluginClient, type Answer } from "@family-agenda/plugin-kit/testing";
import { describePluginContract } from "@family-agenda/plugin-kit/vitest";
import type { IngestResult } from "@family-agenda/plugin-contract";
import { createWebUntisPlugin, type FetchDispatcher, type WebUntisPluginOptions } from "../src/plugin";

type Json = Record<string, unknown>;

const fixture = (name: string): Json => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8")) as Json;

// The RFC 6238 test secret, "12345678901234567890" in Base32.
const secret = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";
const config = { plain: { server: "park.webuntis.com", school: "gym-am-park", user: "anna.koenig" }, secrets: { secret } };
// Monday 2026-09-14 at 09:00 in Berlin.
const now = new Date("2026-09-14T07:00:00Z");

type Call = { url: URL; body: { method: string; params: Json[] }; dispatcher?: unknown };

/** The egress proxy the core hands a call, with the ticket for that one Source. */
const egressProxy = "http://ticket:a-ticket@plugin-webuntis-egress:3128";

/**
 * A WebUntis server answering the mobile API with recorded responses: the parent's children, and
 * each child's Timetable, which a test may change between runs.
 */
function server(timetables: Record<number, Json> = { 1201: fixture("timetable-mia.json"), 1202: fixture("timetable-leo.json") }) {
  const requests: Call[] = [];
  const answers: { userData: Json | Response | Error } = { userData: fixture("user-data.json") };
  const fetch = (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    const body = JSON.parse(init?.body as string) as Call["body"];
    requests.push({ url, body, dispatcher: init?.dispatcher });
    if (body.method === "getUserData2017") {
      const answer = answers.userData;
      if (answer instanceof Error) return Promise.reject(answer);
      return Promise.resolve(answer instanceof Response ? answer : Response.json(answer));
    }
    if (body.method === "getTimetable2017") {
      const timetable = timetables[Number(body.params[0]?.id)];
      return Promise.resolve(Response.json(timetable ?? { jsonrpc: "2.0", id: "family-agenda", error: { code: -7004, message: "no right for timetable" } }));
    }
    return Promise.resolve(Response.json({ jsonrpc: "2.0", id: "family-agenda", error: { code: -32601, message: "Method not found" } }));
  };
  return { fetch, requests, answers, timetables };
}

type Context = { config?: { plain: Record<string, unknown>; secrets: Record<string, string> }; syncCursor?: string | null; now?: Date; egressProxy?: string };

/** A plugin as the core sees it, over the kit's validating handler: polls answer status and body. */
function webUntisPlugin(options: WebUntisPluginOptions) {
  const call = pluginClient(createPluginHandler(createWebUntisPlugin(options)));
  const answer = ({ now: at = now, ...context }: Context = {}): Promise<Answer> =>
    call("poll", { config, syncCursor: null, now: at.toISOString(), timeZone: "Europe/Berlin", egressProxy, ...context });
  const poll = async (context: Context = {}): Promise<IngestResult> => {
    const { status, body } = await answer(context);
    if (status !== 200) throw new Error(`poll answered ${status}: ${JSON.stringify(body)}`);
    return body as IngestResult;
  };
  const attributes = async ({ now: at = now, ...context }: Context = {}) => {
    const { status, body } = await call("sourceAttributes", { config, syncCursor: null, now: at.toISOString(), timeZone: "Europe/Berlin", egressProxy, ...context });
    if (status !== 200) throw new Error(`sourceAttributes answered ${status}: ${JSON.stringify(body)}`);
    return body as NonNullable<IngestResult["attributes"]>;
  };
  return { answer, poll, call, attributes };
}

/** Each Source Record as its key and the Lesson it states. */
const statements = (records: IngestResult["sourceRecords"]) =>
  records.flatMap((record) =>
    record.content.kind === "stated" && record.content.stated.kind === "lesson" ? [{ key: record.externalId, ...record.content.stated }] : [],
  );

const childrenOf = (records: IngestResult["sourceRecords"]) => new Set(records.map((record) => record.externalId.split("/")[0]));

/** A Lesson as planned, without a Timetable Change. */
const asPlanned = { change: null, previousRoom: null, previousTeacher: null, note: null };

/** A Lesson of a recorded Timetable, which Untis calls a period, to change it between runs. */
const lessonIn = (timetable: Json, id: number) =>
  ((timetable.result as Json).timetable as { periods: Json[] }).periods.find((period) => period.id === id)!;

/** Berlin is two hours ahead of UTC in September. */
const span = (day: string, from: string, until: string) => ({
  allDay: false,
  start: new Date(`${day}T${from}:00+02:00`).toISOString(),
  end: new Date(`${day}T${until}:00+02:00`).toISOString(),
});

describePluginContract(() => createPluginHandler(createWebUntisPlugin({ fetch: server().fetch })), { config, now, languages: ["de"], egressProxy });

describe("the WebUntis plugin's connection outside", () => {
  it("requests through the egress proxy of the call, not the environment", async () => {
    const untis = server();
    const proxies: string[] = [];
    const dispatcherFor = (proxy: string) => (proxies.push(proxy), { proxy } as unknown as FetchDispatcher);

    await webUntisPlugin({ fetch: untis.fetch, dispatcherFor }).poll({ egressProxy: "http://ticket:other@plugin-webuntis-egress:3128" });

    expect(proxies).toContain("http://ticket:other@plugin-webuntis-egress:3128");
    expect(untis.requests.map((request) => request.dispatcher)).not.toContain(undefined);
  });

  it("names the Source Attributes through the egress proxy too", async () => {
    const untis = server();
    const proxies: string[] = [];
    const dispatcherFor = (proxy: string) => (proxies.push(proxy), { proxy } as unknown as FetchDispatcher);

    await webUntisPlugin({ fetch: untis.fetch, dispatcherFor }).attributes();

    expect(proxies).toEqual([egressProxy]);
  });
});

describe("the WebUntis plugin", () => {
  it("logs in with a one-time password from the QR secret, lists the children and asks for each one's Timetable as a STUDENT", async () => {
    const untis = server();

    // RFC 6238 gives 081804 for its test secret at this time.
    await webUntisPlugin({ fetch: untis.fetch }).poll({ now: new Date(1111111109 * 1000) });

    expect(untis.requests.map(({ url, body }) => ({ url: `${url.origin}${url.pathname}`, school: url.searchParams.get("school"), method: body.method }))).toEqual([
      { url: "https://park.webuntis.com/WebUntis/jsonrpc_intern.do", school: "gym-am-park", method: "getUserData2017" },
      { url: "https://park.webuntis.com/WebUntis/jsonrpc_intern.do", school: "gym-am-park", method: "getTimetable2017" },
      { url: "https://park.webuntis.com/WebUntis/jsonrpc_intern.do", school: "gym-am-park", method: "getTimetable2017" },
    ]);
    for (const { body } of untis.requests) {
      expect(body.params[0]?.auth).toEqual({ user: "anna.koenig", otp: 81804, clientTime: 1111111109000 });
    }
    expect(untis.requests.slice(1).map(({ body }) => ({ ...body.params[0], auth: undefined }))).toMatchObject([
      { id: 1201, type: "STUDENT", startDate: 20050318, endDate: 20050331 },
      { id: 1202, type: "STUDENT", startDate: 20050318, endDate: 20050331 },
    ]);
  });

  it("takes the server from an address an Admin pasted", async () => {
    const untis = server();

    await webUntisPlugin({ fetch: untis.fetch }).poll({ config: { ...config, plain: { ...config.plain, server: " HTTPS://Park.WebUntis.com/WebUntis/?school=x " } } });

    expect(untis.requests[0]?.url.host).toBe("park.webuntis.com");
  });

  it("refuses a server that is still no bare host once scheme and path are gone", async () => {
    const plugin = webUntisPlugin({ fetch: server().fetch });

    for (const value of ["park webuntis.com", "park.webuntis.com:443", "ftp://park.webuntis.com", "", "park..webuntis.com"]) {
      expect(await plugin.answer({ config: { ...config, plain: { ...config.plain, server: value } } })).toEqual({
        status: 422,
        body: { kind: "definite", message: "The WebUntis server is no host name, such as park.webuntis.com." },
      });
    }
  });

  it("fails definitely, saying so, when the key is missing", async () => {
    expect(await webUntisPlugin({ fetch: server().fetch }).answer({ config: { ...config, secrets: {} } })).toEqual({
      status: 422,
      body: { kind: "definite", message: "The WebUntis key is missing." },
    });
  });

  it("reads the school's wall-clock time in the Family's time zone on both sides of each change of offset", async () => {
    for (const { day, now: at, start, end } of [
      // Berlin moves from +01:00 to +02:00 on 2026-03-29 and back on 2026-10-25.
      { day: "2026-03-28", now: "2026-03-27T07:00:00Z", start: "2026-03-28T07:00:00.000Z", end: "2026-03-28T07:45:00.000Z" },
      { day: "2026-03-30", now: "2026-03-27T07:00:00Z", start: "2026-03-30T06:00:00.000Z", end: "2026-03-30T06:45:00.000Z" },
      { day: "2026-10-24", now: "2026-10-23T07:00:00Z", start: "2026-10-24T06:00:00.000Z", end: "2026-10-24T06:45:00.000Z" },
      { day: "2026-10-26", now: "2026-10-23T07:00:00Z", start: "2026-10-26T07:00:00.000Z", end: "2026-10-26T07:45:00.000Z" },
    ]) {
      const untis = server();
      const maths = lessonIn(untis.timetables[1201]!, 90001);
      maths.startDateTime = `${day}T08:00Z`;
      maths.endDateTime = `${day}T08:45Z`;

      const { sourceRecords } = await webUntisPlugin({ fetch: untis.fetch }).poll({ now: new Date(at) });

      expect(statements(sourceRecords).find((statement) => statement.key === "1201/90001")?.span).toEqual({ allDay: false, start, end });
    }
  });

  it("states each child's Lessons whole, keyed by child and the id Untis gives the Lesson, with how they deviate from the Timetable", async () => {
    const { sourceRecords } = await webUntisPlugin({ fetch: server().fetch }).poll();

    expect(statements(sourceRecords)).toEqual([
      {
        key: "1201/90001",
        kind: "lesson",
        subject: "Mathematik",
        span: span("2026-09-15", "08:00", "08:45"),
        room: "101",
        teacher: "Jonas Brandt",
        ...asPlanned,
      },
      {
        key: "1201/90002",
        kind: "lesson",
        subject: "Englisch",
        span: span("2026-09-15", "08:50", "09:35"),
        room: "102",
        teacher: "Sara Weber",
        change: "substitution",
        previousRoom: null,
        previousTeacher: "Petra Roth",
        note: "Vertretung",
      },
      {
        key: "1201/90003",
        kind: "lesson",
        subject: "Physik",
        span: span("2026-09-15", "09:55", "10:40"),
        room: "PH1",
        teacher: "Eva Lang",
        change: "cancellation",
        previousRoom: null,
        previousTeacher: null,
        note: "Lehrkraft erkrankt",
      },
      {
        key: "1201/90004",
        kind: "lesson",
        subject: "Mathematik",
        span: span("2026-09-16", "08:00", "08:45"),
        room: "204",
        teacher: "Jonas Brandt",
        change: "room-change",
        previousRoom: "101",
        previousTeacher: null,
        note: null,
      },
      // The school withholds its teachers from Leo's parents.
      {
        key: "1202/91001",
        kind: "lesson",
        subject: "Kunst",
        span: span("2026-09-15", "08:00", "09:35"),
        room: "KU1",
        teacher: null,
        ...asPlanned,
      },
    ]);
    expect(sourceRecords.map((record) => [record.externalId, record.attributes])).toEqual([
      ["1201/90001", ["1201"]],
      ["1201/90002", ["1201"]],
      ["1201/90003", ["1201"]],
      ["1201/90004", ["1201"]],
      ["1202/91001", ["1202"]],
    ]);
    expect(sourceRecords.every((record) => record.occurredAt === undefined)).toBe(true);
  });

  it("states a Lesson as planned again once the school takes its cancellation back", async () => {
    const untis = server();
    const plugin = webUntisPlugin({ fetch: untis.fetch });
    const first = await plugin.poll();
    const physics = lessonIn(untis.timetables[1201]!, 90003);
    physics.is = ["STANDARD"];
    physics.text = { lesson: "", substitution: "", info: "" };

    const { sourceRecords } = await plugin.poll({ syncCursor: first.syncCursor });

    expect(statements(sourceRecords).find((statement) => statement.key === "1201/90003")).toEqual({
      key: "1201/90003",
      kind: "lesson",
      subject: "Physik",
      span: span("2026-09-15", "09:55", "10:40"),
      room: "PH1",
      teacher: "Eva Lang",
      ...asPlanned,
    });
  });

  it("states every Lesson again on each run, and withdraws a Lesson gone from the Timetable", async () => {
    const untis = server();
    const plugin = webUntisPlugin({ fetch: untis.fetch });
    const first = await plugin.poll();
    const timetable = (untis.timetables[1201]!.result as Json).timetable as { periods: Json[] };
    timetable.periods = timetable.periods.filter((period) => period.id !== 90001);
    const maths = lessonIn(untis.timetables[1201]!, 90004);
    maths.startDateTime = "2026-09-16T08:50Z";
    maths.endDateTime = "2026-09-16T09:35Z";

    const { sourceRecords, withdrawn } = await plugin.poll({ syncCursor: first.syncCursor });

    expect(statements(sourceRecords).map((statement) => statement.key)).toEqual(["1201/90002", "1201/90003", "1201/90004", "1202/91001"]);
    expect(statements(sourceRecords).find((statement) => statement.key === "1201/90004")?.span).toEqual(span("2026-09-16", "08:50", "09:35"));
    expect(withdrawn).toEqual(["1201/90001"]);
  });

  it("clips texts to what a Lesson keeps", async () => {
    const untis = server();
    const physics = lessonIn(untis.timetables[1201]!, 90003);
    physics.text = { lesson: "", substitution: "", info: `  ${"x".repeat(300)}` };

    const { sourceRecords } = await webUntisPlugin({ fetch: untis.fetch }).poll();

    expect(statements(sourceRecords).find((statement) => statement.key === "1201/90003")?.note).toBe("x".repeat(200));
  });

  it("starts afresh from a sync cursor it cannot read", async () => {
    const plugin = webUntisPlugin({ fetch: server().fetch });

    expect((await plugin.poll({ syncCursor: "not json" })).withdrawn).toEqual([]);
    expect((await plugin.poll({ syncCursor: JSON.stringify({ declared: [], known: "nonsense" }) })).withdrawn).toEqual([]);
  });

  it("forgets past Lessons without cancelling them", async () => {
    const untis = server();
    const plugin = webUntisPlugin({ fetch: untis.fetch });
    const first = await plugin.poll();
    // On Thursday, Tuesday and Wednesday have passed and the Timetable starts with Thursday.
    for (const id of [1201, 1202]) ((untis.timetables[id]!.result as Json).timetable as { periods: Json[] }).periods = [];

    const { sourceRecords, withdrawn } = await plugin.poll({ syncCursor: first.syncCursor, now: new Date("2026-09-17T07:00:00Z") });

    expect(sourceRecords).toEqual([]);
    expect(withdrawn).toEqual([]);
  });

  it("declares each child of the account as a Source Attribute named by first and last name", async () => {
    const { attributes } = await webUntisPlugin({ fetch: server().fetch }).poll();

    expect(attributes).toEqual({
      declared: [
        { externalId: "1201", name: "Mia König" },
        { externalId: "1202", name: "Leo König" },
      ],
      archived: [],
    });
  });

  it("names the children apart from a run with one login, reading no Timetable", async () => {
    const untis = server();
    const plugin = webUntisPlugin({ fetch: untis.fetch });

    expect(await plugin.attributes()).toEqual((await webUntisPlugin({ fetch: server().fetch }).poll()).attributes);
    expect(untis.requests.map((request) => request.body.method)).toEqual(["getUserData2017"]);
  });

  it("archives apart from a run a child that vanished, and the account's legacy Source Attribute", async () => {
    const untis = server();
    const plugin = webUntisPlugin({ fetch: untis.fetch });
    const first = await plugin.poll();
    const userData = fixture("user-data.json");
    const children = ((userData.result as Json).userData as { children: Json[] }).children;
    ((userData.result as Json).userData as Json).children = children.filter((child) => child.id === 1201);
    untis.answers.userData = userData;

    expect((await plugin.attributes({ syncCursor: first.syncCursor })).archived).toEqual(["1202"]);
    expect((await plugin.attributes({ syncCursor: JSON.stringify({ children: [], known: {} }) })).archived).toEqual(["account"]);
  });

  it("asks no longer which child to read: every child is read, and setup has no field for it", async () => {
    const plugin = webUntisPlugin({ fetch: server().fetch });

    const { sourceRecords } = await plugin.poll({ config: { ...config, plain: { ...config.plain, children: ["1202"] } } });

    expect(childrenOf(sourceRecords)).toEqual(new Set(["1201", "1202"]));
    const { body } = await plugin.call("description");
    const fields = (body as { configuration: { fields: { key: string; host?: boolean }[] } }).configuration.fields;
    expect(fields.map((field) => field.key)).toEqual(["server", "school", "user", "secret"]);
    // The egress proxy lets the plugin reach the server an Admin enters.
    expect(fields.filter((field) => field.host).map((field) => field.key)).toEqual(["server"]);
  });

  it("archives a child that vanished from the account and withdraws its coming Lessons", async () => {
    const untis = server();
    const plugin = webUntisPlugin({ fetch: untis.fetch });
    const first = await plugin.poll();
    const userData = fixture("user-data.json");
    const children = ((userData.result as Json).userData as { children: Json[] }).children;
    ((userData.result as Json).userData as Json).children = children.filter((child) => child.id === 1201);
    untis.answers.userData = userData;

    const { sourceRecords, withdrawn, attributes } = await plugin.poll({ syncCursor: first.syncCursor });

    expect(attributes).toEqual({ declared: [{ externalId: "1201", name: "Mia König" }], archived: ["1202"] });
    expect(childrenOf(sourceRecords)).toEqual(new Set(["1201"]));
    expect(withdrawn).toEqual(["1202/91001"]);
  });

  it("declares a child that joined the account", async () => {
    const untis = server();
    const plugin = webUntisPlugin({ fetch: untis.fetch });
    const full = fixture("user-data.json");
    const both = ((full.result as Json).userData as { children: Json[] }).children;
    const onlyMia = fixture("user-data.json");
    ((onlyMia.result as Json).userData as Json).children = both.filter((child) => child.id === 1201);
    untis.answers.userData = onlyMia;
    const first = await plugin.poll();
    expect(first.attributes?.declared.map((attribute) => attribute.externalId)).toEqual(["1201"]);

    untis.answers.userData = full;
    const { attributes } = await plugin.poll({ syncCursor: first.syncCursor });

    expect(attributes?.declared.map((attribute) => attribute.externalId)).toEqual(["1201", "1202"]);
    expect(attributes?.archived).toEqual([]);
  });

  it("archives the account's constant Source Attribute of a Source from before the children were Source Attributes", async () => {
    const legacyCursor = JSON.stringify({ children: [], known: { "1202/91001": "2026-09-15" } });

    const { attributes } = await webUntisPlugin({ fetch: server().fetch }).poll({ syncCursor: legacyCursor });

    expect(attributes?.archived).toEqual(["account"]);
  });

  it("fails definitely when WebUntis refuses the login, without passing on what Untis says", async () => {
    const untis = server();
    untis.answers.userData = { jsonrpc: "2.0", id: "family-agenda", error: { code: -8504, message: "bad credentials for anna.koenig" } };

    const { status, body } = await webUntisPlugin({ fetch: untis.fetch }).answer();

    expect({ status, body }).toEqual({ status: 422, body: { kind: "definite", message: "WebUntis refused the user or key." } });
  });

  it("tells another refusal by its code only", async () => {
    const untis = server({});

    const { status, body } = await webUntisPlugin({ fetch: untis.fetch }).answer();

    expect({ status, body }).toEqual({ status: 422, body: { kind: "definite", message: "WebUntis refused getTimetable2017 (error -7004)." } });
  });

  it("fails temporarily when WebUntis cannot be reached, telling the error code but not its message", async () => {
    const untis = server();
    const plugin = webUntisPlugin({ fetch: untis.fetch });

    untis.answers.userData = new Response("Bad gateway", { status: 502 });
    expect(await plugin.answer()).toMatchObject({ status: 503, body: { kind: "temporary" } });

    untis.answers.userData = new TypeError("fetch failed", { cause: Object.assign(new Error(`connect ETIMEDOUT ${secret}`), { code: "ETIMEDOUT" }) });
    expect(await plugin.answer()).toEqual({ status: 503, body: { kind: "temporary", message: "WebUntis could not be reached (ETIMEDOUT)." } });

    untis.answers.userData = new DOMException("The operation timed out.", "TimeoutError");
    expect(await plugin.answer()).toEqual({ status: 503, body: { kind: "temporary", message: "WebUntis could not be reached (timeout)." } });

    untis.answers.userData = new Error(`something about ${secret}`);
    expect(await plugin.answer()).toEqual({ status: 503, body: { kind: "temporary", message: "WebUntis could not be reached." } });
  });

  it("fails definitely when WebUntis knows no such address, and temporarily when it answers with no JSON", async () => {
    const untis = server();
    const plugin = webUntisPlugin({ fetch: untis.fetch });

    untis.answers.userData = new Response("Not found", { status: 404 });
    expect(await plugin.answer()).toMatchObject({ status: 422, body: { kind: "definite" } });

    untis.answers.userData = new Response("<html>", { status: 200 });
    expect(await plugin.answer()).toMatchObject({ status: 503, body: { kind: "temporary" } });

    untis.answers.userData = { jsonrpc: "2.0", id: "family-agenda" };
    expect(await plugin.answer()).toMatchObject({ status: 503, body: { kind: "temporary" } });
  });

  it("fails definitely on a configuration it cannot use", async () => {
    const plugin = webUntisPlugin({ fetch: server().fetch });

    for (const plain of [
      { ...config.plain, school: " " },
      { ...config.plain, user: 7 },
    ]) {
      expect(await plugin.answer({ config: { ...config, plain } })).toMatchObject({ status: 422, body: { kind: "definite" } });
    }
    expect(await plugin.answer({ config: { ...config, secrets: { secret: "not base32!" } } })).toMatchObject({ status: 422, body: { kind: "definite" } });
  });

  it("reads the account's own Timetable when it is a student's", async () => {
    const untis = server();
    const userData = fixture("user-data.json");
    Object.assign((userData.result as Json).userData as Json, { children: [], elemType: "STUDENT", elemId: 1201, displayName: "Mia" });
    untis.answers.userData = userData;

    const { sourceRecords, attributes } = await webUntisPlugin({ fetch: untis.fetch }).poll();

    expect(childrenOf(sourceRecords)).toEqual(new Set(["1201"]));
    expect(attributes?.declared).toEqual([{ externalId: "1201", name: "Mia" }]);
  });

  it("fails temporarily when WebUntis answers without the account's data", async () => {
    const untis = server();
    untis.answers.userData = { jsonrpc: "2.0", id: "family-agenda", result: {} };

    expect(await webUntisPlugin({ fetch: untis.fetch }).answer()).toMatchObject({ status: 503, body: { kind: "temporary" } });
  });

  it("fails definitely when the account lists no children", async () => {
    const untis = server();
    const userData = fixture("user-data.json");
    ((userData.result as Json).userData as Json).children = [];
    untis.answers.userData = userData;

    expect(await webUntisPlugin({ fetch: untis.fetch }).answer()).toMatchObject({ status: 422, body: { kind: "definite" } });
  });
});
