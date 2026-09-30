import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { VoiceRecorder } from "../components/VoiceRecorder";

// Mock MediaRecorder
class MockMediaRecorder {
  state = "inactive";
  ondataavailable: ((e: any) => void) | null = null;
  onstop: (() => void) | null = null;
  mimeType = "audio/webm";

  static isTypeSupported(type: string) {
    return type === "audio/webm";
  }

  start() {
    this.state = "recording";
  }

  stop() {
    this.state = "inactive";
    // Simulate data available
    this.ondataavailable?.({ data: new Blob(["audio"], { type: "audio/webm" }) });
    this.onstop?.();
  }
}

// Mock AudioContext
class MockAnalyserNode {
  fftSize = 256;
  frequencyBinCount = 128;
  getByteFrequencyData(arr: Uint8Array) {
    arr.fill(100);
  }
}

class MockAudioContext {
  createMediaStreamSource() {
    return { connect: vi.fn() };
  }
  createAnalyser() {
    return new MockAnalyserNode();
  }
}

const mockGetUserMedia = vi.fn();

beforeEach(() => {
  vi.stubGlobal("MediaRecorder", MockMediaRecorder);
  vi.stubGlobal("AudioContext", MockAudioContext);
  // Mock URL.createObjectURL / revokeObjectURL (not in jsdom)
  vi.stubGlobal("URL", {
    ...globalThis.URL,
    createObjectURL: vi.fn(() => "blob:mock-url"),
    revokeObjectURL: vi.fn(),
  });
  Object.defineProperty(navigator, "mediaDevices", {
    value: { getUserMedia: mockGetUserMedia },
    writable: true,
    configurable: true,
  });
  mockGetUserMedia.mockResolvedValue({
    getTracks: () => [{ stop: vi.fn() }],
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("VoiceRecorder", () => {
  it("renders start recording button in idle state", () => {
    const onComplete = vi.fn();
    render(<VoiceRecorder onRecordingComplete={onComplete} />);

    expect(screen.getByText("Start Recording")).toBeInTheDocument();
  });

  it("shows recording UI after clicking start", async () => {
    const user = userEvent.setup();
    const onComplete = vi.fn();
    render(<VoiceRecorder onRecordingComplete={onComplete} />);

    await user.click(screen.getByText("Start Recording"));

    expect(screen.getByText("Stop")).toBeInTheDocument();
    expect(screen.getByText("0:00")).toBeInTheDocument();
  });

  it("calls onRecordingComplete when stopped", async () => {
    const user = userEvent.setup();
    const onComplete = vi.fn();
    render(<VoiceRecorder onRecordingComplete={onComplete} />);

    await user.click(screen.getByText("Start Recording"));
    await user.click(screen.getByText("Stop"));

    expect(onComplete).toHaveBeenCalledWith(expect.any(Blob));
  });

  it("shows error when microphone access is denied", async () => {
    mockGetUserMedia.mockRejectedValueOnce(
      new DOMException("Permission denied", "NotAllowedError"),
    );

    const user = userEvent.setup();
    const onComplete = vi.fn();
    render(<VoiceRecorder onRecordingComplete={onComplete} />);

    await user.click(screen.getByText("Start Recording"));

    expect(
      screen.getByText(/Microphone access denied/),
    ).toBeInTheDocument();
  });

  it("shows unsupported message when MediaRecorder is unavailable", () => {
    vi.stubGlobal("MediaRecorder", undefined);
    const onComplete = vi.fn();
    render(<VoiceRecorder onRecordingComplete={onComplete} />);

    expect(
      screen.getByText(/Voice recording is not supported/),
    ).toBeInTheDocument();
  });

  it("disables start button when disabled prop is true", () => {
    const onComplete = vi.fn();
    render(<VoiceRecorder onRecordingComplete={onComplete} disabled />);

    expect(screen.getByText("Start Recording")).toBeDisabled();
  });
});
