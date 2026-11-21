/* oxlint-disable t3code/no-untranslated-copy -- the fork adds nothing to the translation catalogs, so its copy stays English */
import {
  closestCenter,
  DndContext,
  type DragEndEvent,
  PointerSensor,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import { restrictToParentElement } from "@dnd-kit/modifiers";
import { rectSortingStrategy, SortableContext, useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, ScopedThreadRef, ThreadId } from "@t3tools/contracts";
import { useNavigate, useParams } from "@tanstack/react-router";
import { type ComponentProps, useEffect, useState } from "react";

import {
  resolveSidebarReorderableThreadKeys,
  resolveThreadLastVisitedAt,
  resolveThreadStatusPill,
} from "../components/Sidebar.logic";
import { Popover, PopoverPopup, PopoverTrigger } from "../components/ui/popover";
import { stackedThreadToast, toastManager } from "../components/ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../components/ui/tooltip";
import { useNowMinute } from "../hooks/useNowMinute";
import { useThreadActionMenu } from "../hooks/useThreadActionMenu";
import { useThreadActions } from "../hooks/useThreadActions";
import { cn } from "../lib/utils";
import { useConnectedEnvironmentIds } from "../state/environments";
import {
  useDelegatedUnderParent,
  useProjects,
  useQuietThreadShells,
  useServerConfigs,
} from "../state/entities";
import { useUiStateStore } from "../uiStateStore";
import {
  defaultPictureSvg,
  holdActorOrder,
  minuteStart,
  pictureImageUrl,
  planActorMove,
  selectActors,
  splitActorDock,
} from "./actorPicture.logic";
import { loadActorPictures, useActorPictureSvg } from "./actorPictures";
import {
  loadRexActors,
  type RexActor,
  rexActorKey,
  useDockFileProblems,
  useRexActors,
} from "./rexActors";

type Actor = ReturnType<typeof useQuietThreadShells>[number];
/** One place in the dock: a pinned thread, or a terminal in Rex that the dock file names. */
type DockEntry =
  | { readonly kind: "thread"; readonly key: string; readonly actor: Actor }
  | { readonly kind: "rex"; readonly key: string; readonly actor: RexActor };

/** How long a dropped order stays on screen after its writes finish, while the server's own report arrives. */
const ACTOR_ORDER_HOLD_MS = 4000;
/** A press that travels less than this far is a click, not a drag. */
const ACTOR_DRAG_START_PX = 6;

type HeldActorOrder = {
  readonly order: readonly string[];
  /** The order keys this drop and any still-held earlier drop wrote, for planning the next drop before they are reported. */
  readonly orderKeys: ReadonlyMap<string, string>;
};

const keyOf = (actor: Pick<Actor, "environmentId" | "id">) =>
  scopedThreadKey(scopeThreadRef(actor.environmentId, actor.id));

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

type ActorTileProps = {
  readonly actor: Actor;
  readonly active: boolean;
  readonly projectCwd: string | null;
  readonly onOpen: (threadRef: ScopedThreadRef) => void;
  /** Set when the tile can be dragged to a new place in the pin order. */
  readonly drag?: {
    readonly ref: (node: HTMLElement | null) => void;
    readonly listeners: ComponentProps<"button">;
    readonly style: {
      readonly transform: string | undefined;
      readonly transition: string | undefined;
    };
    readonly dragging: boolean;
  };
};

function SortableActorTile(props: Omit<ActorTileProps, "drag"> & { readonly canDrag: boolean }) {
  const { canDrag, ...tile } = props;
  const { listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: keyOf(props.actor),
    // A tile that cannot be dragged still makes room for one that can.
    disabled: { draggable: !canDrag, droppable: false },
  });
  return (
    <ActorTile
      {...tile}
      drag={{
        ref: setNodeRef,
        listeners: listeners ?? {},
        style: { transform: CSS.Translate.toString(transform), transition },
        dragging: isDragging,
      }}
    />
  );
}

