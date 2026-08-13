/**
 * The web app renders the world the engine produces, so it depends on two
 * workspace packages whose entry points are TypeScript (`@sim/engine`,
 * `@sim/runner`) — those must be transpiled, not treated as prebuilt.
 *
 * The engine reads Natural Earth coastlines at runtime with a `createRequire`
 * of `world-atlas/land-110m.json`; that stays a real Node require, so the two
 * geo packages are kept external (not bundled) and their data files are traced
 * into the serverless function for `/api/world`.
 */

/** @type {import('next').NextConfig} */
const nextConfig = {
  transpilePackages: ["@sim/engine", "@sim/runner"],
  serverExternalPackages: ["world-atlas", "topojson-client"],
  outputFileTracingIncludes: {
    "/api/world": ["../../node_modules/.pnpm/world-atlas@*/**"],
  },
};

export default nextConfig;
