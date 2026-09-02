// Offline checks for the per-session request budget. No Priority server needed.
//
// The window length is a constructor parameter precisely so these can run: proving
// that a window SLIDES with the real 60s default would cost a minute per case.
import { RequestBudget } from "../src/ratelimit.js";

let failures = 0;
const ok = (m: string) => console.log(`  ok   ${m}`);
const bad = (m: string) => {
  failures++;
  console.log(`  FAIL ${m}`);
};

const far = () => Date.now() + 60_000;

console.log("\n1. A limit of 0 means no budget at all");
{
  const budget = new RequestBudget(0, 50);
  let granted = 0;
  for (let i = 0; i < 20; i++) {
    if ((await budget.acquire(Date.now() - 1)).granted) granted++;
  }
  // Note the deadline is already in the PAST: an unlimited budget must not even
  // consult it, or "0 = unlimited" would fail closed the moment a call is slow.
  if (granted === 20) ok("20 acquires granted, past deadline ignored");
  else bad(`only ${granted}/20 granted with the budget disabled`);
}

console.log("\n2. Under the limit is instant");
{
  const budget = new RequestBudget(3, 10_000);
  const started = Date.now();
  const verdicts = [
    await budget.acquire(far()),
    await budget.acquire(far()),
    await budget.acquire(far()),
  ];
  const elapsed = Date.now() - started;
  if (verdicts.every((v) => v.granted) && elapsed < 50) ok(`3 of 3 granted in ${elapsed}ms`);
  else bad(`expected 3 instant grants, got ${JSON.stringify(verdicts)} in ${elapsed}ms`);
}

console.log("\n3. Over the limit waits for the window, then proceeds");
{
  const windowMs = 120;
  const budget = new RequestBudget(2, windowMs);
  await budget.acquire(far());
  await budget.acquire(far());

  const started = Date.now();
  const third = await budget.acquire(far());
  const waited = Date.now() - started;

  if (!third.granted) bad("the third acquire was refused despite a generous deadline");
  else if (waited < windowMs * 0.8) bad(`granted after only ${waited}ms; the window is ${windowMs}ms`);
  else ok(`third acquire waited ${waited}ms for the window and was granted`);
}

console.log("\n4. A deadline it cannot meet REFUSES rather than sleeping past it");
{
  // The case that breaks silently: sleep past the deadline and the caller sees a
  // timeout, which reads as a fault on the Priority server rather than a budget.
  const windowMs = 5_000;
  const budget = new RequestBudget(1, windowMs);
  await budget.acquire(far());

  const started = Date.now();
  const second = await budget.acquire(Date.now() + 100);
  const elapsed = Date.now() - started;

  if (second.granted) bad("granted a slot the deadline had no room for");
  else if (elapsed > 100) bad(`refused, but only after sleeping ${elapsed}ms — it must refuse immediately`);
  else if (!(second.wouldWaitMs > 0)) bad(`refused without saying how long the wait was (${second.wouldWaitMs})`);
  else ok(`refused in ${elapsed}ms, reporting a ${second.wouldWaitMs}ms wait`);
}

console.log("\n5. The window slides — it does not reset into a free-for-all");
{
  const windowMs = 100;
  const budget = new RequestBudget(2, windowMs);
  await budget.acquire(far());
  await budget.acquire(far());
  await new Promise((r) => setTimeout(r, windowMs + 20));

  // Two should be free again, and the third should be made to wait again.
  const a = await budget.acquire(far());
  const b = await budget.acquire(far());
  const started = Date.now();
  const c = await budget.acquire(far());
  const waited = Date.now() - started;

  if (!a.granted || !b.granted) bad("the window did not release its slots after expiring");
  else if (waited < windowMs * 0.5) bad(`a third slot was granted after ${waited}ms — the limit stopped applying`);
  else ok(`2 slots freed, and the next still waited ${waited}ms`);
}

console.log("\n6. Concurrent callers cannot both claim one free slot");
{
  // describe_screen fires its metadata fetches in parallel, so this is the real
  // shape, not a hypothetical one.
  const windowMs = 120;
  const budget = new RequestBudget(3, windowMs);
  const started = Date.now();
  const verdicts = await Promise.all(
    Array.from({ length: 5 }, () => budget.acquire(far())),
  );
  const elapsed = Date.now() - started;

  if (!verdicts.every((v) => v.granted)) bad("a concurrent caller was refused despite a generous deadline");
  else if (elapsed < windowMs * 0.8) bad(`5 concurrent acquires against a limit of 3 finished in ${elapsed}ms — two were not held`);
  else ok(`5 concurrent acquires, limit 3: the extra two waited (${elapsed}ms total)`);
}

console.log(
  failures === 0 ? "\nAll request-budget checks passed.\n" : `\n${failures} failure(s).\n`,
);
process.exit(failures === 0 ? 0 : 1);
