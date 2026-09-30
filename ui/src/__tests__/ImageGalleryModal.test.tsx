import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ImageGalleryModal } from "../components/ImageGalleryModal";

const mockImages = [
  { id: "1", contentType: "image/png", originalFilename: "first.png", contentPath: "/blobs/1" },
  { id: "2", contentType: "image/jpeg", originalFilename: "second.jpg", contentPath: "/blobs/2" },
  { id: "3", contentType: "image/gif", originalFilename: "third.gif", contentPath: "/blobs/3" },
] as any[];

describe("ImageGalleryModal", () => {
  it("renders the initial image filename and counter", () => {
    render(<ImageGalleryModal images={mockImages} initialIndex={0} open onOpenChange={() => {}} />);
    // The visible top-bar span contains both filename and counter
    expect(screen.getByText(/\(1 \/ 3\)/)).toBeInTheDocument();
    // The img alt text uses originalFilename
    expect(screen.getByRole("img", { name: /first\.png/ })).toBeInTheDocument();
  });

  it("advances on ArrowRight keyboard event", () => {
    render(<ImageGalleryModal images={mockImages} initialIndex={0} open onOpenChange={() => {}} />);
    fireEvent.keyDown(window, { key: "ArrowRight" });
    expect(screen.getByRole("img", { name: /second\.jpg/ })).toBeInTheDocument();
  });

  it("wraps to first when ArrowRight on last image", () => {
    render(<ImageGalleryModal images={mockImages} initialIndex={2} open onOpenChange={() => {}} />);
    fireEvent.keyDown(window, { key: "ArrowRight" });
    expect(screen.getByRole("img", { name: /first\.png/ })).toBeInTheDocument();
  });

  it("calls onOpenChange(false) when close button clicked", async () => {
    const user = userEvent.setup();
    const onOpenChange = vi.fn();
    render(<ImageGalleryModal images={mockImages} initialIndex={0} open onOpenChange={onOpenChange} />);
    const close = screen.getByRole("button", { name: /close gallery/i });
    await user.click(close);
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("renders nothing when images is empty", () => {
    const { container } = render(<ImageGalleryModal images={[]} initialIndex={0} open onOpenChange={() => {}} />);
    expect(container.querySelector("img")).toBeNull();
  });

  it("calls onOpenChange(false) when curtain is clicked", async () => {
    const user = userEvent.setup();
    const onOpenChange = vi.fn();
    render(<ImageGalleryModal images={mockImages} initialIndex={0} open onOpenChange={onOpenChange} />);
    const curtain = screen.getByTestId("image-gallery-curtain");
    await user.click(curtain);
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("does NOT call onOpenChange when image itself is clicked", async () => {
    const user = userEvent.setup();
    const onOpenChange = vi.fn();
    render(<ImageGalleryModal images={mockImages} initialIndex={0} open onOpenChange={onOpenChange} />);
    const img = screen.getByRole("img");
    await user.click(img);
    expect(onOpenChange).not.toHaveBeenCalled();
  });

  it("navigates backward on ArrowLeft (wraps from first to last)", () => {
    render(<ImageGalleryModal images={mockImages} initialIndex={0} open onOpenChange={() => {}} />);
    fireEvent.keyDown(window, { key: "ArrowLeft" });
    expect(screen.getByRole("img", { name: /third\.gif/ })).toBeInTheDocument();
  });
});
