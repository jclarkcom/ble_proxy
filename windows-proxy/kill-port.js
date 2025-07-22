const { exec } = require('child_process');
const chalk = require('chalk');

/**
 * Find and kill processes using a specific port on Windows
 * @param {number} port - The port number to check
 * @param {boolean} autoKill - Whether to automatically kill found processes
 * @returns {Promise<boolean>} - True if processes were found and killed
 */
async function killProcessOnPort(port, autoKill = false) {
  return new Promise((resolve) => {
    console.log(chalk.blue(`🔍 Checking for processes using port ${port}...`));
    
    // Use netstat to find processes using the port
    const cmd = `netstat -ano | findstr :${port}`;
    
    exec(cmd, (error, stdout, stderr) => {
      if (error || !stdout.trim()) {
        console.log(chalk.green(`✅ Port ${port} is available`));
        resolve(false);
        return;
      }
      
      // Parse PIDs from netstat output
      const lines = stdout.trim().split('\n');
      const pids = new Set();
      
      lines.forEach(line => {
        const parts = line.trim().split(/\s+/);
        if (parts.length >= 5) {
          const localAddress = parts[1];
          const pid = parts[4];
          
          // Check if this line is for our port
          if (localAddress.includes(`:${port}`)) {
            pids.add(pid);
          }
        }
      });
      
      if (pids.size === 0) {
        console.log(chalk.green(`✅ Port ${port} is available`));
        resolve(false);
        return;
      }
      
      console.log(chalk.yellow(`⚠️  Found ${pids.size} process(es) using port ${port}:`));
      
      // Get process names for each PID
      const pidArray = Array.from(pids);
      let processInfoPromises = pidArray.map(pid => {
        return new Promise((pidResolve) => {
          exec(`tasklist /FI "PID eq ${pid}" /FO CSV /NH`, (err, out) => {
            if (!err && out.trim()) {
              const csvLine = out.trim().split('\n')[0];
              const processName = csvLine.split(',')[0].replace(/"/g, '');
              console.log(chalk.cyan(`  PID ${pid}: ${processName}`));
            } else {
              console.log(chalk.cyan(`  PID ${pid}: Unknown process`));
            }
            pidResolve();
          });
        });
      });
      
      Promise.all(processInfoPromises).then(() => {
        if (autoKill) {
          killPids(pidArray, resolve);
        } else {
          console.log(chalk.yellow('\n🤔 Would you like to kill these processes? (y/N)'));
          
          process.stdin.resume();
          process.stdin.setEncoding('utf8');
          
          const stdin = process.openStdin();
          stdin.addListener('data', function(d) {
            const input = d.toString().trim().toLowerCase();
            
            if (input === 'y' || input === 'yes') {
              killPids(pidArray, resolve);
            } else {
              console.log(chalk.red('❌ Processes not killed. Please manually stop the server or use a different port.'));
              resolve(false);
            }
            
            stdin.pause();
          });
        }
      });
    });
  });
}

function killPids(pids, resolve) {
  console.log(chalk.blue('🔪 Attempting to kill processes...'));
  
  let killPromises = pids.map(pid => {
    return new Promise((killResolve) => {
      exec(`taskkill /F /PID ${pid}`, (error, stdout, stderr) => {
        if (error) {
          console.log(chalk.red(`❌ Failed to kill PID ${pid}: ${error.message}`));
          killResolve(false);
        } else {
          console.log(chalk.green(`✅ Killed PID ${pid}`));
          killResolve(true);
        }
      });
    });
  });
  
  Promise.all(killPromises).then((results) => {
    const killedCount = results.filter(r => r).length;
    
    if (killedCount > 0) {
      console.log(chalk.green(`🎉 Successfully killed ${killedCount} process(es)`));
      // Wait a moment for processes to fully terminate
      setTimeout(() => resolve(true), 1000);
    } else {
      console.log(chalk.red('❌ Failed to kill processes'));
      resolve(false);
    }
  });
}

// CLI usage
if (require.main === module) {
  const port = process.argv[2] || 8080;
  const autoKill = process.argv.includes('--auto') || process.argv.includes('-y');
  
  console.log(chalk.bold.blue('🔧 Port Killer Utility\n'));
  
  killProcessOnPort(parseInt(port), autoKill).then((killed) => {
    if (killed) {
      console.log(chalk.green(`\n✨ Port ${port} is now available!`));
    }
    process.exit(0);
  });
}

module.exports = { killProcessOnPort }; 