import path from 'path';
import { fileURLToPath } from 'url';
import webpack from 'webpack';
import MiniCssExtractPlugin from 'mini-css-extract-plugin';
import { buildMdiSubset } from '../scripts/build-mdi-subset.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// The icon font subset is derived from a source scan and is built once, when
// this config is loaded. A watcher rebuild does not rescan, so a newly used
// mdi-* class renders as a blank glyph until the watcher restarts or
// `node scripts/build-mdi-subset.mjs` runs.
await buildMdiSubset();

const useHmr =
  process.env.CRETLI_FRONT_HMR === '1' ||
  (process.env.CRETLI_FRONT_HMR !== '0' && process.env.CURSOR_REMOTE_FRONT_HMR === '1');
const styleLoaderOrExtract = useHmr ? 'style-loader' : MiniCssExtractPlugin.loader;
const devEntry = useHmr
  ? ['webpack-hot-middleware/client?path=/__webpack_hmr&reload=false&overlay=false', './App.js']
  : './App.js';

export default {
  watch: !useHmr,
  mode: 'development',
  context: __dirname,
  entry: {
    index: devEntry,
    login: './login/LoginApp.js',
    'embed-widget': './embed/widget.js',
  },
  output: {
    path: path.resolve(__dirname, '../public/dist/app'),
    filename: '[name].bundle.js',
    publicPath: '/dist/app/',
    clean: true,
  },
  target: 'web',
  devtool: 'eval-source-map',
  resolve: {
    extensions: ['.js'],
  },
  module: {
    rules: [
      {
        test: /\.css$/i,
        use: [styleLoaderOrExtract, 'css-loader'],
      },
      {
        test: /\.scss$/i,
        use: [
          styleLoaderOrExtract,
          'css-loader',
          { loader: 'sass-loader', options: { api: 'modern' } },
        ],
      },
    ],
  },
  plugins: [
    ...(useHmr
      ? [new webpack.HotModuleReplacementPlugin()]
      : [
          new MiniCssExtractPlugin({
            filename: '[name].css',
          }),
        ]),
  ],
  optimization: {
    splitChunks: {
      chunks: 'initial',
      cacheGroups: {
        // Mirrors webpack.prod.js: the pre-auth login page gets its own vendor
        // chunk so it does not load the SPA dependencies.
        vendorLogin: {
          test: /[\\/]node_modules[\\/]/,
          name: 'vendor-login',
          chunks(chunk) {
            return chunk.canBeInitial() && chunk.name === 'login';
          },
          priority: 20,
        },
        // Only split node_modules into the vendor chunk. Disable the automatic
        // shared-app chunk so each entry is self-contained for the static shells.
        vendor: {
          test: /[\\/]node_modules[\\/]/,
          name: 'vendor',
          chunks(chunk) {
            return chunk.canBeInitial() && chunk.name !== 'embed-widget' && chunk.name !== 'login';
          },
          priority: 10,
        },
        // Vendor is initial-only. @xterm is imported only by lazy Terminal/Tasks/
        // Agents panels — without this group those modules are dropped and the
        // tab shows "This panel could not be loaded".
        xterm: {
          test: /[\\/]node_modules[\\/]@xterm[\\/]/,
          name: 'xterm',
          chunks: (chunk) => !chunk.canBeInitial(),
          priority: 30,
          reuseExistingChunk: true,
        },
        default: false,
        defaultVendors: false,
      },
    },
  },
};
