/** Protected Unix Host executable; configuration is provisioned explicitly by the operator. */
import { loadHostConfiguration } from "./host-configuration.ts";
import { Host } from "./protected-host.ts";
import { LinuxNative } from "./linux-native.ts";
import { UnixService } from "./host-service.ts";
import { requireFact } from "./protected-io.ts";
async function main() {
  const [flag, path, ...extra] = process.argv.slice(2);
  requireFact(
    flag === "--config" && path && extra.length === 0,
    "explicit_host_configuration_required",
  );
  const config = await loadHostConfiguration(path),
    native = await LinuxNative.open(config.native),
    host = new Host(config, native);
  await new UnixService(host).serve();
}
main().catch((error) => {
  process.stderr.write(
    (error instanceof Error && /^[a-z_]{1,80}$/.test(error.message)
      ? error.message
      : "protected_host_failed") + "\n",
  );
  process.exitCode = 1;
});
