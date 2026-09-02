// Drives the web app's HTTP API exactly as the browser page does, so the SSE
// framing, tool events and multi-turn history are verified without a browser.
// Requires `npm run web` to already be running.
const BASE = process.env["WEB_BASE"] ?? "http://127.0.0.1:3400";
const sessionId = "test-" + Math.random().toString(36).slice(2);

let failures = 0;
const ok = (m: string) => console.log(`  ok   ${m}`);
const bad = (m: string) => {
  failures++;
  console.log(`  FAIL ${m}`);
};

interface Turn {
  text: string;
  tools: { name: string; input: unknown }[];
  errors: string[];
  done?: { stopReason: string; inputTokens: number; outputTokens: number };
  deltaCount: number;
}

/** Consume one /api/chat SSE response, mirroring the page's parser. */
async function ask(message: string): Promise<Turn> {
  const res = await fetch(`${BASE}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sessionId, message }),
  });
  if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);

  const turn: Turn = { text: "", tools: [], errors: [], deltaCount: 0 };
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const frames = buffer.split("\n\n");
    buffer = frames.pop() ?? "";
    for (const frame of frames) {
      const ev = frame.split("\n").find((l) => l.startsWith("event: "))?.slice(7).trim();
      const raw = frame.split("\n").find((l) => l.startsWith("data: "))?.slice(6);
      if (!ev || raw === undefined) continue;
      const data = JSON.parse(raw) as Record<string, never>;
      if (ev === "delta") {
        turn.text += String(data["text"]);
        turn.deltaCount++;
      } else if (ev === "tool") {
        turn.tools.push({ name: String(data["name"]), input: data["input"] });
      } else if (ev === "error") {
        turn.errors.push(String(data["message"]));
      } else if (ev === "done") {
        turn.done = data as unknown as Turn["done"];
      }
    }
  }
  return turn;
}

console.log(`\n1. Static page and vendored assets`);
for (const [pathname, label] of [
  ["/", "chat page"],
  ["/vendor/marked/marked.umd.js", "marked (markdown renderer)"],
  ["/vendor/dompurify/purify.min.js", "dompurify (sanitiser)"],
] as const) {
  const r = await fetch(BASE + pathname);
  const body = await r.text();
  if (r.ok && body.length > 500) ok(`${label} served (${(body.length / 1024).toFixed(1)} KB)`);
  else bad(`${label} -> HTTP ${r.status}, ${body.length} bytes`);
}

console.log(`\n2. First question streams, calls the tool, and answers`);
const t1 = await ask("כמה מכרנו ב-2022, ובאילו מטבעות?");
if (t1.errors.length) bad(`errors: ${t1.errors.join("; ")}`);
if (t1.tools.length >= 1) ok(`tool called: ${t1.tools.map((t) => t.name).join(", ")}`);
else bad("the model answered without calling get_sales");
if (t1.deltaCount > 5) ok(`text arrived incrementally (${t1.deltaCount} deltas — real streaming)`);
else bad(`only ${t1.deltaCount} delta events; streaming may be buffered`);
if (/ש"ח|שקל/.test(t1.text) && /\$|דולר/.test(t1.text)) ok("answer names both currencies separately");
else bad(`answer does not mention both currencies: ${t1.text.slice(0, 160)}`);
if (t1.done) ok(`done event: ${t1.done.stopReason}, ${t1.done.outputTokens} output tokens`);
else bad("no done event");

console.log(`\n3. Follow-up question reuses the conversation history`);
// Deliberately elliptical: only answerable if the previous turn is remembered.
const t2 = await ask("ומה מזה היה בדולר בלבד?");
if (t2.errors.length) bad(`errors: ${t2.errors.join("; ")}`);
else if (t2.text.trim().length > 0) ok(`follow-up answered (${t2.text.trim().length} chars)`);
else bad("follow-up produced no text");
console.log(`       → ${t2.text.replace(/\s+/g, " ").slice(0, 200)}`);

console.log(`\n4. Reset clears the session`);
const r = await fetch(`${BASE}/api/reset`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ sessionId }),
});
if (r.ok) ok("reset accepted");
else bad(`reset -> HTTP ${r.status}`);

console.log(`\n5. An empty message is rejected`);
const empty = await fetch(`${BASE}/api/chat`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ sessionId, message: "   " }),
});
if (empty.status === 400) ok("empty message -> HTTP 400");
else bad(`empty message -> HTTP ${empty.status}`);

console.log(failures === 0 ? "\nAll web checks passed.\n" : `\n${failures} failure(s).\n`);
process.exit(failures === 0 ? 0 : 1);
