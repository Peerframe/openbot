/** Executable entry for the sealed native packet. Fixed modes only; no shell or arbitrary RPC. */
import { childRecord, daemon, execute, lookup } from "./native-runtime.ts";
import { requireFact } from "./protected-io.ts";
import type { NativePhase } from "./native-unit.ts";
async function main() {
  const [mode, flag, root, ...extra] = process.argv.slice(2);
  requireFact(
    extra.length === 0 &&
      flag === "--root" &&
      root &&
      ["daemon", "execute", "lookup", "lookup-output"].includes(mode ?? ""),
    "invalid_native_helper_arguments",
  );
  const started = performance.now();
  const progress = (phase: NativePhase) => {
    if (mode === "execute")
      process.stderr.write(`native-stage:${phase}:${Math.floor(performance.now() - started)}\n`);
  };
  progress("entry");
  const record = childRecord(root, progress);
  if (mode === "daemon") await daemon(record);
  else if (mode === "execute") await execute(record, progress);
  else process.stdout.write(JSON.stringify(await lookup(record, mode === "lookup-output")) + "\n");
}
// Immediate exit also closes inherited handles on refusal; PID1 then owns unit-wide cleanup.
main().then(
  () => process.exit(0),
  (error) => {
    process.stderr.write(
      (error instanceof Error && /^[a-z_]{1,80}$/.test(error.message)
        ? error.message
        : "native_helper_failed") + "\n",
    );
    process.exit(1);
  },
);
