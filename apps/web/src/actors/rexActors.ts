import { withDeviceHubQuery } from "@t3tools/client-runtime/state/deviceHubAccess";
import type { EnvironmentId } from "@t3tools/contracts";
import { create } from "zustand";

import { freshActorAccess } from "./actorAccess";

/** An actor that runs in Rex, as its environment's dock file names it. */
export interface RexActor {
  readonly environmentId: EnvironmentId;
  readonly name: string;
  readonly title: string;
  /** The picture the dock file names, or null for the default picture. */
  readonly svg: string | null;
}

export interface DockFileProblem {
  readonly environmentId: EnvironmentId;
  readonly line: number;
  readonly message: string;
}

interface RexActorState {
  readonly actors: readonly RexActor[];
  readonly problems: readonly DockFileProblem[];
}

const useRexActorStore = create<RexActorState>(() => ({ actors: [], problems: [] }));

export const rexActorKey = (actor: Pick<RexActor, "environmentId" | "name">) =>
  `rex:${actor.environmentId}:${actor.name}`;

/** Every connected environment's Rex actors, in the order each dock file lists them. */
export function useRexActors(): readonly RexActor[] {
  return useRexActorStore((state) => state.actors);
}

export function useDockFileProblems(): readonly DockFileProblem[] {
  return useRexActorStore((state) => state.problems);
}

function parseDock(environmentId: EnvironmentId, payload: unknown): RexActorState {
  const actors: RexActor[] = [];
  const problems: DockFileProblem[] = [];
  if (typeof payload !== "object" || payload === null) return { actors, problems };
  const rex = "rex" in payload && Array.isArray(payload.rex) ? payload.rex : [];
  for (const entry of rex) {
    if (
      typeof entry === "object" &&
      entry !== null &&
      "name" in entry &&
      typeof entry.name === "string" &&
      "title" in entry &&
      typeof entry.title === "string"
    ) {
      const svg = "svg" in entry && typeof entry.svg === "string" ? entry.svg : null;
      actors.push({ environmentId, name: entry.name, title: entry.title, svg });
    }
  }
  const reported = "problems" in payload && Array.isArray(payload.problems) ? payload.problems : [];
  for (const entry of reported) {
    if (
      typeof entry === "object" &&
      entry !== null &&
      "line" in entry &&
      typeof entry.line === "number" &&
      "message" in entry &&
      typeof entry.message === "string"
    ) {
      problems.push({ environmentId, line: entry.line, message: entry.message });
    }
  }
  return { actors, problems };
}

/** Null when the environment could not be asked, which leaves what was known about it in place. */
async function loadEnvironmentDock(environmentId: EnvironmentId): Promise<RexActorState | null> {
  const access = await freshActorAccess(environmentId, "/api/actor-dock");
  if (access === null) return null;
  const response = await fetch(withDeviceHubQuery(access.httpBase, access), {
    cache: "no-store",
    credentials: access.credentials ? "include" : "same-origin",
  });
  // An environment that runs stock T3 Code has no dock file and no Rex actors.
  if (response.status === 404) return { actors: [], problems: [] };
  if (!response.ok) return null;
  return parseDock(environmentId, await response.json());
}

const sameState = (left: RexActorState, right: RexActorState) =>
  JSON.stringify(left) === JSON.stringify(right);

/** Reads each connected environment's dock file. Never rejects. */
export async function loadRexActors(environmentIds: readonly EnvironmentId[]): Promise<void> {
  const loaded = await Promise.all(
    environmentIds.map((environmentId) => loadEnvironmentDock(environmentId).catch(() => null)),
  );
  const connected = new Set<string>(environmentIds);
  useRexActorStore.setState((state) => {
    const next: RexActorState = {
      actors: environmentIds.flatMap((environmentId, index) => {
        const dock = loaded[index];
        // A file that stopped parsing mid-edit lists nobody. The actors it listed before stay.
        return dock == null || (dock.actors.length === 0 && dock.problems.length > 0)
          ? state.actors.filter((actor) => actor.environmentId === environmentId)
          : dock.actors;
      }),
      problems: environmentIds.flatMap((environmentId, index) => {
        const dock = loaded[index];
        return dock == null
          ? state.problems.filter((problem) => problem.environmentId === environmentId)
          : dock.problems;
      }),
    };
    // An environment that is no longer connected has no terminal to open.
    const kept = {
      actors: next.actors.filter((actor) => connected.has(actor.environmentId)),
      problems: next.problems.filter((problem) => connected.has(problem.environmentId)),
    };
    return sameState(state, kept) ? state : kept;
  });
}

/** The WebSocket address of a Rex actor's terminal, signed for one connection. */
export async function rexTerminalUrl(
  environmentId: EnvironmentId,
  name: string,
): Promise<string | null> {
  const access = await freshActorAccess(environmentId, "/api/rex-terminal");
  if (access === null) return null;
  return withDeviceHubQuery(`${access.wsBase}?${new URLSearchParams({ actor: name })}`, access);
}
