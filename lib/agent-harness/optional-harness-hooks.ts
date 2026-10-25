/**
 * Small host-side registries that repo harness plugins (`harnesses/<id>/`) fill
 * from their light entry. They keep shared code free of harness names:
 *
 * - usage-limit bindings: extra fields stored with a limit lockout of a harness
 *   (room kernel);
 * - billing credential sources: how a harness' API credential is read for
 *   billing-account resolution;
 * - credit-ledger contributions: extra HTTP routes and a top-up listener.
 *
 * Leaf module (no imports) so any layer may read it; a plugin that is not
 * loaded simply never registers anything.
 */

/** Express application; `express` ships no type declarations in this repo. */
type Express = any;

export type HarnessLimitBindingFn = (ctx: Record<string, unknown>) => Record<string, unknown>;

export interface HarnessBillingCredentialSource {
  provider: string;
  endpoint: string;
  profileKey?: string;
  credential: () => string;
}

export interface CreditLedgerContribution {
  registerRoutes?: (app: Express, ctx: { filePath?: string; denied: (req: any) => boolean }) => void;
  /** Called after a new posted top-up. */
  onTopupPosted?: (event: { filePath?: string }) => void;
}

const LIMIT_BINDINGS = new Map<string, HarnessLimitBindingFn>();

const BILLING_CREDENTIAL_SOURCES = new Map<string, HarnessBillingCredentialSource>();

const CREDIT_LEDGER_CONTRIBUTIONS = new Map<string, CreditLedgerContribution>();

export function hasOptionalHarnessHooks(id: string): boolean {
  return LIMIT_BINDINGS.has(id) || BILLING_CREDENTIAL_SOURCES.has(id) || CREDIT_LEDGER_CONTRIBUTIONS.has(id);
}

export function registerHarnessLimitBinding(id: string, fn: HarnessLimitBindingFn): void {
  LIMIT_BINDINGS.set(id, fn);
}

/**
 * @returns Extra fields for the limit record ({} when none).
 */
export function resolveHarnessLimitBinding(transport: string, ctx: Record<string, unknown>): Record<string, unknown> {
  const fn = LIMIT_BINDINGS.get(transport);
  return fn ? fn(ctx) : {};
}

export function registerHarnessBillingCredentialSource(id: string, source: HarnessBillingCredentialSource): void {
  BILLING_CREDENTIAL_SOURCES.set(id, Object.freeze({ ...source }));
}

export function getHarnessBillingCredentialSource(id: string): HarnessBillingCredentialSource | undefined {
  return BILLING_CREDENTIAL_SOURCES.get(id);
}

export function registerCreditLedgerContribution(id: string, contribution: CreditLedgerContribution): void {
  CREDIT_LEDGER_CONTRIBUTIONS.set(id, Object.freeze({ ...contribution }));
}

export function listCreditLedgerContributions(): CreditLedgerContribution[] {
  return [...CREDIT_LEDGER_CONTRIBUTIONS.values()];
}
