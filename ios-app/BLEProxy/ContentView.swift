import SwiftUI

struct ContentView: View {
    @EnvironmentObject var viewModel: ProxyViewModel
    @State private var showingStats = false
    @State private var showingHelp = false
    
    var body: some View {
        NavigationView {
            VStack(spacing: 20) {
                // Header
                VStack(spacing: 8) {
                    Image(systemName: "antenna.radiowaves.left.and.right")
                        .font(.system(size: 60))
                        .foregroundColor(viewModel.proxyStatusColor)
                    
                    Text("BLE Proxy")
                        .font(.largeTitle)
                        .fontWeight(.bold)
                    
                    Text("HTTP proxy over Bluetooth LE")
                        .font(.subheadline)
                        .foregroundColor(.secondary)
                }
                .padding(.top)
                
                Spacer()
                
                // Status Card
                StatusCardView(viewModel: viewModel)
                
                Spacer()
                
                // Control Buttons
                VStack(spacing: 16) {
                    // Main Control Button
                    Button(action: {
                        if viewModel.isProxyActive {
                            viewModel.stopProxy()
                        } else {
                            viewModel.startProxy()
                        }
                    }) {
                        HStack {
                            Image(systemName: viewModel.isProxyActive ? "stop.fill" : "play.fill")
                                .font(.title2)
                            
                            Text(viewModel.isProxyActive ? "Stop Proxy" : "Start Proxy")
                                .font(.title2)
                                .fontWeight(.semibold)
                        }
                        .foregroundColor(.white)
                        .frame(maxWidth: .infinity)
                        .frame(height: 56)
                        .background(
                            viewModel.isProxyActive ? 
                            Color.red : Color.blue
                        )
                        .cornerRadius(16)
                    }
                    
                    // Secondary Buttons
                    HStack(spacing: 16) {
                        Button(action: {
                            showingStats = true
                        }) {
                            VStack {
                                Image(systemName: "chart.bar.fill")
                                    .font(.title2)
                                Text("Stats")
                                    .font(.caption)
                            }
                            .foregroundColor(.blue)
                            .frame(maxWidth: .infinity)
                            .frame(height: 64)
                            .background(Color.blue.opacity(0.1))
                            .cornerRadius(12)
                        }
                        
                        Button(action: {
                            viewModel.resetStats()
                        }) {
                            VStack {
                                Image(systemName: "arrow.clockwise")
                                    .font(.title2)
                                Text("Reset")
                                    .font(.caption)
                            }
                            .foregroundColor(.orange)
                            .frame(maxWidth: .infinity)
                            .frame(height: 64)
                            .background(Color.orange.opacity(0.1))
                            .cornerRadius(12)
                        }
                        
                        Button(action: {
                            showingHelp = true
                        }) {
                            VStack {
                                Image(systemName: "questionmark.circle.fill")
                                    .font(.title2)
                                Text("Help")
                                    .font(.caption)
                            }
                            .foregroundColor(.green)
                            .frame(maxWidth: .infinity)
                            .frame(height: 64)
                            .background(Color.green.opacity(0.1))
                            .cornerRadius(12)
                        }
                    }
                }
                .padding(.horizontal)
                
                Spacer()
                
                // Error Display
                if let error = viewModel.lastError {
                    ErrorView(error: error)
                }
            }
            .padding()
            .navigationTitle("")
            .navigationBarHidden(true)
        }
        .sheet(isPresented: $showingStats) {
            StatsView(viewModel: viewModel)
        }
        .sheet(isPresented: $showingHelp) {
            HelpView()
        }
    }
}

// MARK: - Status Card View
struct StatusCardView: View {
    let viewModel: ProxyViewModel
    
