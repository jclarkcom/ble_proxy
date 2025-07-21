#!/usr/bin/env node

const { spawn } = require('child_process');
const http = require('http');
const https = require('https');
const chalk = require('chalk');
const path = require('path');

class BLEProxyTester {
  constructor() {
    this.mockService = null;
    this.windowsProxy = null;
    this.testResults = {
      passed: 0,
      failed: 0,
      tests: []
    };
    this.proxyReady = false;
    this.mockReady = false;
    this.startTime = Date.now();
  }

  async runTests() {
    console.log(chalk.blue('🧪 BLE Proxy System Integration Test'));
    console.log(chalk.gray('Testing traffic flow between Windows Proxy and Mock iOS Service'));
    console.log();

    try {
      await this.startServices();
      await this.waitForServices();
      await this.runTestSuite();
      await this.stopServices();
      this.printResults();
    } catch (error) {
      console.error(chalk.red('❌ Test suite failed:'), error.message);
      await this.cleanup();
      process.exit(1);
    }
  }

  async startServices() {
    console.log(chalk.yellow('📱 Starting Mock iOS Service...'));
    
    this.mockService = spawn('npm', ['start'], {
      cwd: path.join(__dirname, 'mock-ios-service'),
      stdio: 'pipe',
      shell: true
    });

    this.mockService.stdout.on('data', (data) => {
      const output = data.toString();
      if (output.includes('Ready to accept connections')) {
        this.mockReady = true;
      }
      // Only show important messages during test
      if (output.includes('Mock iOS service listening') || output.includes('Ready to accept connections')) {
        console.log(chalk.gray('[Mock iOS]'), output.trim());
      }
    });

    this.mockService.stderr.on('data', (data) => {
      console.error(chalk.red('[Mock iOS Error]'), data.toString().trim());
    });

    // Wait a bit for mock service to start
    await this.sleep(3000);

    console.log(chalk.yellow('💻 Starting Windows Proxy in Mock Mode...'));
    
    this.windowsProxy = spawn('npm', ['run', 'mock'], {
      cwd: path.join(__dirname, 'windows-proxy'),
      stdio: 'pipe',
      shell: true,
      env: { ...process.env, MOCK_MODE: 'true' }
    });

    this.windowsProxy.stdout.on('data', (data) => {
      const output = data.toString();
      if (output.includes('Proxy server listening')) {
        this.proxyReady = true;
      }
      // Only show important messages during test
      if (output.includes('Proxy server listening') || output.includes('Connected to mock iOS')) {
        console.log(chalk.gray('[Windows Proxy]'), output.trim());
      }
    });

    this.windowsProxy.stderr.on('data', (data) => {
      console.error(chalk.red('[Proxy Error]'), data.toString().trim());
    });
  }

  async waitForServices() {
    console.log(chalk.blue('⏳ Waiting for services to be ready...'));
    
    let attempts = 0;
    const maxAttempts = 30; // 30 seconds max
    
    while ((!this.proxyReady || !this.mockReady) && attempts < maxAttempts) {
      await this.sleep(1000);
      attempts++;
    }
    
    if (!this.proxyReady || !this.mockReady) {
      throw new Error('Services failed to start within timeout period');
    }
    
    console.log(chalk.green('✅ Both services are ready'));
    await this.sleep(2000); // Extra time for connections to establish
  }

