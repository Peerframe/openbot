import { cp, lstat, readdir, readlink, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";

function isWithin(root: string, path: string): boolean {
  const child = relative(root, path);
  return child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child);
}

export async function validateContainedResource(source: string): Promise<void> {
  if (!(await lstat(source)).isDirectory()) {
    throw new Error("Desktop native resource root must be a directory.");
  }
  const root = await realpath(source);
  async function visit(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        const target = await readlink(path);
        if (isAbsolute(target) || !isWithin(root, await realpath(path))) {
          throw new Error("Desktop native resource link escapes its package.");
        }
      } else if (entry.isDirectory()) {
        await visit(path);
      } else if (!entry.isFile()) {
        throw new Error("Desktop native resource contains an unsupported file type.");
      }
    }
  }
  await visit(root);
}

export async function copyContainedResource(source: string, destination: string): Promise<void> {
  await validateContainedResource(source);
  const resolvedDestination = join(await realpath(dirname(destination)), basename(destination));
  if (isWithin(await realpath(source), resolvedDestination)) {
    throw new Error("Desktop native resource destination must be outside its source.");
  }
  // Packager 20.3.0's default extra-resource copy resolves symlinks to the build tree.
  await cp(source, destination, {
    recursive: true,
    verbatimSymlinks: true,
    errorOnExist: true,
    force: false,
  });
  await validateContainedResource(destination);
}
