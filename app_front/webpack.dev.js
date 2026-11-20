import { baseConfig } from './webpack.common.js';

import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default {
  ...baseConfig,
  // Kept apart from the production build (public/dist/app) so the two never
  // overwrite each other; the server serves this one with CRETLI_FRONT_BUNDLE=dev.
  output: { ...baseConfig.output, path: path.resolve(__dirname, '../public/dist/app-dev') },
  watch: true,
  mode: 'development',
  // eval-source-map inlines a full map into every module (index.bundle.js ~19 MB vs ~6 MB
  // here), which dominated page load after each rebuild. A separate .map file is fetched
  // only while DevTools is open.
  devtool: 'cheap-module-source-map',
};
