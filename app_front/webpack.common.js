import path from 'path';
import { fileURLToPath } from 'url';
import MiniCssExtractPlugin from 'mini-css-extract-plugin';
import { BuildMdiSubsetPlugin } from './scripts/webpack-icon-subset-plugin.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Shared webpack settings for webpack.dev.js and webpack.prod.js. Both configs
 * must emit the same file names and chunk layout (the static shells, sw.js
 * SHELL_ASSETS and the server read them), so everything except mode, watch and
 * devtool lives here.
 */
export const baseConfig = {
  context: __dirname,
  entry: {
    index: './index.js',
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
  resolve: {
    // .ts first-class: imports may use explicit .ts specifiers or extensionless paths.
    extensions: ['.js', '.ts'],
  },
  module: {
    rules: [
      {
        // Transpile only; types are checked separately by `npm run typecheck`.
        test: /\.ts$/i,
        loader: 'esbuild-loader',
        options: { loader: 'ts', target: 'es2022' },
      },
      {
        test: /\.css$/i,
        use: [MiniCssExtractPlugin.loader, 'css-loader'],
      },
      {
        test: /\.scss$/i,
        use: [
          MiniCssExtractPlugin.loader,
          'css-loader',
          { loader: 'sass-loader', options: { api: 'modern' } },
        ],
      },
    ],
  },
  plugins: [
    new BuildMdiSubsetPlugin(),
    new MiniCssExtractPlugin({
      filename: '[name].css',
    }),
  ],
  optimization: {
    splitChunks: {
      chunks: 'initial',
      cacheGroups: {
        // The pre-auth login page gets its own vendor
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
        // Name must not match webpackChunkName "sdk-hljs" (the lazy wrapper).
        // Webpack 5 forbids a cache group from reusing that named chunk when
        // Files also imports highlight.js — the wrapper is not a parent of
        // those modules.
        hljs: {
          test: /[\\/]node_modules[\\/]highlight\.js[\\/]/,
          name: 'hljs',
          chunks: (chunk) => !chunk.canBeInitial(),
          priority: 28,
          reuseExistingChunk: true,
        },
        sdkMarkdown: {
          test: /[\\/]node_modules[\\/]markdown-it[\\/]/,
          name: 'sdk-markdown',
          chunks: (chunk) => !chunk.canBeInitial(),
          priority: 27,
          reuseExistingChunk: true,
        },
        default: false,
        defaultVendors: false,
      },
    },
  },
};
