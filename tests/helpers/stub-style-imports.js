/**
 * Front modules import their stylesheets (`import './x.scss'`) for webpack. Node cannot
 * load them, so tests that reach such modules import this helper first: every .css/.scss
 * import resolves to an empty module. Must be imported before the front modules.
 */
import { register } from 'node:module';

register('data:text/javascript,' + encodeURIComponent(
  "export async function load(url, ctx, next) { if (/\\.s?css(\\?|$)/.test(url)) return { format: 'module', source: 'export default \"\";', shortCircuit: true }; return next(url, ctx); }",
));
