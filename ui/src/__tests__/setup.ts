import "@testing-library/jest-dom/vitest";

vi.mock("@mdxeditor/editor", () => ({
  CodeMirrorEditor: {},
  MDXEditor: () => null,
  headingsPlugin: () => ({}),
  listsPlugin: () => ({}),
  quotePlugin: () => ({}),
  thematicBreakPlugin: () => ({}),
  markdownShortcutPlugin: () => ({}),
  toolbarPlugin: () => ({}),
  BoldItalicUnderlineToggles: () => null,
  ListsToggle: () => null,
  BlockTypeSelect: () => null,
  CreateLink: () => null,
  linkPlugin: () => ({}),
  linkDialogPlugin: () => ({}),
  codeBlockPlugin: () => ({}),
  codeMirrorPlugin: () => ({}),
  tablePlugin: () => ({}),
  imagePlugin: () => ({}),
}));

// Stub window.matchMedia for jsdom (used by Radix UI, responsive components)
Object.defineProperty(window, "matchMedia", {
  writable: true,
  value: vi.fn().mockImplementation((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })),
});

// Stub ResizeObserver (used by Radix UI)
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
window.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver;

// Stub IntersectionObserver
class IntersectionObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
window.IntersectionObserver = IntersectionObserverStub as unknown as typeof IntersectionObserver;

// jsdom does not implement canvas. Components that use canvas for decorative
// generated images should stay testable without installing native canvas deps.
HTMLCanvasElement.prototype.getContext = vi.fn(() => ({
  arc: vi.fn(),
  beginPath: vi.fn(),
  clearRect: vi.fn(),
  fill: vi.fn(),
  fillRect: vi.fn(),
  restore: vi.fn(),
  save: vi.fn(),
  scale: vi.fn(),
  setLineDash: vi.fn(),
  stroke: vi.fn(),
  translate: vi.fn(),
})) as unknown as HTMLCanvasElement["getContext"];

HTMLCanvasElement.prototype.toDataURL = vi.fn(() => "data:image/png;base64,test");
