#!/usr/bin/env node

const chalk = require('chalk');
const BLEProxy = require('./proxy');

// Custom configuration for demo
const demoConfig = {
  proxy: {
    port: 8080,
    host: '127.0.0.1'
  },
  debug: {
    enabled: true,
    logHTTPRequests: true
  },
  logging: {
    level: 'debug'
  }
};

console.log(chalk.blue('🚀 Starting BLE Proxy Demo'));
console.log(chalk.gray('This demo will start the proxy with debug logging enabled'));
console.log();

const proxy = new BLEProxy(demoConfig);

// Add extra logging for demo
const originalLog = console.log;
console.log = (...args) => {
  const timestamp = new Date().toISOString().slice(11, 23);
  originalLog(chalk.gray(`[${timestamp}]`), ...args);
};

proxy.start().then(() => {
  console.log(chalk.green('✓ Demo proxy started successfully'));
  console.log();
  console.log(chalk.yellow('Next steps:'));
  console.log(chalk.yellow('1. Start the iOS BLE Proxy app'));
  console.log(chalk.yellow('2. Configure your browser proxy settings:'));
  console.log(chalk.yellow(`   HTTP Proxy: ${demoConfig.proxy.host}:${demoConfig.proxy.port}`));
  console.log(chalk.yellow('3. Browse the web - traffic will route through iOS device'));
  console.log();
  console.log(chalk.gray('Press Ctrl+C to stop the proxy'));
}).catch(error => {
  console.error(chalk.red('❌ Failed to start demo:'), error.message);
  process.exit(1);
}); 