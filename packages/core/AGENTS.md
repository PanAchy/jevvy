# Core

This private package owns provider-neutral judgment types and provider implementations. Keep OpenCode SDK types and permission policy in `@jevvy/permissions`.

## Provider boundaries

- Keep each wire format in its owning adapter. Share HTTP status and error handling through `src/provider-http.ts`; keep System One wire schemas in `src/system-one.ts`.
- When changing transport, prefer Effect HTTP clients and test layers over widening the raw `fetch` and `Response` boundary.
- Decode provider wire data with Schema at the transport boundary. Pass typed values inward and preserve typed provider failures in the Effect error channel.
- Keep provider tests credential-free. Exercise the real boundary through an injected transport or test layer rather than reproducing transport logic in the test.
