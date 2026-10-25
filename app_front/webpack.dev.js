import { baseConfig } from './webpack.common.js';

export default {
  ...baseConfig,
  watch: true,
  mode: 'development',
  devtool: 'eval-source-map',
};
