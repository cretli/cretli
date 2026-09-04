import path from 'path';
import { fileURLToPath } from 'url';
import MiniCssExtractPlugin from 'mini-css-extract-plugin';
import { BuildMdiSubsetPlugin } from './webpack-icon-subset-plugin.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default {
  mode: 'production',
  target: 'web',
  context: __dirname,
  entry: {
    index: './App.js',
    login: './login/LoginApp.js',
    'embed-widget': './embed/widget.js',
  },
  output: {
    path: path.resolve(__dirname, '../public/dist/app'),
    filename: '[name].bundle.js',
    clean: true,
  },
  devtool: 'source-map',
  resolve: {
    extensions: ['.js'],
  },
  module: {
    rules: [
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
    minimize: true,
    splitChunks: {
      chunks: 'all',
      minSize: 30000,
      cacheGroups: {
        // The login page is served pre-auth and only needs Lit plus a few UI
        // primitives, so it gets its own vendor chunk. Sharing one with the SPA
        // dragged xterm, markdown-it and the icon font into a password form.
        // canBeInitial() keeps dynamic imports (for example Mermaid) lazy — a
        // plain name check would pull every async chunk into vendor as well.
        vendorLogin: {
          test: /[\\/]node_modules[\\/]/,
          name: 'vendor-login',
          chunks: (chunk) => chunk.canBeInitial() && chunk.name === 'login',
          priority: 20,
        },
        vendor: {
          test: /[\\/]node_modules[\\/]/,
          name: 'vendor',
          chunks: (chunk) => chunk.canBeInitial() && chunk.name !== 'login',
          priority: 10,
        },
        // Terminal, Tasks and Agents are separate lazy chunks but share xterm;
        // without this group each of them would ship its own copy.
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
