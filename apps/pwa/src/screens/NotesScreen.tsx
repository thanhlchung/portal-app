import type { Note } from "@portal/api";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { InstallPrompt } from "../components/InstallPrompt";
import { api, ApiError, unwrap } from "../lib/api";
import { authClient } from "../lib/auth-client";

type NotesPayload = { notes: Note[] };

interface OptimisticNote extends Note {
  pending?: boolean;
}

export default function NotesScreen({
  user,
}: {
  user: { id: string; email: string; name?: string | null };
}) {
  const queryClient = useQueryClient();
  const [title, setTitle] = useState("");
  const [composerOpen, setComposerOpen] = useState(false);
  const [online, setOnline] = useState(() => navigator.onLine);
  const titleRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const update = () => setOnline(navigator.onLine);
    window.addEventListener("online", update);
    window.addEventListener("offline", update);
    return () => {
      window.removeEventListener("online", update);
      window.removeEventListener("offline", update);
    };
  }, []);

  // `?new=1` is the manifest shortcut: launch straight into writing.
  useEffect(() => {
    if (new URLSearchParams(window.location.search).get("new") === "1") {
      setComposerOpen(true);
    }
  }, []);

  useEffect(() => {
    if (composerOpen) titleRef.current?.focus();
  }, [composerOpen]);

  const notesQuery = useQuery({
    queryKey: ["notes"],
    queryFn: async () => unwrap<NotesPayload>(await api.notes.$get()),
  });

  const createNote = useMutation({
    mutationFn: async (input: { title: string; body: string }) =>
      unwrap<{ note: Note }>(await api.notes.$post({ json: input })),

    // Optimistic: the row appears before the round trip finishes. On a phone
    // this is the difference between "instant" and "laggy".
    onMutate: async (input) => {
      await queryClient.cancelQueries({ queryKey: ["notes"] });
      const previous = queryClient.getQueryData<NotesPayload>(["notes"]);

      const optimistic: OptimisticNote = {
        id: `optimistic-${Date.now()}`,
        userId: user.id,
        title: input.title,
        body: input.body,
        createdAt: new Date(),
        updatedAt: new Date(),
        pending: true,
      };

      queryClient.setQueryData<NotesPayload>(["notes"], {
        notes: [optimistic, ...(previous?.notes ?? [])],
      });

      return { previous, optimisticId: optimistic.id };
    },
    onError: (_error, _input, context) => {
      if (context?.previous) {
        queryClient.setQueryData(["notes"], context.previous);
      }
    },
    onSuccess: (data, _input, context) => {
      queryClient.setQueryData<NotesPayload>(["notes"], (current) => ({
        notes: (current?.notes ?? []).map((note) =>
          note.id === context?.optimisticId ? data.note : note,
        ),
      }));
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: ["notes"] });
    },
  });

  const deleteNote = useMutation({
    mutationFn: async (id: string) =>
      // Hono's RPC client nests parameterised routes under their ":id" key.
      unwrap<{ deleted: string }>(await api.notes[":id"].$delete({ param: { id } })),
    onMutate: async (id) => {
      await queryClient.cancelQueries({ queryKey: ["notes"] });
      const previous = queryClient.getQueryData<NotesPayload>(["notes"]);
      queryClient.setQueryData<NotesPayload>(["notes"], {
        notes: (previous?.notes ?? []).filter((note) => note.id !== id),
      });
      return { previous };
    },
    onError: (_error, _id, context) => {
      if (context?.previous) queryClient.setQueryData(["notes"], context.previous);
    },
  });

  // An expired session must not leave the app in a half-signed-in state.
  useEffect(() => {
    const error = notesQuery.error;
    if (error instanceof ApiError && error.status === 401) {
      void authClient.signOut();
    }
  }, [notesQuery.error]);

  const notes: OptimisticNote[] = notesQuery.data?.notes ?? [];
  const showSkeletons = notesQuery.isPending;
  const offlineWithCache = !online && notes.length > 0;

  function submit(event: React.FormEvent) {
    event.preventDefault();
    const value = title.trim();
    if (!value) return;
    createNote.mutate({ title: value, body: "" });
    setTitle("");
    setComposerOpen(false);
  }

  return (
    <div className="app">
      <header className="app-header">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true" />
          <span className="brand-name">Portal</span>
        </div>
        <button
          className="link-button link-button--muted"
          type="button"
          onClick={async () => {
            await authClient.signOut();
            queryClient.clear();
          }}
        >
          Sign out
        </button>
      </header>

      {!online ? (
        <div className="status-bar" role="status">
          Offline{offlineWithCache ? " — showing saved items" : ""}
        </div>
      ) : null}

      <InstallPrompt />

      <main className="screen">
        <div className="screen-head">
          <h1 className="screen-title">Your notes</h1>
          <span className="screen-meta">{user.email}</span>
        </div>

        {composerOpen ? (
          <form className="composer" onSubmit={submit}>
            <input
              ref={titleRef}
              className="text-input"
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              placeholder="What's on your mind?"
              enterKeyHint="done"
              maxLength={200}
              aria-label="New note title"
            />
            <div className="composer-actions">
              <button
                className="button button--compact button--primary"
                type="submit"
                disabled={!title.trim() || createNote.isPending}
              >
                Add
              </button>
              <button
                className="link-button"
                type="button"
                onClick={() => {
                  setComposerOpen(false);
                  setTitle("");
                }}
              >
                Cancel
              </button>
            </div>
          </form>
        ) : null}

        {showSkeletons ? (
          <div className="skeleton-stack" aria-hidden="true">
            <div className="skeleton skeleton-row" />
            <div className="skeleton skeleton-row" />
            <div className="skeleton skeleton-row" />
          </div>
        ) : notes.length === 0 ? (
          <div className="empty">
            <p className="empty-title">Nothing here yet</p>
            <p className="empty-sub">Add your first note — it saves the moment you type it.</p>
          </div>
        ) : (
          <ul className="note-list">
            {notes.map((note) => (
              <li key={note.id} className={`note ${note.pending ? "is-pending" : ""}`}>
                <div className="note-main">
                  <p className="note-title">{note.title}</p>
                  <p className="note-meta">{formatWhen(note.updatedAt)}</p>
                </div>
                <button
                  className="icon-button"
                  type="button"
                  aria-label={`Delete ${note.title}`}
                  onClick={() => deleteNote.mutate(note.id)}
                >
                  <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
                    <path
                      d="M6 7h12M9 7V5h6v2m-8 0 1 12h8l1-12"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.7"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                </button>
              </li>
            ))}
          </ul>
        )}

        {notesQuery.isError && !(notesQuery.error instanceof ApiError) ? (
          <p className="form-error">Couldn&apos;t reach the server. Pull to refresh or try again.</p>
        ) : null}
      </main>

      {!composerOpen ? (
        <div className="fab-layer">
          <button
            className="fab"
            type="button"
            aria-label="Add note"
            onClick={() => setComposerOpen(true)}
          >
            <svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true">
              <path
                d="M12 5v14M5 12h14"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
              />
            </svg>
          </button>
        </div>
      ) : null}
    </div>
  );
}

const relative = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });

function formatWhen(value: Date | string): string {
  const date = value instanceof Date ? value : new Date(value);
  const seconds = Math.round((date.getTime() - Date.now()) / 1000);
  const table: [Intl.RelativeTimeFormatUnit, number][] = [
    ["second", 60],
    ["minute", 60],
    ["hour", 24],
    ["day", 7],
    ["week", 4.34],
    ["month", 12],
  ];

  let amount = seconds;
  for (const [unit, size] of table) {
    if (Math.abs(amount) < size) return relative.format(Math.round(amount), unit);
    amount /= size;
  }
  return relative.format(Math.round(amount), "year");
}
