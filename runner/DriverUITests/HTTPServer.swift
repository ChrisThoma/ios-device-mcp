import Foundation
import Network

struct HTTPRequest {
    let method: String
    let path: String
    let query: [String: String]
    let body: Data

    var json: [String: Any] {
        (try? JSONSerialization.jsonObject(with: body)) as? [String: Any] ?? [:]
    }

    /// Returns nil until the buffer holds a complete request.
    static func parse(_ data: Data) -> HTTPRequest? {
        guard let headerEnd = data.range(of: Data("\r\n\r\n".utf8)) else { return nil }
        guard let head = String(data: data[..<headerEnd.lowerBound], encoding: .utf8) else { return nil }
        let lines = head.components(separatedBy: "\r\n")
        let parts = lines[0].split(separator: " ")
        guard parts.count >= 2 else { return nil }

        var contentLength = 0
        for line in lines.dropFirst() {
            let kv = line.split(separator: ":", maxSplits: 1)
            if kv.count == 2, kv[0].lowercased() == "content-length" {
                contentLength = Int(kv[1].trimmingCharacters(in: .whitespaces)) ?? 0
            }
        }
        let bodyStart = headerEnd.upperBound
        guard data.count - bodyStart >= contentLength else { return nil }

        let components = URLComponents(string: String(parts[1]))
        var query: [String: String] = [:]
        for item in components?.queryItems ?? [] { query[item.name] = item.value ?? "" }
        return HTTPRequest(
            method: String(parts[0]),
            path: components?.path ?? String(parts[1]),
            query: query,
            body: data.subdata(in: bodyStart..<(bodyStart + contentLength))
        )
    }
}

struct HTTPResponse {
    var status: Int
    var body: Data

    static func json(_ object: Any, status: Int = 200) -> HTTPResponse {
        let data = (try? JSONSerialization.data(withJSONObject: object)) ?? Data("{}".utf8)
        return HTTPResponse(status: status, body: data)
    }

    static func error(_ message: String, status: Int = 500) -> HTTPResponse {
        json(["error": message], status: status)
    }

    func serialize() -> Data {
        var out = Data("HTTP/1.1 \(status) \(status < 400 ? "OK" : "Error")\r\n".utf8)
        out.append(Data("Content-Type: application/json\r\nContent-Length: \(body.count)\r\nConnection: close\r\n\r\n".utf8))
        out.append(body)
        return out
    }
}

/// Minimal one-request-per-connection HTTP server. Handlers run on the main
/// thread because XCUITest APIs must be called there.
final class HTTPServer {
    private let listener: NWListener
    private let queue = DispatchQueue(label: "ios-device-mcp.http")
    private let handlerQueue = DispatchQueue(label: "ios-device-mcp.handler")
    private let handler: (HTTPRequest) -> HTTPResponse

    init(port: UInt16, handler: @escaping (HTTPRequest) -> HTTPResponse) throws {
        let params = NWParameters.tcp
        params.allowLocalEndpointReuse = true
        listener = try NWListener(using: params, on: NWEndpoint.Port(rawValue: port)!)
        self.handler = handler
    }

    func start() {
        listener.newConnectionHandler = { [weak self] connection in
            guard let self else { return }
            connection.start(queue: self.queue)
            self.receive(connection, buffer: Data())
        }
        listener.start(queue: queue)
    }

    private func receive(_ connection: NWConnection, buffer: Data) {
        connection.receive(minimumIncompleteLength: 1, maximumLength: 1 << 20) { [weak self] data, _, isComplete, error in
            guard let self else { return }
            var buffer = buffer
            if let data { buffer.append(data) }
            if let request = HTTPRequest.parse(buffer) {
                // XCUITest actions spin nested run loops while they wait, so feed
                // the main thread one request at a time to avoid re-entrancy.
                self.handlerQueue.async {
                    let response = DispatchQueue.main.sync { self.handler(request) }
                    connection.send(content: response.serialize(), completion: .contentProcessed { _ in connection.cancel() })
                }
            } else if isComplete || error != nil {
                connection.cancel()
            } else {
                self.receive(connection, buffer: buffer)
            }
        }
    }
}
