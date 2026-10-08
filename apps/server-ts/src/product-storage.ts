import { refuse } from "./owner-transaction.js";
import type { ProductRoute } from "./product-identity.js";
import type { StorageService } from "./storage-service.js";
export function storageRoutes(service: StorageService): ProductRoute[] {
  const routes: ProductRoute[] = [];
  const add = (
    method: string,
    path: string,
    remote: NonNullable<ProductRoute["remote"]>,
    maxBytes = 4096,
  ) =>
    routes.push({
      method,
      path,
      kind: "product",
      maxBytes,
      remote,
      execute: async () => {
        throw new Error("Storage must own file/transaction ordering.");
      },
    });
  routes.push({
    method: "GET",
    path: "/api/v1/settings/storage",
    kind: "product",
    execute: (db) => service.getSettings(db),
  });
  add("PUT", "/api/v1/settings/storage", (owner, _ids, body, signal) =>
    service.saveSettings(owner, body, signal),
  );
  add("GET", "/api/v1/storage", (owner, _ids, _body, signal, request) => {
    if (request.query.size) return refuse(422, "invalid_storage_query");
    return service.usage(owner, signal);
  });
  add("POST", "/api/v1/storage/trash/cleanup", (owner, _ids, body, signal, request) => {
    if (request.query.size) return refuse(422, "invalid_storage_query");
    return service.cleanup(owner, null, body, signal);
  });
  add("POST", "/api/v1/channels/{channel_id}/attachments/cleanup", (owner, ids, body, signal) =>
    service.cleanup(owner, ids[0]!, body, signal),
  );
  add(
    "DELETE",
    "/api/v1/channels/{channel_id}/attachments/{attachment_id}/purge",
    (owner, ids, body, signal) => {
      if (
        body !== null &&
        (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).length)
      )
        return refuse(422, "invalid_attachment_command");
      return service.purge(owner, ids[0]!, ids[1]!, signal);
    },
    32768,
  );
  return routes;
}
