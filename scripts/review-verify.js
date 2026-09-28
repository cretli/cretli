#!/usr/bin/env node
/**
 * Trusted review verification entry. Agents may pass only catalog ids.
 * Isolation and spawn live in lib/sdk/sdk-review-verify.js.
 */
import { runReviewVerifyCli } from '../lib/sdk/sdk-review-verify.js';

const result = await runReviewVerifyCli(process.argv.slice(2));
if (result.output) process.stdout.write(`${result.output}\n`);
if (!result.ok) {
  if (result.error) process.stderr.write(`${result.error}\n`);
  process.exit(1);
}
