// The question that previously got "I can't do that": line-level invoice detail,
// asked through the web app the same way a browser would.
const BASE = process.env["WEB_BASE"] ?? "http://127.0.0.1:3400";
const sessionId = "lines-" + Math.random().toString(36).slice(2);

const question =
  process.argv[2] ?? "תן לי פירוט ברמת שורה של חשבוניות המס מ-2022 — פריט, כמות ומחיר.";

const res = await fetch(`${BASE}/api/chat`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ sessionId, message: question }),
});
if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);

let text = "";
const tools: string[] = [];
const errors: string[] = [];
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
    const d = JSON.parse(raw) as Record<string, unknown>;
    if (ev === "delta") text += String(d["text"]);
    else if (ev === "tool") tools.push(`${String(d["name"])} ${JSON.stringify(d["input"])}`);
    else if (ev === "error") errors.push(String(d["message"]));
  }
}

console.log(`\nשאלה: ${question}\n${"-".repeat(72)}`);
for (const t of tools) console.log(`  [כלי] ${t}`);
console.log(`\n${text}\n${"-".repeat(72)}`);

let failures = 0;
const check = (cond: boolean, msg: string) => {
  console.log(`  ${cond ? "ok  " : "FAIL"} ${msg}`);
  if (!cond) failures++;
};

check(errors.length === 0, `no errors${errors.length ? `: ${errors.join("; ")}` : ""}`);
check(tools.some((t) => /includeLines"?\s*:\s*true/.test(t)), "the tool was called with includeLines: true");
check(!/אין לי|לא ניתן|לא יכול|איני יכול/.test(text), "the answer does not claim the capability is missing");
check(/qty|כמות|יח/.test(text), "the answer mentions quantities");

console.log(failures === 0 ? "\nLine-level detail works end to end.\n" : `\n${failures} failure(s).\n`);
process.exit(failures === 0 ? 0 : 1);
