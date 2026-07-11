import { type DragEvent, useCallback, useEffect, useRef, useState } from "react";
import {
  ChevronRight,
  CornerLeftUp,
  Download,
  File as FileIcon,
  Folder,
  RotateCw,
  Upload,
} from "lucide-react";
import { files, type FsFile, type FsList } from "../lib/files";

/** Human file size for the listing. */
function fmtSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

const join = (dir: string, name: string) => (dir ? `${dir}/${name}` : name);
const parentOf = (path: string) => path.split("/").slice(0, -1).join("/");

/**
 * Read/write file browser onto a Sindri session's working checkout — a directory
 * tree on the left, the selected file on the right. Navigate folders, view/download
 * any file, and drop files anywhere on the panel to upload them into the current
 * directory (they hot-reload in the preview like any edit). Keyed by sessionId;
 * renders a hero when the session has no checkout yet.
 */
export function FileViewer({ sessionId }: { sessionId: string }) {
  const [dir, setDir] = useState("");
  const [list, setList] = useState<FsList | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [file, setFile] = useState<FsFile | null>(null);
  const [html, setHtml] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [fileBusy, setFileBusy] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [err, setErr] = useState("");
  const inputRef = useRef<HTMLInputElement | null>(null);
  const dragDepth = useRef(0);

  const loadDir = useCallback(
    async (path: string) => {
      setErr("");
      setLoading(true);
      try {
        const l = await files.list(sessionId, path);
        setList(l);
        setDir(l.ready ? l.path : path);
      } catch (e) {
        setErr(e instanceof Error ? e.message : String(e));
      } finally {
        setLoading(false);
      }
    },
    [sessionId],
  );

  // (Re)load the root whenever the session changes.
  useEffect(() => {
    setList(null);
    setSelected(null);
    setFile(null);
    void loadDir("");
  }, [loadDir]);

  // Load the selected file's content.
  useEffect(() => {
    if (!selected) {
      setFile(null);
      return;
    }
    let cancelled = false;
    setFileBusy(true);
    files
      .read(sessionId, selected)
      .then(
        (f) => !cancelled && setFile(f),
        (e) => !cancelled && setErr(e instanceof Error ? e.message : String(e)),
      )
      .finally(() => !cancelled && setFileBusy(false));
    return () => {
      cancelled = true;
    };
  }, [sessionId, selected]);

  // Syntax-highlight the loaded text file. Shiki is dynamic-imported here, so it
  // (and its grammars) only load the first time a file is opened. Falls back to a
  // plain <pre> for binaries and unknown languages.
  useEffect(() => {
    if (!file || file.binary) {
      setHtml(null);
      return;
    }
    let cancelled = false;
    import("../lib/highlighter")
      .then((m) => m.highlight(file.content, file.path))
      .then(
        (h) => !cancelled && setHtml(h),
        () => !cancelled && setHtml(null),
      );
    return () => {
      cancelled = true;
    };
  }, [file]);

  const openEntry = (name: string, type: "dir" | "file") => {
    if (type === "dir") {
      setSelected(null);
      setFile(null);
      void loadDir(join(dir, name));
    } else {
      setSelected(join(dir, name));
    }
  };

  const uploadFiles = useCallback(
    async (fileList: FileList | File[]) => {
      const arr = Array.from(fileList);
      if (!arr.length) return;
      setUploading(true);
      setErr("");
      try {
        for (const f of arr) await files.upload(sessionId, join(dir, f.name), f);
        await loadDir(dir);
      } catch (e) {
        setErr(e instanceof Error ? e.message : String(e));
      } finally {
        setUploading(false);
      }
    },
    [sessionId, dir, loadDir],
  );

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    dragDepth.current = 0;
    setDragging(false);
    if (e.dataTransfer.files?.length) void uploadFiles(e.dataTransfer.files);
  };
  const onDragEnter = (e: DragEvent) => {
    e.preventDefault();
    if (Array.from(e.dataTransfer.types).includes("Files")) {
      dragDepth.current += 1;
      setDragging(true);
    }
  };
  const onDragLeave = (e: DragEvent) => {
    e.preventDefault();
    dragDepth.current = Math.max(0, dragDepth.current - 1);
    if (dragDepth.current === 0) setDragging(false);
  };

  const crumbs = dir ? dir.split("/") : [];

  return (
    <div
      className="fv-panel"
      onDrop={onDrop}
      onDragOver={(e) => e.preventDefault()}
      onDragEnter={onDragEnter}
      onDragLeave={onDragLeave}
    >
      <div className="fv-bar">
        <nav className="fv-crumbs">
          <button type="button" className="fv-crumb" onClick={() => void loadDir("")}>
            root
          </button>
          {crumbs.map((seg, i) => (
            <span key={i} className="fv-crumb-wrap">
              <ChevronRight size={12} className="fv-crumb-sep" />
              <button
                type="button"
                className="fv-crumb"
                onClick={() => void loadDir(crumbs.slice(0, i + 1).join("/"))}
              >
                {seg}
              </button>
            </span>
          ))}
        </nav>
        <span className="fv-spacer" />
        <button
          type="button"
          className="sindri-preview-icon"
          title="Upload file"
          onClick={() => inputRef.current?.click()}
          disabled={!list?.ready || uploading}
        >
          <Upload size={14} />
        </button>
        <button
          type="button"
          className="sindri-preview-icon"
          title="Reload"
          onClick={() => void loadDir(dir)}
          disabled={loading}
        >
          <RotateCw size={14} />
        </button>
        <input
          ref={inputRef}
          type="file"
          multiple
          hidden
          onChange={(e) => {
            if (e.target.files) void uploadFiles(e.target.files);
            e.target.value = "";
          }}
        />
      </div>

      {err ? <div className="fv-err">{err}</div> : null}

      {!list ? (
        <div className="fv-hero">
          <span className="sindri-spinner" />
          <p>Reading…</p>
        </div>
      ) : !list.ready ? (
        <div className="fv-hero">
          <div className="fv-hero-mark">
            <Folder size={26} strokeWidth={1.4} />
          </div>
          <p>No checkout yet</p>
          <span className="fv-hero-sub">
            Start the preview — or let Sindri make the first edit — and the session&apos;s files
            land here.
          </span>
        </div>
      ) : (
        <div className="fv-split">
          <aside className="fv-tree">
            {dir ? (
              <button type="button" className="fv-item fv-up" onClick={() => void loadDir(parentOf(dir))}>
                <CornerLeftUp size={13} />
                <span className="fv-name">..</span>
              </button>
            ) : null}
            {list.entries.map((en) => (
              <button
                type="button"
                key={en.name}
                className={`fv-item ${selected === join(dir, en.name) ? "is-on" : ""}`}
                onClick={() => openEntry(en.name, en.type)}
              >
                {en.type === "dir" ? (
                  <Folder size={13} className="fv-ic-dir" />
                ) : (
                  <FileIcon size={13} className="fv-ic-file" />
                )}
                <span className="fv-name">{en.name}</span>
                {en.type === "file" ? <span className="fv-size">{fmtSize(en.size)}</span> : null}
              </button>
            ))}
            {list.entries.length === 0 ? <div className="fv-empty">0 files.</div> : null}
          </aside>

          <div className="fv-view">
            {!selected ? (
              <div className="fv-hero">
                <div className="fv-hero-mark">
                  <FileIcon size={26} strokeWidth={1.4} />
                </div>
                <p>Pick a file</p>
                <span className="fv-hero-sub">Or drop files here to upload them to the worktree.</span>
              </div>
            ) : fileBusy && !file ? (
              <div className="fv-hero">
                <span className="sindri-spinner" />
              </div>
            ) : file ? (
              <>
                <div className="fv-view-bar">
                  <span className="fv-view-path" title={file.path}>
                    {file.path}
                  </span>
                  <span className="fv-view-meta">{fmtSize(file.size)}</span>
                  <a
                    className="sindri-preview-icon"
                    title="Download"
                    href={files.downloadUrl(sessionId, file.path)}
                  >
                    <Download size={14} />
                  </a>
                </div>
                {file.binary ? (
                  <div className="fv-hero">
                    <div className="fv-hero-mark">
                      <FileIcon size={26} strokeWidth={1.4} />
                    </div>
                    <p>Binary file</p>
                    <span className="fv-hero-sub">No preview for binaries — download it.</span>
                  </div>
                ) : (
                  <div className="fv-code-scroll">
                    {html ? (
                      // biome-ignore lint/security/noDangerouslySetInnerHtml: Shiki
                      // escapes the source; output is trusted highlighter markup.
                      <div className="fv-hl" dangerouslySetInnerHTML={{ __html: html }} />
                    ) : (
                      <pre className="fv-code">{file.content}</pre>
                    )}
                    {file.truncated ? (
                      <div className="fv-trunc">Truncated — first 512 KB shown.</div>
                    ) : null}
                  </div>
                )}
              </>
            ) : null}
          </div>
        </div>
      )}

      {dragging ? (
        <div className="fv-drop">
          <Upload size={30} strokeWidth={1.4} />
          <p>Drop to upload to {dir ? `/${dir}` : "root"}</p>
        </div>
      ) : null}
      {uploading ? <div className="fv-uploading">Uploading…</div> : null}
    </div>
  );
}
