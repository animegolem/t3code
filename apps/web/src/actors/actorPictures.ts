import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import { withDeviceHubQuery } from "@t3tools/client-runtime/state/deviceHubAccess";
import type { EnvironmentId, ScopedThreadRef } from "@t3tools/contracts";
import { create } from "zustand";

import { freshActorAccess } from "./actorAccess";

const ACTOR_PICTURES_ROUTE = "/api/actor-pictures";
/** Mirrors the server's cap on one read. */
const ACTOR_PICTURES_MAX_PER_READ = 24;

const useActorPictureStore = create<{ readonly svgByThreadKey: Readonly<Record<string, string>> }>(
  () => ({ svgByThreadKey: {} }),
);

/** The stored picture, or undefined when the thread has none or it has not loaded. */
export function useActorPictureSvg(threadRef: ScopedThreadRef): string | undefined {
  return useActorPictureStore((state) => state.svgByThreadKey[scopedThreadKey(threadRef)]);
}

function remember(threadRef: ScopedThreadRef, svg: string | null) {
  const key = scopedThreadKey(threadRef);
  useActorPictureStore.setState((state) => {
    if ((state.svgByThreadKey[key] ?? null) === svg) return state;
    const { [key]: _previous, ...rest } = state.svgByThreadKey;
    return { svgByThreadKey: svg === null ? rest : { ...rest, [key]: svg } };
  });
}

function parsePictures(payload: unknown): ReadonlyMap<string, string> {
  const pictures = new Map<string, string>();
  if (typeof payload !== "object" || payload === null || !("pictures" in payload)) return pictures;
  if (!Array.isArray(payload.pictures)) return pictures;
  for (const entry of payload.pictures) {
    if (
      typeof entry === "object" &&
      entry !== null &&
      "threadId" in entry &&
      "svg" in entry &&
      typeof entry.threadId === "string" &&
      typeof entry.svg === "string"
    ) {
      pictures.set(entry.threadId, entry.svg);
    }
  }
  return pictures;
}

async function loadEnvironmentPictures(
  environmentId: EnvironmentId,
  threadRefs: readonly ScopedThreadRef[],
): Promise<void> {
  for (let start = 0; start < threadRefs.length; start += ACTOR_PICTURES_MAX_PER_READ) {
    const batch = threadRefs.slice(start, start + ACTOR_PICTURES_MAX_PER_READ);
    const access = await freshActorAccess(environmentId, ACTOR_PICTURES_ROUTE);
    if (access === null) return;
    const search = new URLSearchParams(batch.map((ref) => ["thread", ref.threadId]));
    const response = await fetch(withDeviceHubQuery(`${access.httpBase}?${search}`, access), {
      cache: "no-store",
      credentials: access.credentials ? "include" : "same-origin",
    });
    // An environment without the route, or one that refuses, leaves the default pictures in place.
    if (!response.ok) return;
    const pictures = parsePictures(await response.json());
    for (const ref of batch) remember(ref, pictures.get(ref.threadId) ?? null);
  }
}

/** Never rejects: a picture that cannot be fetched stays as it was. */
export async function loadActorPictures(threadRefs: readonly ScopedThreadRef[]): Promise<void> {
  const byEnvironment = new Map<EnvironmentId, ScopedThreadRef[]>();
  for (const ref of threadRefs) {
    byEnvironment.set(ref.environmentId, [...(byEnvironment.get(ref.environmentId) ?? []), ref]);
  }
  await Promise.all(
    [...byEnvironment].map(([environmentId, refs]) =>
      loadEnvironmentPictures(environmentId, refs).catch(() => undefined),
    ),
  );
}

/** Stores the picture, or clears it when `svg` is null. Rejects with a message to show. */
export async function saveActorPicture(
  threadRef: ScopedThreadRef,
  svg: string | null,
): Promise<void> {
  const access = await freshActorAccess(threadRef.environmentId, ACTOR_PICTURES_ROUTE);
  if (access === null) throw new Error("This thread's environment is not connected.");
  const search = new URLSearchParams({ thread: threadRef.threadId });
  const response = await fetch(withDeviceHubQuery(`${access.httpBase}?${search}`, access), {
    method: "POST",
    cache: "no-store",
    credentials: access.credentials ? "include" : "same-origin",
    headers: { "content-type": "image/svg+xml" },
    body: svg ?? "",
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(
      response.status === 404
        ? "This environment does not store pictures."
        : detail.length > 0 && detail.length < 200
          ? detail
          : `The picture was not saved (${response.status}).`,
    );
  }
  remember(threadRef, svg);
}
