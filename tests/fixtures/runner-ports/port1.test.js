// Fixture: obtains a free port the way the sidebar DOM tests do (listen on 0), holds it, prints it.
import { createServer } from 'node:net';

const server = createServer();
server.listen(0, '127.0.0.1', () => {
  console.log(`PORT=${server.address().port}`);
  setTimeout(() => server.close(), 300);
});
