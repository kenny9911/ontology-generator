/**
 * ============================================================================
 *  ONTOLOGY GENERATOR — NEO4J DRIVER (env-gated, lazy, graceful)
 * ============================================================================
 *
 *  Neo4j is an OPTIONAL, env-gated projection of the canonical JSON ontology.
 *  This module owns the lifecycle of the (lazily created) singleton driver and
 *  exposes only safe, non-throwing surface area:
 *
 *    - neo4jEnabled():   true iff ALL THREE of NEO4J_URI / NEO4J_USER /
 *                        NEO4J_PASSWORD are set. No connection is attempted.
 *    - getDriver():      lazy singleton Driver, or null when disabled. NEVER
 *                        opens a connection when disabled (no driver()).
 *    - neo4jHealthy():   verifyConnectivity(), catches ALL errors -> false.
 *    - closeDriver():    tears down the singleton (best-effort, never throws).
 *
 *  HARD RULE: this file must NEVER throw on a missing env. No request path
 *  hard-depends on Neo4j — callers degrade to `{ mirrored: false }`.
 * ============================================================================
 */

import neo4j, { type Driver } from 'neo4j-driver';

/** Lazy singleton. `null` = not yet created (or torn down / disabled). */
let driverSingleton: Driver | null = null;

/**
 * True iff every required Neo4j env var is present and non-empty. Reads env on
 * every call so config picked up at runtime (serverless cold start) is honored;
 * never attempts a connection.
 */
export function neo4jEnabled(): boolean {
  const uri = process.env.NEO4J_URI;
  const user = process.env.NEO4J_USER;
  const password = process.env.NEO4J_PASSWORD;
  return Boolean(uri && user && password);
}

/**
 * Lazily construct (once) and return the shared Driver. Returns `null` when
 * Neo4j is disabled — and crucially does NOT call `neo4j.driver(...)` in that
 * case, so no connection / DNS / socket work happens when env is absent.
 *
 * `neo4j.driver()` itself does not open a socket eagerly (connections are
 * pooled lazily on first query), so constructing the singleton here is safe.
 */
export function getDriver(): Driver | null {
  if (!neo4jEnabled()) {
    return null;
  }
  if (driverSingleton) {
    return driverSingleton;
  }
  try {
    const uri = process.env.NEO4J_URI as string;
    const user = process.env.NEO4J_USER as string;
    const password = process.env.NEO4J_PASSWORD as string;
    driverSingleton = neo4j.driver(uri, neo4j.auth.basic(user, password));
    return driverSingleton;
  } catch {
    // Construction should not throw for valid env, but stay graceful.
    driverSingleton = null;
    return null;
  }
}

/**
 * Verify the driver can reach the server. Catches ALL errors (disabled,
 * unreachable, auth failure, malformed URI) and resolves to `false` — never
 * rejects.
 */
export async function neo4jHealthy(): Promise<boolean> {
  const driver = getDriver();
  if (!driver) {
    return false;
  }
  try {
    await driver.verifyConnectivity();
    return true;
  } catch {
    return false;
  }
}

/**
 * Best-effort teardown of the singleton. Never throws; safe to call when no
 * driver was ever created.
 */
export async function closeDriver(): Promise<void> {
  const driver = driverSingleton;
  driverSingleton = null;
  if (!driver) {
    return;
  }
  try {
    await driver.close();
  } catch {
    // ignore — teardown must never throw.
  }
}
