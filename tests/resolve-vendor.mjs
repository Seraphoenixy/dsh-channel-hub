/**
 * Test-only resolver: vendored TypeScript sources keep their compiled `.js`
 * specifiers, while this checkout has no emitted vendor files. Resolve those
 * relative imports to the adjacent `.ts` source so protocol tests can import
 * the vendor modules directly.
 */
import { registerHooks } from "node:module";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (
      context.parentURL?.includes("/vendor/") &&
      specifier.startsWith(".") &&
      specifier.endsWith(".js")
    ) {
      const candidate = new URL(
        specifier.slice(0, -3) + ".ts",
        context.parentURL,
      );
      if (existsSync(fileURLToPath(candidate))) {
        return { url: candidate.href, shortCircuit: true };
      }
    }
    return nextResolve(specifier, context);
  },
});
