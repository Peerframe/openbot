# Protocol contributor rules

This package owns retained Node/wire Zod contracts. Python product HTTP DTOs and Web `work-api.ts`
are a separate contract chain. Work create/get/cancel types are generated from actual Python
OpenAPI; `work-api.ts` retains runtime validation and safe errors. This is not a generated client.
Use the [cross-language route](../../docs/REPOSITORY_MAP.md#cross-language-contract).
Trace actual Node, Web/Desktop and Python consumers, not just direct imports. Preserve strict runtime
validation, unknown fields, missing versus null, error codes, byte bounds and negative serialization
cases. A public contract change requires targeted evidence and affected consumer checks. Shared
packages must not import apps. Build shared contracts before downstream typechecks; frozen oracle
comparison is compatibility evidence, not permission to extend the retired implementation.
