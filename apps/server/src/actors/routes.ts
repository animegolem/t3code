import * as Layer from "effect/Layer";

import * as ActorPictures from "./ActorPictures.ts";
import * as DockFile from "./DockFile.ts";
import * as RexTerminal from "./RexTerminal.ts";

/** Every route the fork adds, so the server's route list names the fork once. */
export const layer = Layer.mergeAll(ActorPictures.layer, DockFile.layer, RexTerminal.layer);
