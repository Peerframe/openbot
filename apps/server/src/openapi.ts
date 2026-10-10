/** Publishes the existing contract document and its actual transport cookie security scheme. */
import { controlHttpOpenApi } from "@openbot/protocol";
export function publicOpenApi(secure: boolean) {
  const document = controlHttpOpenApi();
  for (const methods of Object.values(document.paths)) for (const operation of Object.values(methods)) {
    if (operation && typeof operation === "object")
      Reflect.set(operation, "security", Reflect.get(operation, "x-openbot-owner-session") === false ? [] : [{ OwnerSession: [] }]);
  }
  return { ...document, components: { ...document.components, securitySchemes: {
    OwnerSession: { type: "apiKey", in: "cookie", name: secure ? "__Host-openbot_session" : "openbot_session" },
  } } };
}
