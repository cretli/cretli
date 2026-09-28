import path from 'node:path';
import { fileURLToPath } from 'node:url';
import webpack from 'webpack';

const here = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(here, '../..');

export default {
  mode: 'development',
  context: projectRoot,
  entry: path.join(here, 'harness.js'),
  output: {
    path: path.join(projectRoot, '.tmp/chat-history-sync-e2e'),
    filename: 'harness.js',
    publicPath: '/',
    clean: false,
  },
  target: 'web',
  devtool: false,
  resolve: {
    extensions: ['.js'],
    modules: [
      path.join(projectRoot, 'node_modules'),
      path.join(projectRoot, 'app_front/node_modules'),
    ],
  },
  resolveLoader: {
    modules: [
      path.join(projectRoot, 'node_modules'),
      path.join(projectRoot, 'app_front/node_modules'),
    ],
  },
  module: {
    rules: [
      {
        test: /\.css$/i,
        use: ['style-loader', 'css-loader'],
      },
      {
        test: /\.scss$/i,
        use: [
          'style-loader',
          'css-loader',
          { loader: 'sass-loader', options: { api: 'modern' } },
        ],
      },
    ],
  },
  plugins: [
    new webpack.DefinePlugin({
      'process.env.NODE_ENV': JSON.stringify('development'),
    }),
  ],
};
