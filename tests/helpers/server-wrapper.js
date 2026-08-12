/**
 * Test wrapper around src/server.js.
 *
 * Spawns the real application with process.env.PORT set to 0 so the OS
 * assigns a free port, then prints the actual listening port so the test
 * harness can connect. No source outside tests/ is modified.
 */

const net = require('net');
const path = require('path');

const originalListen = net.Server.prototype.listen;
net.Server.prototype.listen = function (...args) {
  this.once('listening', () => {
    const address = this.address();
    if (address && typeof address === 'object' && address.port) {
      // This line is parsed by tests/helpers/server.js.
      console.log(`SCAMBLER_TEST_PORT=${address.port}`);
    }
  });
  return originalListen.apply(this, args);
};

require(path.join(__dirname, '..', '..', 'src', 'server.js'));
