import { getOpenBotDesktopBridge } from "../desktop-runtime";
import { useEffect, useRef, useState } from "react";
import {
  type ComposerAttachment,
  uploadComposerAttachment,
  validateComposerAttachmentBatch,
} from "../composer-context";
import "./VoiceRecorder.css";

const LIMIT_BYTES = 10 * 1024 * 1024;
const LIMIT_MS = 5 * 60 * 1000;

/** Only an explicit click opens the microphone; leaving the channel always stops its tracks. */
export function VoiceRecorder({
  channelId,
  getAttachments,
  onChange,
  disabled,
}: {
  channelId: string;
  getAttachments(): ComposerAttachment[];
  onChange(attachments: ComposerAttachment[]): void;
  disabled?: boolean;
}) {
  const [state, setState] = useState<"idle" | "requesting" | "recording" | "review" | "uploading">(
    "idle",
  );
  const [error, setError] = useState("");
  const [seconds, setSeconds] = useState(0);
  const [recording, setRecording] = useState<{ file: File; url: string }>();
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
  async function start() {
    if (state !== "idle" || disabled) return;
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
        setRecording({ file, url });
        setState("review");
      };
      setSeconds(0);
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
      {state !== "idle" && (
        <div className="voice-panel">
          {state === "requesting" ? (
            <p role="status">正在请求麦克风权限…</p>
          ) : state === "recording" ? (
            <>
              <p role="status">
                录音中 · {Math.floor(seconds / 60)}:{String(seconds % 60).padStart(2, "0")} / 5:00
              </p>
              <button type="button" onClick={() => recorder.current?.stop()}>
                结束录音
              </button>
            </>
          ) : (
            <>
              {recording && (
                // biome-ignore lint/a11y/useMediaCaption: This is the Owner's unsent local recording; transcription requires a separate explicit action.
                <audio controls src={recording.url}>
                  音频预览
                </audio>
              )}
              <small>添加到草稿后，可在附件操作中选择转写；发送前可以检查或移除。</small>
              <div>
                <button
                  type="button"
                  disabled={state === "uploading"}
                  onClick={() => void attach()}
                >
                  {state === "uploading" ? "正在添加…" : "添加到草稿"}
                </button>
                {state === "uploading" ? (
                  <button
                    type="button"
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
                ) : (
                  <button type="button" onClick={discard}>
                    丢弃
                  </button>
                )}
              </div>
            </>
          )}
        </div>
      )}
      {error && (
        <p className="voice-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
