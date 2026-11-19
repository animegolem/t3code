import type { ScopedThreadRef } from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import { useRef, useState } from "react";

import { Button } from "../components/ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../components/ui/dialog";
import { Input } from "../components/ui/input";
import { Toggle, ToggleGroup } from "../components/ui/toggle-group";
import { cn } from "../lib/utils";
import { deriveProjectIdentity } from "../projectIdentity";
import { useThreadShell } from "../state/entities";
import {
  ACTOR_PICTURE_COLORS,
  ACTOR_PICTURE_IMAGE_SIZE,
  actorPictureColor,
  actorPictureText,
  defaultPictureSvg,
  imagePictureSvg,
  monogramPictureSvg,
  pictureImageUrl,
} from "./actorPicture.logic";
import { actorPictureDialogThreadAtom, closeActorPictureDialog } from "./actorPictureDialogState";
import { saveActorPicture, useActorPictureSvg } from "./actorPictures";

const close = closeActorPictureDialog;

// Cropped to a centred square and scaled down, so any photo fits the picture size cap.
async function squareImageDataUrl(file: File): Promise<string | null> {
  const bitmap = await createImageBitmap(file).catch(() => null);
  if (bitmap === null) return null;
  const canvas = document.createElement("canvas");
  canvas.width = ACTOR_PICTURE_IMAGE_SIZE;
  canvas.height = ACTOR_PICTURE_IMAGE_SIZE;
  const context = canvas.getContext("2d");
  if (context === null) return null;
  const side = Math.min(bitmap.width, bitmap.height);
  context.drawImage(
    bitmap,
    (bitmap.width - side) / 2,
    (bitmap.height - side) / 2,
    side,
    side,
    0,
    0,
    ACTOR_PICTURE_IMAGE_SIZE,
    ACTOR_PICTURE_IMAGE_SIZE,
  );
  bitmap.close();
  const webp = canvas.toDataURL("image/webp", 0.9);
  // A browser that cannot encode WebP answers with a PNG.
  return webp.startsWith("data:image/webp") ? webp : canvas.toDataURL("image/png");
}

export function ActorPictureDialogHost() {
  const threadRef = useAtomValue(actorPictureDialogThreadAtom);
  return (
    <Dialog open={threadRef !== null} onOpenChange={(open) => (open ? undefined : close())}>
      <DialogPopup>
        {/* The popup mounts per open, so the draft below starts fresh each time. */}
        {threadRef === null ? null : <ActorPictureDialogBody threadRef={threadRef} />}
      </DialogPopup>
    </Dialog>
  );
}

function ActorPictureDialogBody({ threadRef }: { readonly threadRef: ScopedThreadRef }) {
  const thread = useThreadShell(threadRef);
  const stored = useActorPictureSvg(threadRef);
  const title = thread?.title ?? "";
  const [mode, setMode] = useState<"letters" | "image">("letters");
  const [letters, setLetters] = useState(() => deriveProjectIdentity(title).monogram);
  const [background, setBackground] = useState<string>(
    () => actorPictureColor(threadRef.threadId).background,
  );
  const [imageSvg, setImageSvg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  const text = actorPictureText(letters);
  const draft =
    mode === "image" ? imageSvg : text.length > 0 ? monogramPictureSvg(text, background) : null;
  const preview = draft ?? stored ?? defaultPictureSvg({ id: threadRef.threadId, title });

  const save = (svg: string | null) => {
    setSaving(true);
    setError(null);
    void saveActorPicture(threadRef, svg).then(close, (cause: unknown) => {
      setSaving(false);
      setError(cause instanceof Error ? cause.message : "The picture was not saved.");
    });
  };
  const chooseImage = (file: File | undefined) => {
    if (file === undefined) return;
    setError(null);
    void squareImageDataUrl(file).then((dataUrl) => {
      const svg = dataUrl === null ? null : imagePictureSvg(dataUrl);
      setImageSvg(svg);
      if (svg === null) setError("That file could not be read as an image.");
    });
  };

  return (
    <>
      <DialogHeader>
        <DialogTitle>Set picture</DialogTitle>
        <DialogDescription>{title}</DialogDescription>
      </DialogHeader>
      <DialogPanel>
        <div className="flex flex-col gap-4">
          <ToggleGroup
            aria-label="Picture type"
            variant="segmented"
            value={[mode]}
            onValueChange={(next) => {
              const value = next[0];
              if (value === "letters" || value === "image") setMode(value);
            }}
          >
            <Toggle value="letters">Letters</Toggle>
            <Toggle value="image">Image</Toggle>
          </ToggleGroup>
          <div className="flex items-center gap-4">
            <img
              src={pictureImageUrl(preview)}
              alt="Picture preview"
              className="size-16 shrink-0 rounded-[25%] object-cover"
            />
            {mode === "letters" ? (
              <div className="flex-1 space-y-2">
                <Input
                  value={letters}
                  aria-label="Letters"
                  autoComplete="off"
                  onChange={(event) => setLetters(event.currentTarget.value)}
                />
                <p className="text-xs text-muted-foreground">
                  One or two characters. An emoji counts as one.
                </p>
              </div>
            ) : (
              <div className="flex-1 space-y-2">
                <input
                  ref={fileInput}
                  type="file"
                  accept="image/*"
                  aria-label="Image file"
                  className="sr-only"
                  onChange={(event) => chooseImage(event.currentTarget.files?.[0])}
                />
                <Button variant="outline" onClick={() => fileInput.current?.click()}>
                  Choose image…
                </Button>
                <p className="text-xs text-muted-foreground">
                  The image is cropped to a square and scaled down.
                </p>
              </div>
            )}
          </div>
          {mode === "letters" ? (
            <div className="flex flex-wrap gap-1.5" role="group" aria-label="Picture colour">
              {ACTOR_PICTURE_COLORS.map((option) => (
                <button
                  key={option.id}
                  type="button"
                  aria-label={option.label}
                  aria-pressed={background === option.background}
                  className={cn(
                    "flex size-6 items-center justify-center rounded-full border border-transparent outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
                    background === option.background && "border-foreground/64",
                  )}
                  onClick={() => setBackground(option.background)}
                >
                  <span
                    className="size-4 rounded-full"
                    style={{ backgroundColor: option.background }}
                  />
                </button>
              ))}
            </div>
          ) : null}
          {error === null ? null : (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
        </div>
      </DialogPanel>
      <DialogFooter>
        {stored === undefined ? null : (
          <Button variant="outline" disabled={saving} onClick={() => save(null)}>
            Use default
          </Button>
        )}
        <Button variant="outline" onClick={close}>
          Cancel
        </Button>
        <Button disabled={saving || draft === null} onClick={() => save(draft)}>
          Save picture
        </Button>
      </DialogFooter>
    </>
  );
}
