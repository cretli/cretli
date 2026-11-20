import { EsbuildPlugin } from 'esbuild-loader';
import { baseConfig } from './webpack.common.js';

export default {
  ...baseConfig,
  mode: 'production',
  output: {
    ...baseConfig.output,
    // Lazy chunks are content-hashed so the server can mark them immutable.
    // Entry and split-vendor files keep stable names (static shells and sw.js
    // SHELL_ASSETS reference them); i18n-pl is precached by name, so it stays stable too.
    chunkFilename: (pathData) =>
      pathData.chunk?.name === 'i18n-pl' ? '[name].bundle.js' : '[name].[contenthash:8].chunk.js',
  },
  // Separate .map files that are not referenced from the bundles.
  devtool: 'hidden-source-map',
  optimization: {
    ...baseConfig.optimization,
    minimize: true,
    // esbuild is already the TS loader; it minifies JS and CSS without terser.
    minimizer: [new EsbuildPlugin({ target: 'es2022', css: true })],
  },
};
