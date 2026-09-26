/**
 * A fake Zo MCP server on a real local port (Bun.serve), speaking the same
 * Streamable HTTP shape as api.zo.computer: initialize hands out an
 * mcp-session-id, tools/call answers with MCP content blocks whose text uses
 * Zo's Python-repr style. Samples are sanitized copies of live responses
 * captured 2026-09-26.
 */

export const SAMPLE_CREATE = (id: string, title: string, start: string, end: string) =>
  `exports={'$summary': 'Successfully created event with ID: "${id}"'} os=[] ret={'kind': 'calendar#event', 'etag': '"3580918296306142"', 'id': '${id}', 'status': 'confirmed', 'htmlLink': 'https://www.google.com/calendar/event?eid=${id}', 'created': '2026-09-26T21:45:48.000Z', 'summary': '${title}', 'description': 'booked by Eve', 'creator': {'email': 'me@example.com', 'self': True}, 'organizer': {'email': 'me@example.com', 'self': True}, 'start': {'dateTime': '${start}', 'timeZone': 'America/Los_Angeles'}, 'end': {'dateTime': '${end}', 'timeZone': 'America/Los_Angeles'}, 'iCalUID': '${id}@google.com', 'sequence': 0, 'reminders': {'useDefault': True}, 'eventType': 'default'} stash_id=None t={'ar': 1790459145797, 'ble': 1790459148210}`;

export const SAMPLE_DELETE = (id: string) =>
  `exports={'$summary': 'Successfully deleted event: "${id}"'} os=[] ret={'size': 0, 'data': '', 'config': {'url': 'https://www.googleapis.com/calendar/v3/calendars/primary/events/${id}', 'method': 'DELETE', 'retry': True}, 'headers': {}} stash_id=None t={}`;

export const SAMPLE_SPOTIFY_NOTHING = `exports={'$summary': 'Currently playing track: Nothing'} os=[] ret={'playing': False} stash_id=None t={'ar': 1790459013599}`;

export const SAMPLE_SPOTIFY_PLAYING = (name: string, artist: string, id: string, progress: number) =>
  `exports={'$summary': 'Currently playing track: ${name}'} os=[] ret={'timestamp': 1790459013599, 'progress_ms': ${progress}, 'is_playing': True, 'currently_playing_type': 'track', 'item': {'id': '${id}', 'name': '${name}', 'duration_ms': 215000, 'artists': [{'name': '${artist}', 'id': 'a1'}], 'album': {'name': 'x'}}} stash_id=None t={}`;

export const SAMPLE_MAPS = JSON.stringify(
  [
    "(showing 10 of 30 places \u2014 full results at /home/.z/workspaces/null/read_webpage/maps_search~~3a1790459064903.json, use read_file for all)",
    `summary="I found a few options for cheap spicy ramen in Irvine, CA that are currently open.\\n\\nKitakata Ramen Ban Nai is a popular choice with a 4.4-star rating. They offer various ramen flavors, including spicy miso and tan tan, and have a price range of $10-20. One reviewer mentioned that a small chicken/pork bowl is well-portioned for a cheaper price.\\n\\nSilverlake Ramen has a 4.1-star rating and also falls within the $10-20 price range. They offer spicy options like the Sriracha Spicy Ramen and Blaze.\\n\\nHiroNori Craft Ramen has a 4.6-star rating, but their price range is slightly higher at $20-30. They offer a vegan ramen with creamy miso broth and a spicy tuna option." places=[MapPlace(title='Kitakata Ramen Ban Nai - Irvine - Google Maps', uri='https://maps.google.com/maps?cid=11892275661009871434', address=None, primary_type=None, types=None, rating=None, price_level=None, phone_number=None, website_uri=None, snippet=None), MapPlace(title='Review of Kitakata Ramen Ban Nai - Irvine - Google Maps', uri='https://www.google.com/maps/reviews/data=!4m6', address=None, primary_type=None, types=None, rating=None, price_level=None, phone_number=None, website_uri=None, snippet=None), MapPlace(title='Silverlake Ramen - Google Maps', uri='https://maps.google.com/maps?cid=17557312198620284667', address=None, primary_type=None, types=None, rating=None, price_level=None, phone_number=None, website_uri=None, snippet=None), MapPlace(title='HiroNori Craft Ramen - Google Maps', uri='https://maps.google.com/maps?cid=8739717908117716858', address=None, primary_type=None, types=None, rating=None, price_level=None, phone_number=None, website_uri=None, snippet=None)]`,
  ],
  null,
  2,
);

export type ToolReply = string | { text: string; isError?: boolean } | Promise<string | { text: string; isError?: boolean }>;
export type ToolHandler = (args: Record<string, any>, name: string) => ToolReply;

