import type { ScopedThreadRef } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";

import { appAtomRegistry } from "../rpc/atomRegistry";

/** Which thread has the picture dialog open. Thread menus close as their command runs, so the root renders the dialog. */
export const actorPictureDialogThreadAtom = Atom.make<ScopedThreadRef | null>(null).pipe(
  Atom.keepAlive,
  Atom.withLabel("actor-picture:dialog-thread"),
);

export function openActorPictureDialog(threadRef: ScopedThreadRef): void {
  appAtomRegistry.set(actorPictureDialogThreadAtom, threadRef);
}

export function closeActorPictureDialog(): void {
  appAtomRegistry.set(actorPictureDialogThreadAtom, null);
}
