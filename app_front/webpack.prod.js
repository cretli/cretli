import { baseConfig } from './webpack.common.js';

export default {
  ...baseConfig,
  mode: 'production',
  // Separate .map files that are not referenced from the bundles.
  devtool: 'hidden-source-map',
  optimization: {
    ...baseConfig.optimization,
    minimize: true,
  },
};
