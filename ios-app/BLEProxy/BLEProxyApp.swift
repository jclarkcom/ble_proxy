import SwiftUI

@main
struct BLEProxyApp: App {
    @StateObject private var proxyViewModel = ProxyViewModel()
    
    var body: some Scene {
        WindowGroup {
            ContentView()
                .environmentObject(proxyViewModel)
                .onAppear {
                    // Initialize the proxy when app launches
                    proxyViewModel.initialize()
                }
        }
    }
} 