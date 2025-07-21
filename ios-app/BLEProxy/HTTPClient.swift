import Foundation
import os.log

class HTTPClient: ObservableObject {
    @Published var requestCount = 0
    @Published var successCount = 0
    @Published var errorCount = 0
    
    private let logger = Logger(subsystem: "com.bleproxy.app", category: "HTTPClient")
    private let session: URLSession
    
    init() {
        let config = URLSessionConfiguration.default
        config.timeoutIntervalForRequest = 30.0
        config.timeoutIntervalForResource = 60.0
        config.httpMaximumConnectionsPerHost = 6
        config.requestCachePolicy = .useProtocolCachePolicy
        
        self.session = URLSession(configuration: config)
        logger.info("HTTP Client initialized")
    }
    
    func makeRequest(_ proxyRequest: ProxyRequest) async -> ProxyResponse {
        DispatchQueue.main.async {
            self.requestCount += 1
        }
        
        logger.info("Making HTTP request: \(proxyRequest.method) \(proxyRequest.url)")
        
        do {
            if proxyRequest.isConnect {
                return await handleConnectRequest(proxyRequest)
            } else {
                return await handleRegularRequest(proxyRequest)
            }
        } catch {
            logger.error("HTTP request failed: \(error.localizedDescription)")
            DispatchQueue.main.async {
                self.errorCount += 1
            }
            
            return ProxyResponse(
                id: proxyRequest.id,
                statusCode: 500,
                statusMessage: "Internal Server Error",
                headers: ["content-type": "text/plain"],
                body: Data("HTTP request failed: \(error.localizedDescription)".utf8),
                isConnect: proxyRequest.isConnect,
                success: false
            )
        }
    }
    
    private func handleRegularRequest(_ proxyRequest: ProxyRequest) async -> ProxyResponse {
        guard let url = URL(string: proxyRequest.url) else {
            return errorResponse(for: proxyRequest, message: "Invalid URL")
        }
        
        var request = URLRequest(url: url)
        request.httpMethod = proxyRequest.method
        
        // Set headers
        for (key, value) in proxyRequest.headers {
            // Skip proxy-specific headers
            let lowercaseKey = key.lowercased()
            if !lowercaseKey.contains("proxy") && lowercaseKey != "connection" {
                request.setValue(value, forHTTPHeaderField: key)
            }
        }
        
        // Add user agent if not present
        if request.value(forHTTPHeaderField: "User-Agent") == nil {
            request.setValue("BLEProxy-iOS/1.0", forHTTPHeaderField: "User-Agent")
        }
        
        // Set body data
        if !proxyRequest.body.isEmpty {
            request.httpBody = Data(base64Encoded: proxyRequest.body)
        }
        
        do {
            let (data, response) = try await session.data(for: request)
            
            guard let httpResponse = response as? HTTPURLResponse else {
                return errorResponse(for: proxyRequest, message: "Invalid response type")
            }
            
            logger.info("HTTP response: \(httpResponse.statusCode)")
            
            DispatchQueue.main.async {
                self.successCount += 1
            }
            
            // Convert headers
            var responseHeaders: [String: String] = [:]
            for (key, value) in httpResponse.allHeaderFields {
                if let keyString = key as? String, let valueString = value as? String {
                    responseHeaders[keyString] = valueString
                }
            }
            
            return ProxyResponse(
                id: proxyRequest.id,
                statusCode: httpResponse.statusCode,
                statusMessage: HTTPURLResponse.localizedString(forStatusCode: httpResponse.statusCode),
                headers: responseHeaders,
                body: data,
                isConnect: false,
                success: true
            )
            
        } catch {
            logger.error("URLSession error: \(error.localizedDescription)")
            DispatchQueue.main.async {
                self.errorCount += 1
            }
            
            if let urlError = error as? URLError {
                return handleURLError(urlError, for: proxyRequest)
            }
            
            return errorResponse(for: proxyRequest, message: error.localizedDescription)
        }
    }
    
