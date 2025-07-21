#!/usr/bin/env node

const net = require('net');
const zlib = require('zlib');
const chalk = require('chalk');

class MockServiceTester {
  constructor() {
    this.testResults = {
      passed: 0,
      failed: 0,
      tests: []
    };
    this.startTime = Date.now();
    this.socket = null;
  }

  async runTests() {
    console.log(chalk.blue('🧪 Mock iOS Service Direct Test'));
    console.log(chalk.gray('Testing mock service functionality without Windows proxy'));
    console.log();

    try {
      await this.connectToMockService();
      await this.runTestSuite();
      await this.disconnect();
      this.printResults();
    } catch (error) {
      console.error(chalk.red('❌ Test suite failed:'), error.message);
      await this.cleanup();
      process.exit(1);
    }
  }

  async connectToMockService() {
    console.log(chalk.blue('🔌 Connecting to mock iOS service...'));
    
    return new Promise((resolve, reject) => {
      this.socket = new net.Socket();
      
      const timeout = setTimeout(() => {
        reject(new Error('Connection timeout - make sure mock service is running on port 9999'));
      }, 5000);

      this.socket.connect(9999, '127.0.0.1', () => {
        clearTimeout(timeout);
        console.log(chalk.green('✅ Connected to mock service'));
        resolve();
      });

      this.socket.on('error', (error) => {
        clearTimeout(timeout);
        reject(new Error(`Connection error: ${error.message}`));
      });
    });
  }

  async runTestSuite() {
    console.log();
    console.log(chalk.blue('🔬 Running Test Suite...'));
    console.log();

    // Test 1: Basic HTTP GET
    await this.test('Basic HTTP GET', async () => {
      const request = {
        id: 'test-1',
        method: 'GET',
        url: 'https://httpbin.org/get',
        headers: {
          'User-Agent': 'MockServiceTester/1.0'
        },
        body: ''
      };

      const response = await this.sendRequest(request);
      this.assert(response.statusCode === 200, 'Status code should be 200');
      this.assert(response.id === 'test-1', 'Response ID should match request ID');
      this.assert(response.body.includes('https://httpbin.org/get'), 'Response should contain request URL');
      return response;
    });

    // Test 2: HTTP POST
    await this.test('HTTP POST with JSON', async () => {
      const postData = JSON.stringify({ test: 'data', timestamp: Date.now() });
      const request = {
        id: 'test-2',
        method: 'POST',
        url: 'https://httpbin.org/post',
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': 'MockServiceTester/1.0'
        },
        body: Buffer.from(postData).toString('base64')
      };

      const response = await this.sendRequest(request);
      this.assert(response.statusCode === 200, 'Status code should be 200');
      this.assert(response.body.includes('"test": "data"'), 'Response should echo POST data');
      return response;
    });

    // Test 3: Custom headers
    await this.test('Custom Headers', async () => {
      const request = {
        id: 'test-3',
        method: 'GET',
        url: 'https://httpbin.org/headers',
        headers: {
          'X-Test-Header': 'MockServiceTest',
          'User-Agent': 'MockServiceTester/1.0'
        },
        body: ''
      };

      const response = await this.sendRequest(request);
      this.assert(response.statusCode === 200, 'Status code should be 200');
      this.assert(response.body.includes('X-Test-Header'), 'Custom header should be present');
      this.assert(response.body.includes('MockServiceTest'), 'Header value should be preserved');
      return response;
    });

    // Test 4: Error handling
    await this.test('HTTP 404 Error', async () => {
      const request = {
        id: 'test-4',
        method: 'GET',
        url: 'https://httpbin.org/status/404',
        headers: {},
        body: ''
      };

      const response = await this.sendRequest(request);
      this.assert(response.statusCode === 404, 'Status code should be 404');
      return response;
    });

