// Orbit's dictation helper.
//
// Electron cannot reach macOS speech recognition, and there is no transcription
// service configured for this app, so the microphone and the recogniser both
// live here: a tiny command-line tool that captures audio with AVAudioEngine
// and transcribes it with SFSpeechRecognizer, on device wherever the machine
// supports it. Nothing leaves the Mac unless macOS itself falls back to server
// recognition.
//
// Protocol, so the main process never has to parse anything but JSON:
//
//   stdout  one JSON object per line — {"type":"ready"}, {"type":"partial",
//           "text":…}, {"type":"final","text":…}, {"type":"error","message":…,
//           "code":…}
//   stdin   "stop\n" finishes the utterance and emits the final transcript;
//           "cancel\n" (or EOF) exits without one.
//
// The binary is compiled on demand by src/main/speech/index.ts, which also
// staples an Info.plist into __TEXT so the TCC prompts carry a real purpose
// string, and ad-hoc signs it so the grant sticks between runs.

import AVFoundation
import Foundation
import Speech

/// Writes one JSON line and flushes, so the parent never waits on a buffer.
///
/// Serialised through its own queue: partials arrive on the recogniser's
/// callback thread while the final transcript can be emitted from the main
/// queue's backstop, and a pipe write is only atomic below PIPE_BUF. Two
/// interleaved lines would reach the parent as unparseable JSON, which it
/// silently drops — losing the very transcript the user just dictated.
private let emitQueue = DispatchQueue(label: "dev.orbit.speech.emit")

func emit(_ payload: [String: Any]) {
    guard let data = try? JSONSerialization.data(withJSONObject: payload),
          var line = String(data: data, encoding: .utf8) else { return }
    line.append("\n")
    let bytes = Data(line.utf8)
    emitQueue.sync {
        FileHandle.standardOutput.write(bytes)
    }
}

func fail(_ code: String, _ message: String) -> Never {
    emit(["type": "error", "code": code, "message": message])
    exit(1)
}

final class Dictation {
    private let engine = AVAudioEngine()
    private let recognizer: SFSpeechRecognizer
    private var request: SFSpeechAudioBufferRecognitionRequest?
    private var task: SFSpeechRecognitionTask?
    private var transcript = ""
    /// Guards against emitting a final transcript twice, which is easy to do:
    /// the recognition task reports completion both when we end the audio and
    /// when it tears itself down.
    private var finished = false
    private let lock = NSLock()

    init(locale: Locale) {
        guard let recognizer = SFSpeechRecognizer(locale: locale) else {
            fail("unsupported-locale", "No speech recogniser for \(locale.identifier).")
        }
        guard recognizer.isAvailable else {
            fail("unavailable", "Speech recognition is not available right now.")
        }
        self.recognizer = recognizer
    }

    func start() {
        let request = SFSpeechAudioBufferRecognitionRequest()
        request.shouldReportPartialResults = true
        // Keep dictation on the Mac when the machine can. Requesting it when
        // unsupported makes the recogniser fail outright, so ask first.
        if recognizer.supportsOnDeviceRecognition {
            request.requiresOnDeviceRecognition = true
        }
        self.request = request

        let input = engine.inputNode
        let format = input.outputFormat(forBus: 0)
        guard format.sampleRate > 0 else {
            fail("no-input", "No microphone input is available.")
        }
        input.installTap(onBus: 0, bufferSize: 1024, format: format) { buffer, _ in
            request.append(buffer)
        }

        task = recognizer.recognitionTask(with: request) { [weak self] result, error in
            guard let self else { return }
            if let result {
                let text = result.bestTranscription.formattedString
                self.lock.lock()
                self.transcript = text
                self.lock.unlock()
                if result.isFinal {
                    self.finish(text)
                } else {
                    emit(["type": "partial", "text": text])
                }
            }
            if let error {
                // A cancelled task after a successful finish is not news.
                self.lock.lock()
                let alreadyDone = self.finished
                self.lock.unlock()
                if alreadyDone { return }
                emit([
                    "type": "error",
                    "code": "recognition-failed",
                    "message": error.localizedDescription,
                ])
                self.shutdown(exitCode: 1)
            }
        }

        engine.prepare()
        do {
            try engine.start()
        } catch {
            fail("engine-failed", error.localizedDescription)
        }
        emit(["type": "ready", "onDevice": recognizer.supportsOnDeviceRecognition])
    }