    var body: some View {
        VStack(spacing: 16) {
            // Status Indicator
            HStack {
                Circle()
                    .fill(viewModel.proxyStatusColor)
                    .frame(width: 12, height: 12)
                
                Text(viewModel.proxyStatusText)
                    .font(.headline)
                    .fontWeight(.semibold)
                
                Spacer()
                
                if viewModel.isProxyActive {
                    Text(viewModel.formattedUptime)
                        .font(.caption)
                        .foregroundColor(.secondary)
                }
            }
            
            // Connection Status
            HStack {
                Image(systemName: "network")
                    .foregroundColor(.blue)
                
                Text(viewModel.connectionStatus)
                    .font(.subheadline)
                
                Spacer()
            }
            
            // Quick Stats
            if viewModel.isProxyActive {
                HStack(spacing: 24) {
                    StatItem(
                        title: "Requests",
                        value: "\(viewModel.requestCount)",
                        color: .blue
                    )
                    
                    StatItem(
                        title: "Responses",
                        value: "\(viewModel.responseCount)",
                        color: .green
                    )
                    
                    if viewModel.errorCount > 0 {
                        StatItem(
                            title: "Errors",
                            value: "\(viewModel.errorCount)",
                            color: .red
                        )
                    }
                }
            }
        }
        .padding()
        .background(Color(UIColor.systemBackground))
        .cornerRadius(16)
        .shadow(color: .black.opacity(0.1), radius: 10, x: 0, y: 5)
        .overlay(
            RoundedRectangle(cornerRadius: 16)
                .stroke(viewModel.proxyStatusColor.opacity(0.3), lineWidth: 1)
        )
    }
}

// MARK: - Stat Item View
struct StatItem: View {
    let title: String
    let value: String
    let color: Color
    
    var body: some View {
        VStack(spacing: 4) {
            Text(value)
                .font(.title2)
                .fontWeight(.bold)
                .foregroundColor(color)
            
            Text(title)
                .font(.caption)
                .foregroundColor(.secondary)
        }
    }
}

// MARK: - Error View
struct ErrorView: View {
    let error: String
    
    var body: some View {
        HStack {
            Image(systemName: "exclamationmark.triangle.fill")
                .foregroundColor(.red)
            
            Text(error)
                .font(.caption)
                .foregroundColor(.red)
                .lineLimit(2)
            
            Spacer()
        }
        .padding()
        .background(Color.red.opacity(0.1))
        .cornerRadius(8)
    }
}

// MARK: - Stats View
struct StatsView: View {
    let viewModel: ProxyViewModel
    @Environment(\.presentationMode) var presentationMode
    
    var body: some View {
        NavigationView {
            VStack(spacing: 20) {
                // Uptime
                VStack(spacing: 8) {
                    Text("Uptime")
                        .font(.headline)
                    
                    Text(viewModel.formattedUptime)
                        .font(.largeTitle)
                        .fontWeight(.bold)
                        .foregroundColor(.blue)
                }
                .padding()
                .background(Color.blue.opacity(0.1))
                .cornerRadius(16)
                
                // Stats Grid
                LazyVGrid(columns: Array(repeating: GridItem(.flexible()), count: 2), spacing: 16) {
                    StatCard(title: "Total Requests", value: "\(viewModel.requestCount)", color: .blue)
                    StatCard(title: "Responses Sent", value: "\(viewModel.responseCount)", color: .green)
                    StatCard(title: "Errors", value: "\(viewModel.errorCount)", color: .red)
                    StatCard(title: "Success Rate", value: successRate, color: .orange)
                }
                
                // Version Info
                VStack(spacing: 8) {
                    Text("Version Information")
                        .font(.headline)
                    
                    VStack(spacing: 4) {
                        HStack {
                            Text("Version:")
                                .foregroundColor(.secondary)
                            Spacer()
                            Text(appVersion)
                                .fontWeight(.semibold)
                        }
                        
                        HStack {
                            Text("Build:")
                                .foregroundColor(.secondary)
                            Spacer()
                            Text(buildNumber)
                                .fontWeight(.semibold)
                        }
                        
                        HStack {
                            Text("Build Date:")
                                .foregroundColor(.secondary)
                            Spacer()
                            Text(buildDate)
                                .fontWeight(.semibold)
                                .font(.caption)
                        }
                    }
                }
                .padding()
                .background(Color.gray.opacity(0.1))
                .cornerRadius(16)
                
                Spacer()
                
                // Reset Button
                Button(action: {
                    viewModel.resetStats()
                    presentationMode.wrappedValue.dismiss()
                }) {
                    Text("Reset All Stats")
                        .foregroundColor(.white)
                        .frame(maxWidth: .infinity)
                        .frame(height: 44)
                        .background(Color.red)
                        .cornerRadius(12)
                }
            }
            .padding()
            .navigationTitle("Statistics")
            .navigationBarItems(trailing: Button("Done") {
                presentationMode.wrappedValue.dismiss()
            })
        }
    }
    
    @MainActor private var successRate: String {
        let total = viewModel.requestCount
        guard total > 0 else { return "0%" }
        
        let successful = total - viewModel.errorCount
        let rate = (Double(successful) / Double(total)) * 100
        return String(format: "%.1f%%", rate)
    }
    
