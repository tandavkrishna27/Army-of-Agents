import { useEffect, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
  DialogClose,
} from "@/components/ui/dialog";
import { ChevronLeft, ChevronRight, Download, X } from "lucide-react";
import type { IssueAttachment } from "@armyofagents/shared";

interface Props {
  images: IssueAttachment[];
  initialIndex: number;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function ImageGalleryModal({ images, initialIndex, open, onOpenChange }: Props) {
  const [index, setIndex] = useState(initialIndex);

  useEffect(() => {
    if (open) setIndex(Math.max(0, Math.min(initialIndex, images.length - 1)));
  }, [open, initialIndex, images]);

  useEffect(() => {
    if (!open) return;
    function handler(e: KeyboardEvent) {
      if (e.key === "ArrowRight") setIndex((i) => (i + 1) % images.length);
      else if (e.key === "ArrowLeft") setIndex((i) => (i - 1 + images.length) % images.length);
    }
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [open, images.length]);

  if (images.length === 0) return null;
  const current = images[index];
  if (!current) return null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        showCloseButton={false}
        className="max-w-none w-screen h-screen p-0 bg-black/95 border-0 translate-y-0 top-0 rounded-none"
      >
        <DialogTitle className="sr-only">{current.originalFilename}</DialogTitle>
        <DialogDescription className="sr-only">
          Image {index + 1} of {images.length}
        </DialogDescription>

        <div className="flex h-full flex-col">
          {/* Top bar */}
          <div className="flex items-center justify-between bg-black/60 px-4 py-2 text-white">
            <span className="text-sm">
              {current.originalFilename}{" "}
              <span className="text-white/60">
                ({index + 1} / {images.length})
              </span>
            </span>
            <div className="flex items-center gap-2">
              <a
                href={current.contentPath}
                download={current.originalFilename}
                className="rounded p-1 hover:bg-white/10"
                aria-label="Download image"
                onClick={(e) => e.stopPropagation()}
              >
                <Download className="size-4" aria-hidden="true" />
              </a>
              <DialogClose
                className="rounded p-1 hover:bg-white/10"
                aria-label="Close gallery"
              >
                <X className="size-4" aria-hidden="true" />
              </DialogClose>
            </div>
          </div>

          {/* Image area — click on curtain to close, click on image stays open */}
          <div
            data-testid="image-gallery-curtain"
            className="relative flex flex-1 items-center justify-center"
            onClick={() => onOpenChange(false)}
          >
            {images.length > 1 ? (
              <button
                type="button"
                aria-label="Previous image"
                className="absolute left-4 rounded bg-black/60 p-2 text-white hover:bg-black/80"
                onClick={(e) => {
                  e.stopPropagation();
                  setIndex((i) => (i - 1 + images.length) % images.length);
                }}
              >
                <ChevronLeft className="size-6" aria-hidden="true" />
              </button>
            ) : null}

            <img
              src={current.contentPath}
              alt={current.originalFilename ?? "attachment"}
              className="max-h-full max-w-full object-contain"
              onClick={(e) => e.stopPropagation()}
            />

            {images.length > 1 ? (
              <button
                type="button"
                aria-label="Next image"
                className="absolute right-4 rounded bg-black/60 p-2 text-white hover:bg-black/80"
                onClick={(e) => {
                  e.stopPropagation();
                  setIndex((i) => (i + 1) % images.length);
                }}
              >
                <ChevronRight className="size-6" aria-hidden="true" />
              </button>
            ) : null}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