export interface FakeZoOptions {
  sse?: boolean;
  /** Per-tool handlers. use_app_* tools dispatch on args.tool_name too: "use_app_google_calendar:google_calendar-create-event". */
  tools?: Record<string, ToolHandler>;
  /** Reject every session id issued before this many initializes (simulates a server restart). */
  delayMs?: number;
}

export interface McpRequest {
  method: string;
  params: any;
  id?: number;
  session: string | null;
  accept: string | null;
  auth: string | null;
}

export function fakeZoServer(opts: FakeZoOptions = {}) {
  const requests: McpRequest[] = [];
  const files = new Map<string, string>();
  const valid = new Set<string>();
  let sessions = 0;
  let inflight = 0;
  let maxInflight = 0;
  const asks: string[] = [];

  const defaults: Record<string, ToolHandler> = {
    write_file: (a) => {
      files.set(a.target_file, a.content ?? "");
      return `Wrote ${(a.content ?? "").split("\n").length} lines to ${a.target_file}`;
    },
    read_file: (a) => {
      if (!files.has(a.target_file)) return { text: `Error: Error from get_file for '${a.target_file}': File not found\ncode: read_failed`, isError: true };
      return JSON.stringify([files.get(a.target_file), `kind='file_ref' path='${a.target_file}' media_type=None label=None`], null, 2);
    },
    list_directory: (a) => {
      const dir = String(a.path).replace(/\/$/, "");
      const names = [...files.keys()].filter((f) => f.startsWith(`${dir}/`)).map((f) => f.slice(dir.length + 1));
      if (!names.length) return { text: `Error: path not found\ncode: not_found`, isError: true };
      return `Showing ${names.length} entries.\n\n- ${dir}/\n${names.map((n) => `  - ${n}`).join("\n")}`;
    },
    ...opts.tools,
  };

  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/zo/ask") {
        const b = (await req.json()) as { input: string };
        asks.push(b.input);
        return Response.json({ output: "OK", conversation_id: "c1" });
      }
      if (url.pathname !== "/mcp") return new Response("nope", { status: 404 });
      const body = (await req.json()) as { method: string; params: any; id?: number };
      const session = req.headers.get("mcp-session-id");
      requests.push({ method: body.method, params: body.params, id: body.id, session, accept: req.headers.get("accept"), auth: req.headers.get("authorization") });
      const reply = (result: unknown, headers: Record<string, string> = {}) => {
        const msg = JSON.stringify({ jsonrpc: "2.0", id: body.id, result });
        return opts.sse
          ? new Response(`event: message\ndata: ${msg}\n\n`, { headers: { "content-type": "text/event-stream", ...headers } })
          : new Response(msg, { headers: { "content-type": "application/json", ...headers } });
      };
      if (body.method === "initialize") {
        const sid = `s${++sessions}`;
        valid.add(sid);
        return reply({ protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "zo-tools", version: "1.0.0" } }, { "mcp-session-id": sid });
      }
      if (session && !valid.has(session)) return new Response(JSON.stringify({ error: "session not found" }), { status: 404 });
      if (body.id === undefined) return new Response(null, { status: 202 });
      if (body.method === "ping") return reply({});
      if (body.method === "tools/list") return reply({ tools: Object.keys(defaults).map((name) => ({ name, inputSchema: { type: "object" } })) });
      if (body.method === "tools/call") {
        const name = body.params.name as string;
        const args = body.params.arguments ?? {};
        const key = typeof args.tool_name === "string" ? `${name}:${args.tool_name}` : name;
        const h = defaults[key] ?? defaults[name];
        inflight++;
        maxInflight = Math.max(maxInflight, inflight);
        try {
          if (opts.delayMs) await Bun.sleep(opts.delayMs);
          if (!h) return reply({ content: [{ type: "text", text: `Error: Tool '${name}' not found\ncode: tool_not_found` }], isError: true });
          const out = await h(args, name);
          const r = typeof out === "string" ? { text: out } : out;
          return reply({ content: [{ type: "text", text: r.text }], isError: !!r.isError });
        } finally {
          inflight--;
        }
      }
      return reply({});
    },
  });

  return {
    url: `http://127.0.0.1:${server.port}`,
    requests,
    files,
    asks,
    calls: (name?: string) => requests.filter((r) => r.method === "tools/call" && (!name || r.params.name === name || r.params.arguments?.tool_name === name)),
    /** Forget every session (server restart): the next call with an old id gets 404. */
    expireSessions: () => valid.clear(),
    maxInflight: () => maxInflight,
    stop: () => server.stop(true),
  };
}
