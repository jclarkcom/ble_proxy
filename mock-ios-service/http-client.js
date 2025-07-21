const http = require('http');
const https = require('https');
const url = require('url');
const chalk = require('chalk');

class HttpClient {
  constructor(config = {}) {
    this.config = {
      timeout: config.timeout || 30000,
      maxRedirects: config.maxRedirects || 5,
      userAgent: config.userAgent || 'MockiOS/1.0 (BLE Proxy Simulator)',
      ...config
    };
    
    this.stats = {
      requests: 0,
      responses: 0,
      errors: 0,
      redirects: 0
    };
  }

  async makeRequest(proxyRequest) {
    this.stats.requests++;
    
    try {
      const parsedUrl = url.parse(proxyRequest.url);
      const isHttps = parsedUrl.protocol === 'https:';
      const client = isHttps ? https : http;
      
      // Prepare request options
      const options = {
        hostname: parsedUrl.hostname,
        port: parsedUrl.port || (isHttps ? 443 : 80),
        path: parsedUrl.path,
        method: proxyRequest.method,
        headers: {
          ...proxyRequest.headers,
          'user-agent': this.config.userAgent
        },
        timeout: this.config.timeout
      };
      
      // Remove proxy-specific headers that shouldn't be sent to the target server
      delete options.headers['proxy-connection'];
      delete options.headers['proxy-authorization'];
      
      console.log(chalk.blue(`🌐 Making ${options.method} request to ${parsedUrl.hostname}${parsedUrl.path}`));
      
      const response = await this.executeRequest(client, options, proxyRequest.body);
      
      this.stats.responses++;
      
      return {
        statusCode: response.statusCode,
        statusMessage: response.statusMessage,
        headers: response.headers,
        body: response.body
      };
      
    } catch (error) {
      this.stats.errors++;
      console.error(chalk.red(`HTTP request failed: ${error.message}`));
      
      return {
        statusCode: 500,
        statusMessage: 'Internal Server Error',
        headers: {
          'content-type': 'text/plain',
          'x-proxy-error': 'Mock iOS HTTP client error'
        },
        body: Buffer.from(`HTTP request failed: ${error.message}`).toString('base64')
      };
    }
  }

  executeRequest(client, options, bodyData = null, redirectCount = 0) {
    return new Promise((resolve, reject) => {
      const req = client.request(options, (res) => {
        // Handle redirects
        if (this.isRedirect(res.statusCode) && redirectCount < this.config.maxRedirects) {
          const location = res.headers.location;
          if (location) {
            console.log(chalk.yellow(`↪ Redirecting to: ${location}`));
            this.stats.redirects++;
            
            // Parse new URL and make new request
            const redirectUrl = url.resolve(url.format(options), location);
            const newOptions = {
              ...options,
              ...url.parse(redirectUrl)
            };
            
            // For redirects, usually we don't send body data
            const shouldSendBody = (options.method === 'POST' || options.method === 'PUT') && 
                                 (res.statusCode === 307 || res.statusCode === 308);
            
            return this.executeRequest(client, newOptions, shouldSendBody ? bodyData : null, redirectCount + 1)
              .then(resolve)
              .catch(reject);
          }
        }
        
        // Collect response data
        const chunks = [];
        
        res.on('data', chunk => {
          chunks.push(chunk);
        });
        
        res.on('end', () => {
          const body = Buffer.concat(chunks);
          
          resolve({
            statusCode: res.statusCode,
            statusMessage: res.statusMessage,
            headers: res.headers,
            body: body.toString('base64') // Convert to base64 for JSON serialization
          });
        });
        
        res.on('error', (error) => {
          reject(new Error(`Response error: ${error.message}`));
        });
      });
      
      // Handle request errors
      req.on('error', (error) => {
        reject(new Error(`Request error: ${error.message}`));
      });
      
      req.on('timeout', () => {
        req.destroy();
        reject(new Error('Request timeout'));
      });
      
      // Send body data if present
      if (bodyData) {
        try {
          const bodyBuffer = Buffer.from(bodyData, 'base64');
          req.write(bodyBuffer);
        } catch (error) {
          req.destroy();
          reject(new Error(`Invalid body data: ${error.message}`));
          return;
        }
      }
      
      req.end();
    });
  }

  isRedirect(statusCode) {
    return [301, 302, 303, 307, 308].includes(statusCode);
  }

  getStats() {
    return { ...this.stats };
  }

  resetStats() {
    this.stats = {
      requests: 0,
      responses: 0,
      errors: 0,
      redirects: 0
    };
  }
}

module.exports = HttpClient; 