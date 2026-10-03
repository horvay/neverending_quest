import { useEffect, useRef, useState } from "preact/hooks";
import type { LocalLogChunk, LocalLogSource } from "@nq/local-inference/logs.ts";

const LOCAL_LOG_TEXT_LIMIT = 256 * 1024;

function appendBoundedLog(current: string, chunk: string): string {
  const next = current + chunk;
  if (next.length <= LOCAL_LOG_TEXT_LIMIT) return next;
  const clipped = next.slice(next.length - LOCAL_LOG_TEXT_LIMIT);
  const newline = clipped.indexOf("\n");
  return newline >= 0 ? clipped.slice(newline + 1) : clipped;
}

export function LocalLogDrawer(props: {
  read: (
    source: LocalLogSource,
    offset?: number,
    file?: string,
  ) => Promise<LocalLogChunk>;
}) {
  const [source, setSource] = useState<LocalLogSource>("engine");
  const [file, setFile] = useState("");
  const [text, setText] = useState("");
  const [available, setAvailable] = useState(true);
  const [error, setError] = useState("");
  const [follow, setFollow] = useState(true);
  const [copied, setCopied] = useState(false);
  const outputRef = useRef<HTMLPreElement>(null);

  useEffect(() => {
    let disposed = false;
    let offset: number | undefined;
    let file: string | undefined;
    setText("");
    setAvailable(true);
    setError("");
    setFollow(true);

    const poll = async () => {
      while (!disposed) {
        try {
          const chunk = await props.read(source, offset, file);
          if (disposed) return;
          offset = chunk.nextOffset;
          file = chunk.file;
          setFile(chunk.file);
          setAvailable(chunk.available);
          setError("");
          setText((current) =>
            chunk.reset ? chunk.text : appendBoundedLog(current, chunk.text),
          );
        } catch {
          if (disposed) return;
          setError("Could not read the local AI log.");
        }
        await new Promise<void>((resolve) => window.setTimeout(resolve, 750));
      }
    };
    void poll();
    return () => {
      disposed = true;
    };
  }, [source, props.read]);

  useEffect(() => {
    if (!follow || !outputRef.current) return;
    outputRef.current.scrollTop = outputRef.current.scrollHeight;
  }, [text, follow]);

  const empty = source === "engine"
    ? "No AI engine log yet. It appears when a local model starts."
    : "No inference host log yet. It appears when the local host starts.";

  return (
    <section class="local-log" aria-label="Local AI diagnostics">
      <header class="local-log-head">
        <div>
          <strong>Local AI log</strong>
          <span>{file ? `Raw inference diagnostics · ${file}` : "Raw inference diagnostics"}</span>
        </div>
        <label>
          Source
          <select
            value={source}
            onChange={(event) =>
              setSource(event.currentTarget.value as LocalLogSource)
            }
          >
            <option value="engine">AI engine</option>
            <option value="host">Inference host</option>
          </select>
        </label>
      </header>
      <pre
        class="local-log-output"
        ref={outputRef}
        tabIndex={0}
        onScroll={(event) => {
          const el = event.currentTarget;
          setFollow(el.scrollHeight - el.scrollTop - el.clientHeight < 20);
        }}
      >
        {error || (!available ? empty : text || "Waiting for log output…")}
      </pre>
      <footer class="local-log-actions">
        <button type="button" onClick={() => setFollow(true)} disabled={follow}>
          {follow ? "Following" : "Resume"}
        </button>
        <button
          type="button"
          disabled={!text}
          onClick={() => {
            void navigator.clipboard.writeText(text).then(() => {
              setCopied(true);
              setTimeout(() => setCopied(false), 1200);
            });
          }}
        >
          {copied ? "Copied" : "Copy"}
        </button>
        <button type="button" disabled={!text} onClick={() => setText("")}>
          Clear view
        </button>
      </footer>
    </section>
  );
}
