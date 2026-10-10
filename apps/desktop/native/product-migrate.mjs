// The explicit TS candidate shares the container's validated SQL/Temporal upgrade preflight.
import { prepareProduct } from "../deploy/server/prepare-product.ts";
await prepareProduct(process.env);
