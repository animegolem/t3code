import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentId, ScopedThreadRef, ThreadId } from "@t3tools/contracts";
import { useEffect } from "react";

import { resolveThreadLastVisitedAt, resolveThreadStatusPill } from "../components/Sidebar.logic";
import { Popover, PopoverPopup, PopoverTrigger } from "../components/ui/popover";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../components/ui/tooltip";
import { useNowMinute } from "../hooks/useNowMinute";
import { useThreadActionMenu } from "../hooks/useThreadActionMenu";
import { cn } from "../lib/utils";
import {
  useDelegatedUnderParent,
  useProjects,
  useQuietThreadShells,
  useServerConfigs,
} from "../state/entities";
import { useUiStateStore } from "../uiStateStore";
import {
  defaultPictureSvg,
  pictureImageUrl,
  selectActors,
  splitActorDock,
} from "./actorPicture.logic";
import { loadActorPictures, useActorPictureSvg } from "./actorPictures";

type Actor = ReturnType<typeof useQuietThreadShells>[number];

function ActorPicture(props: { readonly actor: Actor; readonly className?: string }) {
  const { actor } = props;
  const stored = useActorPictureSvg(scopeThreadRef(actor.environmentId, actor.id));
  return (
    <img
      src={pictureImageUrl(stored ?? defaultPictureSvg(actor))}
      alt=""
      draggable={false}
      className={cn("rounded-[25%] object-cover", props.className)}
    />
  );
}

function useActorStatus(actor: Actor) {
  const threadKey = scopedThreadKey(scopeThreadRef(actor.environmentId, actor.id));
  const localLastVisitedAt = useUiStateStore((state) => state.threadLastVisitedAtById[threadKey]);
  return resolveThreadStatusPill({
    thread: {
      ...actor,
      lastVisitedAt: resolveThreadLastVisitedAt(actor.lastVisitedAt, localLastVisitedAt),
    },
  });
}

function ActorTile(props: {
  readonly actor: Actor;
  readonly active: boolean;
  readonly projectCwd: string | null;
  readonly onOpen: (threadRef: ScopedThreadRef) => void;
}) {
  const { actor, active, onOpen } = props;
  const threadRef = scopeThreadRef(actor.environmentId, actor.id);
  const status = useActorStatus(actor);
  const { openMenu } = useThreadActionMenu({
    threadRef,
    projectCwd: props.projectCwd,
    // The dock has no title to edit in place; the open thread's header does.
    onStartRename: () => onOpen(threadRef),
    canShareWithGuest: false,
  });
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            data-testid="actor-tile"
            aria-label={status ? `${actor.title}, ${status.label}` : actor.title}
            aria-current={active ? "page" : undefined}
            className={cn(
              "relative aspect-square w-full cursor-pointer rounded-[25%] outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
              active
                ? "ring-2 ring-sidebar-foreground/80"
                : "opacity-90 hover:opacity-100 hover:ring-1 hover:ring-sidebar-foreground/40",
            )}
            onClick={() => onOpen(threadRef)}
            onContextMenu={(event) => {
              event.preventDefault();
              openMenu({ x: event.clientX, y: event.clientY });
            }}
          />
        }
      >
        <ActorPicture actor={actor} className="size-full" />
        {status ? (
          <span
            aria-hidden
            className={cn(
              "absolute -right-0.5 -bottom-0.5 size-2.5 rounded-full ring-2 ring-sidebar",
              status.dotClass,
            )}
          />
        ) : null}
      </TooltipTrigger>
      <TooltipPopup side="bottom">
        {status ? `${actor.title} · ${status.label}` : actor.title}
      </TooltipPopup>
    </Tooltip>
  );
}

