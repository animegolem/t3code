import {
  type DeviceHubAccess,
  resolveDeviceHubAccess,
} from "@t3tools/client-runtime/state/deviceHubAccess";
import type { EnvironmentId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { Atom, AtomRegistry } from "effect/reactivity";

import { connectionAtomRuntime } from "../connection/runtime";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { environmentSession } from "../state/session";

type ActorRoute = "/api/actor-pictures" | "/api/actor-dock" | "/api/rex-terminal";

const accessAtom = Atom.family((key: string) => {
  const [environmentId, route] = JSON.parse(key) as [EnvironmentId, ActorRoute];
  return connectionAtomRuntime
    .atom((get) => {
      const prepared = Option.getOrNull(
        get(environmentSession.preparedConnectionValueAtom(environmentId)),
      );
      if (prepared === null) return Effect.never;
      return resolveDeviceHubAccess({ prepared, hubBasePath: route });
    })
    .pipe(Atom.setIdleTTL(60_000), Atom.withLabel(`actor-access:${environmentId}:${route}`));
});

/**
 * Where one of the fork's routes is on an environment, and how to sign a request to it. Null when
 * the environment is not connected. A ticket can be single-use, so every request mints its own.
 */
export function freshActorAccess(
  environmentId: EnvironmentId,
  route: ActorRoute,
): Promise<DeviceHubAccess | null> {
  const atom = accessAtom(JSON.stringify([environmentId, route]));
  appAtomRegistry.refresh(atom);
  return Effect.runPromise(
    AtomRegistry.getResult(appAtomRegistry, atom, { suspendOnWaiting: true }).pipe(
      Effect.timeout("10 seconds"),
      Effect.orElseSucceed(() => null),
    ),
  );
}
