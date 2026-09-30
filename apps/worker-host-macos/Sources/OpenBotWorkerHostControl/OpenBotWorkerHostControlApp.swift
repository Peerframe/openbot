import Darwin
import Foundation
import OpenBotWorkerHostCore
import ServiceManagement
import SwiftUI

struct OpenBotWorkerHostControlApp: App {
    @StateObject private var model = WorkerHostControlModel()

    var body: some Scene {
        WindowGroup("OpenBot Worker Host") {
            WorkerHostControlView(model: model)
                .frame(minWidth: 520, minHeight: 430)
        }
        .windowResizability(.contentSize)
    }
}

@main
enum OpenBotWorkerHostEntrypoint {
    @MainActor
    static func main() async {
        switch Array(CommandLine.arguments.dropFirst()) {
        case []:
            OpenBotWorkerHostControlApp.main()
        case ["--worker-host"]:
            do {
                exit(try runWorkerHost())
            } catch {
                fputs("OpenBot Worker Host failed.\n", stderr)
                exit(1)
            }
        case ["--desktop-control"]:
            exit(await runDesktopControl())
        default:
            fputs("OpenBot Worker Host received invalid arguments.\n", stderr)
            exit(64)
        }
    }

    private static func runDesktopControl() async -> Int32 {
        var input = Data()
        defer {
            if !input.isEmpty { input.resetBytes(in: 0..<input.count) }
        }
        do {
            guard getuid() > 0 else { throw OpenBotMacOSError.invalidConfiguration }
            input = try readBoundedControlFrame()
            let request = try DesktopWorkerHostControlRequest.decodeFrame(input)
            let hostURL = URL(fileURLWithPath: CommandLine.arguments[0]).standardizedFileURL
            let application = try InstalledWorkerHostApplication(hostURL: hostURL)
            try application.validate()
            let configurationStore = try MacOSConfigurationStore(
                homeDirectory: currentUserHomeDirectory()
            )
            let identityStore = try SystemNodeIdentityStore(
                accessGroup: MacOSAccessGroup.current()
            )
            let controller = DesktopWorkerHostController(
                configurationStore: configurationStore,
                enrollmentClient: URLSessionNodeEnrollmentClient(),
                identityStore: identityStore,
                registration: SystemWorkerHostRegistration()
            )
            try FileHandle.standardOutput.write(contentsOf: await controller.handle(request).encodedFrame())
            return 0
        } catch {
            let response = DesktopWorkerHostControlResponse(status: .invalid)
            try? FileHandle.standardOutput.write(contentsOf: response.encodedFrame())
            return 1
        }
    }

    private static func readBoundedControlFrame() throws -> Data {
        var result = Data()
        while result.count <= DesktopWorkerHostControlRequest.maximumBytes + 1 {
            let remaining = DesktopWorkerHostControlRequest.maximumBytes + 2 - result.count
            guard remaining > 0 else { break }
            guard let chunk = try FileHandle.standardInput.read(
                upToCount: min(4 * 1024, remaining)
            ), !chunk.isEmpty
            else {
                break
            }
            result.append(chunk)
        }
        guard result.count <= DesktopWorkerHostControlRequest.maximumBytes + 1 else {
            throw OpenBotMacOSError.invalidControlRequest
        }
        return result
    }

    private static func runWorkerHost() throws -> Int32 {
        guard getuid() > 0 else {
            throw OpenBotMacOSError.invalidConfiguration
        }
        let hostURL = URL(fileURLWithPath: CommandLine.arguments[0]).standardizedFileURL
        let application = try InstalledWorkerHostApplication(hostURL: hostURL)
        try application.validate()

        let homeDirectory = try currentUserHomeDirectory()
        let configurationStore = try MacOSConfigurationStore(homeDirectory: homeDirectory)
        let configuration = try configurationStore.load()
        try configurationStore.ensureWorkDirectory()

        let accessGroup = try MacOSAccessGroup.current()
        let identityStore = try SystemNodeIdentityStore(accessGroup: accessGroup)
        guard let envelope = try identityStore.load(configuration: configuration) else {
            throw OpenBotMacOSError.unavailableIdentity
        }
        try envelope.requireMatches(configuration)

        let policy = try NodeChildLaunchPolicy(
            applicationRoot: application.root,
            homeDirectory: homeDirectory,
            workDirectory: configurationStore.workDirectoryURL
        )
        let child = try SpawnedNodeProcess(policy: policy)
        return try NodeProcessSupervisor().run(process: child, identity: envelope.identity)
    }
}

