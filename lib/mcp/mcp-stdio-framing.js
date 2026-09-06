/**
 * MCP stdio framing: Content-Length (spec) with newline-JSON fallback.
 */

/**
 * @param {NodeJS.ReadableStream} input
 * @param {(message: object) => void} onMessage
 * @returns {() => void} stop
 */
export function listenMcpStdio(input, onMessage) {
  let buffer = Buffer.alloc(0);
  const onData = (chunk) => {
    buffer = Buffer.concat([buffer, Buffer.from(chunk)]);
    while (true) {
      const headerEnd = buffer.indexOf('\r\n\r\n');
      if (headerEnd !== -1) {
        const header = buffer.slice(0, headerEnd).toString('utf8');
        const match = header.match(/Content-Length:\s*(\d+)/i);
        if (!match) {
          buffer = buffer.slice(headerEnd + 4);
          continue;
        }
        const length = Number(match[1]);
        const start = headerEnd + 4;
        if (buffer.length < start + length) return;
        const body = buffer.slice(start, start + length).toString('utf8');
        buffer = buffer.slice(start + length);
        try {
          onMessage(JSON.parse(body));
        } catch {
          // ignore malformed
        }
        continue;
      }
      const nl = buffer.indexOf('\n');
      if (nl === -1) return;
      const line = buffer.slice(0, nl).toString('utf8').replace(/\r$/, '').trim();
      buffer = buffer.slice(nl + 1);
      if (!line.startsWith('{')) continue;
      try {
        onMessage(JSON.parse(line));
      } catch {
        // ignore malformed
      }
    }
  };
  input.on('data', onData);
  return () => input.off('data', onData);
}

/**
 * @param {NodeJS.WritableStream} output
 * @param {object} message
 */
export function writeMcpStdioMessage(output, message) {
  const json = JSON.stringify(message);
  const payload = Buffer.from(json, 'utf8');
  output.write(`Content-Length: ${payload.length}\r\n\r\n`);
  output.write(payload);
}
