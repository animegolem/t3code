import { effectiveSnoozed } from "@t3tools/client-runtime/state/thread-settled";

import {
  filterSidebarV2VisibleThreads,
  resolveSidebarThreadSection,
  sortPinnedThreadsForSidebar,
} from "../components/Sidebar.logic";
import { deriveProjectIdentity } from "../projectIdentity";

const ACTOR_DOCK_LIMIT = 20;
/** Mirrors the server's cap; a larger picture is refused there. */
const ACTOR_PICTURE_MAX_BYTES = 128 * 1024;
export const ACTOR_PICTURE_IMAGE_SIZE = 128;

export const ACTOR_PICTURE_COLORS = [
  { id: "slate", label: "Slate", background: "#475569" },
  { id: "red", label: "Red", background: "#dc2626" },
  { id: "orange", label: "Orange", background: "#ea580c" },
  { id: "amber", label: "Amber", background: "#b45309" },
  { id: "green", label: "Green", background: "#15803d" },
  { id: "teal", label: "Teal", background: "#0f766e" },
  { id: "sky", label: "Sky", background: "#0369a1" },
  { id: "blue", label: "Blue", background: "#2563eb" },
  { id: "violet", label: "Violet", background: "#7c3aed" },
  { id: "pink", label: "Pink", background: "#be185d" },
] as const;

export type ActorPictureColor = (typeof ACTOR_PICTURE_COLORS)[number];

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/** A thread keeps its colour through renames, so the colour comes from its ID. */
export function actorPictureColor(threadId: string): ActorPictureColor {
  let index = 0;
  for (const character of threadId) {
    index = (index * 31 + (character.codePointAt(0) ?? 0)) % ACTOR_PICTURE_COLORS.length;
  }
  return ACTOR_PICTURE_COLORS[index] ?? ACTOR_PICTURE_COLORS[0];
}

/** At most two characters as a person counts them, so one emoji is one. */
export function actorPictureText(input: string): string {
  return Array.from(graphemes.segment(input.normalize("NFKC").trim()), (part) => part.segment)
    .slice(0, 2)
    .join("");
}

const escapeXml = (value: string) =>
  value.replace(
    /[&<>"']/g,
    (character) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[character] ??
      character,
  );

export function monogramPictureSvg(text: string, background: string): string {
  const shown = actorPictureText(text);
  const fontSize = Array.from(graphemes.segment(shown)).length > 1 ? 26 : 34;
  return [
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">',
    `<rect width="64" height="64" fill="${escapeXml(background)}"/>`,
    `<text x="32" y="32" text-anchor="middle" dominant-baseline="central" font-family="ui-sans-serif, system-ui, sans-serif" font-size="${fontSize}" font-weight="700" fill="#ffffff">${escapeXml(shown)}</text>`,
    "</svg>",
  ].join("");
}

const IMAGE_DATA_URL = /^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/]+=*$/;

/** Null when the image is not one this module made, or does not fit the size cap. */
export function imagePictureSvg(dataUrl: string): string | null {
  if (!IMAGE_DATA_URL.test(dataUrl)) return null;
  const svg = [
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">',
    `<image href="${dataUrl}" width="64" height="64" preserveAspectRatio="xMidYMid slice"/>`,
    "</svg>",
  ].join("");
  return svg.length > ACTOR_PICTURE_MAX_BYTES ? null : svg;
}

export function defaultPictureSvg(thread: { readonly id: string; readonly title: string }): string {
  return monogramPictureSvg(
    deriveProjectIdentity(thread.title).monogram,
    actorPictureColor(thread.id).background,
  );
}

/** An image element runs no script and loads nothing from a picture, so any stored SVG is safe to show. */
export function pictureImageUrl(svg: string): string {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

type ActorThread = Parameters<typeof filterSidebarV2VisibleThreads>[0][number] &
  Parameters<typeof effectiveSnoozed>[0] &
  Parameters<typeof sortPinnedThreadsForSidebar>[0][number] & {
    readonly pinnedAt?: string | null | undefined;
    readonly settledOverride?: string | null | undefined;
  };

/** The threads upstream's sidebar lists as pinned when no project filter is set. */
export function selectActors<T extends ActorThread>(input: {
  readonly threads: readonly T[];
  readonly delegatedUnderParent: ReadonlySet<string>;
  readonly loadedEnvironmentIds: ReadonlySet<string>;
  readonly now: string;
}): T[] {
  const pinned = filterSidebarV2VisibleThreads(
    input.threads,
    null,
    input.delegatedUnderParent,
  ).filter((thread) => {
    const loaded = input.loadedEnvironmentIds.has(thread.environmentId);
    return (
      resolveSidebarThreadSection({
        snoozed: loaded && effectiveSnoozed(thread, { now: input.now }),
        settled: loaded && thread.settledOverride === "settled",
        pinned: thread.pinnedAt != null,
      }) === "pinned"
    );
  });
  return sortPinnedThreadsForSidebar(pinned);
}

/** The open actor always gets a place in the dock, taking the last one when it would overflow. */
export function splitActorDock<T>(
  actors: readonly T[],
  isActive: (actor: T) => boolean,
  limit: number = ACTOR_DOCK_LIMIT,
): { readonly shown: readonly T[]; readonly overflow: readonly T[] } {
  if (actors.length <= limit) return { shown: actors, overflow: [] };
  const shown = actors.slice(0, limit);
  const overflow = actors.slice(limit);
  const activeIndex = overflow.findIndex(isActive);
  if (activeIndex === -1) return { shown, overflow };
  const [active] = overflow.splice(activeIndex, 1);
  const displaced = shown.pop();
  if (active !== undefined) shown.push(active);
  if (displaced !== undefined) overflow.unshift(displaced);
  return { shown, overflow };
}
