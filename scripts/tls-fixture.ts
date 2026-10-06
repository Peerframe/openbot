import { execFileSync } from "node:child_process";
import { chmod, writeFile } from "node:fs/promises";
import { join } from "node:path";

/** Disposable CA/leaf only; follows the existing work-journey OpenSSL fixture, never provisions PKI. */
export async function issueTlsFixture(
  directory: string,
  purpose: "serverAuth" | "clientAuth" = "serverAuth",
) {
  const command = (...args: string[]) =>
    execFileSync("/usr/bin/openssl", args, {
      cwd: directory,
      env: { PATH: "/usr/bin:/bin" },
      stdio: "ignore",
      timeout: 20_000,
    });
  await writeFile(
    join(directory, "ca.cnf"),
    "[req]\nprompt=no\ndistinguished_name=dn\nx509_extensions=ca\n[dn]\nCN=OpenBot disposable CA\n[ca]\nbasicConstraints=critical,CA:TRUE\nkeyUsage=critical,keyCertSign,cRLSign\nsubjectKeyIdentifier=hash\n",
    { mode: 0o600 },
  );
  command(
    "req",
    "-new",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-sha256",
    "-days",
    "2",
    "-config",
    "ca.cnf",
    "-keyout",
    "ca.key",
    "-out",
    "ca.pem",
  );
  await writeFile(
    join(directory, "server.cnf"),
    `basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=${purpose}\nsubjectAltName=DNS:localhost,DNS:entry.test,IP:127.0.0.1\n`,
    { mode: 0o600 },
  );
  command(
    "req",
    "-new",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-sha256",
    "-subj",
    "/CN=entry.test",
    "-keyout",
    "server.key",
    "-out",
    "server.csr",
  );
  command(
    "x509",
    "-req",
    "-in",
    "server.csr",
    "-CA",
    "ca.pem",
    "-CAkey",
    "ca.key",
    "-CAcreateserial",
    "-sha256",
    "-days",
    "1",
    "-extfile",
    "server.cnf",
    "-out",
    "server.pem",
  );
  for (const name of ["ca.key", "ca.pem", "server.key", "server.pem"])
    await chmod(join(directory, name), 0o600);
  return {
    certificatePath: join(directory, "server.pem"),
    privateKeyPath: join(directory, "server.key"),
    caPath: join(directory, "ca.pem"),
  };
}