    private func handleConnectRequest(_ proxyRequest: ProxyRequest) async -> ProxyResponse {
        logger.info("HTTPS CONNECT request to \(proxyRequest.url)")
        
        // For CONNECT requests, we'll return success to indicate tunnel establishment
        // In a full implementation, this would establish a tunnel connection
        
        return ProxyResponse(
            id: proxyRequest.id,
            statusCode: 200,
            statusMessage: "Connection Established",
            headers: [:],
            body: Data(),
            isConnect: true,
            success: true
        )
    }
    
    private func handleURLError(_ error: URLError, for request: ProxyRequest) -> ProxyResponse {
        let statusCode: Int
        let message: String
        
        switch error.code {
        case .notConnectedToInternet:
            statusCode = 503
            message = "Service Unavailable - No Internet Connection"
        case .timedOut:
            statusCode = 408
            message = "Request Timeout"
        case .cannotFindHost:
            statusCode = 404
            message = "Host Not Found"
        case .cannotConnectToHost:
            statusCode = 503
            message = "Cannot Connect to Host"
        case .badURL:
            statusCode = 400
            message = "Bad Request - Invalid URL"
        default:
            statusCode = 502
            message = "Bad Gateway - \(error.localizedDescription)"
        }
        
        return ProxyResponse(
            id: request.id,
            statusCode: statusCode,
            statusMessage: message,
            headers: ["content-type": "text/plain"],
            body: Data(message.utf8),
            isConnect: request.isConnect,
            success: false
        )
    }
    
    private func errorResponse(for request: ProxyRequest, message: String) -> ProxyResponse {
        return ProxyResponse(
            id: request.id,
            statusCode: 500,
            statusMessage: "Internal Server Error",
            headers: ["content-type": "text/plain"],
            body: Data(message.utf8),
            isConnect: request.isConnect,
            success: false
        )
    }
}

// MARK: - Data Models
struct ProxyRequest: Codable {
    let id: String
    let method: String
    let url: String
    let headers: [String: String]
    let body: String // Base64 encoded
    let isConnect: Bool
    
    init(id: String, method: String, url: String, headers: [String: String], body: String, isConnect: Bool = false) {
        self.id = id
        self.method = method
        self.url = url
        self.headers = headers
        self.body = body
        self.isConnect = isConnect
    }
}

struct ProxyResponse: Codable {
    let id: String
    let statusCode: Int
    let statusMessage: String
    let headers: [String: String]
    let body: Data
    let isConnect: Bool
    let success: Bool
    
    // Custom encoding to handle Data as base64
    private enum CodingKeys: String, CodingKey {
        case id, statusCode, statusMessage, headers, body, isConnect, success
    }
    
    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(id, forKey: .id)
        try container.encode(statusCode, forKey: .statusCode)
        try container.encode(statusMessage, forKey: .statusMessage)
        try container.encode(headers, forKey: .headers)
        try container.encode(body.base64EncodedString(), forKey: .body)
        try container.encode(isConnect, forKey: .isConnect)
        try container.encode(success, forKey: .success)
    }
    
    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = try container.decode(String.self, forKey: .id)
        statusCode = try container.decode(Int.self, forKey: .statusCode)
        statusMessage = try container.decode(String.self, forKey: .statusMessage)
        headers = try container.decode([String: String].self, forKey: .headers)
        let bodyString = try container.decode(String.self, forKey: .body)
        body = Data(base64Encoded: bodyString) ?? Data()
        isConnect = try container.decode(Bool.self, forKey: .isConnect)
        success = try container.decode(Bool.self, forKey: .success)
    }
    
    init(id: String, statusCode: Int, statusMessage: String, headers: [String: String], body: Data, isConnect: Bool, success: Bool) {
        self.id = id
        self.statusCode = statusCode
        self.statusMessage = statusMessage
        self.headers = headers
        self.body = body
        self.isConnect = isConnect
        self.success = success
    }
} 