function ActorTile(props: ActorTileProps) {
  const { actor, active, onOpen, drag } = props;
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
            {...drag?.listeners}
            ref={drag?.ref}
            style={drag?.style}
            className={cn(
              "relative aspect-square w-full cursor-pointer rounded-[25%] outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
              active
                ? "ring-2 ring-sidebar-foreground/80"
                : "opacity-90 hover:opacity-100 hover:ring-1 hover:ring-sidebar-foreground/40",
              drag?.dragging && "z-10 cursor-grabbing opacity-100 shadow-lg",
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

function RexActorPicture(props: { readonly actor: RexActor; readonly className?: string }) {
  const { actor } = props;
  return (
    <img
      src={pictureImageUrl(
        actor.svg ?? defaultPictureSvg({ id: rexActorKey(actor), title: actor.title }),
      )}
      alt=""
      draggable={false}
      className={cn("rounded-[25%] object-cover", props.className)}
    />
  );
}

/** A Rex actor's place is its place in the dock file, so its tile is not dragged. */
function RexActorTile(props: {
  readonly actor: RexActor;
  readonly active: boolean;
  readonly onOpen: (actor: RexActor) => void;
}) {
  const { actor, active } = props;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            data-testid="rex-actor-tile"
            aria-label={`${actor.title}, in Rex`}
            aria-current={active ? "page" : undefined}
            className={cn(
              "relative aspect-square w-full cursor-pointer rounded-[25%] outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
              active
                ? "ring-2 ring-sidebar-foreground/80"
                : "opacity-90 hover:opacity-100 hover:ring-1 hover:ring-sidebar-foreground/40",
            )}
            onClick={() => props.onOpen(actor)}
          />
        }
      >
        <RexActorPicture actor={actor} className="size-full" />
        <span
          aria-hidden
          className="absolute -right-0.5 -bottom-0.5 rounded-sm bg-sidebar px-0.5 font-mono text-4xs leading-3 font-semibold text-sidebar-foreground ring-1 ring-sidebar-foreground/30"
        >
          {">_"}
        </span>
      </TooltipTrigger>
      <TooltipPopup side="bottom">{`${actor.title} · Rex`}</TooltipPopup>
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
  const connectedEnvironmentIds = useConnectedEnvironmentIds();
  const { reorderPinnedThread } = useThreadActions();
  const [held, setHeld] = useState<HeldActorOrder | null>(null);
  const [writingOrder, setWritingOrder] = useState(false);
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: ACTOR_DRAG_START_PX } }),
  );
  const navigate = useNavigate();
  const rexActors = useRexActors();
  const dockFileProblems = useDockFileProblems();
  const activeRexKey = useParams({
    strict: false,
    select: (params) =>
      params.rexEnvironmentId !== undefined && params.rexActor !== undefined
        ? rexActorKey({
            environmentId: params.rexEnvironmentId as EnvironmentId,
            name: params.rexActor,
          })
        : null,
  });
  const connectedEnvironmentsKey = JSON.stringify([...connectedEnvironmentIds].toSorted());
  const pinned = selectActors({
    threads,
    delegatedUnderParent,
    loadedEnvironmentIds: new Set(serverConfigs.keys()),
    now: minuteStart(nowMinute),
  });
  const actors = held === null ? pinned : holdActorOrder(pinned, keyOf, held.order);
  // Sorted, so that a new order alone does not look like a new set of actors.
  const actorRefsKey = JSON.stringify(
    pinned
      .map((actor) => [actor.environmentId, actor.id] as const)
      .toSorted((left, right) => left.join("\n").localeCompare(right.join("\n"))),
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

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- reads each connected environment's dock file when the set of environments changes or the window regains focus, since a person or an agent edits that file by hand
  useEffect(() => {
    const environmentIds = JSON.parse(connectedEnvironmentsKey) as EnvironmentId[];
    const load = () => void loadRexActors(environmentIds);
    load();
    window.addEventListener("focus", load);
    return () => window.removeEventListener("focus", load);
  }, [connectedEnvironmentsKey]);

  if (actors.length === 0 && rexActors.length === 0 && dockFileProblems.length === 0) return null;
  // Pinned threads come first, in pin order. Rex actors follow, in the order of the dock file.
  const entries: DockEntry[] = [
    ...actors.map((actor) => ({ kind: "thread" as const, key: keyOf(actor), actor })),
    ...rexActors.map((actor) => ({ kind: "rex" as const, key: rexActorKey(actor), actor })),
  ];
  const activeKey = activeRexKey ?? props.activeThreadKey;
  const split = splitActorDock(entries, (entry) => entry.key === activeKey);
  const overflow = split.overflow;
  // The open actor borrows the last place when its own is in the overflow, so that tile has no place in the order to drag from or to.
  const lastShown = split.shown.at(-1);
  const borrowed = lastShown !== undefined && entries[split.shown.length - 1] !== lastShown;
  const placed = borrowed ? split.shown.slice(0, -1) : split.shown;
  const sortable = placed.flatMap((entry) => (entry.kind === "thread" ? [entry.actor] : []));
  const shownRexActors = placed.flatMap((entry) => (entry.kind === "rex" ? [entry.actor] : []));
  const openRexActor = (actor: RexActor) =>
    void navigate({
      to: "/rex/$rexEnvironmentId/$rexActor",
      params: { rexEnvironmentId: actor.environmentId, rexActor: actor.name },
    });
  const { draggableThreadKeys: writableKeys } = resolveSidebarReorderableThreadKeys({
    threads: actors,
    serverConfigs,
    connectedEnvironmentIds,
  });
  const moveActor = (event: DragEndEvent) => {
    if (event.over === null) return;
    const pinOrderKeys = new Map<string, string | null | undefined>(
      threads.map((thread) => [keyOf(thread), thread.pinOrderKey ?? null]),
    );
    for (const [key, orderKey] of held?.orderKeys ?? []) pinOrderKeys.set(key, orderKey);
    const plan = planActorMove({
      order: actors.map(keyOf),
      movedKey: String(event.active.id),
      targetKey: String(event.over.id),
      pinOrderKeys,
      writableKeys,
    });
    if (plan === null) return;
    const drop: HeldActorOrder = {
      order: plan.order,
      orderKeys: new Map([
        ...(held?.orderKeys ?? []),
        ...plan.assignments.map(({ id, orderKey }) => [id, orderKey] as const),
      ]),
    };
    const release = () => setHeld((current) => (current === drop ? null : current));
    const actorByKey = new Map(actors.map((actor) => [keyOf(actor), actor]));
    setHeld(drop);
    setWritingOrder(true);
    void (async () => {
      for (const { id, orderKey } of plan.assignments) {
        const actor = actorByKey.get(id);
        if (actor === undefined) continue;
        const result = await reorderPinnedThread(
          scopeThreadRef(actor.environmentId, actor.id),
          orderKey,
        );
        if (result._tag === "Success") continue;
        setWritingOrder(false);
        release();
        if (isAtomCommandInterrupted(result)) return;
        const error = squashAtomCommandFailure(result);
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "The actors were not reordered",
            description: error instanceof Error ? error.message : "An error occurred.",
          }),
        );
        return;
      }
      setWritingOrder(false);
      window.setTimeout(release, ACTOR_ORDER_HOLD_MS);
    })();
  };
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
      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        modifiers={[restrictToParentElement]}
        onDragEnd={moveActor}
      >
        <SortableContext items={sortable.map(keyOf)} strategy={rectSortingStrategy}>
          {sortable.map((actor) => (
            <SortableActorTile
              key={keyOf(actor)}
              actor={actor}
              active={keyOf(actor) === props.activeThreadKey}
              projectCwd={projectCwd(actor)}
              onOpen={props.onOpen}
              // One drop's writes finish before the next drop is planned.
              canDrag={!writingOrder && writableKeys.has(keyOf(actor))}
            />
          ))}
        </SortableContext>
      </DndContext>
      {shownRexActors.map((actor) => (
        <RexActorTile
          key={rexActorKey(actor)}
          actor={actor}
          active={rexActorKey(actor) === activeKey}
          onOpen={openRexActor}
        />
      ))}
      {borrowed && lastShown?.kind === "thread" ? (
        <ActorTile
          key={lastShown.key}
          actor={lastShown.actor}
          active
          projectCwd={projectCwd(lastShown.actor)}
          onOpen={props.onOpen}
        />
      ) : null}
      {borrowed && lastShown?.kind === "rex" ? (
        <RexActorTile key={lastShown.key} actor={lastShown.actor} active onOpen={openRexActor} />
      ) : null}
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
              {overflow.map((entry) =>
                entry.kind === "thread" ? (
                  <ActorOverflowRow key={entry.key} actor={entry.actor} onOpen={props.onOpen} />
                ) : (
                  <button
                    key={entry.key}
                    type="button"
                    data-testid="actor-overflow-row"
                    className="flex w-full cursor-pointer items-center gap-2 rounded-md px-2 py-1 text-left text-sm outline-none hover:bg-accent focus-visible:bg-accent"
                    onClick={() => openRexActor(entry.actor)}
                  >
                    <RexActorPicture actor={entry.actor} className="size-5 shrink-0" />
                    <span className="min-w-0 flex-1 truncate">{entry.actor.title}</span>
                    <span className="text-xs text-muted-foreground">Rex</span>
                  </button>
                ),
              )}
            </div>
          </PopoverPopup>
        </Popover>
      ) : null}
      {dockFileProblems.length > 0 ? (
        <Popover>
          <PopoverTrigger
            render={
              <button
                type="button"
                data-testid="dock-file-problems"
                aria-label={`${dockFileProblems.length} problems in the dock file`}
                className="flex aspect-square w-full cursor-pointer items-center justify-center rounded-[25%] border border-dashed border-destructive/60 text-sm font-semibold text-destructive outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
              />
            }
          >
            !
          </PopoverTrigger>
          <PopoverPopup side="bottom" align="start">
            <div className="flex max-h-80 w-72 flex-col gap-1 overflow-y-auto text-sm">
              <p className="font-medium">actors/dock.kdl</p>
              {dockFileProblems.map((problem) => (
                <p key={`${problem.environmentId}:${problem.line}:${problem.message}`}>
                  Line {problem.line}: {problem.message}
                </p>
              ))}
            </div>
          </PopoverPopup>
        </Popover>
      ) : null}
    </div>
  );
}
