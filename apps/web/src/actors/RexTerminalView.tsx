/* oxlint-disable t3code/no-untranslated-copy -- the fork adds nothing to the translation catalogs, so its copy stays English */
import { chunkTerminalWrite, type EnvironmentId } from "@t3tools/contracts";
import { useEffect, useRef, useState } from "react";

import {
  resolveTerminalFontPreference,
  resolveTerminalFontSizePreference,
} from "../appearanceFonts";
import { terminalThemeFromApp } from "../components/ThreadTerminalDrawer";
import { Button } from "../components/ui/button";
import { SidebarInset } from "../components/ui/sidebar";
import { WorkspaceBreadcrumb, WorkspaceBreadcrumbItem } from "../components/WorkspaceBreadcrumb";
import { WorkspacePageHeader } from "../components/WorkspacePageHeader";
import { isElectron } from "../env";
import { useClientSettings } from "../hooks/useSettings";
import { observeResize } from "../lib/observeResize";
import { ensureLocalApi } from "../localApi";
import { GhosttyTerminalSurface } from "../terminal/ghostty/surface";
import { rexTerminalUrl } from "./rexActors";

/** Mirrors the server: the terminal closed in Rex or the dock names nothing that exists. */
const CLOSE_GONE = 4000;
/** How long to wait before each try to open the terminal again, after it was lost. */
const RETRY_DELAYS_MS = [500, 2000, 5000] as const;

type Link =
  | { readonly state: "opening" }
  | { readonly state: "live"; readonly owned: boolean; readonly exited: boolean }
  | { readonly state: "closed"; readonly message: string; readonly retrying: boolean };

type Grid = { readonly cols: number; readonly rows: number };

const isGridNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && value > 0;

/**
 * One connection to a Rex actor's terminal. The server paints the screen once and then sends the
 * program's output as it comes. Typing and this surface's size go back as messages.
 */
function connectRexTerminal(input: {
  readonly environmentId: EnvironmentId;
  readonly name: string;
  readonly surface: GhosttyTerminalSurface;
  readonly grid: () => Grid | null;
  readonly onLink: (link: Link) => void;
  /** Called when a terminal that may come back was lost. Says whether another try is on its way. */
  readonly onLost: () => boolean;
}): { readonly send: (message: object) => void; readonly close: () => void } {
  let socket: WebSocket | null = null;
  let closed = false;
  let opened = false;
  let live = false;
  let owned = false;
  let exited = false;
  let refused: string | null = null;
  // One character can be cut across two frames.
  const decoder = new TextDecoder();
  const report = () => input.onLink({ state: "live", owned, exited });
  const send = (message: object) => {
    if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
  };
  const open = () => {
    const grid = input.grid();
    if (opened || grid === null || socket?.readyState !== WebSocket.OPEN) return;
    opened = true;
    send({ type: "open", ...grid });
  };

  void rexTerminalUrl(input.environmentId, input.name).then((url) => {
    if (closed) return;
    if (url === null) {
      input.onLink({
        state: "closed",
        message: "This environment is not connected.",
        retrying: input.onLost(),
      });
      return;
    }
    socket = new WebSocket(url);
    socket.binaryType = "arraybuffer";
    socket.addEventListener("open", open);
    socket.addEventListener("message", (event) => {
      if (closed) return;
      if (event.data instanceof ArrayBuffer) {
        if (live) input.surface.write(decoder.decode(event.data, { stream: true }));
        return;
      }
      let message: Record<string, unknown>;
      try {
        message = JSON.parse(String(event.data));
      } catch {
        return;
      }
      if (message.type === "error" && typeof message.message === "string") {
        refused = message.message;
      } else if (message.type === "seed" && typeof message.data === "string") {
        if (isGridNumber(message.cols) && isGridNumber(message.rows)) {
          input.surface.setSharedGrid({ cols: message.cols, rows: message.rows });
        }
        input.surface.resetAndWrite(message.data);
        live = true;
        owned = message.owned === true;
        report();
        input.surface.focus();
      } else if (message.type === "size") {
        if (isGridNumber(message.cols) && isGridNumber(message.rows)) {
          input.surface.setSharedGrid({ cols: message.cols, rows: message.rows });
        }
        owned = message.owned === true;
        report();
      } else if (message.type === "owner") {
        owned = message.owned === true;
        report();
      } else if (message.type === "exit") {
        exited = true;
        report();
      }
    });
    socket.addEventListener("close", (event) => {
      if (closed) return;
      closed = true;
      input.onLink({
        state: "closed",
        message: refused ?? "The connection to this terminal closed.",
        retrying: event.code !== CLOSE_GONE && input.onLost(),
      });
    });
  });

  return {
    // The first size this surface measures opens the terminal; later ones resize it.
    send: (message) => {
      if (!opened) return open();
      send(message);
    },
    close: () => {
      closed = true;
      socket?.close(1000);
    },
  };
}

