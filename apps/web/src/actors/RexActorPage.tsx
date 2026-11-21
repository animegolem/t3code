import type { EnvironmentId } from "@t3tools/contracts";
import { useParams } from "@tanstack/react-router";

import { useRexActors } from "./rexActors";
import { RexTerminalView } from "./RexTerminalView";

/** The page a Rex actor's picture opens. */
export function RexActorPage() {
  const environmentId = useParams({
    strict: false,
    select: (params) => params.rexEnvironmentId ?? "",
  });
  const name = useParams({ strict: false, select: (params) => params.rexActor ?? "" });
  const title = useRexActors().find(
    (actor) => actor.environmentId === environmentId && actor.name === name,
  )?.title;
  return (
    <RexTerminalView
      // A different actor gets a different terminal, not the last one's screen.
      key={`${environmentId}:${name}`}
      environmentId={environmentId as EnvironmentId}
      name={name}
      title={title ?? name}
    />
  );
}
