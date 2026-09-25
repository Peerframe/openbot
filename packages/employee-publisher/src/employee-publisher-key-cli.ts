import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  exportEmployeePublisherPublicKey,
  initializeEmployeePublisherKeyring,
  readEmployeePublisherKeyringStatus,
  revokeEmployeePublisherKey,
  rotateEmployeePublisherKeyring,
  trustEmployeePublisherKey,
  type EmployeePublisherKeyringLocation,
} from "./employee-publisher-keyring.js";

const [command, ...arguments_] = process.argv.slice(2);

try {
  if (command === undefined || command === "help" || command === "--help") {
    printHelp();
  } else {
    const location = readLocation(arguments_);
    const result = await run(command, arguments_, location);
    console.info(JSON.stringify(result, null, 2));
    if (!["status", "export-public"].includes(command)) {
      console.info("Restart the OpenBot Server to load the updated publisher keyring.");
    }
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}

async function run(
  command: string,
  arguments_: string[],
  location: EmployeePublisherKeyringLocation,
) {
  switch (command) {
    case "init":
      return initializeEmployeePublisherKeyring(location);
    case "rotate":
      return rotateEmployeePublisherKeyring(location);
    case "revoke": {
      const keyid = optionValue(arguments_, "--key-id");
      if (keyid === undefined) throw new Error("revoke requires --key-id <id>.");
      return revokeEmployeePublisherKey(location, keyid);
    }
    case "trust": {
      const publicKeyFile = optionValue(arguments_, "--public-key");
      const expectedKeyId = optionValue(arguments_, "--expected-key-id");
      if (publicKeyFile === undefined || expectedKeyId === undefined) {
        throw new Error("trust requires --public-key <file> and --expected-key-id <id>.");
      }
      return trustEmployeePublisherKey(location, publicKeyFile, expectedKeyId);
    }
    case "export-public": {
      const output = optionValue(arguments_, "--output");
      if (output === undefined) throw new Error("export-public requires --output <file>.");
      const exported = await exportEmployeePublisherPublicKey(
        location,
        optionValue(arguments_, "--key-id"),
      );
      const outputPath = resolve(output);
      await writeFile(outputPath, exported.publicKey, { flag: "wx", mode: 0o644 });
      return { keyid: exported.keyid, algorithm: exported.algorithm, output: outputPath };
    }
    case "status":
      return readEmployeePublisherKeyringStatus(location);
    default:
      throw new Error(`Unknown Employee publisher-key command: ${command}`);
  }
}

function readLocation(arguments_: string[]): EmployeePublisherKeyringLocation {
  const directory =
    optionValue(arguments_, "--keyring") ?? process.env.OPENBOT_EMPLOYEE_PUBLISHER_KEYRING_PATH;
  const passphraseFile =
    optionValue(arguments_, "--passphrase-file") ??
    process.env.OPENBOT_EMPLOYEE_PUBLISHER_PASSPHRASE_FILE;
  if (directory === undefined || passphraseFile === undefined) {
    throw new Error(
      "Set --keyring and --passphrase-file, or the matching OPENBOT_EMPLOYEE_PUBLISHER_* variables.",
    );
  }
  return { directory, passphraseFile };
}

function optionValue(arguments_: string[], name: string): string | undefined {
  const index = arguments_.indexOf(name);
  if (index === -1) return undefined;
  const value = arguments_[index + 1];
  if (value === undefined || value.startsWith("--")) throw new Error(`${name} requires a value.`);
  return value;
}

function printHelp(): void {
  console.info(`OpenBot Employee publisher-key commands

Usage:
  npm run employee:publisher-key -- init --keyring <directory> --passphrase-file <file>
  npm run employee:publisher-key -- rotate --keyring <directory> --passphrase-file <file>
  npm run employee:publisher-key -- revoke --key-id <id> --keyring <directory> --passphrase-file <file>
  npm run employee:publisher-key -- export-public --output <file> --keyring <directory> --passphrase-file <file>
  npm run employee:publisher-key -- trust --public-key <file> --expected-key-id <id> --keyring <directory> --passphrase-file <file>
  npm run employee:publisher-key -- status --keyring <directory> --passphrase-file <file>

init creates a random passphrase file when it does not exist. Back up the keyring and passphrase
separately. Private key material is never printed.`);
}
