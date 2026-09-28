import Foundation
import Testing
@testable import OpenBotWorkerHostCore

private let nodeId = "mac-node"
private let serverUrl = "wss://openbot.example/ws/nodes"
private let enrollmentToken = "obenr_" + String(repeating: "t", count: 43)

@Test func desktopControlRequestRequiresOneCanonicalBoundedFrame() throws {
    let request = try DesktopWorkerHostControlRequest.enroll(
        nodeId: nodeId,
        serverUrl: serverUrl,
        enrollmentToken: enrollmentToken
    )
    let encoded = try request.encoded()
    #expect(try DesktopWorkerHostControlRequest.decodeStrict(encoded) == request)
    #expect(try DesktopWorkerHostControlRequest.decodeFrame(encoded + Data([0x0A])) == request)

    let reordered = Data(
        "{\"format\":\"openbot.macos-desktop-control/v1\",\"action\":\"status\"}".utf8
    )
    #expect(throws: OpenBotMacOSError.invalidControlRequest) {
        try DesktopWorkerHostControlRequest.decodeStrict(reordered)
    }
    #expect(throws: OpenBotMacOSError.invalidControlRequest) {
        try DesktopWorkerHostControlRequest.decodeFrame(encoded)
    }
    #expect(throws: OpenBotMacOSError.invalidControlRequest) {
        try DesktopWorkerHostControlRequest.decodeFrame(encoded + Data([0x0A, 0x0A]))
    }
    #expect(throws: OpenBotMacOSError.invalidControlRequest) {
        try DesktopWorkerHostControlRequest.decodeStrict(
            Data(repeating: 0x61, count: DesktopWorkerHostControlRequest.maximumBytes + 1)
        )
    }
}

@Test func desktopControlProjectsOnlyActualConfigurationIdentityAndRegistrationState() async throws {
    let recorder = EventRecorder()
    let configurationStore = TestConfigurationStore(recorder: recorder)
    let identityStore = TestIdentityStore(recorder: recorder)
    let registration = TestRegistration(recorder: recorder)
    let controller = DesktopWorkerHostController(
        configurationStore: configurationStore,
        enrollmentClient: TestEnrollmentClient(recorder: recorder),
        identityStore: identityStore,
        registration: registration
    )

    #expect(await controller.handle(.status()).status == .notConfigured)
    configurationStore.configuration = try configuration()
    #expect(await controller.handle(.status()).status == .invalid)
    identityStore.envelope = try envelope()

    for (native, expected) in [
        (WorkerHostRegistrationStatus.notRegistered, DesktopWorkerHostState.disabled),
        (.requiresApproval, .requiresApproval),
        (.enabled, .enabled),
        (.notFound, .invalid),
    ] {
        registration.registrationStatus = native
        #expect(await controller.handle(.status()).status == expected)
    }
}

@Test func desktopControlEnrollsInTheReviewedOrderAndReturnsApprovalAsIncomplete() async throws {
    let recorder = EventRecorder()
    let configurationStore = TestConfigurationStore(recorder: recorder)
    let identityStore = TestIdentityStore(recorder: recorder)
    let registration = TestRegistration(recorder: recorder)
    registration.statusAfterRegister = .requiresApproval
    let controller = DesktopWorkerHostController(
        configurationStore: configurationStore,
        enrollmentClient: TestEnrollmentClient(recorder: recorder),
        identityStore: identityStore,
        registration: registration
    )

    let response = await controller.handle(
        try .enroll(nodeId: nodeId, serverUrl: serverUrl, enrollmentToken: enrollmentToken)
    )

    #expect(response.status == .requiresApproval)
    #expect(recorder.events == [
        "enrollment.exchange",
        "identity.save",
        "identity.load",
        "configuration.save",
        "configuration.load",
        "registration.register",
        "registration.status",
    ])
    #expect(configurationStore.configuration == (try configuration()))
    #expect(identityStore.envelope == (try envelope()))
}

@Test func desktopControlFailsClosedBeforeRegistrationWhenIdentityPersistenceFails() async throws {
    let recorder = EventRecorder()
    let identityStore = TestIdentityStore(recorder: recorder)
    identityStore.failSave = true
    let registration = TestRegistration(recorder: recorder)
    let controller = DesktopWorkerHostController(
        configurationStore: TestConfigurationStore(recorder: recorder),
        enrollmentClient: TestEnrollmentClient(recorder: recorder),
        identityStore: identityStore,
        registration: registration
    )

    let response = await controller.handle(
        try .enroll(nodeId: nodeId, serverUrl: serverUrl, enrollmentToken: enrollmentToken)
    )

    #expect(response.status == .invalid)
    #expect(recorder.events == ["enrollment.exchange", "identity.save"])
}

