import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default {
  watch: true,
  mode: 'development',
  context: __dirname,
  entry: {
    'embed-widget': './embed/widget.js',
  },
  output: {
    path: path.resolve(__dirname, '../public/dist/app'),
    filename: '[name].bundle.js',
    publicPath: '/dist/app/',
    clean: false,
  },
  target: 'web',
  devtool: 'eval-source-map',
  resolve: {
    extensions: ['.js'],
  },
};
