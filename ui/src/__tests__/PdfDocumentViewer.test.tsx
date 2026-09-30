import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";

const pdfMockState = vi.hoisted(() => ({ failLoad: false }));

vi.mock("react-pdf", async () => {
  const { useEffect } = await vi.importActual<typeof import("react")>("react");

  return {
    Document: ({
      children,
      onLoadSuccess,
      onLoadError,
    }: {
      children: React.ReactNode;
      onLoadSuccess: (document: { numPages: number }) => void;
      onLoadError: () => void;
    }) => {
      useEffect(() => {
        if (pdfMockState.failLoad) {
          onLoadError();
          return;
        }
        onLoadSuccess({ numPages: 3 });
      }, [onLoadError, onLoadSuccess]);

      return <div data-testid="react-pdf-document">{children}</div>;
    },
    Page: ({ pageNumber, width }: { pageNumber: number; width?: number }) => (
      <div data-testid="react-pdf-page" data-page-width={width}>
        page {pageNumber}
      </div>
    ),
    pdfjs: { GlobalWorkerOptions: { workerSrc: "" } },
  };
});
vi.mock("react-pdf/dist/Page/TextLayer.css", () => ({}));
vi.mock("react-pdf/dist/Page/AnnotationLayer.css", () => ({}));

import { PdfDocumentViewer } from "../components/viewers/PdfDocumentViewer";

describe("PdfDocumentViewer", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("renders a loaded PDF document with filename, page controls, and download link", async () => {
    pdfMockState.failLoad = false;

    render(
      <PdfDocumentViewer
        fileUrl="/uploads/sample.pdf"
        filename="sample.pdf"
        className="custom-viewer"
      />,
    );

    expect(screen.getByTestId("pdf-document-viewer")).toBeInTheDocument();
    expect(screen.getByText("sample.pdf")).toBeInTheDocument();
    expect(await screen.findByTestId("react-pdf-document")).toBeInTheDocument();
    expect(await screen.findByTestId("react-pdf-page")).toHaveTextContent("page 1");
    expect(await screen.findByText("1 / 3")).toBeInTheDocument();
    expect(screen.getByLabelText("Previous page")).toBeInTheDocument();
    expect(screen.getByLabelText("Next page")).toBeInTheDocument();

    const downloadLink = screen.getByRole("link", { name: /download/i });
    expect(downloadLink).toHaveAttribute("href", "/uploads/sample.pdf");
    expect(downloadLink).toHaveAttribute("download", "sample.pdf");
  });

  it("sizes the rendered PDF page to the available panel width", async () => {
    pdfMockState.failLoad = false;

    vi.stubGlobal(
      "ResizeObserver",
      class ResizeObserver {
        private readonly callback: ResizeObserverCallback;

        constructor(callback: ResizeObserverCallback) {
          this.callback = callback;
        }

        observe(target: Element) {
          this.callback(
            [
              {
                target,
                contentRect: { width: 512 },
              } as ResizeObserverEntry,
            ],
            this,
          );
        }

        unobserve() {}

        disconnect() {}
      },
    );

    render(<PdfDocumentViewer fileUrl="/uploads/responsive.pdf" filename="responsive.pdf" />);

    expect(await screen.findByTestId("react-pdf-page")).toHaveAttribute("data-page-width", "480");
  });

  it("falls back to the native browser PDF frame when PDF.js cannot load", async () => {
    pdfMockState.failLoad = true;

    render(<PdfDocumentViewer fileUrl="/uploads/fallback.pdf" filename="fallback.pdf" />);

    const fallback = await screen.findByTestId("pdf-native-fallback");
    expect(fallback).toHaveAttribute("src", "/uploads/fallback.pdf");
    expect(fallback).toHaveAttribute("title", "fallback.pdf");
  });
});