    private var appVersion: String {
        Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "Unknown"
    }
    
    private var buildNumber: String {
        Bundle.main.infoDictionary?["CFBundleVersion"] as? String ?? "Unknown"
    }
    
    private var buildDate: String {
        // Get build date from bundle info or use current date as fallback
        if let infoPath = Bundle.main.path(forResource: "Info", ofType: "plist"),
           let infoAttr = try? FileManager.default.attributesOfItem(atPath: infoPath),
           let infoDate = infoAttr[.modificationDate] as? Date {
            let formatter = DateFormatter()
            formatter.dateStyle = .medium
            formatter.timeStyle = .short
            return formatter.string(from: infoDate)
        } else {
            // Fallback to compile-time date
            let formatter = DateFormatter()
            formatter.dateStyle = .medium
            return formatter.string(from: Date())
        }
    }
}

// MARK: - Stat Card View
struct StatCard: View {
    let title: String
    let value: String
    let color: Color
    
    var body: some View {
        VStack(spacing: 8) {
            Text(value)
                .font(.largeTitle)
                .fontWeight(.bold)
                .foregroundColor(color)
            
            Text(title)
                .font(.caption)
                .foregroundColor(.secondary)
                .multilineTextAlignment(.center)
        }
        .frame(height: 80)
        .frame(maxWidth: .infinity)
        .background(color.opacity(0.1))
        .cornerRadius(12)
    }
}

// MARK: - Help View
struct HelpView: View {
    @Environment(\.presentationMode) var presentationMode
    
    var body: some View {
        NavigationView {
            ScrollView {
                VStack(alignment: .leading, spacing: 20) {
                    // Setup Instructions
                    HelpSection(
                        title: "Setup Instructions",
                        icon: "gear",
                        content: """
                        1. Start the BLE proxy on your iOS device
                        2. On your Windows PC, start the proxy client
                        3. Configure your browser to use proxy: 127.0.0.1:8080
                        4. Browse normally - traffic will route through this device
                        """
                    )
                    
                    // How It Works
                    HelpSection(
                        title: "How It Works",
                        icon: "antenna.radiowaves.left.and.right",
                        content: """
                        This app acts as a Bluetooth Low Energy peripheral that receives HTTP requests from your Windows PC and forwards them to the internet using this device's WiFi connection.
                        
                        Data is compressed to optimize transfer over BLE.
                        """
                    )
                    
                    // Battery Usage
                    HelpSection(
                        title: "Battery Usage",
                        icon: "battery.100",
                        content: """
                        To keep the proxy active in background, this app plays silent audio. This may increase battery usage by 10-20%.
                        
                        Keep the device plugged in for extended use.
                        """
                    )
                    
                    // Troubleshooting
                    HelpSection(
                        title: "Troubleshooting",
                        icon: "wrench.and.screwdriver",
                        content: """
                        • Ensure Bluetooth is enabled on both devices
                        • Keep devices within 10 meters for best performance
                        • Restart both apps if connection is lost
                        • Check Windows proxy settings are correct
                        """
                    )
                    
                    // Technical Info
                    HelpSection(
                        title: "Technical Information",
                        icon: "info.circle",
                        content: """
                        Service UUID: A1B2C3D4-E5F6-7890-1234-567890ABCDEF
                        BLE Name: BLE-Proxy
                        
                        Supported: HTTP, HTTPS (basic)
                        Compression: LZFSE
                        Max Range: ~10 meters
                        """
                    )
                }
                .padding()
            }
            .navigationTitle("Help")
            .navigationBarItems(trailing: Button("Done") {
                presentationMode.wrappedValue.dismiss()
            })
        }
    }
}

// MARK: - Help Section View
struct HelpSection: View {
    let title: String
    let icon: String
    let content: String
    
    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                Image(systemName: icon)
                    .foregroundColor(.blue)
                    .font(.title2)
                
                Text(title)
                    .font(.headline)
                    .fontWeight(.semibold)
            }
            
            Text(content)
                .font(.body)
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding()
        .background(Color(UIColor.systemBackground))
        .cornerRadius(12)
        .shadow(color: .black.opacity(0.1), radius: 5, x: 0, y: 2)
    }
}

// MARK: - Preview
struct ContentView_Previews: PreviewProvider {
    static var previews: some View {
        ContentView()
            .environmentObject(ProxyViewModel())
    }
} 