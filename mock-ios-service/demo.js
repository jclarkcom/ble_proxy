#!/usr/bin/env node

const chalk = require('chalk');
const MockIOSService = require('./mock-ios');

// Demo configuration
const demoConfig = {
  port: 9999,
  host: '127.0.0.1',
  timeout: 30000,
  maxConnections: 10
};

console.log(chalk.blue('🚀 Starting Mock iOS Service Demo'));
console.log(chalk.gray('This simulates the iOS BLE peripheral app using TCP sockets'));
console.log();

const mockService = new MockIOSService(demoConfig);

// Enhanced logging for demo
const originalLog = console.log;
console.log = (...args) => {
  const timestamp = new Date().toISOString().slice(11, 23);
  originalLog(chalk.gray(`[${timestamp}]`), ...args);
};

mockService.start().then(() => {
  console.log(chalk.green('✅ Mock iOS service started successfully'));
  console.log();
  console.log(chalk.yellow('Ready to accept connections! Next steps:'));
  console.log(chalk.yellow('1. In another terminal, navigate to windows-proxy/'));
  console.log(chalk.yellow('2. Run: npm run mock'));
  console.log(chalk.yellow('3. Configure your browser proxy settings:'));
  console.log(chalk.yellow('   HTTP Proxy: 127.0.0.1:8080'));
  console.log(chalk.yellow('4. Browse the web - traffic will route through this mock service'));
  console.log();
  console.log(chalk.blue('📊 The service will show request/response stats every minute'));
  console.log(chalk.gray('Press Ctrl+C to stop the service'));
  console.log();
  
  // Show initial stats
  setTimeout(() => {
    mockService.printStats();
  }, 2000);
  
}).catch(error => {
  console.error(chalk.red('❌ Failed to start mock service:'), error.message);
  process.exit(1);
}); 