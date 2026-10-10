/** Fixed Docker lifecycle verbs; incomplete captures can never establish success or absence. */
import { DockerUnavailable, type Commander, type CommandResult } from "./subprocess.ts";
export function absent(result: CommandResult) {
  return (
    !result.uncertain &&
    [1, 127].includes(result.status ?? -1) &&
    (result.stdout + " " + result.stderr).toLowerCase().includes("no such")
  );
}
export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new DockerUnavailable("invalid Docker object");
  return value as Record<string, unknown>;
}
export class DockerCli {
  readonly commander: Commander;
  readonly timeout: number;
  constructor(commander: Commander, timeout = 30000) {
    this.commander = commander;
    this.timeout = timeout;
  }
  async version() {
    const result = await this.commander.run(
      ["version", "--format", "{{.Server.Version}}"],
      this.timeout,
    );
    if (!result.ok) throw new DockerUnavailable("Docker version unknown");
    return result.stdout.trim();
  }
  async info() {
    const result = await this.commander.run(["info", "--format", "{{json .}}"], this.timeout);
    if (!result.ok) throw new DockerUnavailable("Docker info unknown");
    return object(JSON.parse(result.stdout));
  }
  async imageInspect(reference: string) {
    const result = await this.commander.run(
      ["image", "inspect", reference, "--format", "{{json .}}"],
      this.timeout,
    );
    if (result.uncertain) throw new DockerUnavailable("Docker image inspect unknown");
    if (result.status !== 0) return null;
    return object(JSON.parse(result.stdout));
  }
  create(args: readonly string[], timeout = this.timeout) {
    return this.commander.run(["create", ...args], timeout);
  }
  start(id: string, timeout = this.timeout) {
    return this.commander.run(["start", id], timeout);
  }
  wait(id: string, timeout: number) {
    return this.commander.run(["wait", id], timeout);
  }
  async inspect(id: string, timeout = this.timeout) {
    const result = await this.commander.run(["inspect", id, "--format", "{{json .}}"], timeout);
    if (!result.ok) {
      if (absent(result)) return null;
      throw new DockerUnavailable("Docker inspect unknown");
    }
    return object(JSON.parse(result.stdout));
  }
  kill(id: string, timeout = this.timeout) {
    return this.commander.run(["kill", id], timeout);
  }
  remove(id: string, timeout = this.timeout) {
    return this.commander.run(["rm", "--force", id], timeout);
  }
}
