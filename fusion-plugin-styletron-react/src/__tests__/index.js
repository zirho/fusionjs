/* eslint-env browser */
import tape from 'tape-cup';
import Plugin, {styled} from '../index.js';

tape('styletron-react plugin interface', t => {
  t.equal(typeof Plugin, 'object', 'exports a default plugin object');
  t.equal(
    typeof Plugin.middleware,
    'function',
    'exports a plugin with a middleware'
  );
  t.equal(typeof styled, 'function', 'exports a styled function');
  t.end();
});
