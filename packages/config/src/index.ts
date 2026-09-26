import { isIP } from "node:net";
import { URL } from "node:url";
import { z } from "zod";

const portSchema = z.coerce.number().int().positive().max(65_535);
const booleanSchema = z
  .enum(["true", "false"])
  .default("false")
  .transform((value) => value === "true");
const nodeIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/, "Use a stable machine identifier.");
const nodeEnrollmentTokenSchema = z
  .string()
  .min(48)
  .max(256)
  .regex(/^obenr_[A-Za-z0-9_-]+$/, "Use an OpenBot Node enrollment token.");
const nodeCredentialSchema = z
  .string()
  .min(47)
  .max(256)
  .regex(/^obn_[A-Za-z0-9_-]+$/, "Use an OpenBot Node credential.");
const nodeServerUrlSchema = z
  .string()
  .url()
  .superRefine((value, context) => {
    const url = new URL(value);
    if (url.protocol !== "ws:" && url.protocol !== "wss:") {
      context.addIssue({ code: "custom", message: "Node Server URLs must use WS or WSS." });
      return;
    }
    if (!isLoopbackHostname(url.hostname) && url.protocol !== "wss:") {
      context.addIssue({
        code: "custom",
        message: "Non-loopback Node Server URLs must use WSS.",
      });
    }
  });

export const macOSNodeServiceConfigFormat = "openbot.macos-node-config/v1" as const;

export const macOSNodeServiceConfigSchema = z
  .object({
    format: z.literal(macOSNodeServiceConfigFormat),
    nodeId: nodeIdSchema,
    serverUrl: nodeServerUrlSchema,
    maxConcurrentRuns: z.number().int().min(1).max(16).default(1),
    logLevel: z.enum(["debug", "info", "warn", "error"]).default("info"),
  })
  .strict();

