#!/usr/bin/env node

const { killProcessOnPort } = require('./kill-port');
const BLEProxy = require('./proxy');
const chalk = require('chalk');

async function startWithCleanup() {
  console.log(chalk.bold.blue('🚀 BLE Proxy Launcher\n'));
  
  try {
    // Create and start proxy with port cleanup
    const proxy = new BLEProxy();
    await proxy.start({ killPorts: true });
    
    // Handle graceful shutdown
    const cleanup = async () => {
      console.log(chalk.yellow('\n🛑 Shutting down gracefully...'));
      try {
        await proxy.stop();
        console.log(chalk.green('✓ Proxy stopped'));
      } catch (error) {
        console.error(chalk.red('Error during shutdown:'), error.message);
      }
      process.exit(0);
    };
    
    process.on('SIGINT', cleanup);  // Ctrl+C
    process.on('SIGTERM', cleanup); // Termination signal
    
  } catch (error) {
    console.error(chalk.red('❌ Failed to start proxy:'), error.message);
    process.exit(1);
  }
}

// Run if this script is executed directly
if (require.main === module) {
  startWithCleanup();
} 