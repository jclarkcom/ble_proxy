#!/usr/bin/env node

const { spawn } = require('child_process');
const chalk = require('chalk');
const path = require('path');

console.log(chalk.blue('🚀 BLE Proxy System Demo'));
console.log(chalk.gray('This will start both the mock iOS service and Windows proxy in mock mode'));
console.log();

let mockService, windowsProxy;

// Start mock iOS service
console.log(chalk.yellow('📱 Starting Mock iOS Service...'));
mockService = spawn('npm', ['start'], {
  cwd: path.join(__dirname, 'mock-ios-service'),
  stdio: 'pipe',
  shell: true
});

mockService.stdout.on('data', (data) => {
  const lines = data.toString().split('\n');
  lines.forEach(line => {
    if (line.trim()) {
      console.log(chalk.gray('[Mock iOS]'), line);
    }
  });
});

mockService.stderr.on('data', (data) => {
  console.error(chalk.red('[Mock iOS Error]'), data.toString());
});

// Wait a bit, then start Windows proxy in mock mode
setTimeout(() => {
  console.log();
  console.log(chalk.yellow('💻 Starting Windows Proxy in Mock Mode...'));
  
  windowsProxy = spawn('npm', ['run', 'mock'], {
    cwd: path.join(__dirname, 'windows-proxy'),
    stdio: 'pipe',
    shell: true,
    env: { ...process.env, MOCK_MODE: 'true' }
  });

  windowsProxy.stdout.on('data', (data) => {
    const lines = data.toString().split('\n');
    lines.forEach(line => {
      if (line.trim()) {
        console.log(chalk.gray('[Windows Proxy]'), line);
      }
    });
  });

  windowsProxy.stderr.on('data', (data) => {
    console.error(chalk.red('[Proxy Error]'), data.toString());
  });

  // After both are started, show instructions
  setTimeout(() => {
    console.log();
    console.log(chalk.green('🎉 Both services are starting up!'));
    console.log();
    console.log(chalk.yellow('📋 Next steps:'));
    console.log(chalk.yellow('1. Wait for both services to show "ready" status'));
    console.log(chalk.yellow('2. Configure your browser proxy settings:'));
    console.log(chalk.yellow('   HTTP Proxy: 127.0.0.1:8080'));
    console.log(chalk.yellow('   HTTPS Proxy: 127.0.0.1:8080'));
    console.log(chalk.yellow('3. Test with: curl -x http://127.0.0.1:8080 https://httpbin.org/ip'));
    console.log(chalk.yellow('4. Or browse to any website in your configured browser'));
    console.log();
    console.log(chalk.blue('💡 Tip: Watch the console logs to see requests being processed'));
    console.log(chalk.gray('Press Ctrl+C to stop both services'));
  }, 5000);

}, 3000);

// Handle cleanup
process.on('SIGINT', () => {
  console.log();
  console.log(chalk.blue('🛑 Stopping services...'));
  
  if (mockService) {
    mockService.kill('SIGTERM');
  }
  
  if (windowsProxy) {
    windowsProxy.kill('SIGTERM');
  }
  
  setTimeout(() => {
    console.log(chalk.green('✅ Demo stopped'));
    process.exit(0);
  }, 2000);
});

// Handle process exits
if (mockService) {
  mockService.on('exit', (code) => {
    console.log(chalk.yellow(`Mock iOS service exited with code ${code}`));
  });
}

if (windowsProxy) {
  windowsProxy.on('exit', (code) => {
    console.log(chalk.yellow(`Windows proxy exited with code ${code}`));
  });
} 