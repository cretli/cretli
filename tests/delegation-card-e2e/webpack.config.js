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
    path: path.join(projectRoot, '.tmp/delegation-card-e2e'),
    filename: 'harness.js',
    publicPath: '/',
    clean: false,
  },
  target: 'web',
  devtool: false,
  resolve: {
    extensions: ['.js', '.ts'],
    alias: {
      // Cards use status predicates; server settings persistence is outside this fixture.
      [path.join(projectRoot, 'lib/delegation-settings.js')]: path.join(here, 'settings-stub.js'),
    },
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
      { test: /\.ts$/i, loader: 'esbuild-loader', options: { loader: 'ts', target: 'es2022' } },
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