  async runTestSuite() {
    console.log();
    console.log(chalk.blue('🔬 Running Test Suite...'));
    console.log();

    // Test 1: Basic HTTP GET
    await this.test('Basic HTTP GET', async () => {
      const result = await this.makeRequest('http://httpbin.org/get');
      this.assert(result.statusCode === 200, 'Status code should be 200');
      this.assert(result.body.includes('"url": "http://httpbin.org/get"'), 'Response should contain request URL');
      return result;
    });

    // Test 2: HTTPS GET
    await this.test('HTTPS GET', async () => {
      const result = await this.makeRequest('https://httpbin.org/get');
      this.assert(result.statusCode === 200, 'Status code should be 200');
      this.assert(result.body.includes('"url": "https://httpbin.org/get"'), 'Response should contain HTTPS URL');
      return result;
    });

    // Test 3: HTTP POST with data
    await this.test('HTTP POST with JSON', async () => {
      const postData = JSON.stringify({ test: 'data', timestamp: Date.now() });
      const result = await this.makeRequest('https://httpbin.org/post', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(postData)
        }
      }, postData);
      
      this.assert(result.statusCode === 200, 'Status code should be 200');
      this.assert(result.body.includes('"test": "data"'), 'Response should echo POST data');
      return result;
    });

    // Test 4: Large response (test chunking)
    await this.test('Large Response (1KB)', async () => {
      const result = await this.makeRequest('https://httpbin.org/bytes/1024');
      this.assert(result.statusCode === 200, 'Status code should be 200');
      this.assert(result.body.length >= 1024, 'Response should be at least 1KB');
      return result;
    });

    // Test 5: HTTP headers test
    await this.test('Custom Headers', async () => {
      const result = await this.makeRequest('https://httpbin.org/headers', {
        headers: {
          'X-Test-Header': 'BLE-Proxy-Test',
          'User-Agent': 'BLE-Proxy-Tester/1.0'
        }
      });
      
      this.assert(result.statusCode === 200, 'Status code should be 200');
      this.assert(result.body.includes('X-Test-Header'), 'Custom header should be present');
      this.assert(result.body.includes('BLE-Proxy-Test'), 'Header value should be preserved');
      return result;
    });

    // Test 6: Redirect handling
    await this.test('HTTP Redirect', async () => {
      const result = await this.makeRequest('https://httpbin.org/redirect/2');
      this.assert(result.statusCode === 200, 'Final status should be 200 after redirects');
      this.assert(result.body.includes('"url": "https://httpbin.org/get"'), 'Should end up at final URL');
      return result;
    });

    // Test 7: Error handling
    await this.test('HTTP 404 Error', async () => {
      const result = await this.makeRequest('https://httpbin.org/status/404');
      this.assert(result.statusCode === 404, 'Status code should be 404');
      return result;
    });

    // Test 8: Compression test (if response indicates compression was used)
    await this.test('Response Compression', async () => {
      const result = await this.makeRequest('https://httpbin.org/gzip');
      this.assert(result.statusCode === 200, 'Status code should be 200');
      this.assert(result.body.includes('"gzipped": true'), 'Response should indicate gzip was handled');
      return result;
    });

    // Test 9: Multiple concurrent requests
    await this.test('Concurrent Requests', async () => {
      const promises = [];
      for (let i = 0; i < 3; i++) {
        promises.push(this.makeRequest(`https://httpbin.org/delay/1?id=${i}`));
      }
      
      const startTime = Date.now();
      const results = await Promise.all(promises);
      const totalTime = Date.now() - startTime;
      
      this.assert(results.every(r => r.statusCode === 200), 'All requests should succeed');
      this.assert(totalTime < 3000, 'Concurrent requests should complete faster than sequential');
      
      return { results, totalTime };
    });

    // Test 10: Performance baseline
    await this.test('Performance Baseline', async () => {
      const startTime = Date.now();
      const result = await this.makeRequest('https://httpbin.org/get');
      const responseTime = Date.now() - startTime;
      
      this.assert(result.statusCode === 200, 'Status code should be 200');
      this.assert(responseTime < 10000, 'Response should complete within 10 seconds');
      
      return { result, responseTime };
    });
  }

  async test(name, testFunc) {
    process.stdout.write(chalk.yellow(`• ${name}... `));
    
    try {
      const startTime = Date.now();
      const result = await testFunc();
      const duration = Date.now() - startTime;
      
      console.log(chalk.green(`✅ PASS`) + chalk.gray(` (${duration}ms)`));
      
      this.testResults.passed++;
      this.testResults.tests.push({
        name,
        status: 'PASS',
        duration,
        result
      });
    } catch (error) {
      console.log(chalk.red(`❌ FAIL`));
      console.log(chalk.red(`   Error: ${error.message}`));
      
      this.testResults.failed++;
      this.testResults.tests.push({
        name,
        status: 'FAIL',
        error: error.message
      });
    }
  }

  assert(condition, message) {
    if (!condition) {
      throw new Error(message);
    }
  }

  makeRequest(url, options = {}, body = null) {
    return new Promise((resolve, reject) => {
      const proxyUrl = 'http://127.0.0.1:8080';
      const targetUrl = new URL(url);
      const isHttps = targetUrl.protocol === 'https:';
      
      const requestOptions = {
        hostname: '127.0.0.1',
        port: 8080,
        path: url,
        method: options.method || 'GET',
        headers: {
          'Host': targetUrl.hostname,
          ...options.headers
        }
      };

      const req = http.request(requestOptions, (res) => {
        const chunks = [];
        
        res.on('data', chunk => {
          chunks.push(chunk);
        });
        
        res.on('end', () => {
          const responseBody = Buffer.concat(chunks).toString();
          resolve({
            statusCode: res.statusCode,
            statusMessage: res.statusMessage,
            headers: res.headers,
            body: responseBody
          });
        });
      });

      req.on('error', (error) => {
        reject(new Error(`Request failed: ${error.message}`));
      });

      req.setTimeout(15000, () => {
        req.destroy();
        reject(new Error('Request timeout'));
      });

      if (body) {
        req.write(body);
      }
      
      req.end();
    });
  }

  async stopServices() {
    console.log();
    console.log(chalk.blue('🛑 Stopping services...'));
    
    if (this.windowsProxy) {
      this.windowsProxy.kill('SIGTERM');
    }
    
    if (this.mockService) {
      this.mockService.kill('SIGTERM');
    }
    
    await this.sleep(2000);
  }

  async cleanup() {
    await this.stopServices();
  }

  printResults() {
    const totalTime = Date.now() - this.startTime;
    
    console.log();
    console.log(chalk.blue('📊 Test Results Summary'));
    console.log(chalk.green(`✅ Passed: ${this.testResults.passed}`));
    console.log(chalk.red(`❌ Failed: ${this.testResults.failed}`));
    console.log(chalk.gray(`⏱️  Total Time: ${totalTime}ms`));
    
    if (this.testResults.failed === 0) {
      console.log();
      console.log(chalk.green('🎉 All tests passed! The BLE Proxy system is working correctly.'));
      console.log();
      console.log(chalk.yellow('System is ready for:'));
      console.log(chalk.yellow('• Browser configuration (proxy: 127.0.0.1:8080)'));
      console.log(chalk.yellow('• Real-world usage testing'));
      console.log(chalk.yellow('• iOS app development'));
    } else {
      console.log();
      console.log(chalk.red('💥 Some tests failed. Please check the issues above.'));
    }
    
    // Show performance metrics
    const performanceTests = this.testResults.tests.filter(t => t.duration);
    if (performanceTests.length > 0) {
      const avgTime = performanceTests.reduce((sum, t) => sum + t.duration, 0) / performanceTests.length;
      console.log();
      console.log(chalk.blue('⚡ Performance Metrics:'));
      console.log(chalk.gray(`Average Response Time: ${Math.round(avgTime)}ms`));
      console.log(chalk.gray(`Fastest: ${Math.min(...performanceTests.map(t => t.duration))}ms`));
      console.log(chalk.gray(`Slowest: ${Math.max(...performanceTests.map(t => t.duration))}ms`));
    }
  }

  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

// Handle graceful shutdown
process.on('SIGINT', async () => {
  console.log(chalk.yellow('\n⚠️  Test interrupted by user'));
  process.exit(1);
});

// Run the tests
const tester = new BLEProxyTester();
tester.runTests(); 