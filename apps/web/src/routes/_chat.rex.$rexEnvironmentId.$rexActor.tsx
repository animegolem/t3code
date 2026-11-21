import { createFileRoute } from "@tanstack/react-router";

import { RexActorPage } from "../actors/RexActorPage";

// The params are not named environmentId or threadId: the chat layout reads those as a thread.
export const Route = createFileRoute("/_chat/rex/$rexEnvironmentId/$rexActor")({
  component: RexActorPage,
});