/** A Rex actor's terminal, filling the main area beside the sidebar. */
export function RexTerminalView(props: {
  readonly environmentId: EnvironmentId;
  readonly name: string;
  readonly title: string;
}) {
  const { environmentId, name } = props;
  const [surface, setSurface] = useState<GhosttyTerminalSurface | null>(null);
  const [link, setLink] = useState<Link>({ state: "opening" });
  const [loadError, setLoadError] = useState<string | null>(null);
  /** Opens a new connection in place of the one that closed. */
  const reopen = useRef<(() => void) | null>(null);
  const connection = useRef<ReturnType<typeof connectRexTerminal> | null>(null);
  const grid = useRef<Grid | null>(null);
  const fontFamily = useClientSettings((settings) =>
    resolveTerminalFontPreference({
      advanced: false,
      code: settings.fontFamilyCode,
      terminal: settings.fontFamilyTerminal,
    }),
  );
  const fontSize = useClientSettings((settings) =>
    resolveTerminalFontSizePreference({
      advanced: false,
      code: settings.fontSizeCode,
      terminal: settings.fontSizeTerminal,
    }),
  );
  const font = useRef({ family: fontFamily, size: fontSize });

  const mountSurface = (element: HTMLDivElement) => {
    let disposed = false;
    let created: GhosttyTerminalSurface | null = null;
    const family = font.current.family.trim();
    void GhosttyTerminalSurface.create(element, {
      theme: terminalThemeFromApp(element),
      font: family.length > 0 ? { family, size: font.current.size } : { size: font.current.size },
      onData: (data) => {
        for (const chunk of chunkTerminalWrite(data)) {
          connection.current?.send({ type: "write", data: chunk });
        }
      },
      // Rex's write takes text only, so input that is not UTF-8 has nowhere to go.
      onBinary: () => {},
      // Rex's own terminal answers a program's queries. A second answer would be typed into the program.
      onReply: () => {},
      onResize: (cols, rows) => {
        grid.current = { cols, rows };
        connection.current?.send({ type: "resize", cols, rows });
      },
      onSelectionChange: () => {},
      beforeKey: () => true,
      onLinkActivate: (url) => {
        if (/^https?:\/\//i.test(url)) void ensureLocalApi().shell.openExternal(url);
      },
    })
      .then((terminal) => {
        if (disposed) return terminal.dispose();
        created = terminal;
        setSurface(terminal);
      })
      .catch(() => setLoadError("The terminal could not be loaded."));
    // The surface measures itself only when told to.
    const stopObserving = observeResize(element, () => created?.fit());
    const retheme = () => created?.setTheme(terminalThemeFromApp(element));
    window.addEventListener("focus", retheme);
    return () => {
      disposed = true;
      stopObserving();
      window.removeEventListener("focus", retheme);
      created?.dispose();
      grid.current = null;
      setSurface(null);
    };
  };

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- applies a changed font setting to the imperative terminal surface
  useEffect(() => {
    if (font.current.family === fontFamily && font.current.size === fontSize) return;
    font.current = { family: fontFamily, size: fontSize };
    const family = fontFamily.trim();
    void surface?.setFont(family.length > 0 ? { family, size: fontSize } : { size: fontSize });
  }, [surface, fontFamily, fontSize]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- holds a WebSocket to the actor's terminal for as long as this actor is shown
  useEffect(() => {
    if (surface === null) return;
    let retry: number | null = null;
    /** Losses in a row, which choose how long to wait before the next try. */
    let losses = 0;
    const start = () => {
      connection.current?.close();
      connection.current = connectRexTerminal({
        environmentId,
        name,
        surface,
        grid: () => grid.current,
        onLink: (next) => {
          // A terminal that opened earns a fresh set of tries.
          if (next.state === "live") losses = 0;
          setLink(next);
        },
        onLost: () => {
          const delay = RETRY_DELAYS_MS[losses];
          if (delay === undefined) return false;
          losses += 1;
          retry = window.setTimeout(() => {
            setLink({ state: "opening" });
            start();
          }, delay);
          return true;
        },
      });
    };
    reopen.current = () => {
      losses = 0;
      setLink({ state: "opening" });
      start();
    };
    start();
    return () => {
      if (retry !== null) window.clearTimeout(retry);
      reopen.current = null;
      connection.current?.close();
      connection.current = null;
    };
  }, [surface, environmentId, name]);

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-background">
        <WorkspacePageHeader electron={isElectron} className="relative bg-background">
          <WorkspaceBreadcrumb ariaLabel="Rex actor">
            <WorkspaceBreadcrumbItem current>
              <h1 className="truncate">{props.title}</h1>
            </WorkspaceBreadcrumbItem>
          </WorkspaceBreadcrumb>
          <span className="shrink-0 text-xs text-muted-foreground">Rex</span>
          <div className="min-w-0 flex-1" />
          <div
            className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground [-webkit-app-region:no-drag]"
            data-testid="rex-terminal-status"
          >
            {loadError !== null ? <span role="alert">{loadError}</span> : null}
            {link.state === "opening" ? <span>Opening…</span> : null}
            {link.state === "live" && link.exited ? <span>The program exited.</span> : null}
            {link.state === "live" && !link.owned ? (
              <>
                <span className="truncate">Another Rex client sets this terminal's size.</span>
                <Button
                  size="xs"
                  variant="outline"
                  onClick={() => {
                    connection.current?.send({ type: "own" });
                    if (grid.current !== null) {
                      connection.current?.send({ type: "resize", ...grid.current });
                    }
                    surface?.focus();
                  }}
                >
                  Take over
                </Button>
              </>
            ) : null}
            {link.state === "closed" ? (
              <>
                <span role="alert" className="truncate">
                  {link.message}
                </span>
                {link.retrying ? (
                  <span className="shrink-0">Trying again…</span>
                ) : (
                  <Button size="xs" variant="outline" onClick={() => reopen.current?.()}>
                    Open again
                  </Button>
                )}
              </>
            ) : null}
          </div>
        </WorkspacePageHeader>
        <div
          ref={mountSurface}
          aria-label={`${props.title} terminal`}
          data-testid="rex-terminal"
          data-rex-terminal-state={link.state}
          className="relative min-h-0 min-w-0 flex-1 overflow-hidden"
        />
      </div>
    </SidebarInset>
  );
}