    // Test 5: Large response
    await this.test('Large Response (1KB)', async () => {
      const request = {
        id: 'test-5',
        method: 'GET',
        url: 'https://httpbin.org/bytes/1024',
        headers: {},
        body: ''
      };

      const response = await this.sendRequest(request);
      this.assert(response.statusCode === 200, 'Status code should be 200');
      const responseBody = Buffer.from(response.body, 'base64');
      this.assert(responseBody.length >= 1024, 'Response should be at least 1KB');
      return response;
    });
  }

  async sendRequest(request) {
    return new Promise((resolve, reject) => {
      // Compress the request
      const requestData = JSON.stringify(request);
      
      zlib.gzip(Buffer.from(requestData), (err, compressed) => {
        if (err) {
          reject(new Error(`Compression error: ${err.message}`));
          return;
        }

        // Prepare data with length header
        const totalLength = compressed.length;
        const header = Buffer.alloc(4);
        header.writeUInt32LE(totalLength, 0);
        const fullData = Buffer.concat([header, compressed]);

        // Set up response handling
        let receiving = false;
        let expectedLength = 0;
        let receivedLength = 0;
        let chunks = [];
        
        const onData = (data) => {
          if (!receiving) {
            // First chunk with header
            if (data.length < 4) {
              reject(new Error('Invalid response header'));
              return;
            }
            
            expectedLength = data.readUInt32LE(0);
            receivedLength = 0;
            chunks = [];
            receiving = true;
            
            const remainingData = data.slice(4);
            if (remainingData.length > 0) {
              chunks.push(remainingData);
              receivedLength += remainingData.length;
            }
          } else {
            // Subsequent chunks
            chunks.push(data);
            receivedLength += data.length;
          }
          
          // Check if complete
          if (receivedLength >= expectedLength) {
            const fullResponse = Buffer.concat(chunks).slice(0, expectedLength);
            
            // Decompress response
            zlib.gunzip(fullResponse, (err, decompressed) => {
              if (err) {
                reject(new Error(`Decompression error: ${err.message}`));
                return;
              }
              
              try {
                const response = JSON.parse(decompressed.toString());
                // Convert body from base64 to string for easier testing
                if (response.body) {
                  response.body = Buffer.from(response.body, 'base64').toString();
                }
                this.socket.removeListener('data', onData);
                resolve(response);
              } catch (parseErr) {
                reject(new Error(`JSON parse error: ${parseErr.message}`));
              }
            });
          }
        };

        this.socket.on('data', onData);

        // Set timeout
        const timeout = setTimeout(() => {
          this.socket.removeListener('data', onData);
          reject(new Error('Request timeout'));
        }, 15000);

        // Send the request
        this.socket.write(fullData);
        
        // Clean up timeout when done
        this.socket.once('data', () => {
          clearTimeout(timeout);
        });
      });
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

  async disconnect() {
    if (this.socket) {
      this.socket.end();
    }
  }

  async cleanup() {
    await this.disconnect();
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
      console.log(chalk.green('🎉 All tests passed! Mock iOS service is working correctly.'));
      console.log();
      console.log(chalk.yellow('✅ Mock service validates:'));
      console.log(chalk.yellow('• TCP socket communication'));
      console.log(chalk.yellow('• Gzip compression/decompression'));
      console.log(chalk.yellow('• HTTP request handling'));
      console.log(chalk.yellow('• Response processing'));
      console.log(chalk.yellow('• Error handling'));
      console.log();
      console.log(chalk.blue('Next: Install Windows proxy dependencies and test full system'));
    } else {
      console.log();
      console.log(chalk.red('💥 Some tests failed. Please check the mock service.'));
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
}

// Handle graceful shutdown
process.on('SIGINT', async () => {
  console.log(chalk.yellow('\n⚠️  Test interrupted by user'));
  process.exit(1);
});

// Instructions if mock service not running
console.log(chalk.blue('📋 Prerequisites:'));
console.log(chalk.yellow('1. Make sure mock iOS service is running:'));
console.log(chalk.yellow('   cd mock-ios-service && npm start'));
console.log(chalk.yellow('2. Then run this test in another terminal'));
console.log();

// Run the tests
const tester = new MockServiceTester();
tester.runTests(); 