export const serverEnvSchema = z
  .object({
    OPENBOT_HOST: z.string().default("127.0.0.1"),
    OPENBOT_AGENT_RUNTIME: z.enum(["typescript", "python"]).default("typescript"),
    OPENBOT_PORT: portSchema.default(3001),
    OPENBOT_DATABASE_URL: z.string().default("postgres://openbot:openbot@localhost:5432/openbot"),
    OPENBOT_OWNER_NAME: z.string().trim().min(1).max(80).default("Owner"),
    OPENBOT_OWNER_PASSWORD: z
      .string()
      .min(15)
      .refine(
        (value) => value !== "replace-with-a-long-random-owner-password",
        "Replace the example owner password before starting OpenBot.",
      ),
    OPENBOT_SESSION_TTL_HOURS: z.coerce.number().int().min(1).max(168).default(12),
    OPENBOT_SECURE_COOKIES: booleanSchema,
    OPENBOT_ALLOWED_ORIGINS: z
      .string()
      .default("http://localhost:5173,http://127.0.0.1:5173")
      .transform((value) =>
        value
          .split(",")
          .map((origin) => origin.trim())
          .filter(Boolean),
      )
      .pipe(z.array(z.string().url()).min(1)),
    OPENBOT_OBJECT_STORE_PATH: z.string().default("./data/objects"),
    OPENBOT_PLUGIN_LOCAL_ENDPOINTS: z
      .string()
      .max(32768)
      .default("")
      .transform((value) =>
        value
          .split(",")
          .map((item) => item.trim())
          .filter(Boolean),
      )
      .pipe(z.array(z.string().url().max(2048)).max(16)),
    OPENBOT_EMPLOYEE_PUBLISHER_KEYRING_PATH: z.string().trim().min(1).optional(),
    OPENBOT_EMPLOYEE_PUBLISHER_PASSPHRASE_FILE: z.string().trim().min(1).optional(),
    OPENBOT_MODEL_SETTINGS_PATH: z.string().trim().min(1).optional(),
    OPENBOT_MODEL_DIRECTORY: z.string().trim().min(1).optional(),
    OPENBOT_MODEL_ENCRYPTION_KEY: z
      .string()
      .regex(/^[a-f0-9]{64}$/u)
      .optional(),
    OPENBOT_LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
    TAVILY_API_KEY: z.preprocess(
      (value) => (value === "" ? undefined : value),
      z
        .string()
        .trim()
        .min(1)
        .max(512)
        .regex(/^[\x21-\x7e]+$/u)
        .optional(),
    ),
    OPENBOT_TRUSTED_PROXY_ADDRESS: z.preprocess(
      (value) => (value === "" ? undefined : value),
      z
        .string()
        .trim()
        .refine((value) => isIP(value) !== 0, "Trusted proxy address must be one exact IP address.")
        .optional(),
    ),
  })
  .superRefine((value, context) => {
    if (
      value.OPENBOT_MODEL_DIRECTORY !== undefined &&
      (value.OPENBOT_MODEL_SETTINGS_PATH !== undefined ||
        value.OPENBOT_MODEL_ENCRYPTION_KEY !== undefined)
    ) {
      context.addIssue({
        code: "custom",
        message: "Model directory cannot be combined with legacy model path or encryption key.",
        path: ["OPENBOT_MODEL_DIRECTORY"],
      });
    }
    if (
      (value.OPENBOT_MODEL_SETTINGS_PATH === undefined) !==
      (value.OPENBOT_MODEL_ENCRYPTION_KEY === undefined)
    ) {
      context.addIssue({
        code: "custom",
        message: "Model settings path and encryption key must be configured together.",
        path: ["OPENBOT_MODEL_SETTINGS_PATH"],
      });
    }
    let hasRemoteOrigin = false;
    for (const origin of value.OPENBOT_ALLOWED_ORIGINS) {
      const url = new URL(origin);
      if (url.protocol !== "http:" && url.protocol !== "https:") {
        context.addIssue({
          code: "custom",
          message: "Allowed origins must use HTTP or HTTPS.",
          path: ["OPENBOT_ALLOWED_ORIGINS"],
        });
        continue;
      }
      if (isLoopbackHostname(url.hostname)) continue;
      hasRemoteOrigin = true;
      if (url.protocol !== "https:") {
        context.addIssue({
          code: "custom",
          message: "Non-loopback origins must use HTTPS.",
          path: ["OPENBOT_ALLOWED_ORIGINS"],
        });
      }
    }
    if (hasRemoteOrigin && !value.OPENBOT_SECURE_COOKIES) {
      context.addIssue({
        code: "custom",
        message: "Secure cookies are required when an allowed origin is not loopback.",
        path: ["OPENBOT_SECURE_COOKIES"],
      });
    }
    if (
      (value.OPENBOT_EMPLOYEE_PUBLISHER_KEYRING_PATH === undefined) !==
      (value.OPENBOT_EMPLOYEE_PUBLISHER_PASSPHRASE_FILE === undefined)
    ) {
      context.addIssue({
        code: "custom",
        message:
          "Employee publisher keyring and passphrase-file paths must be configured together.",
        path: ["OPENBOT_EMPLOYEE_PUBLISHER_KEYRING_PATH"],
      });
    }
  });

