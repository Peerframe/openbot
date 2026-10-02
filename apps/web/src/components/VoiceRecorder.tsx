import { useEffect, useRef, useState } from "react";
import {
  type ComposerAttachment,
  uploadComposerAttachment,
  validateComposerAttachmentBatch,
} from "../composer-context";
import { getOpenBotDesktopBridge } from "../desktop-runtime";
import "./VoiceRecorder.css";

const LIMIT_BYTES = 10 * 1024 * 1024;
const LIMIT_MS = 5 * 60 * 1000;

/** Only an explicit click opens the microphone; leaving the channel always stops its tracks. */
export function VoiceRecorder({
  channelId,
  getAttachments,
  onChange,
  disabled,
  onActiveChange,
}: {
  channelId: string;
  getAttachments(): ComposerAttachment[];
  onChange(attachments: ComposerAttachment[]): void;
  disabled?: boolean;
  /** The recorder takes over the whole composer while it is not idle (Composer artboard). */
  onActiveChange?(active: boolean): void;
}) {
  const [state, setState] = useState<"idle" | "requesting" | "recording" | "review" | "uploading">(
    "idle",
  );
  const [error, setError] = useState("");
  const [seconds, setSeconds] = useState(0);
  const [recording, setRecording] = useState<{ file: File; url: string; seconds: number }>();
  const [playing, setPlaying] = useState(false);
  const player = useRef<HTMLAudioElement>(null);
  // 取消 while recording: the recorder still fires onstop, which then discards the audio.
  const cancelled = useRef(false);
  const recorder = useRef<MediaRecorder | undefined>(undefined);
  const stream = useRef<MediaStream | undefined>(undefined);
  const controller = useRef<AbortController | undefined>(undefined);
  const live = useRef(true);
  const preview = useRef<string | undefined>(undefined);
  const latest = useRef({ channelId, getAttachments, onChange });
  latest.current = { channelId, getAttachments, onChange };
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
      controller.current?.abort();
      void getOpenBotDesktopBridge()
        ?.endVoiceCapture?.()
        .catch(() => undefined);
      if (recorder.current?.state === "recording") recorder.current.stop();
      for (const track of stream.current?.getTracks() ?? []) track.stop();
      if (preview.current) URL.revokeObjectURL(preview.current);
    };
  }, []);
  const active = state !== "idle";
  const activeChange = useRef(onActiveChange);
  activeChange.current = onActiveChange;
  useEffect(() => {
    activeChange.current?.(active);
  }, [active]);
  useEffect(() => {
    if (state !== "recording") return;
    const start = Date.now();
    const timer = window.setInterval(() => {
      setSeconds(Math.floor((Date.now() - start) / 1000));
      if (Date.now() - start >= LIMIT_MS && recorder.current?.state === "recording")
        recorder.current.stop();
    }, 500);
    return () => window.clearInterval(timer);
  }, [state]);
  /** `again` is 重录: the review being discarded in the same click has not re-rendered yet. */
  async function start(again = false) {
    if ((state !== "idle" && !again) || disabled) return;
    setError("");
    setState("requesting");
    try {
      if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined")
        throw new Error("此环境不支持录音，请添加已有音频文件。");
      const bridge = getOpenBotDesktopBridge();
      if (bridge?.beginVoiceCapture && !(await bridge.beginVoiceCapture()))
        throw new DOMException("Microphone permission denied.", "NotAllowedError");
      if (!live.current) {
        await bridge?.endVoiceCapture?.().catch(() => undefined);
        return;
      }
      let media: MediaStream;
      try {
        media = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
      } finally {
        await bridge?.endVoiceCapture?.().catch(() => undefined);
      }
      if (!live.current) {
        for (const track of media.getTracks()) track.stop();
        return;
      }
      stream.current = media;
      const mime = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"].find((type) =>
        MediaRecorder.isTypeSupported(type),
      );
      if (!mime) throw new Error("此环境不支持可用的录音格式，请添加音频文件。");
      const next = new MediaRecorder(media, { mimeType: mime, audioBitsPerSecond: 64000 });
      recorder.current = next;
      const chunks: Blob[] = [];
      let bytes = 0;
      next.ondataavailable = (event) => {
        bytes += event.data.size;
        if (bytes <= LIMIT_BYTES) chunks.push(event.data);
        else if (next.state === "recording") next.stop();
      };
      next.onerror = () => {
        if (live.current) setError("录音中断，请检查麦克风。可保留已经录下的部分。");
      };
      next.onstop = () => {
        for (const track of media.getTracks()) track.stop();
        if (!live.current) return;
        if (cancelled.current) {
          cancelled.current = false;
          setState("idle");
          return;
        }
        const blob = new Blob(chunks, { type: mime.split(";")[0] ?? "audio/webm" });
        if (!blob.size) {
          setState("idle");
          setError("未录到音频，请检查麦克风后重试。");
          return;
        }
        const extension = mime.includes("mp4") ? "m4a" : "webm";
        const file = new File([blob], `voice-${Date.now()}.${extension}`, { type: blob.type });
        const url = URL.createObjectURL(blob);
        preview.current = url;
        setRecording({ file, url, seconds: Math.round((Date.now() - startedAt) / 1000) });
        setState("review");
      };
      setSeconds(0);
      const startedAt = Date.now();
      cancelled.current = false;
      next.start(1000);
      setState("recording");
    } catch (cause) {
      for (const track of stream.current?.getTracks() ?? []) track.stop();
      if (live.current) {
        setState("idle");
        setError(
          cause instanceof DOMException && cause.name === "NotAllowedError"
            ? "未获得麦克风权限，请在系统或浏览器设置中允许 OpenBot 使用麦克风。"
            : cause instanceof Error
              ? cause.message
              : "无法开始录音。",
        );
      }
    }
  }
  function discard() {
    player.current?.pause();
    setPlaying(false);
    if (preview.current) URL.revokeObjectURL(preview.current);
    preview.current = undefined;
    setRecording(undefined);
    setState("idle");
    setError("");
  }
  async function attach() {
    if (!recording || state !== "review") return;
    const current = latest.current;
    setState("uploading");
    setError("");
    const abort = new AbortController();
    controller.current = abort;
    try {
      validateComposerAttachmentBatch(current.getAttachments(), [recording.file]);
      const file = await uploadComposerAttachment(current.channelId, recording.file, abort.signal);
      if (!live.current || abort.signal.aborted || latest.current.channelId !== current.channelId)
        return;
      validateComposerAttachmentBatch(current.getAttachments(), [recording.file]);
      current.onChange([...current.getAttachments(), file]);
      discard();
    } catch (cause) {
      if (live.current && !abort.signal.aborted) {
        setError(cause instanceof Error ? cause.message : "录音添加失败，请重试。");
        setState("review");
      }
    }
  }
  const clock = (value: number) =>
    `${Math.floor(value / 60)}:${String(value % 60).padStart(2, "0")}`;
  return (
    <div className="voice-recorder">
      <button
        type="button"
        className="voice-start"
        disabled={disabled || state !== "idle"}
        onClick={() => void start()}
        aria-label="录制语音附件"
        title="录制语音附件"
      >
        <svg
          viewBox="0 0 24 24"
          width="18"
          height="18"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.7"
          aria-hidden="true"
        >
          <rect x="9" y="2" width="6" height="12" rx="3" />
          <path d="M5 10v2a7 7 0 0 0 14 0v-2M12 19v3M8 22h8" />
        </svg>
      </button>
      {state === "requesting" ? (
        <div className="voice-panel">
          <p role="status">正在请求麦克风权限…</p>
        </div>
      ) : state === "recording" ? (
        <div className="voice-panel is-recording">
          <i className="voice-dot" aria-hidden="true" />
          <span role="status">
            <span className="visually-hidden">录音中 </span>
            <strong>{clock(seconds)}</strong>
          </span>
          <span className="voice-wave" aria-hidden="true" />
          <button
            type="button"
            className="ob-pill is-small"
            onClick={() => {
              cancelled.current = true;
              recorder.current?.stop();
            }}
          >
            取消
          </button>
          <button
            type="button"
            className="ob-pill is-small is-primary"
            aria-label="结束录音"
            onClick={() => recorder.current?.stop()}
          >
            停止
          </button>
        </div>
      ) : state === "review" || state === "uploading" ? (
        <div className="voice-panel is-review">
          {recording ? (
            <>
              {/* biome-ignore lint/a11y/useMediaCaption: This is the Owner's unsent local recording; transcription requires a separate explicit action. */}
              <audio
                ref={player}
                src={recording.url}
                onEnded={() => setPlaying(false)}
                onPause={() => setPlaying(false)}
              >
                音频预览
              </audio>
              <button
                type="button"
                className="voice-play"
                aria-label={playing ? "暂停试听" : "试听"}
                onClick={() => {
                  const audio = player.current;
                  if (!audio) return;
                  if (audio.paused) {
                    void audio.play().then(
                      () => setPlaying(true),
                      () => setError("无法播放这段录音。"),
                    );
                  } else audio.pause();
                }}
              >
                {playing ? "❚❚" : "▶"}
              </button>
            </>
          ) : null}
          <span className="voice-text">
            <strong>语音 {clock(recording?.seconds ?? seconds)}</strong>
            <small>添加后可以选择转写；发送前可以检查或移除</small>
          </span>
          {state === "uploading" ? (
            <>
              <button type="button" className="ob-pill is-small is-primary" disabled>
                正在添加…
              </button>
              <button
                type="button"
                className="ob-pill is-small"
                onClick={() => {
                  controller.current?.abort();
                  controller.current = undefined;
                  setState("review");
                  setError(
                    "已取消添加，录音仍保留在本地供试听或重试。服务电脑已收到的原件可在附件管理中查看。",
                  );
                }}
              >
                取消添加
              </button>
            </>
          ) : (
            <>
              <button
                type="button"
                className="ob-pill is-small"
                onClick={() => {
                  discard();
                  void start(true);
                }}
              >
                重录
              </button>
              <button
                type="button"
                className="ob-pill is-small"
                aria-label="丢弃录音"
                onClick={discard}
              >
                丢弃
              </button>
              <button
                type="button"
                className="ob-pill is-small is-primary"
                onClick={() => void attach()}
              >
                添加到草稿
              </button>
            </>
          )}
        </div>
      ) : null}
      {error && (
        <p className="voice-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