function ActorOverflowRow(props: {
  readonly actor: Actor;
  readonly onOpen: (threadRef: ScopedThreadRef) => void;
}) {
  const { actor } = props;
  const status = useActorStatus(actor);
  return (
    <button
      type="button"
      data-testid="actor-overflow-row"
      className="flex w-full cursor-pointer items-center gap-2 rounded-md px-2 py-1 text-left text-sm outline-none hover:bg-accent focus-visible:bg-accent"
      onClick={() => props.onOpen(scopeThreadRef(actor.environmentId, actor.id))}
    >
      <ActorPicture actor={actor} className="size-5 shrink-0" />
      <span className="min-w-0 flex-1 truncate">{actor.title}</span>
      {status ? (
        <span aria-label={status.label} className={cn("size-2 rounded-full", status.dotClass)} />
      ) : null}
    </button>
  );
}

/** Pinned threads as a grid of pictures. It ignores the project filter, so every actor stays in reach. */
export function ActorDock(props: {
  readonly activeThreadKey: string | null;
  readonly onOpen: (threadRef: ScopedThreadRef) => void;
}) {
  const threads = useQuietThreadShells();
  const delegatedUnderParent = useDelegatedUnderParent();
  const serverConfigs = useServerConfigs();
  const projects = useProjects();
  // A snooze that ends pulls its thread back into the dock on the next minute.
  const nowMinute = useNowMinute();
  const actors = selectActors({
    threads,
    delegatedUnderParent,
    loadedEnvironmentIds: new Set(serverConfigs.keys()),
    now: nowMinute,
  });
  const keyOf = (actor: Actor) => scopedThreadKey(scopeThreadRef(actor.environmentId, actor.id));
  const actorRefsKey = JSON.stringify(
    actors.map((actor) => [actor.environmentId, actor.id] as const),
  );

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- fetches pictures from each actor's environment when the set of actors changes or the window regains focus, since an agent can rewrite its own picture file
  useEffect(() => {
    // The key carries the refs so that only a change in who the actors are refetches.
    const threadRefs = (JSON.parse(actorRefsKey) as ReadonlyArray<[EnvironmentId, ThreadId]>).map(
      ([environmentId, threadId]) => scopeThreadRef(environmentId, threadId),
    );
    if (threadRefs.length === 0) return;
    const load = () => void loadActorPictures(threadRefs);
    load();
    window.addEventListener("focus", load);
    return () => window.removeEventListener("focus", load);
  }, [actorRefsKey]);

  if (actors.length === 0) return null;
  const { shown, overflow } = splitActorDock(
    actors,
    (actor) => keyOf(actor) === props.activeThreadKey,
  );
  const projectCwd = (actor: Actor) =>
    actor.worktreePath ??
    projects.find(
      (project) => project.environmentId === actor.environmentId && project.id === actor.projectId,
    )?.workspaceRoot ??
    null;
  return (
    <div
      role="toolbar"
      aria-label="Actors"
      data-testid="actor-dock"
      className="grid grid-cols-[repeat(auto-fill,minmax(2rem,1fr))] gap-1.5 px-2 pt-1 pb-2"
    >
      {shown.map((actor) => (
        <ActorTile
          key={keyOf(actor)}
          actor={actor}
          active={keyOf(actor) === props.activeThreadKey}
          projectCwd={projectCwd(actor)}
          onOpen={props.onOpen}
        />
      ))}
      {overflow.length > 0 ? (
        <Popover>
          <PopoverTrigger
            render={
              <button
                type="button"
                data-testid="actor-overflow"
                aria-label={`${overflow.length} more actors`}
                className="flex aspect-square w-full cursor-pointer items-center justify-center rounded-[25%] border border-dashed border-sidebar-foreground/30 text-2xs font-medium text-sidebar-muted-foreground outline-none hover:text-sidebar-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
              />
            }
          >
            +{overflow.length}
          </PopoverTrigger>
          <PopoverPopup side="bottom" align="start">
            <div className="flex max-h-80 w-56 flex-col gap-px overflow-y-auto">
              {overflow.map((actor) => (
                <ActorOverflowRow key={keyOf(actor)} actor={actor} onOpen={props.onOpen} />
              ))}
            </div>
          </PopoverPopup>
        </Popover>
      ) : null}
    </div>
  );
}