export const nodeEnvSchema = z
  .object({
    OPENBOT_NODE_ID: nodeIdSchema,
    OPENBOT_NODE_SERVER_URL: nodeServerUrlSchema.default("ws://localhost:3001/ws/nodes"),
    OPENBOT_NODE_ENROLLMENT_TOKEN: nodeEnrollmentTokenSchema.optional(),
    OPENBOT_NODE_CREDENTIAL: nodeCredentialSchema.optional(),
    OPENBOT_NODE_ALLOW_ENV_CREDENTIAL: booleanSchema,
    OPENBOT_NODE_CREDENTIAL_STORE: z.enum(["file", "secret-service", "macos-host"]).default("file"),
    OPENBOT_NODE_CREDENTIAL_PATH: z.string().trim().min(1).optional(),
    OPENBOT_NODE_SERVICE_CONTROL: z.enum(["stdio-v2", "stdio-v3"]).optional(),
    OPENBOT_NODE_MAX_CONCURRENT_RUNS: z.coerce.number().int().min(1).max(16).default(1),
    OPENBOT_NODE_WORK_DIRECTORY: z.string().default("./data/node"),
    OPENBOT_LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
    OPENBOT_DOCKER_COMPUTER_URL: z.string().url().optional(),
    OPENBOT_DOCKER_COMPUTER_TOKEN: z.string().min(16).optional(),
    OPENBOT_DOCKER_ALLOW_PRIVATE_HOSTS: booleanSchema,
    OPENBOT_DOCKER_INPUT_ORIGINS: z
      .string()
      .default("")
      .transform((value) =>
        value
          .split(",")
          .map((item) => item.trim())
          .filter(Boolean),
      )
      .pipe(
        z
          .array(
            z
              .string()
              .url()
              .refine((value) => {
                const url = new URL(value);
                return (
                  url.origin === value &&
                  !url.username &&
                  !url.password &&
                  (url.protocol === "https:" ||
                    (url.protocol === "http:" && url.hostname === "127.0.0.1"))
                );
              }),
          )
          .max(10),
      ),
  })
  .superRefine((value, context) => {
    if (value.OPENBOT_DOCKER_INPUT_ORIGINS.length && !value.OPENBOT_DOCKER_COMPUTER_URL)
      context.addIssue({
        code: "custom",
        message: "Browser input origins require a configured computer.",
        path: ["OPENBOT_DOCKER_INPUT_ORIGINS"],
      });
    if (
      value.OPENBOT_NODE_CREDENTIAL !== undefined &&
      (!value.OPENBOT_NODE_ALLOW_ENV_CREDENTIAL || value.OPENBOT_NODE_CREDENTIAL_STORE !== "file")
    ) {
      context.addIssue({
        code: "custom",
        message:
          "Environment credentials require OPENBOT_NODE_ALLOW_ENV_CREDENTIAL=true and the file profile. Prefer enrollment with the configured credential store.",
        path: ["OPENBOT_NODE_CREDENTIAL"],
      });
    }
    if (
      value.OPENBOT_NODE_CREDENTIAL_STORE === "secret-service" &&
      value.OPENBOT_NODE_CREDENTIAL_PATH !== undefined
    ) {
      context.addIssue({
        code: "custom",
        message: "A credential path cannot be used with the Secret Service store.",
        path: ["OPENBOT_NODE_CREDENTIAL_PATH"],
      });
    }
    if (value.OPENBOT_NODE_CREDENTIAL_STORE === "macos-host") {
      for (const field of [
        "OPENBOT_NODE_ENROLLMENT_TOKEN",
        "OPENBOT_NODE_CREDENTIAL",
        "OPENBOT_NODE_CREDENTIAL_PATH",
      ] as const) {
        if (value[field] !== undefined) {
          context.addIssue({
            code: "custom",
            message: "The macOS native Host must be the only Node identity source.",
            path: [field],
          });
        }
      }
      if (value.OPENBOT_NODE_SERVICE_CONTROL !== "stdio-v3") {
        context.addIssue({
          code: "custom",
          message: "The macOS native Host requires stdio-v3 control.",
          path: ["OPENBOT_NODE_SERVICE_CONTROL"],
        });
      }
    } else if (value.OPENBOT_NODE_SERVICE_CONTROL === "stdio-v3") {
      context.addIssue({
        code: "custom",
        message: "stdio-v3 control is reserved for the macOS native Host.",
        path: ["OPENBOT_NODE_SERVICE_CONTROL"],
      });
    }
    if (
      (value.OPENBOT_DOCKER_COMPUTER_URL === undefined) !==
      (value.OPENBOT_DOCKER_COMPUTER_TOKEN === undefined)
    ) {
      context.addIssue({
        code: "custom",
        message:
          "OPENBOT_DOCKER_COMPUTER_URL and OPENBOT_DOCKER_COMPUTER_TOKEN must be set together.",
        path: ["OPENBOT_DOCKER_COMPUTER_URL"],
      });
    }
  });

export type ServerEnv = z.infer<typeof serverEnvSchema>;
export type NodeEnv = z.infer<typeof nodeEnvSchema>;
export type MacOSNodeServiceConfig = z.infer<typeof macOSNodeServiceConfigSchema>;

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  return (
    normalized === "localhost" ||
    normalized.endsWith(".localhost") ||
    normalized === "[::1]" ||
    /^127(?:\.\d{1,3}){3}$/.test(normalized)
  );
}