    /// End the utterance and let the recogniser produce its last result. A
    /// backstop timer covers the case where it never does.
    func stop() {
        engine.inputNode.removeTap(onBus: 0)
        engine.stop()
        request?.endAudio()
        DispatchQueue.main.asyncAfter(deadline: .now() + 4) { [weak self] in
            guard let self else { return }
            self.lock.lock()
            let text = self.transcript
            self.lock.unlock()
            self.finish(text)
        }
    }

    func cancel() {
        lock.lock()
        finished = true
        lock.unlock()
        task?.cancel()
        shutdown(exitCode: 0)
    }

    private func finish(_ text: String) {
        lock.lock()
        if finished {
            lock.unlock()
            return
        }
        finished = true
        lock.unlock()
        emit(["type": "final", "text": text])
        shutdown(exitCode: 0)
    }

    private func shutdown(exitCode: Int32) {
        if engine.isRunning {
            engine.inputNode.removeTap(onBus: 0)
            engine.stop()
        }
        exit(exitCode)
    }
}

// MARK: - Permissions

/// TCC calls are asynchronous and there is no run loop yet, so each gate blocks
/// on a semaphore before the next one is asked for.
func requireSpeechAuthorization() {
    let gate = DispatchSemaphore(value: 0)
    var status = SFSpeechRecognizerAuthorizationStatus.notDetermined
    SFSpeechRecognizer.requestAuthorization {
        status = $0
        gate.signal()
    }
    gate.wait()
    switch status {
    case .authorized:
        return
    case .denied:
        fail("speech-denied", "Speech recognition is turned off for Orbit in System Settings › Privacy & Security › Speech Recognition.")
    case .restricted:
        fail("speech-restricted", "Speech recognition is restricted on this Mac.")
    default:
        fail("speech-denied", "Speech recognition was not authorised.")
    }
}

func requireMicrophoneAccess() {
    switch AVCaptureDevice.authorizationStatus(for: .audio) {
    case .authorized:
        return
    case .notDetermined:
        let gate = DispatchSemaphore(value: 0)
        var granted = false
        AVCaptureDevice.requestAccess(for: .audio) {
            granted = $0
            gate.signal()
        }
        gate.wait()
        if !granted {
            fail("mic-denied", "Microphone access was declined.")
        }
    default:
        fail("mic-denied", "Microphone access is turned off for Orbit in System Settings › Privacy & Security › Microphone.")
    }
}

// MARK: - Entry point

let arguments = CommandLine.arguments
// `--probe` answers "could dictation work here?" without opening the mic, so
// the UI can hide or explain itself before the user presses anything.
if arguments.contains("--probe") {
    let identifier = arguments.last.flatMap { $0.hasPrefix("--") ? nil : $0 } ?? Locale.current.identifier
    let recognizer = SFSpeechRecognizer(locale: Locale(identifier: identifier))
    emit([
        "type": "probe",
        "supported": recognizer != nil,
        "available": recognizer?.isAvailable ?? false,
        "onDevice": recognizer?.supportsOnDeviceRecognition ?? false,
        "authorization": String(describing: SFSpeechRecognizer.authorizationStatus()),
    ])
    exit(0)
}

let localeIdentifier = arguments.dropFirst().first { !$0.hasPrefix("--") } ?? Locale.current.identifier

requireSpeechAuthorization()
requireMicrophoneAccess()

let dictation = Dictation(locale: Locale(identifier: localeIdentifier))
dictation.start()

// Commands arrive on stdin. EOF means the parent died, which is a cancel.
DispatchQueue.global(qos: .userInitiated).async {
    while let line = readLine(strippingNewline: true) {
        switch line.trimmingCharacters(in: .whitespaces) {
        case "stop":
            dictation.stop()
        case "cancel":
            dictation.cancel()
        default:
            continue
        }
    }
    dictation.cancel()
}

// A hard ceiling: an abandoned helper must never hold the microphone open.
DispatchQueue.main.asyncAfter(deadline: .now() + 180) {
    dictation.cancel()
}

RunLoop.main.run()
