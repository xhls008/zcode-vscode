import { SessionController } from "../src/session";

async function main() {
  const ws = process.cwd();
  const ctrl = new SessionController(ws, { log: (l) => { if (process.env.VERBOSE) console.error("[log]", l); } });
  let text = "";
  let ended = false;
  ctrl.on("assistantText", (t) => { text = t; });
  ctrl.on("state", (s) => { if (s.mode) console.error("[state] mode=" + s.mode + " model=" + (s.modelLabel||s.modelId||"?")); });
  ctrl.on("error", (e) => console.error("[error]", e));
  ctrl.on("turnEnd", () => { ended = true; });
  console.error("connecting…");
  await ctrl.connect();
  console.error("connected, session=", ctrl.currentSessionId);
  await ctrl.send("Reply with exactly one word: pong");
  const deadline = Date.now() + 75000;
  while (!ended && Date.now() < deadline) { await new Promise((r) => setTimeout(r, 200)); }
  console.log(JSON.stringify({ ended, textLen: text.length, answer: text.slice(0, 200) }));
  ctrl.dispose();
  process.exit(ended && text.length > 0 ? 0 : 1);
}
main().catch((e) => { console.error("THREW:", e.message); process.exit(2); });