@Test func desktopControlRefusesRegistrationWhenSavedIdentityOrConfigurationCannotBeReadBack() async throws {
    for failIdentityReadback in [true, false] {
        let recorder = EventRecorder()
        let configurationStore = TestConfigurationStore(recorder: recorder)
        configurationStore.failReadback = !failIdentityReadback
        let identityStore = TestIdentityStore(recorder: recorder)
        identityStore.failReadback = failIdentityReadback
        let controller = DesktopWorkerHostController(
            configurationStore: configurationStore,
            enrollmentClient: TestEnrollmentClient(recorder: recorder),
            identityStore: identityStore,
            registration: TestRegistration(recorder: recorder)
        )
        let response = await controller.handle(
            try .enroll(nodeId: nodeId, serverUrl: serverUrl, enrollmentToken: enrollmentToken)
        )
        #expect(response.status == .invalid)
        #expect(recorder.events == (failIdentityReadback
            ? ["enrollment.exchange", "identity.save", "identity.load"]
            : ["enrollment.exchange", "identity.save", "identity.load", "configuration.save", "configuration.load"]))
    }
}

@Test func desktopControlEnablesOnlyAnExistingValidIdentityAndOpensFirstPartySettings() async throws {
    let recorder = EventRecorder()
    let configurationStore = TestConfigurationStore(recorder: recorder)
    configurationStore.configuration = try configuration()
    let identityStore = TestIdentityStore(recorder: recorder)
    identityStore.envelope = try envelope()
    let registration = TestRegistration(recorder: recorder)
    registration.registrationStatus = .notRegistered
    registration.statusAfterRegister = .enabled
    let controller = DesktopWorkerHostController(
        configurationStore: configurationStore,
        enrollmentClient: TestEnrollmentClient(recorder: recorder),
        identityStore: identityStore,
        registration: registration
    )

    #expect(await controller.handle(.enable()).status == .enabled)
    #expect(recorder.events == [
        "configuration.load",
        "identity.load",
        "registration.status",
        "registration.register",
        "registration.status",
    ])
    recorder.removeAll()
    registration.registrationStatus = .requiresApproval
    #expect(await controller.handle(.openSettings()).status == .requiresApproval)
    #expect(recorder.events == [
        "configuration.load",
        "identity.load",
        "registration.status",
        "registration.open-settings",
        "registration.status",
    ])
}

private func configuration() throws -> MacOSNodeConfiguration {
    try MacOSNodeConfiguration(nodeId: nodeId, serverUrl: serverUrl)
}

private func envelope() throws -> MacOSKeychainEnvelope {
    try MacOSKeychainEnvelope(
        serverUrl: serverUrl,
        identity: NodeIdentity(
            nodeId: nodeId,
            credential: "obn_" + String(repeating: "c", count: 43),
            enrolledAt: "2026-09-05T00:00:00.000Z"
        )
    )
}

private final class EventRecorder: @unchecked Sendable {
    private let lock = NSLock()
    private var storage: [String] = []

    var events: [String] {
        lock.lock()
        defer { lock.unlock() }
        return storage
    }

    func append(_ event: String) {
        lock.lock()
        storage.append(event)
        lock.unlock()
    }

    func removeAll() {
        lock.lock()
        storage.removeAll()
        lock.unlock()
    }
}

private final class TestConfigurationStore: MacOSConfigurationStoring, @unchecked Sendable {
    var configuration: MacOSNodeConfiguration?
    var failReadback = false
    let recorder: EventRecorder

    init(recorder: EventRecorder) { self.recorder = recorder }

    func load() throws -> MacOSNodeConfiguration {
        recorder.append("configuration.load")
        if failReadback { throw OpenBotMacOSError.invalidConfiguration }
        guard let configuration else { throw OpenBotMacOSError.unavailableConfiguration }
        return configuration
    }

    func save(_ configuration: MacOSNodeConfiguration) throws {
        recorder.append("configuration.save")
        self.configuration = configuration
    }
}

private final class TestIdentityStore: NodeIdentityStore, @unchecked Sendable {
    var envelope: MacOSKeychainEnvelope?
    var failSave = false
    var failReadback = false
    let recorder: EventRecorder

    init(recorder: EventRecorder) { self.recorder = recorder }

    func load(configuration: MacOSNodeConfiguration) throws -> MacOSKeychainEnvelope? {
        recorder.append("identity.load")
        if failReadback { return nil }
        return envelope
    }

    func save(
        _ envelope: MacOSKeychainEnvelope,
        configuration: MacOSNodeConfiguration
    ) throws {
        recorder.append("identity.save")
        if failSave { throw OpenBotMacOSError.keychainFailure }
        self.envelope = envelope
    }

    func remove(configuration: MacOSNodeConfiguration) throws {
        envelope = nil
    }
}

private struct TestEnrollmentClient: NodeEnrollmentClient {
    let recorder: EventRecorder

    func exchange(nodeId: String, serverUrl: String, token: String) async throws -> NodeIdentity {
        recorder.append("enrollment.exchange")
        guard token == enrollmentToken else { throw OpenBotMacOSError.enrollmentFailure }
        return try envelope().identity
    }
}

private final class TestRegistration: WorkerHostRegistrationManaging, @unchecked Sendable {
    var registrationStatus: WorkerHostRegistrationStatus = .notRegistered
    var statusAfterRegister: WorkerHostRegistrationStatus = .enabled
    let recorder: EventRecorder

    init(recorder: EventRecorder) { self.recorder = recorder }

    func status() -> WorkerHostRegistrationStatus {
        recorder.append("registration.status")
        return registrationStatus
    }

    func register() throws {
        recorder.append("registration.register")
        registrationStatus = statusAfterRegister
    }

    func openSystemSettingsLoginItems() {
        recorder.append("registration.open-settings")
    }
}