@MainActor
final class WorkerHostControlModel: ObservableObject {
    @Published var nodeId = ""
    @Published var serverUrl = "wss://"
    @Published var enrollmentToken = ""
    @Published private(set) var registrationStatus = WorkerHostRegistrationStatus.notRegistered
    @Published private(set) var message = "Enter the dedicated Node settings, then enroll and enable."
    @Published private(set) var isBusy = false

    init() { refresh() }

    func refresh() {
        registrationStatus = SystemWorkerHostRegistration().status()
        message = switch registrationStatus {
        case .enabled: "The background Worker Host is enabled."
        case .requiresApproval: "Approval is required in System Settings > Login Items."
        case .notRegistered: "The background Worker Host is not registered."
        case .notFound: "The bundled LaunchAgent is unavailable. Reinstall the app."
        }
    }

    func enrollAndEnable() {
        guard !isBusy else { return }
        isBusy = true
        let inputNodeId = nodeId
        let inputServerUrl = serverUrl
        let token = enrollmentToken
        enrollmentToken = ""
        message = "Enrolling and validating the local identity…"

        Task {
            do {
                let controller = DesktopWorkerHostController(
                    configurationStore: try MacOSConfigurationStore(
                        homeDirectory: currentUserHomeDirectory()
                    ),
                    enrollmentClient: URLSessionNodeEnrollmentClient(),
                    identityStore: try SystemNodeIdentityStore(accessGroup: MacOSAccessGroup.current()),
                    registration: SystemWorkerHostRegistration()
                )
                let result = await controller.handle(try .enroll(
                    nodeId: inputNodeId,
                    serverUrl: inputServerUrl,
                    enrollmentToken: token
                ))
                switch result.status {
                case .enabled:
                    registrationStatus = .enabled
                    message = "Enrollment is complete and the Worker Host is enabled."
                case .requiresApproval:
                    registrationStatus = .requiresApproval
                    message = "Enrollment is complete. Approve OpenBot in System Settings > Login Items."
                default:
                    throw OpenBotMacOSError.registrationFailure
                }
            } catch {
                message = "Enrollment or registration failed without changing service authority."
            }
            isBusy = false
        }
    }

    func disable() {
        guard !isBusy else { return }
        isBusy = true
        do {
            try SystemWorkerHostRegistration().unregister()
            refresh()
        } catch {
            message = "The Worker Host could not be disabled."
        }
        isBusy = false
    }

    func removeLocalIdentity() {
        guard !isBusy, registrationStatus == .notRegistered else {
            message = "Disable the Worker Host before removing its local identity."
            return
        }
        isBusy = true
        do {
            let configStore = try MacOSConfigurationStore(homeDirectory: currentUserHomeDirectory())
            let configuration = try configStore.load()
            let keychain = try SystemNodeIdentityStore(accessGroup: MacOSAccessGroup.current())
            try keychain.remove(configuration: configuration)
            try configStore.remove()
            nodeId = ""
            serverUrl = "wss://"
            message = "The exact local Node identity and public configuration were removed."
        } catch {
            message = "Local identity cleanup failed; no broader data was removed."
        }
        isBusy = false
    }
}

struct WorkerHostControlView: View {
    @ObservedObject var model: WorkerHostControlModel

    var body: some View {
        Form {
            Section("Status") {
                LabeledContent("Background item", value: model.registrationStatus.rawValue)
                Text(model.message)
                    .foregroundStyle(.secondary)
                    .textSelection(.enabled)
            }
            Section("One-time enrollment") {
                TextField("Node ID", text: $model.nodeId)
                    .textFieldStyle(.roundedBorder)
                TextField("Server WebSocket URL", text: $model.serverUrl)
                    .textFieldStyle(.roundedBorder)
                SecureField("Enrollment token", text: $model.enrollmentToken)
                    .textFieldStyle(.roundedBorder)
                Text("The token is exchanged once and is never written to disk or logs.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            HStack {
                Button("Enroll & Enable") { model.enrollAndEnable() }
                    .buttonStyle(.borderedProminent)
                    .disabled(model.isBusy)
                Button("Refresh") { model.refresh() }
                    .disabled(model.isBusy)
                Button("Disable") { model.disable() }
                    .disabled(model.isBusy || model.registrationStatus == .notRegistered)
                Spacer()
                Button("Remove Local Identity", role: .destructive) {
                    model.removeLocalIdentity()
                }
                .disabled(model.isBusy || model.registrationStatus != .notRegistered)
            }
        }
        .padding(20)
    }
}
